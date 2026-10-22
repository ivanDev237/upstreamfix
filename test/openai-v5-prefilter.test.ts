import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProject, runMigration } from '../src/core/runner.js';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';

async function fixture(files: Record<string, string>, check: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-prefilter-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const filename = path.join(cwd, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, contents);
    }
    await check(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const openaiManifest = JSON.stringify({ dependencies: { openai: '^4.0.0' }, engines: { node: '>=20' } });

describe('OpenAI v5 source prefilter', () => {
  it('1 ignores unrelated monorepo packages during discovery and preview', async () => {
    await fixture({
      'package.json': '{}',
      'packages/a/package.json': openaiManifest,
      'packages/a/src/lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI(); client.files.del('id');",
      'packages/b/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/b/src/util.ts': 'export interface Base { value: string }; export const value = 1;',
      'packages/b/src/comp.ts': "import { Base } from './util'; interface Props extends Base {}",
      'packages/b/src/ns.ts': "import * as util from './util'; export const value = util.value;",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath()));
      expect(loaded).toEqual(['packages/a/src/lib.ts']);
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual.some((finding) => finding.file.startsWith('packages/b/'))).toBe(false);
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'packages/a/src/lib.ts')).toBe(true);
    });
  });

  it('1 follows an actual cross-package client escape without a missing-manifest finding', async () => {
    await fixture({
      'package.json': '{}',
      'packages/a/package.json': openaiManifest,
      'packages/a/src/lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI(); client.files.del('id');",
      'packages/b/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/b/src/mutate.ts': "import * as lib from '../../a/src/lib'; (lib.client as any).files = {};",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath()));
      expect(loaded).toContain('packages/b/src/mutate.ts');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual.some((finding) => finding.reason.includes('No containing package.json declares openai'))).toBe(false);
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'packages/a/src/lib.ts')).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'packages/a/src/lib.ts')).toBe(true);
    });
  });

  it('1 keeps a linked consumer analysis-only when only the monorepo root declares openai', async () => {
    await fixture({
      'package.json': openaiManifest,
      'packages/a/package.json': openaiManifest,
      'packages/a/src/lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'packages/b/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/b/src/use.ts': "import { client } from '../../a/src/lib'; client.files.del('id');",
    }, async (cwd) => {
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'packages/b/src/use.ts')).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'packages/b/src/use.ts'
        && finding.reason.includes('another package'))).toBe(true);
      expect(outcome.manual.some((finding) => finding.reason.includes('No containing package.json declares openai'))).toBe(false);
    });
  });

  it('2 uses real local resolution in a shadcn-like component tree', async () => {
    await fixture({
      'package.json': openaiManifest,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/openai.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'src/lib/utils.ts': 'export const cn = (...values: string[]) => values.join(" ");',
      'src/use-client.ts': "import { client } from '@/lib/openai'; client.files.del('id');",
      'src/components/ui/button.tsx': "import * as Slot from '@radix-ui/react-slot'; import { cn } from '@/lib/utils'; interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {} export const Button = Slot.Root;",
      'src/components/ui/dialog.tsx': "import * as Dialog from '@radix-ui/react-dialog'; class Panel extends React.Component {} export const Root = Dialog.Root;",
      'src/components/ui/generic.ts': "import { cn } from '@/lib/utils'; function useThing<T extends Element>(value: T) { return cn(String(value)); }",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath())).sort();
      expect(loaded).toEqual(['src/lib/openai.ts', 'src/use-client.ts']);
    });
  });

  it('2 does not borrow an @/ alias from another package tsconfig', async () => {
    await fixture({
      'package.json': '{}',
      'packages/a/package.json': openaiManifest,
      'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/a/src/lib/openai.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'packages/b/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/b/src/comp.ts': "import * as lib from '@/lib/openai'; export const x = lib.client;",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath())).sort();
      expect(loaded).toEqual(['packages/a/src/lib/openai.ts']);
    });
  });

  it('2 uses the nearest tsconfig when alias mappings conflict', async () => {
    await fixture({
      'package.json': openaiManifest,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/openai.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'packages/ui/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/ui/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/ui/src/comp.ts': "import * as lib from '@/lib/openai'; export const x = lib.client;",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath()));
      expect(loaded).toEqual(['src/lib/openai.ts']);
    });
  });

  it('2 follows paths inherited through tsconfig extends', async () => {
    await fixture({
      'package.json': openaiManifest,
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/openai.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'packages/app/package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'packages/app/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
      'packages/app/src/use.ts': "import { client } from '@/lib/openai'; client.files.del('id');",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath())).sort();
      expect(loaded).toEqual(['packages/app/src/use.ts', 'src/lib/openai.ts']);
    });
  });

  it('2 ignores an unresolved namespace import when another variable is written', async () => {
    await fixture({
      'package.json': openaiManifest,
      'src/lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'src/unrelated.ts': "import * as unknown from './missing'; let count = 0; count = 1;",
    }, async (cwd) => {
      const loaded = loadProject(cwd, 'openai').getSourceFiles().map((file) => path.relative(cwd, file.getFilePath()));
      expect(loaded).toEqual(['src/lib.ts']);
    });
  });

  it('3 keeps dynamic, namespace and require mutations blocking the exported client', async () => {
    for (const mutation of [
      "import('./lib').then((m) => { (m.client as any).files = {}; });",
      "import * as lib from './lib'; Reflect.set(lib, 'client', fake);",
      "require('./lib').client.files = {};",
    ]) await fixture({
      'package.json': openaiManifest,
      'lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI(); client.files.del('id');",
      'mutation.ts': mutation,
    }, async (cwd) => {
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'lib.ts'), mutation).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'lib.ts'), mutation).toBe(true);
    });
  });

  it('3 keeps indirect subclasses, mixins and super.client mutations blocking the base', async () => {
    for (const subclass of [
      "import { Middle } from './middle'; class Sub extends Middle { hack() { (this.client as any).files = {}; } }",
      "import { Middle } from './middle'; const mixin = <T>(Base: T): T => Base; class Sub extends mixin(Middle) { hack() { (this.client as any).files = {}; } }",
      "import { Middle } from './middle'; class Sub extends Middle { hack() { (super.client as any).files = {}; } }",
    ]) await fixture({
      'package.json': openaiManifest,
      'base.ts': "import OpenAI from 'openai'; export class Base { constructor(protected client: OpenAI) {} go(id: string) { return this.client.files.del(id); } }",
      'middle.ts': "import { Base } from './base'; export class Middle extends Base {}",
      'sub.ts': subclass,
    }, async (cwd) => {
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'base.ts'), subclass).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'base.ts'), subclass).toBe(true);
    });
  });
});
