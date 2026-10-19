import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { analyzeImpact } from '../src/core/impact.js';

it('reports two catalog dependencies without changing project files or installing packages', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-impact-'));
  try {
    const manifest = JSON.stringify({ dependencies: { stripe: '^21.0.0', 'firebase-admin': '^13.0.0' } });
    await writeFile(path.join(cwd, 'package.json'), manifest);
    await writeFile(path.join(cwd, 'firebase.ts'), "import * as admin from 'firebase-admin';\nadmin.initializeApp();\nadmin.firestore();\n");
    await writeFile(path.join(cwd, 'stripe.ts'), "import Stripe from 'stripe';\nconst client = Stripe('sk_test_fake');\n");
    const result = await analyzeImpact(cwd, async (name) => name === 'stripe' ? '23.0.0' : '14.0.0');
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.package)).toEqual(['firebase-admin', 'stripe']);
    expect(result.every((item) => item.affected > 0)).toBe(true);
    expect(result.every((item) => item.automatic <= item.affected)).toBe(true);
    expect(await import('node:fs/promises').then((fs) => fs.readFile(path.join(cwd, 'package.json'), 'utf8'))).toBe(manifest);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('reports conflicting nested versions instead of choosing one by directory order', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-impact-mixed-'));
  try {
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { stripe: '^21.0.0' } }));
    await mkdir(path.join(cwd, 'functions'));
    await writeFile(path.join(cwd, 'functions', 'package.json'), JSON.stringify({ dependencies: { stripe: '^22.0.0' } }));
    await mkdir(path.join(cwd, 'broken'));
    await writeFile(path.join(cwd, 'broken', 'package.json'), '{invalid');
    const result = await analyzeImpact(cwd, async () => '23.0.0');
    expect(result[0]?.declaredVersion).toContain('^21.0.0');
    expect(result[0]?.declaredVersion).toContain('^22.0.0');
    expect(result[0]?.note).toContain('Multiple');
    expect(result[0]?.note).toContain('broken/package.json');
    expect(result[0]?.automatic).toBe(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
