import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WatchEvent { package: string; from: string; to: string }
export interface WatchState { versions: Record<string, string>; events: WatchEvent[] }

function exactVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

export async function readBoundedJson(url: string, maxBytes = 2 * 1024 * 1024, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Registry request failed (${response.status}) for ${url}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error(`Registry response exceeds ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function npmLatestVersion(packageName: string, fetcher: typeof fetch = fetch): Promise<string> {
  const data = await readBoundedJson(`https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`, undefined, fetcher) as Record<string, unknown>;
  if (!exactVersion(data.latest)) throw new Error(`Registry returned an invalid latest version for ${packageName}.`);
  return data.latest;
}

export async function watchPackages(
  statePath: string,
  packages: readonly string[],
  lookup: (packageName: string) => Promise<string> = npmLatestVersion,
): Promise<WatchState> {
  const previous: WatchState = await readFile(statePath, 'utf8')
    .then((contents) => JSON.parse(contents) as WatchState, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return { versions: {}, events: [] };
      throw error;
    });
  if (!previous.versions || typeof previous.versions !== 'object' || !Array.isArray(previous.events)) throw new Error('Invalid watch state file.');
  const versions = { ...previous.versions };
  const events: WatchEvent[] = [];
  for (const packageName of [...new Set(packages)]) {
    const latest = await lookup(packageName);
    if (!exactVersion(latest)) throw new Error(`Invalid version for ${packageName}.`);
    const old = versions[packageName];
    if (old && Number(latest.split('.')[0]) > Number(old.split('.')[0])) events.push({ package: packageName, from: old, to: latest });
    versions[packageName] = latest;
  }
  const next: WatchState = { versions, events };
  const absolute = path.resolve(statePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}
