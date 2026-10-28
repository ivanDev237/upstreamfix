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

  it('accepts complete registry prerelease and build versions in ordinary ranges', () => {
    for (const spec of [
      '^1.4.5-lts.1', '^1.4.5-lts.2', '^5.0.0-beta.29', '^0.0.1-security',
      '1.0.0-rc.1 || ^2.0.0', '^1.2.3-rc.1+build.7',
      '~1.2.3-beta.1', '>=1.0.0-rc.1 <2.0.0+build.4', '1.0.0-rc.1 - 2.0.0',
    ]) expect(hasUnsafeDependencySpecs({ dependencies: { example: spec } }), spec).toBe(false);
    expect(hasUnsafeDependencySpecs({ overrides: { example: '^1.4.5-lts.1' } })).toBe(false);
  });

  it('still rejects alternate sources even when they contain a prerelease version', () => {
    for (const spec of [
      'npm:foo@1.0.0-beta', 'git+https://example.invalid/repo.git#v1.0.0-beta',
      'file:../x-1.0.0-beta', 'link:../x-1.0.0-beta', 'workspace:^1.0.0-beta',
      'patch:foo@1.0.0-beta', 'https://example.invalid/x-1.0.0-beta.tgz',
      '../x-1.0.0-beta', '1.0.0-rc..1', '1.0.0+build..1', '1.0.0-rc.1/../x',
    ]) expect(hasUnsafeDependencySpecs({ dependencies: { example: spec } }), spec).toBe(true);
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

  it('does not inherit a pnpm dlx launcher as the npm executable', () => {
    process.env.npm_execpath = '/opt/pnpm/bin/pnpm.cjs';
    const env = lockfileCommandEnvironment('/tmp/upstreamfix-pnpm-launch');
    expect(env.npm_execpath).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
