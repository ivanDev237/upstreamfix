import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiReport } from '../src/core/diff-api.js';
import { generateTypeFixtures, makeFixtureReadable, selectFixtureForMember } from '../src/core/type-fixtures.js';

const report = (packageName: string, symbol: string): ApiReport => ({
  package: packageName, oldVersion: packageName === 'stripe' ? '22.5.0' : '13.10.0',
  newVersion: packageName === 'stripe' ? '23.0.0' : '14.0.0',
  removed: [{ symbol, source: 'index.d.ts', before: 'removed member' }],
  changed: [], added: [], renameHypotheses: [],
});

describe('type-diff fixtures', () => {
  it('can run the real SDK check as a pinned reusable GitHub workflow', () => {
    const workflow = readFileSync(new URL('../.github/workflows/type-fixtures.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain("|| 'ivanDev237/upstreamfix'");
    expect(workflow).toContain("github.event_name == 'pull_request' && github.sha || inputs.source_sha");
  });
  it('makes the temporary root traversable by the unprivileged Docker user', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-fixture-mode-'));
    try {
      await makeFixtureReadable(root);
      expect((await stat(root)).mode & 0o111).toBe(0o111);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('derives a Stripe removed parameter fixture with exact versions', () => {
    const generated = generateTypeFixtures(report('stripe', 'Stripe.PaymentIntentCreateParams.payment_method_types'));
    expect(generated.fixtures).toHaveLength(1);
    expect(generated.fixtures[0]?.source).toContain("Stripe.PaymentIntentCreateParams['payment_method_types']");
    expect(generated.fixtures[0]?.expectedNewDiagnostic).toBe(2339);
    expect(generated.fixtures[0]?.oldVersion).toBe('22.5.0');
    expect(generated.fixtures[0]?.newVersion).toBe('23.0.0');
  });

  it('accepts entrypoint-prefixed symbols from the real Stripe declaration report', () => {
    const generated = generateTypeFixtures(report('stripe', 'esm/stripe.esm.node.d.ts:Stripe.PaymentIntentCreateParams.payment_method_types'));
    expect(generated.fixtures[0]?.source).toContain("Stripe.PaymentIntentCreateParams['payment_method_types']");
  });

  it('derives a Firebase namespace removal fixture', () => {
    const generated = generateTypeFixtures(report('firebase-admin', 'firestore'));
    expect(generated.fixtures[0]?.source).toContain('typeof admin.firestore');
    expect(generated.fixtures[0]?.expectedNewDiagnostic).toBe(2339);
    expect(generated.fixtures[0]?.migratedSource).toContain("from 'firebase-admin/firestore'");
    expect(generated.fixtures[0]?.migratedSource).toContain('typeof getFirestore');
  });
  it('selects a removed member despite the declaration entrypoint prefix', () => {
    const set = generateTypeFixtures(report('firebase-admin', 'lib/index.d.ts:firestore'));
    expect(selectFixtureForMember(set, 'firestore')?.derivedFrom.symbol).toBe('lib/index.d.ts:firestore');
  });

  it('does not invent a fixture for an ambiguous difference', () => {
    const generated = generateTypeFixtures(report('stripe', 'Unknown.nested.complex'));
    expect(generated.fixtures).toEqual([]);
    expect(generated.manual).toHaveLength(1);
  });

  it('does not invent a payment-parameter replacement for Stripe', () => {
    const generated = generateTypeFixtures(report('stripe', 'Stripe.PaymentIntentCreateParams.payment_method_types'));
    expect(generated.fixtures[0]?.migratedSource).toBeUndefined();
  });
});
