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
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
