import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProposedDiffs, applyProposedFiles, copyProject, executeWithProcessGroup, readRegularFile, verifyProposedMigration, type VerificationOptions } from '../src/core/verify.js';

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
  const diagnostic = (line: number, code = 'TS2304', message = "Cannot find name 'PrismaClient'.") =>
    `server.ts(${line},7): error ${code}: ${message}\n`;
  const failing = (output: string) => Promise.reject(Object.assign(new Error('exit 2'), { stdout: output }));

  async function baselineProject(
    migratedOutput: string | undefined,
    originalOutput: string | undefined,
    options: { testsFail?: boolean } = {},
  ) {
    const cwd = await makeProject({ typecheck: 'tsc --noEmit', build: 'tsc', test: 'vitest run' });
    await writeFile(path.join(cwd, 'server.ts'), 'const before = true;\n');
    await execFile('git', ['add', 'server.ts'], { cwd });
    const fileChange = { relativePath: 'server.ts', before: 'const before = true;\n', after: 'const migrated = true;\n' };
    const calls: Array<{ phase: 'migrated' | 'baseline'; name: string; env: NodeJS.ProcessEnv; args: string[] }> = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      fileChanges: [fileChange],
      execute: async (command, args, directory, env, _timeout, allowInstallNetwork) => {
        const phase = (await readFile(path.join(directory, 'server.ts'), 'utf8')).includes('migrated') ? 'migrated' : 'baseline';
        const name = args.includes('typecheck') ? 'typecheck' : args.includes('build') ? 'build'
          : args.includes('test') ? 'test' : 'install';
        calls.push({ phase, name, env, args });
        if (name === 'install') {
          expect(allowInstallNetwork).toBe(true);
          expect(args).toContain('--ignore-scripts');
          expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
          expect(env.UPSTREAMFIX_TEST_TOKEN).toBeUndefined();
          return { stdout: 'installed' };
        }
        if (name === 'test' && options.testsFail) return failing('1 test failed');
        if (name === 'typecheck' || name === 'build') {
          const output = phase === 'migrated' ? migratedOutput : originalOutput;
          if (output !== undefined) return failing(output);
        }
        return { stdout: 'ok' };
      },
    });
    return { result, calls };
  }

  it('accepts identical pre-existing TypeScript errors and reports their count', async () => {
    const { result, calls } = await baselineProject(diagnostic(1), diagnostic(1));
    expect(result.status).toBe('passed');
    expect(result.note).toMatch(/pre-existing TypeScript failures unchanged/i);
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')?.output)
      .toMatch(/1 pre-existing error.*0 introduced/i);
    expect(result.checks.find((check) => check.name === 'Build (.)')?.status).toBe('passed');
    expect(calls.filter((call) => call.phase === 'baseline').map((call) => call.name)).toEqual(['install', 'typecheck', 'build']);
  });

  it('never installs a removed package in the baseline copy', async () => {
    const cwd = await makeProject({ typecheck: 'tsc --noEmit' });
    const before = `${JSON.stringify({ name: 'fixture', dependencies: { express: '^4.21.0', 'legacy-sdk': '^1.0.3' }, scripts: { typecheck: 'tsc --noEmit' } }, null, 2)}\n`;
    const after = `${JSON.stringify({ name: 'fixture', dependencies: { express: '^4.21.0' }, scripts: { typecheck: 'tsc --noEmit' } }, null, 2)}\n`;
    await writeFile(path.join(cwd, 'package.json'), before);
    await execFile('git', ['add', 'package.json'], { cwd });
    const installs: Array<{ phase: string; dependencies: Record<string, string> }> = [];
    const result = await verifyProposedMigration(cwd, [], {
      packageName: '@acme/official-sdk',
      removedPackageName: 'legacy-sdk',
      fileChanges: [{ relativePath: 'package.json', before, after }],
      execute: async (_command, args, directory) => {
        if (!args.includes('typecheck') && !args.includes('--noEmit')) {
          const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
          installs.push({ phase: directory.includes(`${path.sep}baseline`) ? 'baseline' : 'migrated', dependencies: manifest.dependencies });
          return { stdout: 'installed' };
        }
        return failing(diagnostic(1));
      },
    });
    expect(installs.map((install) => install.phase)).toEqual(['migrated', 'baseline']);
    for (const install of installs) expect(install.dependencies).not.toHaveProperty('legacy-sdk');
    expect(result.status).toBe('passed');
  });

  it('rejects a newly introduced TypeScript error and lists its diagnostic', async () => {
    const { result } = await baselineProject(diagnostic(1) + diagnostic(2, 'TS2322', "Type 'string' is not assignable to type 'number'."), diagnostic(1));
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')?.output).toContain('TS2322');
  });

  it('rejects a TypeScript failure when the original check passed', async () => {
    const { result } = await baselineProject(diagnostic(2, 'TS2322', "Type 'string' is not assignable to type 'number'."), undefined);
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')?.output).toContain('TS2322');
  });

  it('ignores line shifts in changed source files', async () => {
    const { result } = await baselineProject(diagnostic(9), diagnostic(1));
    expect(result.status).toBe('passed');
  });

  it('marks non-TypeScript failures before and after as inconclusive', async () => {
    const { result } = await baselineProject('compiler crashed', 'compiler crashed');
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Build (.)')?.output)
      .toContain('fails before and after the migration (not TypeScript diagnostics; often missing environment variables)');
  });

  it.each([
    'echo "Error: no test specified" && exit 1',
    'echo \\"Error: no test specified\\" && exit 1',
    'echo   Error: no test specified   &&   exit   1',
  ])('skips the npm init placeholder test script: %s', async (testScript) => {
    const cwd = await makeProject({ test: testScript });
    let ranTest = false;
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => {
        if (args.includes('test')) ranTest = true;
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(result.checks.find((check) => check.name === 'Smoke check (syntax and imports)')?.status).toBe('passed');
    expect(result.checks.find((check) => check.name === 'Tests (.)')).toMatchObject({ status: 'skipped', command: 'not configured' });
    expect(ranTest).toBe(false);
  });

  it('still executes a real failing test script', async () => {
    const cwd = await makeProject({ test: 'echo "Error: no test specified" && exit 2' });
    let runs = 0;
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => {
        if (args.includes('test')) {
          runs++;
          return failing('real test failure');
        }
        return { stdout: 'ok' };
      },
    });
    expect(runs).toBe(2);
    expect(result.checks.find((check) => check.name === 'Tests (.)')?.status).toBe('inconclusive');
  });

  it('marks a non-TypeScript build failing before and after as inconclusive', async () => {
    const cwd = await makeProject({ build: 'next build' });
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => args.includes('build')
        ? failing('Please define the MONGODB_URI environment variable') : { stdout: 'ok' },
    });
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Build (.)')).toMatchObject({
      status: 'inconclusive', output: expect.stringContaining('fails before and after the migration (not TypeScript diagnostics; often missing environment variables)'),
    });
  });

  it('marks a non-TypeScript typecheck failing before and after as inconclusive', async () => {
    const cwd = await makeProject({ typecheck: 'node check.js' });
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => args.includes('typecheck')
        ? failing('Missing required configuration') : { stdout: 'ok' },
    });
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')?.output)
      .toContain('fails before and after the migration (not TypeScript diagnostics; often missing environment variables)');
  });

  it('marks a custom check failing before and after as inconclusive', async () => {
    const cwd = await makeProject();
    const result = await verifyProposedMigration(cwd, [diff], {
      customCommands: ['node check.js'],
      execute: async (command) => command === '/bin/sh'
        ? failing('Missing required configuration') : { stdout: 'ok' },
    });
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Custom check 1')?.output)
      .toContain('fails before and after the migration (not TypeScript diagnostics; often missing environment variables)');
  });

  it('fails a non-TypeScript build that passed before migration', async () => {
    const cwd = await makeProject({ build: 'next build' });
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args, directory) => args.includes('build')
        && (await readFile(path.join(directory, 'server.js'), 'utf8')).includes('migrated')
        ? failing('Please define the MONGODB_URI environment variable') : { stdout: 'ok' },
    });
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name === 'Build (.)')?.status).toBe('failed');
  });

  it('marks tests failing in both copies inconclusive', async () => {
    const { result } = await baselineProject(undefined, undefined, { testsFail: true });
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Tests (.)')?.status).toBe('inconclusive');
  });

  it('does not create or execute an original copy when migrated checks pass', async () => {
    const { result, calls } = await baselineProject(undefined, undefined);
    expect(result.status).toBe('passed');
    expect(calls.some((call) => call.phase === 'baseline')).toBe(false);
  });
  it('W3 excludes pnpm workspace code hooks and disables pnpmfile loading during installation', async () => {
    const cwd = await makeProject({ test: 'node -e "process.exit(0)"' }, 'pnpm@10.0.0');
    await writeFile(path.join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - .\npnpmfile: ./evil.cjs\nconfigDependencies:\n  evil: ./evil.cjs\n');
    await execFile('git', ['add', 'pnpm-workspace.yaml'], { cwd });
    const installs: string[][] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (command, args, directory) => {
        if (command === 'pnpm' && args[0] === 'install') {
          installs.push(args);
          await expect(readFile(path.join(path.dirname(directory), 'project', 'pnpm-workspace.yaml'), 'utf8')).rejects.toThrow();
        }
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain('--config.pnpmfile=/dev/null');
    expect(installs[0]).toContain('--config.global-pnpmfile=/dev/null');
  });
  it('W6 rejects a FIFO and oversized metadata without blocking', async () => {
    const cwd = await makeProject();
    const fifo = path.join(cwd, 'metadata.fifo');
    const created = spawnSync('mkfifo', [fifo], { timeout: 3_000 });
    if (created.status !== 0) throw new Error('mkfifo is required for this Linux security test.');
    await expect(readRegularFile(fifo)).rejects.toThrow(/regular file/i);
    const large = path.join(cwd, 'large.json');
    await writeFile(large, 'x'.repeat(8 * 1024 * 1024 + 1));
    await expect(readRegularFile(large)).rejects.toThrow(/size limit/i);
  });
  it('runs configured custom checks only in the isolated verification copy', async () => {
    const cwd = await makeProject();
    const observed: Array<{ command: string; args: string[]; directory: string; token?: string }> = [];
    process.env.UPSTREAMFIX_TEST_TOKEN = 'trap-value';
    const result = await verifyProposedMigration(cwd, [diff], {
      customCommands: ['node -e "process.exit(0)"'],
      execute: async (command, args, directory, env) => {
        observed.push({ command, args, directory, token: env.UPSTREAMFIX_TEST_TOKEN });
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(result.checks.some((check) => check.name === 'Custom check 1')).toBe(true);
    expect(observed.some((check) => check.command === '/bin/sh' && check.args[0] === '-c')).toBe(true);
    expect(observed.every((check) => check.directory !== cwd && !check.token)).toBe(true);
  });
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

  it('refuses a manifest replaced by a symlink during container installation', async () => {
    const cwd = await makeProject({ test: 'node -e 1' });
    const secret = path.join(cwd, 'outside-secret.txt');
    await writeFile(secret, 'private payload that must not enter a report');
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args, directory) => {
        if (args[0] === 'install') {
          await rm(path.join(directory, 'package.json'));
          await symlink(secret, path.join(directory, 'package.json'));
        }
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('private payload');
  });

  it('T35 refuses a regular file reached through a symlinked parent directory', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-parent-outside-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-parent-project-'));
    temporaryDirectories.push(outside, project);
    await writeFile(path.join(outside, 'package.json'), '{"name":"secret"}');
    await symlink(outside, path.join(project, 'linked'));
    await expect(readRegularFile(path.join(project, 'linked', 'package.json'))).rejects.toThrow('symbolic link');
  });
  it('X8 accepts a trusted project root reached through a symlink', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-trusted-project-'));
    const parent = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-trusted-link-'));
    temporaryDirectories.push(project, parent);
    await writeFile(path.join(project, 'package.json'), '{"name":"fixture"}\n');
    const alias = path.join(parent, 'project');
    await symlink(project, alias);
    await expect(readRegularFile(path.join(alias, 'package.json'), alias)).resolves.toContain('fixture');
  });

  it('T35 never echoes invalid package contents in a verification error', async () => {
    const cwd = await makeProject();
    const marker = 'PRIVATE_CANARY_DO_NOT_LOG';
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args, directory) => {
        if (args[0] === 'install') await writeFile(path.join(directory, 'package.json'), `{${marker}`);
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(marker);
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

    expect(result.status).toBe('inconclusive');
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

  it('runs a JavaScript smoke check when no stronger check is configured', async () => {
    const cwd = await makeProject({});
    const commands: string[][] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => { commands.push(args); return { stdout: 'installed' }; },
    });

    expect(result.status).toBe('passed');
    expect(result.note).toContain('only a smoke check was available: no typecheck, build or tests are configured');
    expect(result.checks.find((check) => check.name === 'Smoke check (syntax and imports)')?.status).toBe('passed');
    expect(commands.some((args) => args.includes('--check'))).toBe(true);
    expect(result.checks.filter((check) => check.status === 'skipped')).toHaveLength(2);
  });

  it('does not accept a major firebase-functions companion upgrade on a smoke check alone', async () => {
    const cwd = await makeProject({});
    const before = await readFile(path.join(cwd, 'package.json'), 'utf8');
    const after = before.replace('"firebase-admin":"^14.0.0"', '"firebase-admin":"^14.0.0","firebase-functions":"^7.3.0"');
    const oldManifest = before.replace('"firebase-admin":"^14.0.0"', '"firebase-admin":"^13.0.0","firebase-functions":"^6.0.0"');
    await writeFile(path.join(cwd, 'package.json'), oldManifest);
    const result = await verifyProposedMigration(cwd, [], { fileChanges: [
      { relativePath: 'package.json', before: oldManifest, after },
      { relativePath: 'server.js', before: 'const original = true;\n', after: 'const migrated = true;\n' },
    ], execute: async () => ({ stdout: 'ok' }) });
    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name === 'Firebase Functions compatibility')?.output).toContain('syntax-only smoke check is insufficient');
  });

  it('copies and reports an unchanged file above 20 MiB', async () => {
    const cwd = await makeProject({ typecheck: 'tsc --noEmit' });
    const asset = path.join(cwd, 'namma-craft.apk');
    const handle = await open(asset, 'w');
    try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, _args, directory) => {
        if (directory.includes(`${path.sep}project`)) await expect(stat(path.join(directory, 'namma-craft.apk'))).resolves.toMatchObject({ size: 20 * 1024 * 1024 + 1 });
        return { stdout: 'ok' };
      },
    });
    expect(result.status).toBe('passed');
    expect(result.checks.find((check) => check.name === 'Copied large files')?.output).toContain('namma-craft.apk');
  });

  it('copies an unchanged large data file outside assets up to the 500 MiB total budget', async () => {
    const cwd = await makeProject();
    await mkdir(path.join(cwd, 'db-commands'), { recursive: true });
    const data = path.join(cwd, 'db-commands', 'botv2.json');
    const handle = await open(data, 'w');
    try { await handle.truncate(21 * 1024 * 1024); } finally { await handle.close(); }
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-data-copy-'));
    temporaryDirectories.push(copied);
    const largeCopied: string[] = [];
    await copyProject(cwd, copied, '--verify', [], largeCopied);
    expect(largeCopied).toEqual(['db-commands/botv2.json']);
    expect((await stat(path.join(copied, 'db-commands', 'botv2.json'))).size).toBe(21 * 1024 * 1024);
  });

  it('refuses an unchanged large file when it exceeds the 500 MiB total budget', async () => {
    const cwd = await makeProject();
    const handle = await open(path.join(cwd, 'data.json'), 'w');
    try { await handle.truncate(501 * 1024 * 1024); } finally { await handle.close(); }
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-overbudget-copy-'));
    temporaryDirectories.push(copied);
    await expect(copyProject(cwd, copied)).rejects.toThrow('500 MiB');
  });

  it('excludes a large asset directory when total size exceeds 100 MiB', async () => {
    const cwd = await makeProject();
    await mkdir(path.join(cwd, 'public', 'art'), { recursive: true });
    for (let index = 0; index < 12; index++) {
      const handle = await open(path.join(cwd, 'public', 'art', `image-${index}.png`), 'w');
      try { await handle.truncate(10 * 1024 * 1024); } finally { await handle.close(); }
    }
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-asset-copy-'));
    temporaryDirectories.push(copied);
    const excluded = await copyProject(cwd, copied);
    expect(excluded).toHaveLength(12);
    expect(excluded[0]).toContain('public/art/image-');
    await expect(stat(path.join(copied, 'server.js'))).resolves.toBeDefined();
    await expect(stat(path.join(copied, 'public', 'art', 'image-0.png'))).rejects.toThrow();
  });

  it('still refuses a project with more than 100 MiB of source code', async () => {
    const cwd = await makeProject();
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    for (let index = 0; index < 6; index++) {
      const handle = await open(path.join(cwd, 'src', `large-${index}.ts`), 'w');
      try { await handle.truncate(18 * 1024 * 1024); } finally { await handle.close(); }
    }
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-source-copy-'));
    temporaryDirectories.push(copied);
    await expect(copyProject(cwd, copied)).rejects.toThrow('project copy larger than 100 MiB');
  });

  it.each(['namma-craft.apk', 'package.json', 'package-lock.json', 'src/main.js'])
  ('refuses an oversized protected file: %s', async (name) => {
    const cwd = await makeProject();
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    const handle = await open(path.join(cwd, name), 'w');
    try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const copied = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-large-copy-'));
    temporaryDirectories.push(copied);
    await expect(copyProject(cwd, copied, '--verify',
      ['namma-craft.apk', 'src/main.js'].includes(name) ? [name] : [])).rejects.toThrow('refused a file larger than 20 MiB');
  });

  it('skips a tsconfig typecheck when TypeScript is not installed', async () => {
    const cwd = await makeProject({});
    await writeFile(path.join(cwd, 'tsconfig.json'), '{}\n');
    const commands: string[][] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (_command, args) => { commands.push(args); return { stdout: 'ok' }; },
    });
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')).toMatchObject({
      status: 'skipped', output: 'TypeScript is not installed in this project',
    });
    expect(commands.some((args) => args.includes('--noEmit'))).toBe(false);
  });

  it('uses a TypeScript compiler installed as an in-copy npm bin symlink', async () => {
    const cwd = await makeProject({});
    await writeFile(path.join(cwd, 'tsconfig.json'), '{}\n');
    const commands: string[] = [];
    const result = await verifyProposedMigration(cwd, [diff], {
      execute: async (command, args, directory) => {
        if (args[0] === 'install') {
          const binary = path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
          await mkdir(path.dirname(binary), { recursive: true });
          await mkdir(path.join(directory, 'node_modules', '.bin'), { recursive: true });
          await writeFile(binary, '#!/usr/bin/env node\n');
          await symlink('../typescript/bin/tsc', path.join(directory, 'node_modules', '.bin', 'tsc'));
        } else commands.push(command);
        return { stdout: 'ok' };
      },
    });
    expect(result.checks.find((check) => check.name === 'Typecheck (.)')?.status).toBe('passed');
    expect(commands.some((command) => command.endsWith('/node_modules/.bin/tsc'))).toBe(true);
  });

  it('keeps a TypeScript-only edit skipped when no typecheck is available', async () => {
    const cwd = await makeProject({});
    await writeFile(path.join(cwd, 'server.ts'), 'const before = true;\n');
    const result = await verifyProposedMigration(cwd, [], {
      fileChanges: [{ relativePath: 'server.ts', before: 'const before = true;\n', after: 'const after = true;\n' }],
      execute: async () => ({ stdout: 'ok' }),
    });
    expect(result.status).toBe('skipped');
    expect(result.checks.some((check) => check.name === 'Smoke check (syntax and imports)')).toBe(false);
  });

  it('fails the smoke check for invalid JavaScript syntax', async () => {
    const cwd = await makeProject({});
    const result = await verifyProposedMigration(cwd, [], {
      fileChanges: [{ relativePath: 'server.js', before: 'const original = true;\n', after: 'const broken = ;\n' }],
      execute: async (command, args, directory) => args[0] === '--check'
        ? execFile(command, args, { cwd: directory }) : { stdout: 'installed' },
    });
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.name === 'Smoke check (syntax and imports)')?.status).toBe('failed');
  });

  it('resolves migrated package imports and requires from each changed file', async () => {
    const cwd = await makeProject({});
    await writeFile(path.join(cwd, 'worker.cjs'), 'const original = true;\n');
    const changes = [
      { relativePath: 'server.js', before: 'const original = true;\n', after: "import { initializeApp } from 'firebase-admin/app';\n" },
      { relativePath: 'worker.cjs', before: 'const original = true;\n', after: "require('firebase-admin/firestore');\n" },
    ];
    const verify = async (includeFirestore: boolean) => verifyProposedMigration(cwd, [], {
      fileChanges: changes,
      execute: async (command, args, directory) => {
        if (args[0] === 'install') {
          const packageDir = path.join(directory, 'node_modules', 'firebase-admin');
          await mkdir(packageDir, { recursive: true });
          await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
            name: 'firebase-admin', exports: { './app': './app.js', ...(includeFirestore ? { './firestore': './firestore.js' } : {}) },
          }));
          await writeFile(path.join(packageDir, 'app.js'), 'module.exports = {};\n');
          if (includeFirestore) await writeFile(path.join(packageDir, 'firestore.js'), 'module.exports = {};\n');
          return { stdout: 'installed' };
        }
        return args[0] === '--check' ? execFile(command, args, { cwd: directory }) : { stdout: 'ok' };
      },
    });
    expect((await verify(true)).status).toBe('passed');
    const unresolved = await verify(false);
    expect(unresolved.status).toBe('failed');
    expect(unresolved.checks.find((check) => check.name === 'Smoke check (syntax and imports)')?.output)
      .toContain('firebase-admin/firestore');
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

    expect(result.status).toBe('inconclusive');
    expect(result.checks.find((check) => check.name.startsWith('Tests'))?.status).toBe('inconclusive');
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
