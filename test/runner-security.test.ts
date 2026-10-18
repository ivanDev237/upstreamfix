import { afterEach, describe, expect, it } from 'vitest';
import { hasUnsafeDependencySpecs, lockfileCommandEnvironment } from '../src/core/runner.js';

describe('lockfile updater isolation', () => {
  afterEach(() => {
    delete process.env.NPM_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.npm_execpath;
  });

  it('accepts registry semver and tags while rejecting alternate dependency sources and overrides', () => {
    expect(hasUnsafeDependencySpecs({ dependencies: { a: '^1.2.3', b: 'latest', c: '>=2.0.0 <3.0.0' } })).toBe(false);
    for (const manifest of [
      { dependencies: { a: 'owner/repo' } },
      { dependencies: { a: 'git+ssh://git@example.com/repo.git' } },
      { dependencies: { a: 'file:../local' } },
      { dependencies: { a: 'npm:other-package@^1.0.0' } },
      { overrides: { a: 'github:user/repo' } },
      { resolutions: { a: 'https://example.invalid/package.tgz' } },
      { pnpm: { overrides: { a: 'workspace:*' } } },
    ]) expect(hasUnsafeDependencySpecs(manifest)).toBe(true);
  });

  it('passes only allowlisted environment values and uses the per-run home for all npm state', () => {
    process.env.NPM_TOKEN = 'must-not-leak';
    process.env.GITHUB_TOKEN = 'must-not-leak-either';
    process.env.npm_execpath = '/tmp/attacker/npm-cli.js';
    const home = '/tmp/upstreamfix-one-run';
    const env = lockfileCommandEnvironment(home);

    expect(env.HOME).toBe(home);
    expect(env.NPM_CONFIG_USERCONFIG).toBe(`${home}/upstreamfix-empty-user.npmrc`);
    expect(env.NPM_CONFIG_GLOBALCONFIG).toBe(`${home}/upstreamfix-empty-global.npmrc`);
    expect(env.NPM_CONFIG_CACHE).toBe(`${home}/npm-cache`);
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.npm_execpath).toBeUndefined();
  });
});
