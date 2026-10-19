import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ApiReport } from '../src/core/diff-api.js';
import { generateTypeFixtures } from '../src/core/type-fixtures.js';

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
    expect(workflow).toContain('repository: ivanDev237/upstreamfix');
    expect(workflow).toContain('ref: ${{ inputs.source_sha }}');
  });
  it('derives a Stripe removed parameter fixture with exact versions', () => {
    const generated = generateTypeFixtures(report('stripe', 'Stripe.PaymentIntentCreateParams.payment_method_types'));
    expect(generated.fixtures).toHaveLength(1);
    expect(generated.fixtures[0]?.source).toContain("Stripe.PaymentIntentCreateParams['payment_method_types']");
    expect(generated.fixtures[0]?.expectedNewDiagnostic).toBe(2339);
    expect(generated.fixtures[0]?.oldVersion).toBe('22.5.0');
    expect(generated.fixtures[0]?.newVersion).toBe('23.0.0');
  });

  it('derives a Firebase namespace removal fixture', () => {
    const generated = generateTypeFixtures(report('firebase-admin', 'firestore'));
    expect(generated.fixtures[0]?.source).toContain('typeof admin.firestore');
    expect(generated.fixtures[0]?.expectedNewDiagnostic).toBe(2339);
  });

  it('does not invent a fixture for an ambiguous difference', () => {
    const generated = generateTypeFixtures(report('stripe', 'Unknown.nested.complex'));
    expect(generated.fixtures).toEqual([]);
    expect(generated.manual).toHaveLength(1);
  });
});
