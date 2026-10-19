import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram, completedBranchNotice, safeCliError, withCompletedBranchNotice } from '../src/cli.js';

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];
const subprocessProbe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ready")'], { encoding: 'utf8', timeout: 3_000 });
const subprocessAvailable = subprocessProbe.status === 0 && subprocessProbe.stdout === 'ready';

async function makeProject(firebaseAdminRange = '^13.0.0'): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-cli-'));
  temporaryDirectories.push(cwd);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'firebase-admin': firebaseAdminRange } }));
  await writeFile(path.join(cwd, 'index.js'), "const admin = require('firebase-admin');\nadmin.firestore();\n");
  return cwd;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('UpstreamFix CLI', () => {
  it('sanitizes untrusted error details before printing them', () => {
    const error = safeCliError(new Error('bad\x1b[2J\u202Ename'));
    expect(error).toBe('upstreamfix: badname');
  });
  it('summarizes branches already created before a scan fails', () => {
    expect(completedBranchNotice([{ branch: 'upstreamfix/firebase-admin-14', commit: 'abc123' }]))
      .toContain('upstreamfix/firebase-admin-14: abc123');
  });
  it('reports an already committed branch when a later scan step throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(withCompletedBranchNotice(async (record) => {
      record({ branch: 'upstreamfix/firebase-admin-14', commit: 'abc123' });
      throw new Error('second migration failed');
    })).rejects.toThrow('second migration failed');
    expect(errors.mock.calls.map(([message]) => String(message)).join('\n')).toContain('upstreamfix/firebase-admin-14: abc123');
  });
  it('previews by default and requires Git for --write without modifying files', async () => {
    const cwd = await makeProject();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const filesBefore = (await readdir(cwd)).sort();
    const manifestBefore = await readFile(path.join(cwd, 'package.json'), 'utf8');
    const sourceBefore = await readFile(path.join(cwd, 'index.js'), 'utf8');

    await createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd]);
    const preview = output.mock.calls.map(([message]) => String(message)).join('\n');
    expect(preview).toContain('Dry run: no file was written.');
    expect(await readFile(path.join(cwd, 'index.js'), 'utf8')).toContain('admin.firestore()');
    expect((await readdir(cwd)).sort()).toEqual(filesBefore);
    expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(manifestBefore);
    expect(await readFile(path.join(cwd, 'index.js'), 'utf8')).toBe(sourceBefore);

    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd, '--write']))
      .rejects.toThrow('inside a Git repository');
    expect(await readFile(path.join(cwd, 'index.js'), 'utf8')).toContain('admin.firestore()');
  });

  it('writes a report only when an explicit report path is supplied', async () => {
    const cwd = await makeProject();
    const reportPath = path.join(cwd, 'review', 'migration.md');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd, '--report', 'review/migration.md',
    ]);

    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain('Dry run: no file was written.');
    expect((await readdir(path.dirname(reportPath))).sort()).toEqual(['migration.md']);
    expect(vi.mocked(console.log).mock.calls.map(([message]) => String(message)).join('\n'))
      .not.toContain('No project files were written');
  });

  it('prints Node.js guidance cleanly while keeping the saved Markdown escaped', async () => {
    const cwd = await makeProject();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd, '--report', 'review.md']);

    const terminal = output.mock.calls.map(([message]) => String(message)).join('\n');
    const markdown = await readFile(path.join(cwd, 'review.md'), 'utf8');
    expect(terminal).toContain('Node.js');
    expect(terminal).toContain('"node": ">=22"');
    expect(terminal).not.toContain('Node\\.js');
    expect(terminal).not.toContain('&gt;=22');
    expect(markdown).toContain('Node\\.js');
    expect(markdown).toContain('&gt;=22');
  });

  it('rejects unsupported migration identifiers', async () => {
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'unknown@99', '--cwd', '/tmp']))
      .rejects.toThrow('Unknown migration');
  });

  it('rejects verification timeouts longer than 24 hours before any project work', async () => {
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--verify-timeout', '86401']))
      .rejects.toThrow('at most 86400 seconds');
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'scan', '--verify-timeout', '999999999999999999']))
      .rejects.toThrow('at most 86400 seconds');
  });

  it('lists migration metadata from the catalog', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(['node', 'upstreamfix', 'list']);
    const listing = output.mock.calls.map(([message]) => String(message)).join('\n');
    expect(listing).toContain('firebase-admin@14');
    expect(listing).toContain('13 → 14');
    expect(listing).toContain('2026-06-08');
    expect(listing).toContain('stripe@22');
    expect(listing).toContain('stripe@23');
    expect(listing).toContain('openai@5');
    expect(listing).toContain('experimental');
  });

  it('P3.4 requires --experimental for an explicit OpenAI migration', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-cli-'));
    temporaryDirectories.push(cwd);
    await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'openai@5', '--cwd', cwd])).rejects.toThrow('experimental');
  });

  it('prints top-level help and exits successfully', async () => {
    await execFile(process.execPath, ['--import', 'tsx', path.join(projectRoot, 'src/cli.ts'), '--help'], {
      cwd: projectRoot,
      timeout: 10_000,
    });
  });

  it.skipIf(!subprocessAvailable)('runs the compiled CLI through a bin symlink and prints its version (requires subprocess support)', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-bin-link-'));
    temporaryDirectories.push(cwd);
    const bin = path.join(cwd, 'upstreamfix');
    await symlink(path.join(projectRoot, 'dist', 'cli.js'), bin);
    const help = spawnSync(process.execPath, [bin, '--help'], { cwd, encoding: 'utf8', timeout: 10_000 });
    expect(help.error).toBeUndefined();
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: upstreamfix');
    const version = spawnSync(process.execPath, [bin, '--version'], { cwd, encoding: 'utf8', timeout: 10_000 });
    expect(version.error).toBeUndefined();
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('0.1.3');
  });

  it('scans only migrations matching dependencies in the project', async () => {
    const cwd = await makeProject('^14.0.0');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(['node', 'upstreamfix', 'scan', '--cwd', cwd]);
    expect(output.mock.calls.map(([message]) => String(message)).join('\n'))
      .toContain('No supported migration applies');
  });

  it('detects applicable migrations in nested package manifests', async () => {
    const cwd = await makeProject('^14.0.0');
    const nested = path.join(cwd, 'functions');
    await mkdir(nested);
    await writeFile(path.join(nested, 'package.json'), JSON.stringify({ dependencies: { 'firebase-admin': '^13.0.0' } }));
    await writeFile(path.join(nested, 'index.js'), "const admin = require('firebase-admin');\nadmin.firestore();\n");
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'upstreamfix', 'scan', '--cwd', cwd]);

    expect(output.mock.calls.map(([message]) => String(message)).join('\n')).toContain('--- a/functions/index.js');
  });

  it('does not expose the experimental cross-language FCM migration', async () => {
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin-fcm-topics', '--cwd', '/tmp']))
      .rejects.toThrow('Unknown migration');
  });

  it('detects the next Stripe migration from the declared source major', async () => {
    const cwd = await makeProject('^13.0.0');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { stripe: '^21.0.0' } }));
    await writeFile(path.join(cwd, 'stripe-client.ts'), "import Stripe from 'stripe';\nexport const stripe = Stripe(process.env.STRIPE_KEY!);\n");
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'upstreamfix', 'scan', '--cwd', cwd]);

    expect(output.mock.calls.map(([message]) => String(message)).join('\n')).toContain('stripe v21 → v22');
    expect(output.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain('stripe v22 → v23');
  });

  it('documents the verified branch write in command help', () => {
    const migrate = createProgram().commands.find((command) => command.name() === 'migrate');
    expect(migrate?.helpInformation()).toContain('apply verified changes in a new Git branch');
    expect(migrate?.helpInformation()).toContain('--verify');
    expect(migrate?.helpInformation()).toContain('--verify-timeout <seconds>');
    expect(migrate?.helpInformation()).toContain('--node-runtime <major>');
  });

  it('exposes a bounded timeout for probe commands', () => {
    const probe = createProgram().commands.find((command) => command.name() === 'probe');
    expect(probe?.helpInformation()).toContain('--timeout <seconds>');
  });

  it('previews a confirmed Node.js 22 declaration and rejects other majors', async () => {
    const cwd = await makeProject();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd, '--node-runtime', '22']);
    expect(output.mock.calls.map(([message]) => String(message)).join('\n')).toContain('"engines": { "node": ">=22" }');
    expect(JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')).engines).toBeUndefined();
    await expect(createProgram().parseAsync(['node', 'upstreamfix', 'migrate', 'firebase-admin@14', '--cwd', cwd, '--node-runtime', '20']))
      .rejects.toThrow('--node-runtime 22 applies to firebase-admin@14');
  });
});
