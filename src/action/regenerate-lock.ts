import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const npmRegistry = 'registry.npmjs.org';

/** Regenerate from reviewed manifests, with no client source, npm config, tokens, or lifecycle scripts. */
export async function regenerateNpmLockfile(beforeLock: string, afterManifest: string, filename: 'package-lock.json' | 'npm-shrinkwrap.json'): Promise<string> {
  const original = JSON.parse(beforeLock) as { lockfileVersion?: unknown };
  if (original.lockfileVersion !== 2 && original.lockfileVersion !== 3) throw new Error('Only npm v2 and v3 lockfiles can be regenerated.');
  if (beforeLock.length > 8 * 1024 * 1024 || afterManifest.length > 2 * 1024 * 1024) throw new Error('Lockfile regeneration input exceeds its size limit.');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-publish-lock-'));
  const proxy = createServer((_request, response) => { response.writeHead(403).end(); });
  const sockets = new Set<Duplex>();
  proxy.on('connect', (request, client, head) => {
    if (request.url !== `${npmRegistry}:443` || head.length) { client.destroy(); return; }
    const upstream = connect(443, npmRegistry);
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  try {
    await writeFile(path.join(temporaryRoot, 'package.json'), afterManifest);
    await writeFile(path.join(temporaryRoot, filename), beforeLock);
    await writeFile(path.join(temporaryRoot, 'user.npmrc'), '');
    await writeFile(path.join(temporaryRoot, 'global.npmrc'), '');
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Could not start the restricted npm registry proxy.');
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: temporaryRoot,
      npm_config_userconfig: path.join(temporaryRoot, 'user.npmrc'),
      npm_config_globalconfig: path.join(temporaryRoot, 'global.npmrc'),
      npm_config_cache: path.join(temporaryRoot, 'cache'),
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_proxy: proxyUrl,
      npm_config_https_proxy: proxyUrl,
      npm_config_noproxy: '',
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: '',
    };
    try {
      await execFile('npm', [
        'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
        `--lockfile-version=${original.lockfileVersion}`, `--registry=https://${npmRegistry}/`,
      ], { cwd: temporaryRoot, env, timeout: 180_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(`Independent npm lockfile regeneration failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unknown error'}`);
    }
    const regenerated = await readFile(path.join(temporaryRoot, filename), 'utf8');
    if (regenerated.length > 8 * 1024 * 1024) throw new Error('Regenerated lockfile exceeds its size limit.');
    return regenerated;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
