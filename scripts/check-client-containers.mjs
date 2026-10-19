import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
