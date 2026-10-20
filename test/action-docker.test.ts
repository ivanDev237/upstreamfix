import { expect, it } from 'vitest';
import { buildClientDockerArgs } from '../src/action/docker-execute.js';

it('grants network only through an explicit install flag for npm, pnpm and Yarn', () => {
  const cwd = '/tmp/upstreamfix-verify-test/project';
  const env = { HOME: '/tmp/upstreamfix-verify-test/home', TMPDIR: '/home/user/private', NPM_CONFIG_CACHE: '/tmp/upstreamfix-verify-test/home/npm-cache' };
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const testArgs = buildClientDockerArgs(manager, ['run', 'test'], cwd, env, false, 'test-container');
    expect(testArgs.slice(testArgs.indexOf('--network') + 1)[0]).toBe('none');
    expect(testArgs.join(' ')).not.toContain('/home/user/private');
    const installArgs = buildClientDockerArgs(manager, ['install'], cwd, env, true, 'test-container');
    expect(installArgs).toContain('--pull=never');
    expect(installArgs.slice(installArgs.indexOf('--network') + 1)[0]).toBe('bridge');
    if (manager !== 'npm') expect(installArgs).toContain('corepack');
  }
  const misleading = buildClientDockerArgs('npm', ['install'], cwd, env, false, 'test-container');
  expect(misleading[misleading.indexOf('--network') + 1]).toBe('none');
});

it('W1 mounts only the project and isolated client home, never the host Docker configuration root', () => {
  const root = '/tmp/upstreamfix-verify-test';
  const args = buildClientDockerArgs('node', ['-e', 'process.exit(0)'], `${root}/project`, { HOME: `${root}/home` }, false, 'test-container');
  const text = args.join(' ');
  expect(text).toContain(`${root}/project`);
  expect(text).toContain(`${root}/home`);
  expect(text).not.toContain(`source=${root},target=${root}`);
  expect(text).not.toContain(`${root}:${root}`);
});
