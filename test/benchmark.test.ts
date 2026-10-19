import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { assertPinnedCommitIsBranchAncestor, benchmarkOne, buildBenchmarkInstallDockerArgs, containerEnvArgs, installArgs, parseBenchmarkArgs, prepareBenchmarkCache, readBenchmarkRepos, renderBenchmarkReport, resolveBenchmarkConfig, resolveDockerLimits, validatePackageManagerField, validatePatchPaths, validateRepoEntry } from '../scripts/benchmark.js';

const execFile = promisify(execFileCallback);

describe('public repository benchmark helpers', () => {
  it('reports the automatic rate using migration changes and manual items', () => {
    const report = renderBenchmarkReport([
      { name: 'sample', commit: 'a'.repeat(40), status: 'completed', usages: 3, migrated: 2, manual: 1, typecheck: { before: 'pass', after: 'fail: TS error' }, tests: { before: 'fail: existing test', after: 'pass' }, details: '' },
    ]);

    expect(report).toContain('66.7%');
    expect(report).toContain('2 of 3 detected migration items');
    expect(report).toContain('| sample | `aaaaaaaaaaaa` | completed | 3 | 2 | 1 | pass | fail: TS error | fail: existing test | pass |  |');
  });

  it('escapes hostile test output before writing a public Markdown table', () => {
    const report = renderBenchmarkReport([{
      name: 'sample', commit: 'a'.repeat(40), status: 'failed', usages: 0, migrated: 0, manual: 0,
      typecheck: { before: 'pass', after: 'fail: </td>\n| forged | row | \u001b[31m' },
      tests: { before: 'pass', after: 'fail: `code` [link](javascript:alert(1))' },
      details: '<script>alert(1)</script>',
    }]);
    expect(report).not.toContain('</td>');
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('\u001b');
    expect(report).not.toContain('\n| forged | row |');
    expect(report).toContain('&lt;script&gt;');
    expect(report).toContain('&#124; forged &#124; row &#124;');
  });

  it('rejects repositories that have not been reviewed', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: false, reviewNote: '',
    })).toThrow('must be reviewed');
  });

  it('rejects a commit that is not a full SHA', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'deadbeef',
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed package scripts and project scope.',
    })).toThrow('40-character SHA');
  });

  it('rejects secret-shaped values under any benchmark environment variable and unsafe package paths', () => {
    const base = {
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm' as const, reviewed: true, reviewNote: 'Reviewed repository scope and package scripts.',
    };
    expect(() => validateRepoEntry({ ...base, env: { RANDOM_VALUE: 'whsec_live_12345678901234567890' } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, env: { SOME_KEY: '-----BEGIN PRIVATE KEY-----' } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, env: { CUSTOM_NAME: 'a'.repeat(40) } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, packageManagerPaths: { '../../outside': 'npm' } }))
      .toThrow('relative paths inside the checkout');
  });

  it('rejects repository URLs outside public GitHub HTTPS', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://evil.example/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed package scripts and project scope.',
    })).toThrow('GitHub HTTPS');
  });

  it('rejects an unknown migration before reading repositories or cloning anything', () => {
    expect(() => resolveBenchmarkConfig({ migrationId: 'stripe@99' }, '/tmp/upstreamfix-test'))
      .toThrow('Unknown migration "stripe@99"');
  });

  it('reports a clear error when the selected repository manifest is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-manifest-test-'));
    try {
      await expect(readBenchmarkRepos(path.join(root, 'missing.json')))
        .rejects.toThrow('Benchmark repository manifest not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('chooses a migration-specific default report path for Stripe', () => {
    const config = resolveBenchmarkConfig({ migrationId: 'stripe@22' }, '/tmp/upstreamfix-test');
    expect(config.reportPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-22-results.md');
    expect(config.reposPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-22-repos.json');
  });

  it('passes configured dummy credentials as container environment variables', () => {
    expect(containerEnvArgs({ STRIPE_SECRET_KEY: 'sk_test_fake' }))
      .toEqual(['--env', 'STRIPE_SECRET_KEY=sk_test_fake']);
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed repository scope and test commands.',
      env: { STRIPE_SECRET_KEY: 'sk_live_do_not_use' },
    })).toThrow('resembles a real secret');
  });

  it('rejects unsafe project packageManager values and disables Corepack custom URLs', () => {
    expect(() => validatePackageManagerField('yarn@https://attacker.invalid/yarn.tgz', 'package.json')).toThrow('unsafe packageManager');
    expect(() => validatePackageManagerField({ name: 'npm' }, 'package.json')).toThrow('unsafe packageManager');
    expect(validatePackageManagerField('pnpm@9.15.0', 'package.json')).toBeUndefined();
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout', 'yarn', ['install'], '/tmp/cache/yarn', { memoryMb: 1024, tempMb: 128 });
    expect(args).toContain('COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0');
  });

  it('loads the reviewed Stripe corpus as eight v22 repositories and four v23 repositories', async () => {
    const stripe22 = await readBenchmarkRepos(path.resolve('benchmark/stripe-22-repos.json'));
    const stripe23 = await readBenchmarkRepos(path.resolve('benchmark/stripe-23-repos.json'));

    expect(stripe22).toHaveLength(8);
    expect(stripe23).toHaveLength(4);
    for (const repo of [...stripe22, ...stripe23]) validateRepoEntry(repo);
    expect(stripe22.find((repo) => repo.name === 'libera-donations')?.env?.STRIPE_SECRET_KEY).toBe('sk_test_fake');
    expect(stripe23.find((repo) => repo.name === 'signet')?.env?.STRIPE_SECRET_KEY).toBe('sk_test_fake');
  });

  it('selects an install command for each supported package manager', () => {
    expect(installArgs('npm', 'baseline')[0]).toBe('npm');
    expect(installArgs('pnpm', 'baseline')[0]).toBe('pnpm');
    expect(installArgs('yarn', 'baseline')[0]).toBe('yarn');
    expect(installArgs('yarn', 'baseline')[1]).toContain('--ignore-scripts');
    expect(installArgs('yarn', 'baseline', 'berry')[1]).toContain('--mode=skip-builds');
    expect(installArgs('npm', 'baseline')[1][0]).toBe('ci');
    expect(installArgs('npm', 'post-migration')[1][0]).toBe('install');
    expect(installArgs('npm', 'baseline')[1]).toContain('--prefer-offline');
    expect(installArgs('pnpm', 'baseline')[1]).toContain('/cache/pnpm');
  });

  it('uses a persistent install cache and caps RAM and swap equally', () => {
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout', 'npm', ['ci'], '/tmp/cache/npm', { memoryMb: 768, tempMb: 128 });
    expect(args).toContain('type=bind,source=/tmp/cache/npm,target=/cache');
    expect(args).toContain('NPM_CONFIG_CACHE=/cache/npm');
    expect(args).toContain('--memory=768m');
    expect(args).toContain('--memory-swap=768m');
    expect(args.join(' ')).not.toContain('size=512m');
    expect(resolveDockerLimits(2048, 2 * 1024 ** 3).memoryMb).toBeLessThan(2048);
    expect(() => resolveDockerLimits(undefined, 1024 ** 3)).toThrow('RAM is free');
  });

  it('keeps cache paths local and rejects a symlinked cache directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-cache-test-'));
    try {
      const cache = path.join(root, 'cache');
      expect(await prepareBenchmarkCache(cache, 'npm')).toBe(path.join(cache, 'npm'));
      expect(await prepareBenchmarkCache(cache, 'npm')).toBe(path.join(cache, 'npm'));
      const link = path.join(root, 'link');
      await symlink(cache, link);
      await expect(prepareBenchmarkCache(link, 'npm')).rejects.toThrow('symbolic link');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('selects a single repository without overwriting the full report', () => {
    const options = parseBenchmarkArgs(['--migration', 'stripe@23', '--only', 'signet', '--memory-mb', '1024']);
    const config = resolveBenchmarkConfig(options, '/tmp/upstreamfix-test');
    expect(config.only).toBe('signet');
    expect(config.memoryMb).toBe(1024);
    expect(config.reportPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-23-signet-results.md');
    expect(() => parseBenchmarkArgs(['--memory-mb', '99999'])).toThrow('--memory-mb');
  });

  it('runs benchmark installs inside a credential-free Docker container without exposing the Git directory', () => {
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout/functions', 'npm', ['ci', '--ignore-scripts'], '/tmp/cache/npm', { memoryMb: 1024, tempMb: 128 });
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--network=bridge');
    expect(args).toContain('--env');
    expect(args).toContain('type=bind,source=/tmp/checkout/.git,target=/workspace/.git,readonly');
    expect(args).toContain('/workspace/functions');
    expect(args.slice(args.indexOf('node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5') + 1))
      .toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(args.join(' ')).not.toContain('NPM_TOKEN');
  });

  it('accepts only pinned commits reachable from the reviewed upstream branch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-ancestry-test-'));
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    const checkout = path.join(root, 'checkout');
    const home = path.join(root, 'home');
    const git = async (cwd: string, ...args: string[]) => execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    try {
      await execFile('git', ['init', '--bare', '--initial-branch=main', origin]);
      await execFile('git', ['init', '--initial-branch=main', work]);
      await git(work, 'config', 'user.name', 'Fixture');
      await git(work, 'config', 'user.email', 'fixture@example.invalid');
      await git(work, 'remote', 'add', 'origin', origin);
      const fs = await import('node:fs/promises');
      await fs.writeFile(path.join(work, 'source.txt'), 'main 1\n');
      await git(work, 'add', 'source.txt');
      await git(work, 'commit', '-m', 'main 1');
      const pinnedMain = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
      await git(work, 'push', 'origin', 'main');
      await git(work, 'checkout', '-b', 'unmerged');
      await fs.writeFile(path.join(work, 'source.txt'), 'unmerged fork commit\n');
      await git(work, 'commit', '-am', 'unmerged fork commit');
      const forkCommit = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
      await git(work, 'checkout', 'main');
      await fs.writeFile(path.join(work, 'source.txt'), 'main 2\n');
      await git(work, 'commit', '-am', 'main 2');
      await git(work, 'push', 'origin', 'main');
      await git(work, 'push', 'origin', 'unmerged');
      await execFile('git', ['clone', '--depth=1', '--branch', 'main', `file://${origin}`, checkout]);

      await expect(assertPinnedCommitIsBranchAncestor(checkout, { name: 'fixture', branch: 'main', commit: pinnedMain }, home)).resolves.toBeUndefined();
      await expect(assertPinnedCommitIsBranchAncestor(checkout, { name: 'fixture', branch: 'main', commit: forkCommit }, home)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects migration patches that escape the temporary checkout', async () => {
    await expect(validatePatchPaths(['--- a/server.ts\n+++ b/../../outside.ts\n@@ -1 +1 @@\n-old\n+new']))
      .rejects.toThrow('unsafe patch path');
  });

  it('records a reviewed invalid baseline without cloning or installing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-test-'));
    try {
      const result = await benchmarkOne({
        name: 'fitpro', url: 'https://github.com/Qasim-016/Fitpro', branch: 'master', commit: 'a'.repeat(40),
        packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed the package manifest and installation failure.',
        invalidReason: 'The pinned package lock does not match package.json.',
      }, root, root);

      expect(result.status).toBe('invalid repository');
      expect(result.details).toContain('does not match');
      expect(result.usages).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
