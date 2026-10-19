import { execFile as callback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { probeProject } from '../src/core/probe.js';

const execFile = promisify(callback);

it('reports a precise new Stripe diagnostic while preserving the original lockfile', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-probe-test-'));
  try {
    const manifest = JSON.stringify({ dependencies: { stripe: '22.5.0' }, devDependencies: { typescript: '5.9.0' } });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/stripe': { version: '22.5.0' } } });
    await writeFile(path.join(cwd, 'package.json'), manifest);
    await writeFile(path.join(cwd, 'package-lock.json'), lock);
    await writeFile(path.join(cwd, 'tsconfig.json'), '{}');
    await writeFile(path.join(cwd, 'pay.ts'), 'const payment_method_types = true;');
    await execFile('git', ['init', '-q'], { cwd });
    await execFile('git', ['add', '.'], { cwd });
    let typechecks = 0;
    const signalHandlersBefore = process.listenerCount('SIGINT');
    const result = await probeProject(cwd, 'stripe@23.0.0', {
      confirmed: true,
      execute: async (phase, _command, args, _directory, env) => {
        expect(process.listenerCount('SIGINT')).toBeGreaterThan(signalHandlersBefore);
        expect(env.GITHUB_TOKEN).toBeUndefined();
        if (phase.endsWith('typecheck')) {
          expect(args).toContain('--network=none');
          typechecks++;
          return { code: 2, output: typechecks === 1
            ? 'src/pay.ts(2,1): error TS2322: preexisting'
            : 'src/pay.ts(20,1): error TS2322: preexisting\nsrc/pay.ts(243,5): error TS2561: payment_method_types does not exist in PaymentIntentCreateParams' };
        }
        return { code: 0, output: 'installed' };
      },
    });
    expect(result.status).toBe('available');
    expect(process.listenerCount('SIGINT')).toBe(signalHandlersBefore);
    expect(result.currentVersion).toBe('22.5.0');
    expect(result.newDiagnostics).toMatchObject([{ file: 'src/pay.ts', line: 243, code: 2561 }]);
    expect(result.preexisting).toHaveLength(1);
    expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(path.join(cwd, 'package-lock.json'), 'utf8')).toBe(lock);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('refuses non-exact targets and requires confirmation before downloads', async () => {
  await expect(probeProject('/tmp', 'stripe@^23')).rejects.toThrow('exact');
  const preview = await probeProject('/tmp', 'stripe@23.0.0');
  expect(preview.status).toBe('confirmation-required');
  expect(preview.estimatedDownload).toContain('MB');
});

it('marks failed installation or unreadable typecheck as unavailable', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-probe-test-'));
  try {
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { stripe: '22.5.0' } }));
    await writeFile(path.join(cwd, 'pay.ts'), 'const x = 1;');
    await execFile('git', ['init', '-q'], { cwd });
    await execFile('git', ['add', '.'], { cwd });
    const result = await probeProject(cwd, 'stripe@23.0.0', { confirmed: true, execute: async () => ({ code: 1, output: 'install failed' }) });
    expect(result.status).toBe('unavailable');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
