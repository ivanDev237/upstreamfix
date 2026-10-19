import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { stripeV22 } from '../src/migrations/stripe-v22/index.js';
import { stripeV23 } from '../src/migrations/stripe-v23/index.js';
import { runRealSdkNpm, runRealSdkNode } from './helpers/real-sdk-command.js';

const roots: string[] = [];
const enabled = process.env.UPSTREAMFIX_RUN_REAL_SDK_TESTS === '1';

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe.skipIf(!enabled)('Stripe migrations against the official published Node SDKs', () => {
  it('typechecks each of three files before and after v21 → v22 transformations', async () => {
    const cwd = await makeProject('^21.0.0');
    const sources = new Map([
      ['client.ts', "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk_test_fixture');\n"],
      ['types.ts', "import Stripe from 'stripe';\nexport type StripeContext = Stripe.StripeContext;\n"],
      ['errors.ts', "import Stripe from 'stripe';\nexport type StripeError = Stripe.errors.StripeError;\n"],
    ]);
    await writeSources(cwd, sources);
    await installSdk(cwd, '21.0.0');
    await typecheck(cwd);

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    for (const file of sources.keys()) project.addSourceFileAtPath(path.join(cwd, file));
    const result = stripeV22.transform(project);
    expect(result.manual).toEqual([]);
    await applyUpdates(result.fileUpdates ?? []);
    await installSdk(cwd, '22.0.0');
    await typecheck(cwd);
  }, 300_000);

  it('typechecks v22 → v23 transformations against both published SDK majors', async () => {
    const cwd = await makeProject('^22.0.0');
    const source = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_fixture', {apiVersion: '2026-07-29.dahlia'});
export type StripeCardError = Stripe.ErrorType.StripeCardError;
export const event = stripe.constructEventWithoutVerification('payload');
`;
    const file = path.join(cwd, 'webhook.ts');
    await writeFile(file, source);
    await installSdk(cwd, '22.5.0');
    await typecheck(cwd);

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    project.addSourceFileAtPath(file);
    const result = stripeV23.transform(project);
    expect(result.manual.map((item) => item.reason).join('\n')).toContain('explicitly uses 2026-07-29.dahlia');
    await applyUpdates(result.fileUpdates ?? []);
    await writeFile(file, (await readFile(file, 'utf8')).replace('2026-07-29.dahlia', '2026-09-30.endive'));
    await installSdk(cwd, '23.0.0');
    await typecheck(cwd);
  }, 300_000);
});

async function makeProject(stripeRange: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-stripe-real-sdk-'));
  roots.push(cwd);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    engines: { node: '>=20' },
    dependencies: { stripe: stripeRange },
  }));
  await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['*.ts'],
  }));
  return cwd;
}

async function writeSources(cwd: string, sources: Map<string, string>): Promise<void> {
  await Promise.all([...sources].map(([file, source]) => writeFile(path.join(cwd, file), source)));
}

async function applyUpdates(updates: Array<{ file: string; contents: string }>): Promise<void> {
  for (const update of updates) await writeFile(update.file, update.contents);
}

async function installSdk(cwd: string, version: string): Promise<void> {
  await runRealSdkNpm(cwd, ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', `stripe@${version}`, '@types/node@22']);
}

async function typecheck(cwd: string): Promise<void> {
  const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
  try {
    await runRealSdkNode(cwd, [tsc, '--project', path.join(cwd, 'tsconfig.json')], 90_000);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new Error([failure.stderr, failure.stdout].filter(Boolean).join('\n') || failure.message);
  }
}
