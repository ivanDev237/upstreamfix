import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { findApplicableMigrations } from '../src/migrations/index.js';
import { runMigration } from '../src/core/runner.js';
import type { MigrationResult } from '../src/core/types.js';
import { stripeV22 } from '../src/migrations/stripe-v22/index.js';
import { applyStripeEdits } from '../src/migrations/stripe-shared.js';

const roots: string[] = [];

async function makeProject(source: string, range = '^21.0.0'): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-stripe-v22-'));
  roots.push(cwd);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'stripe-fixture', dependencies: { stripe: range } }, null, 2));
  await writeFile(path.join(cwd, 'client.ts'), source);
  return cwd;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Stripe Node SDK v21 → v22 migration', () => {
  it('uses the same conservative major parser and ignored folders in scan and migrate', async () => {
    const cwd = await makeProject("import Stripe from 'stripe';\nStripe('key');\n", '>=21');
    expect(await findApplicableMigrations(cwd)).toEqual([]);
    const outcome = await runMigration(stripeV22, { cwd, dryRun: true });
    expect(outcome.manual.some((item) => item.reason.includes('only analyzes major v21'))).toBe(true);

    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { stripe: '^24.0.0' } }));
    await mkdir(path.join(cwd, '.codex'));
    await writeFile(path.join(cwd, '.codex', 'package.json'), JSON.stringify({ dependencies: { stripe: '^21.0.0' } }));
    await writeFile(path.join(cwd, '.codex', 'private.ts'), "import Stripe from 'stripe';\nStripe('key');\n");
    expect(await findApplicableMigrations(cwd)).toEqual([]);
    const ignored = await runMigration(stripeV22, { cwd, dryRun: true });
    expect(ignored.filesChanged).not.toContain('.codex/private.ts');
  });

  it('withholds all edits from a Stripe file with syntax errors', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('broken.ts', "import Stripe from 'stripe';\nconst stripe = Stripe(\n");
    const result = stripeV22.transform(project);
    expect(result.manual.some((item) => item.reason.includes('syntax'))).toBe(true);
    expect(result.fileUpdates).toEqual([]);
  });

  it('reports overlapping Stripe edits instead of dropping one silently', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = project.createSourceFile('nested.js', 'const stripe = original;\n');
    const result: MigrationResult = { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
    const original = source.getFullText();
    applyStripeEdits(source, [
      { start: 6, end: 12, replacement: 'client', rule: 'first', before: 'stripe', line: 1 },
      { start: 8, end: 14, replacement: 'other', rule: 'second', before: 'ripe =', line: 1 },
    ], result, original);
    expect(result.manual.some((item) => item.reason.includes('overlap'))).toBe(true);
    expect(result.fileUpdates).toEqual([]);
  });

  it('migrates the constructor and unambiguous RequestOptions position, plus the package range, in preview', async () => {
    const cwd = await makeProject(
      "import Stripe from 'stripe';\nconst stripe = Stripe(process.env.STRIPE_KEY!);\nexport const customer = stripe.customers.retrieve('cus_123', {stripeAccount: process.env.CONNECTED_ACCOUNT!});\n",
    );

    const outcome = await runMigration(stripeV22, { cwd, dryRun: true });
    const source = await readFile(path.join(cwd, 'client.ts'), 'utf8');
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

    expect(outcome.manual).toEqual([]);
    expect(outcome.changes.map((change) => change.rule)).toContain('stripe-constructor');
    expect(outcome.changes.map((change) => change.rule)).toContain('request-options-position');
    expect(outcome.manifestNotes).toContain('`dependencies.stripe`: `^21.0.0` → `^22.0.0`');
    expect(source).toContain("const stripe = Stripe(process.env.STRIPE_KEY!)");
    expect(outcome.proposedDiff.join('\n')).toContain('new Stripe(process.env.STRIPE_KEY!)');
    expect(outcome.proposedDiff.join('\n')).toContain("retrieve('cus_123', undefined, {stripeAccount:");
    expect(manifest.dependencies.stripe).toBe('^21.0.0');
  });

  it('preserves create/list options and only adds a params slot to an ID-first update', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('requests.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);
stripe.customers.create({email: 'a@example.com'}, {idempotencyKey: 'create-key'});
stripe.customers.list({limit: 10}, {stripeAccount: 'acct_123'});
stripe.customers.update('cus_123', {stripeAccount: 'acct_123'});
`);

    const result = stripeV22.transform(project);
    const migrated = result.fileUpdates?.[0]?.contents ?? '';

    expect(result.manual).toEqual([]);
    expect(result.changes.filter((change) => change.rule === 'request-options-position')).toHaveLength(1);
    expect(migrated).toContain("create({email: 'a@example.com'}, {idempotencyKey: 'create-key'})");
    expect(migrated).toContain("list({limit: 10}, {stripeAccount: 'acct_123'})");
    expect(migrated).toContain("update('cus_123', undefined, {stripeAccount: 'acct_123'})");
  });

  it('flags ambiguous ID-first request options for manual review without changing them', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('ambiguous.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);
stripe.customers.update({id: 'cus_123'}, {stripeAccount: 'acct_123'});
`);

    const result = stripeV22.transform(project);

    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.reason).toContain('parameter position is ambiguous');
    expect(result.changes.map((change) => change.rule)).not.toContain('request-options-position');
  });

  it('does not guess whether an options-looking single argument is list params or RequestOptions', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('list-options.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);
stripe.customers.list({stripeAccount: 'acct_123'});
`);

    const result = stripeV22.transform(project);

    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.reason).toContain('may be RequestOptions');
    expect(result.changes.map((change) => change.rule)).not.toContain('request-options-position');
  });

  it('rewrites CJS constructor exports and modernizes v22 type references', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('client.ts', `/// <reference types="stripe/types" />
const { Stripe: StripeCtor } = require('stripe');
const stripe = StripeCtor(process.env.STRIPE_KEY);
type Context = StripeCtor.StripeContext;
type Error = StripeCtor.errors.StripeError;
`);

    const result = stripeV22.transform(project);
    const migrated = result.fileUpdates?.[0]?.contents ?? '';

    expect(result.manual).toEqual([]);
    expect(migrated).not.toContain('stripe/types');
    expect(migrated).toContain("const StripeCtor = require('stripe')");
    expect(migrated).toContain('new StripeCtor(');
    expect(migrated).toContain('StripeCtor.StripeContextType');
    expect(migrated).toContain('InstanceType<typeof StripeCtor.errors.StripeError>');
  });

  it('reports callback migration for review without inventing async control flow', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('callbacks.ts', "import Stripe from 'stripe';\nconst stripe = new Stripe('key');\nstripe.customers.list((customers) => consume(customers));\n");

    const result = stripeV22.transform(project);

    expect(result.manual).toHaveLength(1);
    expect(result.manual[0]?.reason).toContain('removes callbacks');
    expect(result.fileUpdates).toEqual([]);
  });

  it('reports per-request host and literal API keys without disclosing keys or moving hosts', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('options.ts', `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY!);
stripe.customers.retrieve('cus_123', 'sk_test_examplesecret');
stripe.customers.create({email: 'a@example.com'}, {host: 'localhost'});
`);

    const result = stripeV22.transform(project);

    expect(result.manual).toHaveLength(2);
    expect(result.manual.map((item) => item.reason).join(' ')).toContain('string API key');
    expect(result.manual.map((item) => item.reason).join(' ')).toContain('per-request host');
    expect(JSON.stringify(result.manual)).not.toContain('examplesecret');
    expect(result.changes).toEqual([]);
  });

  it('recognizes an existing later major without downgrading it', () => {
    const notes = stripeV22.updateManifest?.({ dependencies: { stripe: '^23.0.0' } }) ?? [];
    expect(notes.join(' ')).toContain('left unchanged to avoid downgrading');
  });

  it('routes a v21 package to v22 in the migration catalog', async () => {
    const cwd = await makeProject("import Stripe from 'stripe';\nconst client = Stripe(process.env.STRIPE_KEY!);\n");
    expect((await findApplicableMigrations(cwd)).map((migration) => migration.id)).toEqual(['stripe@22']);
  });
});
