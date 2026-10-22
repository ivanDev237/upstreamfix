import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { runMigration } from '../src/core/runner.js';
import * as benchmark from '../scripts/benchmark.js';

const call = "client.files.del('id')";
function transform(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/client.ts', source);
  return openaiV5.transform(project);
}
function graph(files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, source] of Object.entries(files)) project.createSourceFile(`/${name}`, source);
  return openaiV5.transform(project);
}

describe('OpenAI v5 counter-verification', () => {
  it('10 holds a client when a rewritten method target is replaced', () => {
    for (const write of ['client.files.delete = fake', '(client.files as any).delete = fake', 'Object.assign(client.files, { delete: fake })']) {
      const result = transform(`import OpenAI from 'openai'; const client = new OpenAI(); ${write}; client.files.del('id');`);
      expect(result.fileUpdates, write).toEqual([]);
      expect(result.manual.some((finding) => finding.snippet.includes("client.files.del('id')")), write).toBe(true);
    }
    const runner = transform("import OpenAI from 'openai'; const client = new OpenAI(); const run = client.chat.completions.runTools({ tools: [] }); run.finalFunctionToolCall = fake; run.finalFunctionCall();");
    expect(runner.fileUpdates).toEqual([]);
    expect(runner.manual.some((finding) => finding.snippet.includes('run.finalFunctionCall'))).toBe(true);
  });

  it('11 holds exports mutated through dynamic imports', () => {
    for (const mutation of [
      "import('./lib').then((m) => { (m.client as any).files = {}; });",
      "import('./lib').then((m) => { Reflect.set(m, 'client', fake); });",
      "import('./lib').then((m) => { Object.assign(m, { client: fake }); });",
      "import('./lib').then((m) => { Object.defineProperty(m, 'client', { value: fake }); });",
    ]) {
      const result = graph({ 'lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
        'mutation.ts': mutation, 'consumer.ts': "import { client } from './lib'; client.files.del('id');" });
      expect(result.fileUpdates?.some((item) => item.file === '/consumer.ts'), mutation).toBe(false);
      expect(result.manual.some((finding) => finding.file === '/consumer.ts'), mutation).toBe(true);
    }
  });

  it('12 holds exports mutated through namespace imports and require', () => {
    for (const mutation of [
      "import * as lib from './lib'; (lib.client as any).files = {};",
      "import * as lib from './lib'; Reflect.set(lib, 'client', fake);",
      "import * as lib from './lib'; Object.assign(lib, { client: fake });",
      "import * as lib from './lib'; Object.defineProperty(lib, 'client', { value: fake });",
      "require('./lib').client.files = {};",
      "import * as unresolved from './unresolved'; Reflect.set(unresolved, 'client', fake);",
    ]) {
      const result = graph({ 'lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
        'mutation.ts': mutation, 'consumer.ts': "import { client } from './lib'; client.files.del('id');" });
      expect(result.fileUpdates?.some((item) => item.file === '/consumer.ts'), mutation).toBe(false);
      expect(result.manual.some((finding) => finding.file === '/consumer.ts'), mutation).toBe(true);
    }
    const consumer = graph({ 'lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'consumer.ts': "const { client } = require('./lib'); client.files.del('id');" });
    expect(consumer.manual.some((finding) => finding.file === '/consumer.ts')).toBe(true);
  });

  it('12b loads mutation-only files into the runner analysis', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-module-mutation-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'lib.ts'), "import OpenAI from 'openai'; export const client = new OpenAI();");
      await writeFile(path.join(cwd, 'consumer.ts'), "import { client } from './lib'; client.files.del('id');");
      for (const mutation of [
        "import('./lib').then((m) => { (m.client as any).files = {}; });",
        "import * as lib from './lib'; Reflect.set(lib, 'client', fake);",
        "require('./lib').client.files = {};",
      ]) {
        await writeFile(path.join(cwd, 'mutation.ts'), mutation);
        const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
        expect(outcome.proposedFiles.some((file) => file.relativePath === 'consumer.ts'), mutation).toBe(false);
        expect(outcome.manual.some((finding) => finding.file === 'consumer.ts'), mutation).toBe(true);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('13 holds inherited fields mutated in direct and indirect subclasses across files', () => {
    const cases: Array<Record<string, string>> = [
      { 'classes.ts': "import OpenAI from 'openai'; class Base { constructor(protected client: OpenAI) {} go(id: string) { return this.client.files.del(id); } } class Sub extends Base { hack() { (this.client as any).files = {}; } }" },
      { 'base.ts': "import OpenAI from 'openai'; export class Base { constructor(protected client: OpenAI) {} go(id: string) { return this.client.files.del(id); } }",
        'middle.ts': "import { Base } from './base'; export class Middle extends Base {}",
        'sub.ts': "import { Middle } from './middle'; class Sub extends Middle { hack() { (this.client as any).files = {}; } }" },
    ];
    for (const files of cases) {
      const result = graph(files);
      expect(result.fileUpdates, Object.keys(files).join(',')).toEqual([]);
      expect(result.manual.some((finding) => finding.snippet.includes('this.client.files.del')), Object.keys(files).join(',')).toBe(true);
    }
  });

  it('13b loads derived mutation files into the runner analysis', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-inheritance-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'base.ts'), "import OpenAI from 'openai'; export class Base { constructor(protected client: OpenAI) {} go(id: string) { return this.client.files.del(id); } }");
      await writeFile(path.join(cwd, 'middle.ts'), "import { Base } from './base'; export class Middle extends Base {}");
      await writeFile(path.join(cwd, 'sub.ts'), "import { Middle } from './middle'; class Sub extends Middle { hack() { (this.client as any).files = {}; } }");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'base.ts')).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'base.ts' && finding.snippet.includes('this.client.files.del'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('13c does not hold an unrelated class with a field of the same name', () => {
    const result = graph({
      'safe.ts': "import OpenAI from 'openai'; class Safe { client = new OpenAI(); go() { this.client.files.del('id'); } }",
      'other.ts': "import OpenAI from 'openai'; class Other { client = new OpenAI(); hack() { (this.client as any).files = {}; } }",
    });
    expect(result.fileUpdates?.find((file) => file.file === '/safe.ts')?.contents).toContain("this.client.files.delete('id')");
  });

  it('14 detects an import-only migration before a Node 20 runtime decision', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-import-runtime-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=18.17.0"}}');
      for (const source of [
        "import type { ParsedChatCompletion } from 'openai/resources/beta/chat/completions';",
        "type P = import('openai/resources/beta/chat/completions').ParsedChatCompletion;",
        "const x = require('openai/resources/beta/chat/completions');",
      ]) {
        await writeFile(path.join(cwd, 'index.ts'), source);
        const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
        expect(outcome.manual.some((finding) => finding.reasonCode === 'runtime-confirmation'), source).toBe(true);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('15 distinguishes incompatible engines from missing runtime confirmation in the report', () => {
    const row = { name: 'fixture', commit: 'a'.repeat(40), status: 'manual', usages: 1, migrated: 0, manual: 1,
      typecheck: { before: 'skipped', after: 'skipped' }, tests: { before: 'skipped', after: 'skipped' },
      details: '', runtimeConfirmationCount: 0, runtimeBlockedCount: 1, manualFindings: [] } as never;
    const report = benchmark.renderBenchmarkReport([row], 'complete', 1, openaiV5);
    expect(report).toContain('Packages whose engines.node blocks OpenAI v5: **1**');
    expect(report).toContain('Packages requiring explicit `--node-runtime 20` confirmation: **0**');
  });

  it('15b counts an engines refusal once without adding a second manual item', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-runtime-block-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=18.17.0"}}');
      await writeFile(path.join(cwd, 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('id');");
      const outcome = await benchmark.analyzeBenchmarkMigration(openaiV5, cwd);
      const manifests = [{ directory: cwd, supported: false }];
      expect(benchmark.countRuntimeBlockedPackages(cwd, manifests, outcome)).toBe(1);
      expect(benchmark.runtimeConfirmationFindings(cwd, manifests, outcome)).toEqual([]);
      expect(outcome.manual.filter((finding) => finding.reasonCode === 'manifest-refusal')).toHaveLength(1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('1 holds clients captured by shorthand objects and CommonJS exports', () => {
    for (const exportLine of ['const deps = { client };', 'module.exports = { client };']) {
      const result = transform(`import OpenAI from 'openai'; const client = new OpenAI(); ${exportLine} (deps.client as any).files = fake; ${call};`
        .replace('(deps.client as any).files = fake;', exportLine.startsWith('module.') ? '(module.exports.client as any).files = fake;' : '(deps.client as any).files = fake;'));
      expect(result.fileUpdates, exportLine).toEqual([]);
      expect(result.manual.some((finding) => finding.snippet.includes(call)), exportLine).toBe(true);
    }
  });

  it('2 propagates an imported client escape to every consumer through aliases and barrels', () => {
    const result = graph({
      'lib.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      'barrel.ts': "export { client as ai } from './lib';",
      'mutation.ts': "import { ai as c } from './barrel'; (c as any).files = fake;",
      'consumer.ts': "import { client } from './lib'; client.files.del('id');",
    });
    expect(result.fileUpdates?.some((item) => item.file === '/consumer.ts')).toBe(false);
    expect(result.manual.some((finding) => finding.file === '/consumer.ts')).toBe(true);
    const defaultExport = graph({
      'lib.ts': "import OpenAI from 'openai'; const client = new OpenAI(); export default client; export { client };",
      'mutation.ts': "import c from './lib'; (c as any).files = fake;",
      'consumer.ts': "import { client } from './lib'; client.files.del('id');",
    });
    expect(defaultExport.fileUpdates?.some((item) => item.file === '/consumer.ts')).toBe(false);
    expect(defaultExport.manual.some((finding) => finding.file === '/consumer.ts')).toBe(true);
    const commonJs = graph({
      'lib.ts': "import OpenAI from 'openai'; const client = new OpenAI(); module.exports = { client };",
      'mutation.ts': "const { client } = require('./lib'); (client as any).files = fake;",
      'consumer.ts': "const { client } = require('./lib'); client.files.del('id');",
      'consumer-esm.ts': "import { client } from './lib'; client.models.del('id');",
    });
    expect(commonJs.fileUpdates?.some((item) => item.file === '/consumer.ts')).toBe(false);
    expect(commonJs.manual.some((finding) => finding.file === '/consumer.ts')).toBe(true);
    expect(commonJs.fileUpdates?.some((item) => item.file === '/consumer-esm.ts')).toBe(false);
    expect(commonJs.manual.some((finding) => finding.file === '/consumer-esm.ts')).toBe(true);
  });

  it('3 holds class fields passed, returned, aliased or mutated through Object.assign', () => {
    for (const use of [
      'Object.assign(this.client, { files: fake });',
      'const cc = this.client; (cc as any).files = fake;',
      'helper(this.client);',
      'return this.client;',
    ]) {
      const result = transform(`import OpenAI from 'openai'; class Store { client = new OpenAI(); go() { ${use} this.client.files.del('id'); } }`);
      expect(result.fileUpdates, use).toEqual([]);
      expect(result.manual.some((finding) => finding.snippet.includes('this.client.files.del')), use).toBe(true);
    }
  });

  it('4 rewrites transparent read wrappers but still holds wrapped writes', () => {
    for (const receiver of ['client!', '(client as OpenAI)', '(client satisfies OpenAI)', '(<OpenAI>client)', '(client)']) {
      const result = transform(`import OpenAI from 'openai'; const client = new OpenAI(); ${receiver}.files.del('id');`);
      expect(result.manual, receiver).toEqual([]);
      expect(result.fileUpdates?.[0]?.contents, receiver).toContain(`${receiver}.files.delete('id')`);
    }
    const write = transform("import OpenAI from 'openai'; const client = new OpenAI(); (client as any).files = fake; client.files.del('id');");
    expect(write.fileUpdates).toEqual([]);
    expect(write.manual.some((finding) => finding.snippet.includes(call))).toBe(true);
  });

  it('5 names the opaque consumer when a client is passed to a call or constructor', () => {
    for (const use of ['log(client)', 'new Service(client)']) {
      const result = transform(`import OpenAI from 'openai'; const client = new OpenAI(); ${use}; ${call};`);
      expect(result.fileUpdates, use).toEqual([]);
      expect(result.manual.some((finding) => finding.reason.includes(use.split('(')[0]!) && finding.reason.includes('passed')), use).toBe(true);
    }
  });

  it('6 follows a separately declared default export through the runner prefilter', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-default-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'lib.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); export default client;");
      await writeFile(path.join(cwd, 'consumer.ts'), "import client from './lib'; client.files.del('id');");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'consumer.ts')?.after).toContain("client.files.delete('id')");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('7 credits no changes after a repository-wide CLI refusal and uses the nearest manifest for lock refusals', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-credit-'));
    try {
      await mkdir(path.join(cwd, 'packages', 'api', 'src'), { recursive: true });
      await writeFile(path.join(cwd, 'package.json'), '{}');
      await writeFile(path.join(cwd, 'packages', 'api', 'package.json'), '{}');
      const changes = [{ file: 'packages/api/src/index.ts', line: 1, rule: 'del-to-delete', before: 'del', after: 'delete' }];
      const refusal = { file: 'packages/api/package-lock.json', line: 1, snippet: '', reason: 'Lockfile refused', reasonCode: 'lockfile-refusal' as const };
      const credited = Reflect.get(benchmark, 'benchmarkCreditedChanges') as ((root: string, outcome: unknown) => unknown) | undefined;
      expect(credited).toBeTypeOf('function');
      expect(credited!(cwd, { changes, manual: [refusal] })).toEqual([]);
      expect(credited!(cwd, { changes, manual: [{ ...refusal, reasonCode: 'manifest-refusal' }] })).toEqual([]);
      expect(credited!(cwd, { changes, manual: [{ ...refusal, file: 'other.ts', reasonCode: undefined }] })).toEqual([]);
      await mkdir(path.join(cwd, 'src'), { recursive: true });
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'src', 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('id');");
      await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":2}');
      const actual = await benchmark.analyzeBenchmarkMigration(openaiV5, cwd);
      expect(actual.manual.some((finding) => finding.reasonCode === 'lockfile-refusal')).toBe(true);
      expect(credited!(cwd, actual)).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('8 codes every manifest refusal, including incompatible engines and invalid package JSON', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-manifest-reason-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=18"}}');
      await writeFile(path.join(cwd, 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('id');");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(outcome.manual.some((finding) => finding.reason.includes('engines.node') && (finding.reasonCode as string | undefined) === 'manifest-refusal')).toBe(true);
      const stalled = await runMigration({ ...openaiV5, id: 'stalled-openai@5',
        transform(project) {
          const source = project.getSourceFiles()[0]!;
          return { changes: [{ file: source.getFilePath(), line: 1, rule: 'fixture', before: 'del', after: 'delete' }],
            manual: [], filesChanged: [source.getFilePath()],
            fileUpdates: [{ file: source.getFilePath(), contents: `${source.getFullText()}\n// edited` }] };
        },
        updateManifest: () => ['Could not safely update dependencies.openai'],
      }, { cwd, dryRun: true });
      expect(stalled.manual.some((finding) => finding.reasonCode === 'manifest-refusal')).toBe(true);
      const silent = await runMigration({ ...openaiV5, id: 'silent-openai@5',
        transform(project) {
          const source = project.getSourceFiles()[0]!;
          return { changes: [{ file: source.getFilePath(), line: 1, rule: 'fixture', before: 'del', after: 'delete' }],
            manual: [], filesChanged: [source.getFilePath()],
            fileUpdates: [{ file: source.getFilePath(), contents: `${source.getFullText()}\n// edited` }] };
        },
        updateManifest: () => [],
      }, { cwd, dryRun: true });
      expect(silent.manual.some((finding) => finding.reasonCode === 'manifest-refusal')).toBe(true);
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":');
      const invalid = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(invalid.manual.some((finding) => finding.reasonCode === 'manifest-refusal')).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('9 reports one runtime decision per affected manifest, not per file or comment', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-runtime-count-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=18"}}');
      await writeFile(path.join(cwd, 'one.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('id');");
      await writeFile(path.join(cwd, 'two.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.models.del('id');");
      await writeFile(path.join(cwd, 'comment.ts'), "// openai.files.del('id')\nconst note = 'openai';");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual.filter((finding) => (finding.reasonCode as string | undefined) === 'runtime-confirmation')).toHaveLength(1);
      expect(outcome.manual.some((finding) => finding.file === 'comment.ts')).toBe(false);
      expect(benchmark.runtimeConfirmationFindings(cwd, [{ directory: cwd, supported: false }], outcome)).toHaveLength(1);
      expect(benchmark.runtimeConfirmationFindings(cwd, [{ directory: cwd, supported: false }], { changes: [], manual: [
        { file: 'one.ts', line: 1, reason: 'arbitrary wording', snippet: '', reasonCode: 'runtime-confirmation' },
      ] } as never)).toHaveLength(1);
      const nested = path.join(cwd, 'packages', 'nested');
      const nestedFindings = benchmark.runtimeConfirmationFindings(cwd, [
        { directory: cwd, supported: false }, { directory: nested, supported: false },
      ], { changes: [{ file: 'packages/nested/src/index.ts', line: 1, rule: 'del-to-delete', before: 'del', after: 'delete' }], manual: [] });
      expect(nestedFindings.map((finding) => finding.file)).toEqual(['packages/nested/package.json']);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
