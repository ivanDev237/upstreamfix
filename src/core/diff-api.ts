import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { readBoundedJson } from './watch.js';

const maxArchiveBytes = 15 * 1024 * 1024;
const maxUnpackedBytes = 40 * 1024 * 1024;

export interface ApiFinding { symbol: string; before?: string; after?: string; source: string }
export interface ApiReport {
  package: string;
  oldVersion: string;
  newVersion: string;
  removed: ApiFinding[];
  changed: ApiFinding[];
  added: ApiFinding[];
  renameHypotheses: Array<{ from: string; to: string; reason: string }>;
}

export function validateExactVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    throw new Error(`An exact npm version is required; received ${version}.`);
  }
}

function tarString(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('utf8').split('\0')[0]!.trim();
}

export function unpackDeclarationFiles(archive: Buffer, integrity?: string): Map<string, string> {
  if (archive.length > maxArchiveBytes) throw new Error('Package archive exceeds the size limit.');
  if (integrity) {
    const match = /^(sha512|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity);
    if (!match || createHash(match[1]!).update(archive).digest('base64') !== match[2]) throw new Error('Package archive integrity mismatch.');
  }
  const unpacked = gunzipSync(archive, { maxOutputLength: maxUnpackedBytes });
  const files = new Map<string, string>();
  let nextPath: string | undefined;
  for (let offset = 0; offset + 512 <= unpacked.length;) {
    const header = unpacked.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const headerName = [tarString(header, 345, 155), tarString(header, 0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(tarString(header, 124, 12), 8);
    const kind = tarString(header, 156, 1) || '0';
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > unpacked.length) throw new Error('Invalid package archive entry size.');
    const body = unpacked.subarray(offset + 512, offset + 512 + size);
    if (kind === 'L') {
      nextPath = body.toString('utf8').split('\0')[0];
    } else if (kind === 'x') {
      const records = body.toString('utf8');
      const pathRecord = /(?:^|\n)\d+ path=([^\n]+)/.exec(records);
      if (pathRecord) nextPath = pathRecord[1];
    } else {
      const name = nextPath ?? headerName;
      nextPath = undefined;
      const parts = name.split('/');
      if (parts.some((part) => part === '..' || part === '.') || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) {
        throw new Error(`Package archive has an unsafe path: ${name}`);
      }
      if (!['0', '5'].includes(kind)) throw new Error(`Package archive contains an unsupported link or entry: ${name}`);
      const relative = name.startsWith('package/') ? name.slice('package/'.length) : name;
      if (kind === '0' && (/\.d\.(?:ts|mts|cts)$/.test(relative) || relative === 'package.json')) {
        files.set(relative, body.toString('utf8'));
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has('package.json')) throw new Error('Package archive has no package.json.');
  return files;
}

function declaredEntries(files: Map<string, string>): string[] {
  const manifest = JSON.parse(files.get('package.json')!) as Record<string, unknown>;
  const candidates = new Set<string>();
  if (typeof manifest.types === 'string') candidates.add(manifest.types);
  if (typeof manifest.typings === 'string') candidates.add(manifest.typings);
  if (typeof manifest.main === 'string') candidates.add(manifest.main);
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'types' && typeof item === 'string') candidates.add(item);
      else visit(item);
    }
  }
  visit(manifest.exports);
  visit(manifest.typesVersions);
  if (candidates.size === 0 && files.has('index.d.ts')) candidates.add('index.d.ts');
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const entry = path.posix.normalize(candidate.replace(/^\.\//, ''));
    if (entry.startsWith('../') || path.posix.isAbsolute(entry)) continue;
    for (const form of [entry, `${entry}.d.ts`, `${entry}.d.mts`, `${entry}.d.cts`, path.posix.join(entry, 'index.d.ts'), entry.replace(/\.[cm]?js$/, '.d.ts')]) {
      if (files.has(form)) resolved.add(form);
    }
  }
  return [...resolved];
}

function declarations(files: Map<string, string>): Map<string, ApiFinding> {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { noResolve: false } });
  for (const [name, content] of files) {
    if (/\.d\.(?:ts|mts|cts)$/.test(name)) project.createSourceFile(`/package/${name}`, content, { overwrite: true });
  }
  const symbols = new Map<string, ApiFinding>();
  for (const entry of declaredEntries(files)) {
    const source = project.getSourceFile(`/package/${entry}`);
    if (!source) continue;
    const prefix = entry === 'index.d.ts' ? '' : `${entry}:`;
    const collect = (declarations: ReturnType<typeof source.getExportedDeclarations>, scope: string): void => {
      for (const [name, nodes] of declarations) {
        if (nodes.length === 0) continue;
        const key = `${scope}${name}`;
        symbols.set(key, { symbol: key, after: nodes.map((node) => node.getText().replace(/\s+/g, ' ').trim()).join(' | '), source: entry });
        const members = new Map<string, string[]>();
        for (const node of nodes) {
          if (!Node.isInterfaceDeclaration(node) && !Node.isClassDeclaration(node)) continue;
          for (const member of node.getMembers()) {
            const memberName = (member as typeof member & { getName?: () => string }).getName?.();
            if (!memberName) continue;
            members.set(memberName, [...(members.get(memberName) ?? []), member.getText().replace(/\s+/g, ' ').trim()]);
          }
        }
        for (const [memberName, texts] of members) {
          const memberKey = `${key}.${memberName}`;
          symbols.set(memberKey, { symbol: memberKey, after: texts.join(' | '), source: entry });
        }
      }
    };
    collect(source.getExportedDeclarations(), prefix);
    for (const module of source.getDescendantsOfKind(SyntaxKind.ModuleDeclaration)) {
      collect(module.getExportedDeclarations(), `${prefix}${module.getName()}.`);
    }
  }
  return symbols;
}

