import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Migration, PackageManifest } from './types.js';
import { runMigration, type RunOutcome } from './runner.js';
import { applyProposedFiles, verifyProposedMigration, type VerificationOptions, type VerificationResult } from './verify.js';
import { registerTemporaryCleanup } from './process-cleanup.js';

const execFile = promisify(execFileCallback);

export interface WriteBranchOptions {
  cwd: string;
  allowDirty?: boolean;
  nodeRuntime?: 22;
  allowYarnLockInstall?: boolean;
  timeoutMs?: number;
  /** Test seam for exercising the branch transaction without contacting a package registry. */
  verificationOptions?: VerificationOptions;
}

export interface WriteBranchResult {
  branch: string;
  commit: string;
  outcome: RunOutcome;
  verification: VerificationResult;
  note?: string;
}

/**
 * Builds and verifies a migration in a detached worktree, then commits only the
 * migration's changed paths on a new branch. The caller must enforce the
 * `WRITES_ENABLED` safety gate before calling this operation.
 */
export async function writeMigrationOnBranch(
  migration: Migration,
  options: WriteBranchOptions,
): Promise<WriteBranchResult> {
  const cwd = path.resolve(options.cwd);
  const repositoryRoot = await git(cwd, ['rev-parse', '--show-toplevel']).then((value) => value.trim()).catch(() => {
    throw new Error('--write requires the project directory to be inside a Git repository.');
  });
  const projectRelative = path.relative(repositoryRoot, cwd);
  if (path.isAbsolute(projectRelative) || projectRelative === '..' || projectRelative.startsWith(`..${path.sep}`)) {
    throw new Error('The project directory must be inside the Git repository.');
  }

  await assertSafeLocalGitConfig(repositoryRoot);

  const status = await git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (status.trim() && !options.allowDirty) {
    throw new Error('The Git working tree has uncommitted changes. Commit or stash them, or pass --allow-dirty to migrate the committed HEAD in an isolated worktree.');
  }

  const safeId = migration.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const branch = `upstreamfix/${safeId}`;
  if ((await git(repositoryRoot, ['branch', '--list', '--format=%(refname:short)', branch])).trim()) {
    throw new Error(`Branch ${branch} already exists; remove or rename it before retrying.`);
  }

  const head = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  const worktreeParent = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-write-'));
  const worktree = path.join(worktreeParent, 'repo');
  let worktreeAdded = false;
  let branchCreated = false;
  let committed = false;
  const unregisterCleanup = registerTemporaryCleanup(async () => {
    if (worktreeAdded) await git(repositoryRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(worktreeParent, { recursive: true, force: true });
    if (branchCreated && !committed) await git(repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
  });

  try {
    await git(repositoryRoot, ['worktree', 'add', '--detach', worktree, head]);
    worktreeAdded = true;
    const projectCopy = projectRelative ? path.join(worktree, projectRelative) : worktree;
    const outcome = await runMigration(migration, { cwd: projectCopy, dryRun: true, nodeRuntime: options.nodeRuntime, allowYarnLockInstall: options.allowYarnLockInstall });
    if (outcome.manual.length > 0) {
      throw new Error(`Migration has ${outcome.manual.length} manual review item(s); no branch or commit was created.`);
    }
    if (outcome.proposedDiff.length === 0) throw new Error('Migration produced no changes; no branch or commit was created.');
    await assertChangedSourcesUseTargetSdk(projectCopy, migration, outcome);

    const verification = await verifyProposedMigration(projectCopy, outcome.proposedDiff, {
      packageName: migration.packageName,
      fileChanges: outcome.proposedFiles,
      timeoutMs: options.timeoutMs,
      ...options.verificationOptions,
    });
    if (verification.status !== 'passed') {
      throw new Error(`Migration verification did not pass (${verification.status}); no branch or commit was created.${verification.note ? ` ${verification.note}` : ''}`);
    }

    await git(worktree, ['switch', '-c', branch]);
    branchCreated = true;
    await applyProposedFiles(projectCopy, outcome.proposedFiles);

    const stagePaths = outcome.filesChanged.map((file) => {
      const absolute = path.resolve(projectCopy, file);
      const relativeToProject = path.relative(projectCopy, absolute);
      if (path.isAbsolute(relativeToProject) || relativeToProject === '..' || relativeToProject.startsWith(`..${path.sep}`)) {
        throw new Error(`Migration returned a changed path outside the project: ${file}`);
      }
      const relativeToRepo = path.relative(worktree, absolute);
      if (path.isAbsolute(relativeToRepo) || relativeToRepo === '..' || relativeToRepo.startsWith(`..${path.sep}`)) {
        throw new Error(`Migration returned a changed path outside the worktree: ${file}`);
      }
      return relativeToRepo || '.';
    });
    if (stagePaths.length === 0) throw new Error('Migration returned no files to commit.');
    await git(worktree, ['add', '--', ...stagePaths]);
    const stagedPaths = (await git(worktree, ['diff', '--cached', '--name-only', '-z']))
      .split('\0').filter(Boolean).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify([...stagePaths].sort())) {
      throw new Error('The Git index contains unexpected paths; no migration commit was created.');
    }
    for (const relativePath of stagePaths) {
      const stagedHash = (await git(worktree, ['rev-parse', `:${relativePath}`])).trim();
      const workingHash = (await git(worktree, ['hash-object', '--', relativePath])).trim();
      if (stagedHash !== workingHash) {
        throw new Error(`Git filters changed ${relativePath} after verification; no migration commit was created.`);
      }
    }
    await git(worktree, ['commit', '-m', `Apply ${migration.id} migration with UpstreamFix`]);
    const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
    committed = true;
    return {
      branch,
      commit,
      outcome,
      verification,
      ...(status.trim() ? { note: 'The branch was created from committed HEAD; the original dirty working tree was left untouched.' } : {}),
    };
  } finally {
    unregisterCleanup();
    if (worktreeAdded) {
      await git(repositoryRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(worktreeParent, { recursive: true, force: true });
    if (branchCreated && !committed) await git(repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
  }
}

/** Do not commit vNext source code while its containing manifest still installs vOld. */
async function assertChangedSourcesUseTargetSdk(projectRoot: string, migration: Migration, outcome: RunOutcome): Promise<void> {
  const proposed = new Map(outcome.proposedFiles.map((file) => [path.resolve(projectRoot, file.relativePath), file.after]));
  const targetPattern = new RegExp(`^\\s*[~^]?${migration.toMajor}(?:\\.(?:\\d+|x|\\*)){0,2}\\s*$`, 'i');
  for (const relativeFile of outcome.filesChanged) {
    if (!/\.(?:[cm]?jsx?|[cm]?tsx?)$/i.test(relativeFile) || relativeFile.endsWith('.d.ts')) continue;
    const source = path.resolve(projectRoot, relativeFile);
    const sourceRelative = path.relative(projectRoot, source);
    if (sourceRelative === '..' || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) {
      throw new Error(`Migration returned a changed path outside the project: ${relativeFile}`);
    }
    let directory = path.dirname(source);
    let foundRange: string | undefined;
    while (directory === projectRoot || directory.startsWith(`${projectRoot}${path.sep}`)) {
      const manifestFile = path.join(directory, 'package.json');
      const raw = proposed.get(manifestFile) ?? await readFile(manifestFile, 'utf8').catch(() => undefined);
      if (raw) {
        const manifest = JSON.parse(raw) as PackageManifest;
        const ranges = (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
          .map((section) => manifest[section]?.[migration.packageName])
          .filter((range): range is string => typeof range === 'string');
        if (ranges.length > 0) {
          foundRange = ranges[0];
          if (ranges.some((range) => !targetPattern.test(range))) {
            if (migration.id === 'firebase-admin@14' && !manifest.engines?.node) {
              throw new Error(`${relativeFile} cannot be committed: firebase-admin v14 requires Node.js 22 or newer. Add \"engines\": { \"node\": \">=22\" } to ${path.relative(projectRoot, manifestFile)}, or pass --node-runtime 22 to confirm the deployment runtime and include that declaration in the migration commit.`);
            }
            if (migration.id === 'firebase-admin@14') {
              throw new Error(`${relativeFile} cannot be committed: ${path.relative(projectRoot, manifestFile)} still declares ${migration.packageName} ${ranges.join(', ')}. Its engines.node range (${manifest.engines?.node}) may include Node.js versions below 22; review and update the range to guarantee Node.js 22 or newer, then preview again.`);
            }
            throw new Error(`${relativeFile} cannot be committed: ${path.relative(projectRoot, manifestFile)} does not declare ${migration.packageName} v${migration.toMajor} in every dependency section.`);
          }
          break;
        }
      }
      if (directory === projectRoot) break;
      directory = path.dirname(directory);
    }
    if (!foundRange) throw new Error(`${relativeFile} cannot be committed: no containing package.json declares ${migration.packageName} v${migration.toMajor}.`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', [
      '-c', `core.hooksPath=${os.devNull}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'protocol.file.allow=never',
      ...args,
    ], {
      cwd,
      env: await gitEnvironment(cwd),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message;
    throw Object.assign(new Error(message), { code: error.code });
  }
}

const preservedGitConfigKeys = [
  'commit.gpgsign',
  'gpg.format',
  'gpg.program',
  'gpg.ssh.program',
  'user.signingkey',
];

async function gitEnvironment(cwd: string): Promise<NodeJS.ProcessEnv> {
  const settings = await readPreservedGitSettings(cwd);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['GNUPGHOME', 'GPG_TTY', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!env.GIT_AUTHOR_NAME && settings.get('user.name')) env.GIT_AUTHOR_NAME = settings.get('user.name');
  if (!env.GIT_COMMITTER_NAME && settings.get('user.name')) env.GIT_COMMITTER_NAME = settings.get('user.name');
  if (!env.GIT_AUTHOR_EMAIL && settings.get('user.email')) env.GIT_AUTHOR_EMAIL = settings.get('user.email');
  if (!env.GIT_COMMITTER_EMAIL && settings.get('user.email')) env.GIT_COMMITTER_EMAIL = settings.get('user.email');

  const preserved = preservedGitConfigKeys.flatMap((key) => {
    const value = settings.get(key);
    return value === undefined ? [] : [key, value];
  });
  if (preserved.length > 0) {
    env.GIT_CONFIG_COUNT = String(preserved.length / 2);
    for (let index = 0; index < preserved.length; index += 2) {
      env[`GIT_CONFIG_KEY_${index / 2}`] = preserved[index];
      env[`GIT_CONFIG_VALUE_${index / 2}`] = preserved[index + 1];
    }
  }
  return env;
}

async function readPreservedGitSettings(cwd: string): Promise<Map<string, string>> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const settings = new Map<string, string>();
  const identity = await readGitConfig(cwd, env, ['user.name', 'user.email']);
  const signing = await readGitConfig(cwd, env, preservedGitConfigKeys, true);
  for (const [key, value] of [...identity, ...signing]) settings.set(key, value);
  return settings;
}

async function readGitConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  keys: string[],
  globalOnly = false,
): Promise<Map<string, string>> {
  const pattern = `^(${keys.map((key) => key.replaceAll('.', String.raw`\.`)).join('|')})$`;
  const result = await execFile('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.file.allow=never',
    'config', ...(globalOnly ? ['--global'] : []), '--null', '--get-regexp', pattern,
  ], {
    cwd,
    env,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).catch((error: NodeJS.ErrnoException & { code?: string | number; stdout?: string }) => {
    if (String(error.code) !== '1') throw error;
    return { stdout: error.stdout ?? '' };
  });
  const settings = new Map<string, string>();
  for (const record of result.stdout.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n');
    if (separator > 0) settings.set(record.slice(0, separator).toLowerCase(), record.slice(separator + 1));
  }
  return settings;
}

async function assertSafeLocalGitConfig(repositoryRoot: string): Promise<void> {
  const { stdout } = await execFile('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.file.allow=never',
    'config', '--local', '--get-regexp', String.raw`^(core\.fsmonitor|filter\..*\.(clean|smudge|process|required)|diff\.external|diff\..*\.command)$`,
  ], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? os.homedir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).catch((error: NodeJS.ErrnoException & { code?: string | number; stdout?: string }) => {
    if (String(error.code) !== '1') throw error;
    return { stdout: error.stdout ?? '' };
  });
  const dangerous = stdout.split(/\r?\n/).filter((line) => {
    const [key, ...value] = line.trim().split(/\s+/);
    if (!key) return false;
    if (key.toLowerCase() === 'core.fsmonitor') return value.join(' ') !== '' && !/^false$/i.test(value.join(' '));
    return value.join(' ').trim() !== '';
  });
  if (dangerous.length > 0) {
    throw new Error('The repository has configured Git filters, diff commands, or fsmonitor hooks. Remove them before using --write.');
  }
}
