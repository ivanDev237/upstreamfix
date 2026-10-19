import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { watchPackages } from '../src/core/watch.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('records a major upgrade while ignoring a minor release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-watch-'));
  roots.push(root);
  const state = path.join(root, 'watch.json');
  await writeFile(state, JSON.stringify({ versions: { stripe: '22.1.0', 'firebase-admin': '13.9.0' }, events: [] }));
  const result = await watchPackages(state, ['stripe', 'firebase-admin'], async (name) => name === 'stripe' ? '22.5.0' : '14.0.0');
  expect(result.events).toEqual([{ package: 'firebase-admin', from: '13.9.0', to: '14.0.0' }]);
  expect(JSON.parse(await readFile(state, 'utf8')).versions.stripe).toBe('22.5.0');
});

it('preserves the previous state when one registry request fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-watch-'));
  roots.push(root);
  const state = path.join(root, 'watch.json');
  const original = JSON.stringify({ versions: { stripe: '22.1.0' }, events: [] });
  await writeFile(state, original);
  await expect(watchPackages(state, ['stripe'], async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await readFile(state, 'utf8')).toBe(original);
});

it('rejects invalid stored versions without losing earlier events or lowering a version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-watch-hostile-'));
  roots.push(root);
  const state = path.join(root, 'watch.json');
  await writeFile(state, JSON.stringify({ versions: { stripe: 22 }, events: [] }));
  await expect(watchPackages(state, ['stripe'], async () => '23.0.0')).rejects.toThrow('Invalid watch state');
  const earlier = { package: 'stripe', from: '21.0.0', to: '22.0.0' };
  await writeFile(state, JSON.stringify({ versions: { stripe: '23.0.0' }, events: [earlier] }));
  const result = await watchPackages(state, ['stripe', 'constructor'], async (name) => name === 'stripe' ? '22.0.0' : '1.0.0');
  expect(result.versions.stripe).toBe('23.0.0');
  expect(result.versions.constructor).toBe('1.0.0');
  expect(result.events).toEqual([]);
  expect(JSON.parse(await readFile(state, 'utf8')).events).toEqual([earlier]);
});

it('returns only new events, retains bounded history, and announces a stable major after beta', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-watch-events-'));
  roots.push(root);
  const state = path.join(root, 'watch.json');
  const history = Array.from({ length: 150 }, (_, index) => ({ package: 'old', from: `${index}.0.0`, to: `${index + 1}.0.0` }));
  await writeFile(state, JSON.stringify({ versions: { stripe: '23.0.0-beta.1' }, events: history }));
  const first = await watchPackages(state, ['stripe'], async () => '23.0.0');
  expect(first.events).toEqual([{ package: 'stripe', from: '23.0.0-beta.1', to: '23.0.0' }]);
  expect(JSON.parse(await readFile(state, 'utf8')).events).toHaveLength(100);
  const second = await watchPackages(state, ['stripe'], async () => '23.0.0');
  expect(second.events).toEqual([]);
});
