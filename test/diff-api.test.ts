import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { compareApiFromTarballs, diffPublishedApi, unpackDeclarationFiles, validateExactVersion } from '../src/core/diff-api.js';

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

it('finds removed exports and changed parameter members in two fixture packages', () => {
  const cases = [
    {
      name: 'firebase-admin',
      old: 'export declare function firestore(): object;\nexport interface Config { projectId: string; }',
      next: 'export declare function getFirestore(): object;\nexport interface Config { projectId: string; }',
      removed: 'firestore',
    },
    {
      name: 'stripe',
      old: 'export interface PaymentIntentCreateParams { payment_method_types?: string[]; amount: number; }',
      next: 'export interface PaymentIntentCreateParams { amount: number; }',
      removed: 'PaymentIntentCreateParams.payment_method_types',
    },
  ];
  for (const fixture of cases) {
    const old = tar({ 'package/package.json': JSON.stringify({ types: 'index.d.ts' }), 'package/index.d.ts': fixture.old });
    const next = tar({ 'package/package.json': JSON.stringify({ types: 'index.d.ts' }), 'package/index.d.ts': fixture.next });
    const report = compareApiFromTarballs(fixture.name, '1.0.0', '2.0.0', old, next);
    expect(report.removed.map((item) => item.symbol)).toContain(fixture.removed);
  }
});

it('rejects traversal, symbolic links and invalid integrity', () => {
  const archive = tar({ 'package/../escape.d.ts': 'export const escaped: string;' });
  expect(() => unpackDeclarationFiles(archive)).toThrow('unsafe');
  const normal = tar({ 'package/package.json': '{"types":"index.d.ts"}', 'package/index.d.ts': 'export const safe: string;' });
  expect(() => unpackDeclarationFiles(normal, `sha512-${createHash('sha512').update(normal).digest('base64')}`)).not.toThrow();
  expect(() => unpackDeclarationFiles(normal, 'sha512-invalid')).toThrow('integrity');
  const linked = gunzipSync(normal);
  linked[156] = '2'.charCodeAt(0);
  expect(() => unpackDeclarationFiles(gzipSync(linked))).toThrow('unsupported link');
});

it('requires exact versions', () => {
  expect(() => validateExactVersion('^22')).toThrow('exact');
  expect(() => validateExactVersion('22.0.0')).not.toThrow();
});

it('fetches simulated npm metadata and tarballs while validating integrity', async () => {
  const old = tar({ 'package/package.json': '{"types":"index.d.ts"}', 'package/index.d.ts': 'export declare function oldApi(): void;' });
  const next = tar({ 'package/package.json': '{"types":"index.d.ts"}', 'package/index.d.ts': 'export declare function newApi(): void;' });
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    const version = url.endsWith('/1.0.0') || url.includes('sample-1.0.0.tgz') ? '1.0.0' : '2.0.0';
    if (url.endsWith('.tgz')) return new Response(Uint8Array.from(version === '1.0.0' ? old : next));
    const archive = version === '1.0.0' ? old : next;
    return Response.json({ dist: { tarball: `https://registry.npmjs.org/sample/-/sample-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } });
  }) as typeof fetch;
  const report = await diffPublishedApi('sample', '1.0.0', '2.0.0', fetcher);
  expect(report.removed.map((item) => item.symbol)).toContain('oldApi');
  expect(report.added.map((item) => item.symbol)).toContain('newApi');
});
