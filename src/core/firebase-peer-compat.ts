import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManualItem, PackageManifest } from './types.js';
import { parseManifest } from './manifest.js';

interface PublishedVersion { peerDependencies?: Record<string, string> }
export type FirebasePeerRegistry = (name: string) => Promise<Record<string, PublishedVersion>>;

/** Only package metadata is read. No package archive or project script is executed. */
export const npmPeerRegistry: FirebasePeerRegistry = async (name) => {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Unsafe npm package name.');
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 8 * 1024 * 1024)
    throw new Error(`npm registry metadata unavailable for ${name}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`npm registry metadata has no body for ${name}.`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error(`npm registry metadata too large for ${name}.`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.versions)) throw new Error(`npm registry metadata invalid for ${name}.`);
  return parsed.versions as Record<string, PublishedVersion>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Conservative peer-range intersection with firebase-admin ^14. Unknown syntax is never called incompatible. */
export function allowsFirebaseAdmin14(range: string): boolean | undefined {
  const samples = [[14, 0, 0], [14, 2, 0], [14, 999, 999]];
  let unknown = false;
  for (const alternative of range.split('||')) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) { unknown = true; continue; }
    const predicates: Array<(version: number[]) => boolean> = [];
    for (const token of tokens) {
      if (token === '*') { predicates.push(() => true); continue; }
      const match = /^(\^|~|>=|<=|>|<|=)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(token);
      if (!match) { unknown = true; predicates.length = 0; break; }
      const operator = match[1] ?? '=';
      const major = Number(match[2]);
      const minor = match[3] && /^\d+$/.test(match[3]) ? Number(match[3]) : 0;
      const patch = match[4] && /^\d+$/.test(match[4]) ? Number(match[4]) : 0;
      const base = [major, minor, patch];
      if (major === 14) samples.push(base, [major, minor, patch + 1]);
      if (operator === '^') predicates.push((version) => compareVersion(version, base) >= 0 && version[0] === major);
      else if (operator === '~') predicates.push((version) => compareVersion(version, base) >= 0 && version[0] === major && version[1] === minor);
      else if (operator === '>=') predicates.push((version) => compareVersion(version, base) >= 0);
      else if (operator === '>') predicates.push((version) => compareVersion(version, base) > 0);
      else if (operator === '<=') predicates.push((version) => compareVersion(version, base) <= 0);
      else if (operator === '<') predicates.push((version) => compareVersion(version, base) < 0);
      else if (match[3] === undefined || /^(?:x|\*)$/.test(match[3])) predicates.push((version) => version[0] === major);
      else if (match[4] === undefined || /^(?:x|\*)$/.test(match[4])) predicates.push((version) => version[0] === major && version[1] === minor);
      else predicates.push((version) => compareVersion(version, base) === 0);
    }
    if (predicates.length && samples.some((version) => predicates.every((predicate) => predicate(version)))) return true;
  }
  return unknown ? undefined : false;
}

function declared(manifest: PackageManifest, name: string): Array<{ section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'; range: string }> {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
  return sections.flatMap((section) => typeof manifest[section]?.[name] === 'string'
    ? [{ section, range: manifest[section]![name]! }] : []);
}

export interface PeerResolution { manual: ManualItem[]; upgrades: Map<string, string>; notes: string[] }

/** Inspect direct dependencies whose locked peer excludes v14, plus the two known Firebase companions. */
export async function resolveFirebasePeers(manifestPath: string, registry: FirebasePeerRegistry = npmPeerRegistry,
  projectRoot = path.dirname(manifestPath)): Promise<PeerResolution> {
  const manual: ManualItem[] = [];
  const upgrades = new Map<string, string>();
  const notes: string[] = [];
  const manifest = parseManifest<PackageManifest>(await readFile(manifestPath, 'utf8'));
  const direct = new Set(['firebase-functions', 'firebase-functions-test'].filter((name) => declared(manifest, name).length));
  const installedPeer = new Map<string, string>();
  let lockPath = path.join(path.dirname(manifestPath), 'package-lock.json');
  let search = path.dirname(manifestPath);
  while (search !== projectRoot && search.startsWith(`${projectRoot}${path.sep}`)) {
    try {
      const info = await lstat(lockPath);
      if (info.isFile() && !info.isSymbolicLink()) break;
    } catch { /* Search the parent workspace. */ }
    search = path.dirname(search);
    lockPath = path.join(search, 'package-lock.json');
  }
  try {
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.size > 8 * 1024 * 1024)
      throw new Error('Unsafe or oversized lockfile.');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { packages?: Record<string, PublishedVersion> };
    const ownerDir = path.relative(path.dirname(lockPath), path.dirname(manifestPath)).replaceAll('\\', '/');
    for (const [name, entry] of Object.entries(lock.packages ?? {})) {
      const peer = entry.peerDependencies?.['firebase-admin'];
      if (!peer || allowsFirebaseAdmin14(peer) !== false) continue;
      const packageName = name.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
      if (packageName && declared(manifest, packageName).length &&
        (name === `node_modules/${packageName}` || name === `${ownerDir}/node_modules/${packageName}`)) {
        direct.add(packageName);
        installedPeer.set(packageName, peer);
      }
    }
  } catch { /* No usable npm lockfile: inspect the known direct Firebase companions only. */ }
  for (const name of direct) {
    let versions: Record<string, PublishedVersion>;
    try { versions = await registry(name); }
    catch {
      manual.push({ file: manifestPath, line: 1, reason: `Could not confirm published ${name} peer compatibility with firebase-admin 14; review this dependency before verification.`,
        snippet: name, reasonCode: 'manifest-refusal' });
      continue;
    }
    const published = Object.entries(versions).filter(([version]) => /^\d+\.\d+\.\d+$/.test(version));
    if (published.length === 0) {
      manual.push({ file: manifestPath, line: 1, reason: `No published ${name} versions could be checked for firebase-admin 14 compatibility.`,
        snippet: name, reasonCode: 'manifest-refusal' });
      continue;
    }
    const declarations = declared(manifest, name);
    const floorMatch = /^\s*[~^]?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(declarations[0]?.range ?? '');
    const floor = floorMatch ? [Number(floorMatch[1]), Number(floorMatch[2] ?? 0), Number(floorMatch[3] ?? 0)] : undefined;
    const declaredMajor = floor?.[0];
    // Older releases cannot repair a current dependency. A missing peer range is
    // not proof of v14 support; only an explicit compatible peer is sufficient.
    const eligible = floor ? published.filter(([version]) => compareVersion(version.split('.').map(Number), floor) >= 0) : published;
    const compatible = eligible.filter(([, version]) => {
      const peer = version.peerDependencies?.['firebase-admin'];
      return peer !== undefined && allowsFirebaseAdmin14(peer) === true;
    });
    const uncertain = eligible.some(([, version]) => {
      const peer = version.peerDependencies?.['firebase-admin'];
      return peer === undefined || allowsFirebaseAdmin14(peer) === undefined;
    });
    const declaredPublished = declaredMajor
      ? eligible.filter(([version]) => version.startsWith(`${declaredMajor}.`)) : [];
    const currentBlocked = allowsFirebaseAdmin14(installedPeer.get(name) ?? '') === false ||
      (declaredPublished.length > 0 && declaredPublished.every(([, version]) =>
        version.peerDependencies?.['firebase-admin'] !== undefined &&
        allowsFirebaseAdmin14(version.peerDependencies['firebase-admin']) === false));
    if (!currentBlocked) continue;
    if (compatible.length === 0 && !uncertain) {
      manual.push({ file: manifestPath, line: 1,
        reason: `Blocked by ${name}: no published version accepts firebase-admin 14. Review or remove this dependency before upgrading.${name === 'firebase-functions-test' ? ' Support was merged in https://github.com/firebase/firebase-functions-test/pull/336; track https://github.com/firebase/firebase-functions-test/issues/347 for a release.' : ''}`,
        snippet: name, reasonCode: 'manifest-refusal' });
      continue;
    }
    if (uncertain && compatible.length === 0) {
      manual.push({ file: manifestPath, line: 1,
        reason: `${name} has a newer release whose firebase-admin 14 compatibility could not be safely confirmed; review its peer dependency before upgrading.`,
        snippet: name, reasonCode: 'manifest-refusal' });
      continue;
    }
    const safeOldFunctionsRange = /^\s*[~^]?(?:[0-6](?:\.\d+){0,2}|7\.[0-2](?:\.\d+)?)\s*$/.test(declarations[0]?.range ?? '');
    if (name === 'firebase-functions' && declarations.length === 1 && safeOldFunctionsRange &&
      versions['7.3.0'] && versions['7.3.0'].peerDependencies?.['firebase-admin'] !== undefined &&
      allowsFirebaseAdmin14(versions['7.3.0'].peerDependencies['firebase-admin']) === true &&
      !/^[~^]?7\.(?:[3-9]|\d{2,})\./.test(declarations[0]!.range)) {
      upgrades.set(name, '^7.3.0');
      notes.push(`firebase-functions ${declarations[0]!.range} → ^7.3.0: published v7.3.0 accepts firebase-admin 14.`);
    } else if (compatible.length > 0) {
      manual.push({ file: manifestPath, line: 1,
        reason: `${name} excludes firebase-admin 14 in the current range; a compatible published version exists, but its upgrade is not mapped automatically.`,
        snippet: name, reasonCode: 'manifest-refusal' });
    }
  }
  return { manual, upgrades, notes };
}
