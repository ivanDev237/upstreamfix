import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { stripeV23 } from '../src/migrations/stripe-v23/index.js';

describe('Stripe Node SDK v22 → v23 migration', () => {
  it('moves the removed top-level webhook method and updates the removed error type namespace', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('webhook.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!, {apiVersion: '2026-03-25.dahlia'});
type ApiError = Stripe.ErrorType.StripeAPIError;
export const event = stripe.constructEventWithoutVerification(payload);
`);

    const result = stripeV23.transform(project);
    const migrated = result.fileUpdates?.[0]?.contents ?? '';

    expect(result.manual.map((item) => item.reason).join('\n')).toContain('explicitly uses 2026-03-25.dahlia');
    expect(migrated).toContain('Stripe.errors.StripeAPIError');
    expect(migrated).toContain('stripe.webhooks.constructEventWithoutVerification(payload)');
  });

  it('requires review for API version defaults, webhook tolerance, and V2 address type usages', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('review.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);
type Address = Stripe.JapanAddressParam;
stripe.webhooks.signature.verifyHeader(payload, header, secret);
`);

    const result = stripeV23.transform(project);
    const reasons = result.manual.map((item) => item.reason).join('\n');

    expect(reasons).toContain('default API version');
    expect(reasons).toContain('DEFAULT_TOLERANCE');
    expect(reasons).toContain('operation-specific address types');
  });

  it('updates a v22 manifest to v23 and reports Node runtime requirements', () => {
    const manifest = { dependencies: { stripe: '~22.2.0' }, engines: { node: '>=18' } };
    const notes = stripeV23.updateManifest?.(manifest) ?? [];
    expect(manifest.dependencies.stripe).toBe('^23.0.0');
    expect(notes.join(' ')).toContain('requires Node.js 20 or later');
  });
});
