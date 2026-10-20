import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeClientCommand } from '../dist/action/docker-execute.js';
import { sanitizedEnvironment } from '../dist/core/verify.js';

for (const [manager, version] of [['npm', ''], ['pnpm', '10.0.0'], ['yarn', '1.22.22']]) {
  const root = await mkdtemp(path.join(os.tmpdir(), `upstreamfix-${manager}-smoke-`));
  try {
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    await mkdir(project);
    await mkdir(home);
    await writeFile(path.join(home, 'npmrc.user'), '');
    await writeFile(path.join(home, 'npmrc.global'), '');
    await writeFile(path.join(project, 'package.json'), JSON.stringify({
      name: `upstreamfix-${manager}-smoke`, version: '1.0.0', private: true,
      ...(version ? { packageManager: `${manager}@${version}` } : {}),
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const env = sanitizedEnvironment(home);
    await executeClientCommand(manager, ['install', '--ignore-scripts'], project, env, 120_000, true);
    await executeClientCommand(manager, ['run', 'test'], project, env, 30_000, false);
    console.log(`${manager}: install and network-disabled test passed`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// A client container must not be able to place a configuration file where the
// host Docker CLI reads it on the next invocation.
const trapRoot = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-docker-config-smoke-'));
try {
  const project = path.join(trapRoot, 'project');
  const home = path.join(trapRoot, 'home');
  await mkdir(project);
  await mkdir(home);
  const attempt = await executeClientCommand('node', ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const target = path.join(path.dirname(process.env.HOME), '.docker', 'config.json');
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{invalid'); console.log('wrote'); }
    catch { console.log('blocked'); }
  `], project, sanitizedEnvironment(home), 30_000, false);
  if (!attempt.stdout.includes('blocked')) throw new Error('Client container wrote to the host Docker configuration directory.');
  if (await access(path.join(trapRoot, '.docker', 'config.json')).then(() => true, () => false)) {
    throw new Error('Host Docker configuration was modified by client code.');
  }
  await executeClientCommand('node', ['-e', 'process.exit(0)'], project, sanitizedEnvironment(home), 30_000, false);
  console.log('Host Docker configuration remains outside client mounts');
} finally { await rm(trapRoot, { recursive: true, force: true }); }