export function compareApiFromTarballs(packageName: string, oldVersion: string, newVersion: string, oldArchive: Buffer, newArchive: Buffer, oldIntegrity?: string, newIntegrity?: string): ApiReport {
  const before = declarations(unpackDeclarationFiles(oldArchive, oldIntegrity));
  const after = declarations(unpackDeclarationFiles(newArchive, newIntegrity));
  if (before.size === 0 || after.size === 0) throw new Error('No exported type symbols were resolved from one or both package archives; the API comparison is incomplete.');
  const removed: ApiFinding[] = [];
  const changed: ApiFinding[] = [];
  const added: ApiFinding[] = [];
  for (const [symbol, previous] of before) {
    const current = after.get(symbol);
    if (!current) removed.push({ ...previous, before: previous.after, after: undefined });
    else if (previous.after !== current.after) changed.push({ symbol, before: previous.after, after: current.after, source: current.source });
  }
  for (const [symbol, current] of after) if (!before.has(symbol)) added.push(current);
  const normalize = (finding: ApiFinding, declaration: string | undefined): string =>
    declaration?.replace(finding.symbol.split('.').at(-1)!, '') ?? '';
  const addedByText = new Map<string, ApiFinding[]>();
  for (const candidate of added) {
    const key = normalize(candidate, candidate.after);
    addedByText.set(key, [...(addedByText.get(key) ?? []), candidate]);
  }
  const renameHypotheses: ApiReport['renameHypotheses'] = [];
  for (const old of removed) {
    for (const candidate of addedByText.get(normalize(old, old.before)) ?? []) {
      renameHypotheses.push({ from: old.symbol, to: candidate.symbol, reason: 'Similar declaration text; hypothesis only, verify against vendor guidance.' });
      if (renameHypotheses.length >= 1000) break;
    }
    if (renameHypotheses.length >= 1000) break;
  }
  return { package: packageName, oldVersion, newVersion, removed, changed, added, renameHypotheses };
}

async function boundedArchive(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.port || parsed.username || parsed.password) {
    throw new Error('The package tarball must be served directly by the npm registry over HTTPS.');
  }
  const response = await fetcher(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Package download failed (${response.status}).`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxArchiveBytes) throw new Error('Package archive exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function diffPublishedApi(packageName: string, oldVersion: string, newVersion: string, fetcher: typeof fetch = fetch): Promise<ApiReport> {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(packageName)) throw new Error('Invalid npm package name.');
  validateExactVersion(oldVersion);
  validateExactVersion(newVersion);
  const load = async (version: string): Promise<{ archive: Buffer; integrity: string }> => {
    const metadata = await readBoundedJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`, undefined, fetcher) as { dist?: { tarball?: string; integrity?: string } };
    if (!metadata.dist?.tarball || !metadata.dist.integrity) throw new Error(`Missing tarball integrity for ${packageName}@${version}.`);
    return { archive: await boundedArchive(metadata.dist.tarball, fetcher), integrity: metadata.dist.integrity };
  };
  const old = await load(oldVersion);
  const next = await load(newVersion);
  return compareApiFromTarballs(packageName, oldVersion, newVersion, old.archive, next.archive, old.integrity, next.integrity);
}
