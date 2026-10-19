import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProposedDiffs, applyProposedFiles, copyProject, executeWithProcessGroup, verifyProposedMigration, type VerificationOptions } from '../src/core/verify.js';

const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);
const processGroupProbe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ready")'], { encoding: 'utf8', timeout: 3_000 });
const processGroupsAvailable = process.env.CODEX_PERMISSION_PROFILE !== 'managed' && processGroupProbe.status === 0 && processGroupProbe.stdout === 'ready';

async function makeProject(
  scripts: Record<string, string> = { typecheck: 'tsc --noEmit', test: 'vitest run' },
  packageManager?: string,
): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-verify-test-'));
  temporaryDirectories.push(cwd);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: { 'firebase-admin': '^14.0.0' },
    scripts,
    ...(packageManager ? { packageManager } : {}),
  }));
  await writeFile(path.join(cwd, 'server.js'), 'const original = true;\n');
  await writeFile(path.join(cwd, '.env'), 'PRIVATE_VALUE=do-not-copy\n');
  await writeFile(path.join(cwd, '.env.example'), 'PUBLIC_PLACEHOLDER=value\n');
  await writeFile(path.join(cwd, '.gitignore'), 'ignored-secret.txt\n');
  await writeFile(path.join(cwd, 'ignored-secret.txt'), 'ignored\n');
  await writeFile(path.join(cwd, 'serviceAccountKey.json'), '{"private_key":"credential"}');
  await writeFile(path.join(cwd, 'credentials.json'), '{"token":"credential"}');
  await writeFile(path.join(cwd, 'credentials-prod.json'), '{"token":"credential"}');
  await writeFile(path.join(cwd, 'firebase-adminsdk-demo.json'), '{"private_key":"credential"}');
  await writeFile(path.join(cwd, 'privateKey.json'), '{"private_key":"credential"}');
  await writeFile(path.join(cwd, 'deploy.pem'), 'private key');
  await mkdir(path.join(cwd, '.aws'));
  await writeFile(path.join(cwd, '.aws', 'credentials'), 'aws secrets');
  await mkdir(path.join(cwd, 'secrets'));
  await writeFile(path.join(cwd, 'secrets', 'database.json'), '{"password":"secret"}');
  await symlink(os.tmpdir(), path.join(cwd, 'tmp-link'));
  await execFile('git', ['init', '-q'], { cwd });
  await execFile('git', ['add', '-f', '.env', '.env.example', '.gitignore', 'package.json', 'server.js', 'serviceAccountKey.json', 'credentials.json', 'credentials-prod.json', 'firebase-adminsdk-demo.json', 'privateKey.json', 'deploy.pem', '.aws/credentials', 'secrets/database.json', 'tmp-link'], { cwd });
  return cwd;
}

const diff = [
  '--- a/server.js',
  '+++ b/server.js',
  '@@ -1 +1 @@',
  '-const original = true;',
  '+const migrated = true;',
].join('\n');

