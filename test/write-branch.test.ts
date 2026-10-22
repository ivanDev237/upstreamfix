import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { assertChangedSourcesUseTargetSdk, writeMigrationOnBranch } from '../src/core/write-branch.js';
import { applyProposedFiles } from '../src/core/verify.js';
import { runMigration } from '../src/core/runner.js';
import type { RunOutcome } from '../src/core/runner.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  return stdout.trim();
}

async function makeRepository(
  source = "const admin = require('firebase-admin');\nadmin.firestore();\n",
  withChecks = true,
): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-write-test-'));
  roots.push(cwd);
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.name', 'UpstreamFix test');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    engines: { node: '>=22' },
    dependencies: { 'firebase-admin': '^13.0.0' },
    ...(withChecks ? { scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } } : {}),
  }, null, 2) + '\n');
  await writeFile(path.join(cwd, 'index.js'), source);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}

async function makeOpenAiRepository(typecheck: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-write-test-'));
  roots.push(cwd);
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.name', 'UpstreamFix test');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'openai-fixture', version: '1.0.0', type: 'module',
    engines: { node: '>=20' }, dependencies: { openai: '^4.28.0' },
    scripts: { typecheck, test: 'node -e "process.exit(0)"' },
  }, null, 2) + '\n');
  await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { lib: ['ES2022'], noEmit: true } }));
  await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
  await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}

