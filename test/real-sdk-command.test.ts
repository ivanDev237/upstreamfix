import { afterEach, expect, it } from 'vitest';
import { realSdkCommandOptions } from './helpers/real-sdk-command.js';

const oldToken = process.env.NPM_TOKEN;
const oldExecPath = process.env.npm_execpath;

afterEach(() => {
  if (oldToken === undefined) delete process.env.NPM_TOKEN;
  else process.env.NPM_TOKEN = oldToken;
  if (oldExecPath === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = oldExecPath;
});

it('keeps real SDK subprocesses away from npm_execpath and host credentials', () => {
  process.env.NPM_TOKEN = 'secret-test-value';
  process.env.npm_execpath = '/tmp/untrusted-cli.js';
  const options = realSdkCommandOptions('/tmp/sdk-fixture', 1000);
  expect(options.env?.NPM_TOKEN).toBeUndefined();
  expect(options.env?.npm_execpath).toBeUndefined();
  expect(options.env?.HOME).toContain('sdk-fixture');
  expect(options.env?.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
});