afterEach(async () => {
  delete process.env.UPSTREAMFIX_TEST_TOKEN;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('migration verification', () => {
  it('respects a global Git excludesFile when copying a project', async () => {
    const cwd = await makeProject();
    const home = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-git-global-'));
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-global-copy-'));
    temporaryDirectories.push(home, copied);
    await writeFile(path.join(cwd, 'ignored-global.txt'), 'secret');
    const excludes = path.join(home, 'excludes');
    await writeFile(excludes, 'ignored-global.txt\n');
    await writeFile(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`);
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      await copyProject(cwd, copied);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    await expect(readFile(path.join(copied, 'ignored-global.txt'), 'utf8')).rejects.toThrow();
  });
  it('installs a nested package without a lockfile in that package directory', async () => {
    const cwd = await makeProject();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'root', scripts: {} }));
    await mkdir(path.join(cwd, 'functions'));
    await writeFile(path.join(cwd, 'functions', 'package.json'), JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0' }, scripts: { test: 'node -e 1' } }));
    let installDirectory = '';
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args, directory) => {
        if (args[0] === 'install') installDirectory = directory;
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(path.basename(installDirectory)).toBe('functions');
  });
  it('ignores an unrelated invalid nested manifest during verification', async () => {
    const cwd = await makeProject({ test: 'node -e 1' });
    await mkdir(path.join(cwd, 'broken'));
    await writeFile(path.join(cwd, 'broken', 'package.json'), '{invalid');
    const result = await verifyProposedMigration(cwd, [diff], { execute: async () => ({ stdout: 'ok' }) });
    expect(result.status).toBe('passed');
  });
  it('parses a package manifest with a UTF-8 BOM', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"' });
    const manifest = await readFile(path.join(cwd, 'package.json'), 'utf8');
    await writeFile(path.join(cwd, 'package.json'), `\uFEFF${manifest}`);
    const result = await verifyProposedMigration(cwd, [diff], { execute: async () => ({ stdout: 'ok' }) });
    expect(result.status).toBe('passed');
  });
  it.skipIf(!processGroupsAvailable)('finishes after the parent exits even if a detached descendant holds its output pipe (requires process groups)', async () => {
    const started = Date.now();
    const script = 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{detached:true,stdio:["ignore",process.stdout,process.stderr]}).unref(); process.exit(0);';
    await executeWithProcessGroup(process.execPath, ['-e', script], os.tmpdir(), { PATH: process.env.PATH }, 500);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it.skipIf(!processGroupsAvailable)('preserves UTF-8 characters split across process output chunks (requires process groups)', async () => {
    const script = 'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82,0xac])), 20);';
    const result = await executeWithProcessGroup(process.execPath, ['-e', script], os.tmpdir(), { PATH: process.env.PATH }, 1000);
    expect(result.stdout).toBe('€');
  });
  it('checks a patched temporary copy, strips secrets, and leaves the source untouched', async () => {
    const cwd = await makeProject();
    const fsmonitorMarker = path.join(cwd, 'fsmonitor-ran');
    await execFile('git', ['config', 'core.fsmonitor', `!touch ${fsmonitorMarker}`], { cwd });
    process.env.UPSTREAMFIX_TEST_TOKEN = 'must-not-leak';
    const before = await readFile(path.join(cwd, 'server.js'), 'utf8');
    let sawPatchedCopy = false;
    let sawSecretFile = false;
    let passedCleanEnv = false;
    let separateNpmConfigs = false;
    let copiedCredentials: string[] = [];

    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args, commandCwd, env) => {
        if (args[0] === 'install') {
          expect(args).toContain('--ignore-scripts');
          sawPatchedCopy = (await readFile(path.join(commandCwd, 'server.js'), 'utf8')).includes('const migrated = true;');
          sawSecretFile = await readFile(path.join(commandCwd, '.env'), 'utf8').then(() => true, () => false);
          copiedCredentials = await Promise.all(['serviceAccountKey.json', 'credentials.json', 'credentials-prod.json', 'firebase-adminsdk-demo.json', 'privateKey.json', 'deploy.pem', '.aws/credentials', 'secrets/database.json', 'ignored-secret.txt', 'tmp-link']
            .map(async (file) => await readFile(path.join(commandCwd, file)).then(() => file, () => '')));
          passedCleanEnv = env.UPSTREAMFIX_TEST_TOKEN === undefined && env.HOME !== os.homedir();
          separateNpmConfigs = env.NPM_CONFIG_USERCONFIG !== env.NPM_CONFIG_GLOBALCONFIG;
        }
        return { stdout: 'ok' };
      },
    });

    expect(result.status).toBe('passed');
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed']);
    expect(sawPatchedCopy).toBe(true);
    expect(sawSecretFile).toBe(false);
    expect(passedCleanEnv).toBe(true);
    expect(separateNpmConfigs).toBe(true);
    expect(copiedCredentials.filter(Boolean)).toEqual([]);
    await expect(readFile(fsmonitorMarker, 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(cwd, 'server.js'), 'utf8')).toBe(before);
  });

  it('uses a fresh npm cache per verification instead of the user cache', async () => {
    const cwd = await makeProject();
    const seen: string[] = [];
    for (let run = 0; run < 2; run++) {
      const result = await verifyProposedMigration(cwd, [diff], {
        execute: async (_command, args, _directory, env) => {
          if (args[0] === 'install') seen.push(env.NPM_CONFIG_CACHE ?? '');
          return { stdout: 'offline stub' };
        },
      });
      expect(result.status).toBe('passed');
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((cache) => cache.includes('upstreamfix-verify-') && !cache.startsWith(path.join(os.homedir(), '.npm')))).toBe(true);
    await Promise.all(seen.map(async (cache) => await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' })));
  });

  it('never falls through to a real installation when an install stub returns nothing', async () => {
    const cwd = await makeProject();
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async () => undefined,
    });
    expect(result.status).toBe('failed');
    expect(result.checks[0]?.output).toContain('did not provide an installation result');
  });

  it('reuses a private pnpm store across runs without exposing it to project scripts', async () => {
    const cwd = await makeProject({ test: 'node -e "process.exit(0)"' }, 'pnpm@10.0.0');
    const cache = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-pnpm-cache-test-'));
    temporaryDirectories.push(cache);
    const store = path.join(cache, 'store');
    let reused = false;
    for (let run = 0; run < 2; run++) {
      const result = await verifyProposedMigration(cwd, [diff], {
        pnpmCacheRoot: store,
        execute: async (command, args, _directory, env) => {
          if (command === 'pnpm' && args[0] === 'install') {
            const temporaryStore = args[args.indexOf('--store-dir') + 1]!;
            expect(temporaryStore).toBe(store);
            if (run === 1) reused = (await readFile(path.join(temporaryStore, 'marker'), 'utf8')) === 'cached';
            await mkdir(temporaryStore, { recursive: true });
            await writeFile(path.join(temporaryStore, 'marker'), 'cached');
          } else {
            expect(env.HOME).not.toContain(cache);
            expect(JSON.stringify(env)).not.toContain(store);
          }
          return { stdout: 'ok' };
        },
      });
      expect(result.status).toBe('passed');
    }
    expect(reused).toBe(true);
  });

  it('refuses to verify a folder that is not a Git working tree', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-verify-not-git-'));
    temporaryDirectories.push(cwd);
    await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"firebase-admin":"^14.0.0"}}');
    await expect(verifyProposedMigration(cwd, [diff])).resolves.toMatchObject({
      status: 'failed', note: expect.stringContaining('requires a Git working tree'),
    });
  });

  it('verifies projects using the migration package instead of assuming firebase-admin', async () => {
    const cwd = await makeProject();
    const manifestPath = path.join(cwd, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: Record<string, string> };
    delete manifest.dependencies['firebase-admin'];
    manifest.dependencies.stripe = '^22.0.0';
    await writeFile(manifestPath, JSON.stringify(manifest));
    let installRan = false;

    const result = await verifyProposedMigration(cwd, [diff], {
      packageName: 'stripe',
      execute: async (_command, args) => {
        if (args[0] === 'install') installRan = true;
        return { stdout: 'ok' };
      },
    });

    expect(result.status).toBe('passed');
    expect(installRan).toBe(true);
    expect(result.checks.some((check) => check.name.startsWith('Typecheck'))).toBe(true);
  });

  it('rejects packageManager URLs before invoking Corepack', async () => {
    const cwd = await makeProject({}, 'yarn@https://attacker.invalid/yarn.tgz');
    let commandRan = false;
    const result = await verifyProposedMigration(cwd, [diff], {
      packageName: 'firebase-admin',
      execute: async () => {
        commandRan = true;
        return { stdout: 'unexpected' };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.note).toContain('unsafe packageManager field');
    expect(commandRan).toBe(false);
  });

  it('uses the same validated package manager for installation and scripts', async () => {
    const cwd = await makeProject({ typecheck: 'echo types', test: 'echo tests' }, 'pnpm@10.0.0');
    const commands: string[] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      pnpmCacheRoot: path.join(cwd, 'private-pnpm-cache'),
      execute: async (command) => {
        commands.push(command);
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(commands).toEqual(['pnpm', 'pnpm', 'pnpm']);
  });

  it('applies structured migration contents to filenames containing tabs', async () => {
    const cwd = await makeProject();
    const oddPath = path.join(cwd, 'src', 'x\ty.ts');
    await mkdir(path.dirname(oddPath), { recursive: true });
    await writeFile(oddPath, 'const original = true;\n');
    await execFile('git', ['add', '--', 'src/x\ty.ts'], { cwd });
    let sawExactTarget = false;

    const result = await verifyProposedMigration(cwd, [diff], {
      fileChanges: [{ relativePath: 'src/x\ty.ts', before: 'const original = true;\n', after: 'const migrated = true;\n' }],
      execute: async (_command, args, commandCwd) => {
        if (args[0] === 'install') {
          sawExactTarget = await readFile(path.join(commandCwd, 'src', 'x\ty.ts'), 'utf8')
            .then((contents) => contents === 'const migrated = true;\n');
        }
        return { stdout: 'ok' };
      },
    });

    expect(result.status).toBe('passed');
    expect(sawExactTarget).toBe(true);
    expect(await readFile(oddPath, 'utf8')).toBe('const original = true;\n');
  });

  it('refuses a proposed file whose parent is a symbolic link', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-symlink-project-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-symlink-outside-'));
    temporaryDirectories.push(project, outside);
    await writeFile(path.join(outside, 'target.ts'), 'old');
    await symlink(outside, path.join(project, 'linked'));
    await expect(applyProposedFiles(project, [{ relativePath: 'linked/target.ts', before: 'old', after: 'new' }]))
      .rejects.toThrow('symbolic link');
    expect(await readFile(path.join(outside, 'target.ts'), 'utf8')).toBe('old');
  });

  it('records typecheck and test failures separately', async () => {
    const cwd = await makeProject();
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => {
        if (args.includes('typecheck')) throw Object.assign(new Error('type errors'), { stdout: 'TS2322: invalid assignment' });
        if (args.includes('test')) throw Object.assign(new Error('test failures'), { stdout: '1 failed, 4 passed' });
        return { stdout: 'installed' };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name.startsWith('Typecheck'))?.output).toContain('TS2322');
    expect(result.checks.find((check) => check.name.startsWith('Tests'))?.output).toContain('1 failed');
  });

  it('keeps the first and last lines of long command output', async () => {
    const cwd = await makeProject();
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => {
        if (args.includes('typecheck')) throw Object.assign(new Error('failed'), {
          stderr: `initial context\n${'progress\n'.repeat(1000)}TS2339: actual error at the end`,
        });
        return { stdout: 'ok' };
      },
    });
    const output = result.checks.find((check) => check.name.startsWith('Typecheck'))?.output ?? '';
    expect(output).toContain('initial context');
    expect(output).toContain('TS2339: actual error at the end');
    expect(output).toContain('[truncated');
    expect(output.length).toBeLessThanOrEqual(4_000);
  });

  it('reports timeouts and continues to capture the test command result', async () => {
    const cwd = await makeProject();
    const result = await verifyProposedMigration(cwd, [diff], {
      timeoutMs: 50,
      execute: async (_command, args) => {
        if (args.includes('typecheck')) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        return { stdout: 'tests passed' };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name.startsWith('Typecheck'))?.output).toContain('Timed out');
    expect(result.checks.find((check) => check.name.startsWith('Tests'))?.status).toBe('passed');
  });

  it('reports projects without typecheck or test commands as skipped', async () => {
    const cwd = await makeProject({});
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async () => ({ stdout: 'installed' }),
    });

    expect(result.status).toBe('skipped');
    expect(result.checks.filter((check) => check.status === 'skipped')).toHaveLength(2);
  });

  it('rejects patch paths that escape the copy on POSIX or Windows', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-patch-path-'));
    temporaryDirectories.push(cwd);
    const patch = (destination: string) => [
      '--- a/safe.js', `+++ b/${destination}`, '@@ -1 +1 @@', '-before', '+after',
    ].join('\n');
    await expect(applyProposedDiffs(cwd, [patch('../../outside.js')])).rejects.toThrow('unsafe path');
    await expect(applyProposedDiffs(cwd, [patch('..\\..\\outside.js')])).rejects.toThrow('unsafe path');
    await expect(applyProposedDiffs(cwd, [patch('C:\\outside.js')])).rejects.toThrow('unsafe path');
  });

  it('rejects structured migration paths outside the temporary copy', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-structured-path-'));
    temporaryDirectories.push(cwd);
    await expect(applyProposedFiles(cwd, [{ relativePath: '../outside.js', before: '', after: 'changed' }]))
      .rejects.toThrow('unsafe path');
  });

  it('runs real local npm scripts without network access', async () => {
    const cwd = await makeProject({
      typecheck: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    });
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => args[0] === 'install' ? { stdout: 'dependency install mocked for offline test' } : undefined,
    });

    expect(result.status).toBe('passed');
    expect(result.checks.filter((check) => check.name.startsWith('Typecheck') || check.name.startsWith('Tests'))
      .every((check) => check.status === 'passed')).toBe(true);
  });

  it('captures failure from a real local npm test script without network access', async () => {
    const cwd = await makeProject({
      typecheck: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(7)"',
    });
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => args[0] === 'install' ? { stdout: 'dependency install mocked for offline test' } : undefined,
    });

    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name.startsWith('Tests'))?.status).toBe('failed');
  });

  it('uses pnpm to run scripts when the project declares pnpm', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' }, 'pnpm@10.0.0');
    const commands: string[] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      pnpmCacheRoot: path.join(cwd, '.test-pnpm-store'),
      execute: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return { stdout: 'ok' };
      },
    });

    expect(result.status).toBe('passed');
    expect(commands).toContain('pnpm run typecheck');
    expect(commands).toContain('pnpm run test');
  });
  it('refuses an unreadable Yarn version before installation', async () => {
    const cwd = await makeProject({ test: 'node -e "process.exit(0)"' });
    await writeFile(path.join(cwd, 'yarn.lock'), '__metadata:\n  version: 8\n');
    const commands: string[] = [];
    const result = await verifyProposedMigration(cwd, [diff], { execute: async (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      return { stdout: args[0] === '--version' ? 'unknown build' : 'ok' };
    } });
    expect(result.status).toBe('failed');
    expect(commands).not.toContain('yarn install');
  });

  it('uses Yarn to run scripts when the project declares Yarn', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' }, 'yarn@4.0.0');
    const commands: string[] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return { stdout: args[0] === '--version' ? '4.0.0' : 'ok' };
      },
    });

    expect(result.status).toBe('passed');
    expect(commands).toContain('yarn run typecheck');
    expect(commands).toContain('yarn run test');
  });

  it('runs Yarn Berry without unsupported CLI flags and with the node-modules linker', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"' }, 'yarn@4.0.0');
    let install: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (command, args, _commandCwd, env) => {
        if (command === 'yarn' && args[0] === 'install') install = { args, env };
        return { stdout: args[0] === '--version' ? '4.0.0' : 'offline stub' };
      },
    });
    expect(result.status).toBe('passed');
    expect(install?.args).not.toContain('--non-interactive');
    expect(install?.env.YARN_NODE_LINKER).toBe('node-modules');
    expect(install?.env.YARN_ENABLE_SCRIPTS).toBe('false');
    expect(install?.env.COREPACK_ENABLE_PROJECT_SPEC).toBe('0');
    expect(install?.env.COREPACK_HOME).toContain('upstreamfix-verify-');
  });

  it('refuses Yarn Classic when the project declares Yarn Berry', async () => {
    const cwd = await makeProject({ test: 'node -e "process.exit(0)"' }, 'yarn@4.0.0');
    let installed = false;
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (command, args, _directory, env) => {
        expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
        expect(env.YARN_IGNORE_SCRIPTS).toBe('true');
        if (command === 'yarn' && args[0] === '--version') return { stdout: '1.22.22' };
        if (args[0] === 'install') installed = true;
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('failed');
    expect(result.note).toContain('Yarn');
    expect(installed).toBe(false);
  });

  it('kills the timed out script process group, including its child process', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"' });
    const marker = path.join(cwd, 'surviving-child.txt');
    const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 4000)`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {stdio:"ignore"}); setTimeout(() => {}, 60000)`;
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    manifest.scripts.test = `node -e '${parentScript.replaceAll("'", "'\\''")}'`;
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest));

    const result = await verifyProposedMigration(cwd, [diff], {
      timeoutMs: 1500,
      execute: async (_command, args) => args[0] === 'install' ? { stdout: 'offline install stub' } : undefined,
    });

    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name.startsWith('Tests'))?.output).toContain('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 4500));
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('kills background descendants after a script exits successfully', async () => {
    const cwd = await makeProject({ typecheck: 'node -e "process.exit(0)"' });
    const marker = path.join(cwd, 'orphan-marker.txt');
    const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 2500)`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {stdio:"ignore"}).unref()`;
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    manifest.scripts.test = `node -e '${parentScript.replaceAll("'", "'\\''")}'`;
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest));

    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => args[0] === 'install' ? { stdout: 'offline install stub' } : undefined,
    });
    expect(result.status).toBe('passed');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('cleans temporary files and tracked process groups on SIGTERM', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-signal-test-'));
    temporaryDirectories.push(root);
    const temporary = path.join(root, 'sensitive-temp');
    const marker = path.join(root, 'descendant-survived');
    const ready = path.join(root, 'ready');
    const cleanupModule = pathToFileURL(path.resolve('src/core/process-cleanup.ts')).href;
    const script = `
      import { trackProcessGroup, registerTemporaryCleanup } from ${JSON.stringify(cleanupModule)};
      import { spawn } from 'node:child_process';
      import { mkdir, writeFile, rm } from 'node:fs/promises';
      await mkdir(${JSON.stringify(temporary)});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 2000)`)}], {detached:true,stdio:'ignore'});
      trackProcessGroup(child.pid);
      registerTemporaryCleanup(() => rm(${JSON.stringify(temporary)}, {recursive:true,force:true}));
      await writeFile(${JSON.stringify(ready)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const runner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), stdio: 'ignore',
    });
    try {
      for (let attempt = 0; attempt < 100 && !(await readFile(ready, 'utf8').catch(() => '')); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const childPid = Number(await readFile(ready, 'utf8'));
      expect(Number.isInteger(childPid)).toBe(true);
      runner.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        runner.once('exit', (code) => code === 143 || code === null ? resolve() : reject(new Error(`cleanup subprocess exited with ${code}`)));
      });
      await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (runner.exitCode === null && !runner.killed) runner.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