const verificationOptions = {
  timeoutMs: 5_000,
  execute: async (command: string, args: string[]) => {
    if (command === 'npm' && args[0] === 'install') return { stdout: 'install skipped in offline test' };
    return undefined;
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('verified Git branch writes', () => {
  it('W4 refuses a symlinked package manifest without exposing its target contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-manifest-link-'));
    roots.push(root);
    const nested = path.join(root, 'src');
    await mkdir(nested);
    const secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'root:x:0:0:secret-data');
    await symlink(secret, path.join(nested, 'package.json'));
    const outcome: RunOutcome = {
      changes: [], manual: [], filesChanged: ['src/index.js'], fileUpdates: [],
      manifestNotes: [], proposedDiff: [], proposedFiles: [],
    };
    const message = await assertChangedSourcesUseTargetSdk(root, firebaseAdminV14, outcome)
      .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(message).toContain('Unsafe package.json');
    expect(message).not.toContain('root:x:0:0');
  });
  it('W9 refuses to write a source file above the analysis limit', async () => {
    const source = `// ${'x'.repeat(2_200_000)}\nconst admin = require('firebase-admin');\nadmin.firestore();\n`;
    const cwd = await makeRepository(source);
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions })).rejects.toThrow(/manual review/);
    expect((await git(cwd, 'branch', '--list', 'upstreamfix/*')).trim()).toBe('');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toBe('');
  });

  it('does not create an OpenAI branch unless the isolated typecheck passes after adding Node types', async () => {
    const cwd = await makeOpenAiRepository('node -e "process.exit(1)"');
    await expect(writeMigrationOnBranch(openaiV5, { cwd, nodeRuntime: 20, verificationOptions }))
      .rejects.toThrow('The isolated typecheck failed');
    expect((await git(cwd, 'branch', '--list', 'upstreamfix/openai-5')).trim()).toBe('');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toBe('');
  });

  it('merges OpenAI and Node type edits into one package path for preview, apply, CLI, and Action branch writes', async () => {
    const cwd = await makeOpenAiRepository('tsc --noEmit');
    const preview = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
    expect(new Set(preview.proposedFiles.map((file) => file.relativePath)).size).toBe(preview.proposedFiles.length);
    const copy = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-apply-preview-'));
    roots.push(copy);
    for (const relative of ['package.json', 'tsconfig.json', 'client.ts', 'server.ts'])
      await writeFile(path.join(copy, relative), await readFile(path.join(cwd, relative), 'utf8'));
    await applyProposedFiles(copy, preview.proposedFiles);
    const applied = JSON.parse(await readFile(path.join(copy, 'package.json'), 'utf8')) as { dependencies: { openai: string }; devDependencies: { '@types/node': string } };
    expect(applied.dependencies.openai).toBe('^5.0.0');
    expect(applied.devDependencies['@types/node']).toBe('^20.0.0');
    const result = await writeMigrationOnBranch(openaiV5, {
      cwd, nodeRuntime: 20,
      verificationOptions: { execute: async () => ({ stdout: 'verified without network' }) },
    });
    expect(result.verification.status).toBe('passed');
    const committed = JSON.parse(await git(cwd, 'show', `${result.branch}:package.json`)) as { dependencies: { openai: string }; devDependencies: { '@types/node': string } };
    expect(committed.dependencies.openai).toBe('^5.0.0');
    expect(committed.devDependencies['@types/node']).toBe('^20.0.0');
  });

  it('creates a dedicated branch and commit after real local verification', async () => {
    const cwd = await makeRepository();
    const originalHead = await git(cwd, 'rev-parse', 'HEAD');
    const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions });

    expect(result.branch).toBe('upstreamfix/firebase-admin-14');
    expect(result.verification.status).toBe('passed');
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(await git(cwd, 'show', `${result.branch}:index.js`)).toContain('getFirestore()');
    expect(await git(cwd, 'show', `${result.branch}:index.js`)).toContain('firebase-admin/firestore');
    expect(JSON.parse(await git(cwd, 'show', `${result.branch}:package.json`)).dependencies['firebase-admin']).toBe('^14.0.0');
    expect(await readFile(path.join(cwd, 'index.js'), 'utf8')).toContain('admin.firestore()');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toBe('');
  });

  it('uses global Git identity when the repository has no local identity', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'config', '--local', '--unset', 'user.name');
    await git(cwd, 'config', '--local', '--unset', 'user.email');
    const home = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-git-home-'));
    roots.push(home);
    await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Global Migration User\n\temail = global@example.invalid\n');

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions });
      const author = await git(cwd, 'show', '-s', '--format=%an <%ae>', result.commit);
      expect(author).toBe('Global Migration User <global@example.invalid>');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('honors global commit signing configuration', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'config', '--local', '--unset', 'user.name');
    await git(cwd, 'config', '--local', '--unset', 'user.email');
    const home = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-git-signing-home-'));
    roots.push(home);
    const marker = path.join(home, 'signer-called');
    const signer = path.join(home, 'fake-gpg');
    await writeFile(signer, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' called > '${marker}'\nprintf '%s\\n' '[GNUPG:] SIG_CREATED D 1 10 00 00000000 00000000' >&2\nprintf '%s\\n' '-----BEGIN PGP SIGNATURE-----' '' 'ZmFrZQ==' '-----END PGP SIGNATURE-----'\n`);
    await chmod(signer, 0o755);
    await writeFile(path.join(home, '.gitconfig'), `[user]\n\tname = Global Signing User\n\temail = signer@example.invalid\n\tsigningkey = test-key\n[commit]\n\tgpgsign = true\n[gpg]\n\tformat = openpgp\n\tprogram = ${signer}\n`);

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions });
      const signature = await git(cwd, 'show', '-s', '--format=%G?', result.commit);
      expect(await readFile(marker, 'utf8')).toContain('called');
      expect(signature).toBe('N');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('refuses a non-Git project', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-not-git-'));
    roots.push(cwd);
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('inside a Git repository');
  });

  it('refuses dirty trees unless explicitly allowed, and preserves dirty files', async () => {
    const cwd = await makeRepository();
    await writeFile(path.join(cwd, 'notes.txt'), 'unsaved work');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('uncommitted changes');

    const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, allowDirty: true, verificationOptions });
    expect(result.note).toContain('original dirty working tree was left untouched');
    expect(await readFile(path.join(cwd, 'notes.txt'), 'utf8')).toBe('unsaved work');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toContain('?? notes.txt');
  });

  it('refuses to overwrite a branch that already exists', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'branch', 'upstreamfix/firebase-admin-14');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('already exists');
  });

  it('does not create a branch when migration findings or verification block the write', async () => {
    const manualRepo = await makeRepository("const admin = require('firebase-admin');\nadmin.unknownService();\n");
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd: manualRepo, verificationOptions }))
      .rejects.toThrow('manual review item');
    expect(await git(manualRepo, 'branch', '--list', 'upstreamfix/*')).toBe('');

    const failedRepo = await makeRepository();
    await expect(writeMigrationOnBranch(firebaseAdminV14, {
      cwd: failedRepo,
      verificationOptions: { execute: async (command, args) => {
        if (command === 'npm' && args[0] === 'install') return { stdout: 'offline install stub' };
        if (command === 'npm') throw new Error('verification failed');
        return undefined;
      } },
    })).rejects.toThrow('verification did not pass');
    expect(await git(failedRepo, 'branch', '--list', 'upstreamfix/*')).toBe('');
  });

  it('refuses writes when the project has no configured checks', async () => {
    const cwd = await makeRepository(undefined, false);
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('verification did not pass (skipped)');
    expect(await git(cwd, 'branch', '--list', 'upstreamfix/*')).toBe('');
  });

  it('refuses source changes when the target SDK is not declared in the manifest', async () => {
    const cwd = await makeRepository();
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { engines?: { node: string } };
    delete manifest.engines;
    await writeFile(path.join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await git(cwd, 'add', 'package.json');
    await git(cwd, 'commit', '-qm', 'omit Node runtime');

    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('firebase-admin v14 requires Node.js 22 or newer');
    expect(await git(cwd, 'branch', '--list', 'upstreamfix/*')).toBe('');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toBe('');

    const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, nodeRuntime: 22, verificationOptions });
    const committedManifest = JSON.parse(await git(cwd, 'show', `${result.branch}:package.json`)) as { engines: { node: string }; dependencies: Record<string, string> };
    expect(committedManifest.engines.node).toBe('>=22');
    expect(committedManifest.dependencies['firebase-admin']).toBe('^14.0.0');
    expect(await git(cwd, 'show', `${result.branch}:index.js`)).toContain('getFirestore()');
    expect((await git(cwd, 'status', '--porcelain')).trim()).toBe('');
  });

  it('refuses an active fsmonitor command before it can run during Git status', async () => {
    const cwd = await makeRepository();
    const marker = path.join(cwd, 'fsmonitor-ran');
    await git(cwd, 'config', 'core.fsmonitor', `!touch ${marker}`);

    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('configured Git filters, diff commands, or fsmonitor hooks');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('refuses configured clean filters before staging migration files', async () => {
    const cwd = await makeRepository();
    const marker = path.join(cwd, 'filter-ran');
    await git(cwd, 'config', 'filter.malicious.clean', `touch ${marker}`);

    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('configured Git filters, diff commands, or fsmonitor hooks');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('refuses a clean filter supplied through a local Git include', async () => {
    const cwd = await makeRepository();
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-git-include-'));
    roots.push(configDir);
    const included = path.join(configDir, 'unsafe-git-config');
    await writeFile(included, '[filter "hidden"]\n\tclean = echo unsafe\n');
    await git(cwd, 'config', 'include.path', included);
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('configured Git filters, diff commands, or fsmonitor hooks');
  });

  it('refuses a local GPG program override', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'config', 'gpg.ssh.program', '/tmp/untrusted-signer');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow('configured Git filters, diff commands, or fsmonitor hooks');
  });
  it.each(['gpg.openpgp.program', 'gpg.ssh.defaultKeyCommand'])('refuses local signing command %s before it executes', async (key) => {
    const cwd = await makeRepository();
    const marker = path.join(cwd, 'signer-ran');
    const script = path.join(cwd, 'signer.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(script, 0o755);
    await git(cwd, 'config', key, script);
    await git(cwd, 'config', 'commit.gpgsign', 'true');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, allowDirty: true, verificationOptions }))
      .rejects.toThrow(/configured Git|signing/i);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('refuses a dangerous setting from Git worktree config', async () => {
    const cwd = await makeRepository();
    const marker = path.join(cwd, 'worktree-signer-ran');
    const script = path.join(cwd, 'worktree-signer.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(script, 0o755);
    await git(cwd, 'config', 'extensions.worktreeConfig', 'true');
    await git(cwd, 'config', '--worktree', 'gpg.openpgp.program', script);
    await git(cwd, 'config', '--worktree', 'commit.gpgsign', 'true');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, allowDirty: true, verificationOptions }))
      .rejects.toThrow(/configured Git|signing/i);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
  it('accepts a symlinked cwd that points inside the repository', async () => {
    const cwd = await makeRepository();
    const linkDir = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-linked-cwd-'));
    roots.push(linkDir);
    const link = path.join(linkDir, 'project');
    await symlink(cwd, link);
    const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd: link, verificationOptions });
    expect(result.branch).toBe('upstreamfix/firebase-admin-14');
  });
  it('X8 allows a credential-free local pushurl and insteadOf setting', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'config', 'remote.origin.pushurl', 'https://github.com/example/repo.git');
    await git(cwd, 'config', 'url.https://github.com/.insteadOf', 'gh:');
    const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions });
    expect(result.branch).toBe('upstreamfix/firebase-admin-14');
  });
  it('X8 refuses a pushInsteadOf rewrite to a command transport', async () => {
    const cwd = await makeRepository();
    await git(cwd, 'config', 'url.ext::sh -c true;.pushInsteadOf', 'gh:');
    await expect(writeMigrationOnBranch(firebaseAdminV14, { cwd, verificationOptions }))
      .rejects.toThrow(/configured Git|hooks|filter/i);
  });
});
