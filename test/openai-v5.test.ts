import { describe, expect, it } from 'vitest';
import { Project, ModuleKind, ScriptTarget } from 'ts-morph';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { migrations } from '../src/migrations/index.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigration } from '../src/core/runner.js';
import { validateRepoEntry, type BenchRepo } from '../scripts/benchmark.js';

function migrate(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/client.ts', source);
  return openaiV5.transform(project);
}

describe('openai v4 to v5', () => {
  it('has five pinned and reviewed public repositories for the real benchmark', () => {
    const repos = JSON.parse(readFileSync(new URL('../benchmark/openai-5-repos.json', import.meta.url), 'utf8')) as BenchRepo[];
    expect(repos).toHaveLength(5);
    for (const repo of repos) validateRepoEntry(repo);
  });
  it('registers one exact major transition and updates only v4 manifests', () => {
    expect(migrations.map((migration) => migration.id)).toContain('openai@5');
    const manifest = { dependencies: { openai: '^4.0.0' }, engines: { node: '>=20' } };
    expect(openaiV5.updateManifest?.(manifest)).toContain('`dependencies.openai`: `^4.0.0` → `^5.0.0`');
    expect(manifest.dependencies.openai).toBe('^5.0.0');
  });

  it('does not upgrade a project whose declared runtime includes unsupported Node versions', () => {
    const manifest = { dependencies: { openai: '^4.20.0' }, engines: { node: '>=18' } };
    expect(openaiV5.updateManifest?.(manifest).join(' ')).toContain('Node.js 20');
    expect(manifest.dependencies.openai).toBe('^4.20.0');
  });

  it.each([undefined, '>=18'])('does not rewrite v4 code when engines.node is %s and the SDK cannot upgrade', async (nodeRange) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-engine-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.0.0' }, ...(nodeRange ? { engines: { node: nodeRange } } : {}) }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.files.del('file_1');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.proposedFiles).toEqual([]);
      expect(outcome.changes).toEqual([]);
      expect(outcome.manual.some((item) => item.reason.includes('Node.js 20'))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rewrites only bound client methods and beta chat paths', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
client.files.del('file_1');
client.beta.chat.completions.parse({model:'gpt-4o', messages:[]});
unrelated.files.del('file_2');
`);
    expect(outcome.manual).toEqual([]);
    const next = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(next).toContain("client.files.delete('file_1')");
    expect(next).toContain('client.chat.completions.parse(');
    expect(next).toContain("unrelated.files.del('file_2')");
  });

  it('does not rewrite a shadowing parameter with the same name as an OpenAI client', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
function unrelated(client: { files: { del(id: string): void } }) { client.files.del('other'); }
client.files.del('real');
`);
    expect(outcome.manual).toEqual([]);
    const next = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(next).toContain("client.files.del('other')");
    expect(next).toContain("client.files.delete('real')");
  });

  it('rewrites beta chat on a client declared with the imported OpenAI type', () => {
    const outcome = migrate(`import { OpenAI, ClientOptions } from 'openai';
function make(obj: ClientOptions | OpenAI) {
  let openAi: OpenAI;
  if (obj instanceof OpenAI) openAi = obj;
  else openAi = new OpenAI(obj);
  return openAi.beta.chat.completions.stream({model: 'gpt-4o', messages: []});
}
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('openAi.chat.completions.stream(');
  });

  it('reports semantic changes without guessing a rewrite', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI({httpAgent: agent});
client.chat.completions.runFunctions({functions: []});
client.vectorStores.files.retrieve('store', 'file');
`);
    expect(outcome.manual.map((item) => item.reason).join('\n')).toMatch(/httpAgent|runFunctions|named path/);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('withholds multi-argument del calls whose v5 path parameters changed', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
client.vectorStores.files.del('vs_1', 'file_1');
client.beta.threads.messages.del('thread_1', 'message_1');
client.fineTuning.checkpoints.permissions.del('checkpoint_1', 'permission_1');
client.evals.runs.del('eval_1', 'run_1');
client.containers.files.del('container_1', 'file_1');
`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual).toHaveLength(5);
    expect(outcome.manual.every((item) => item.reason.includes('path parameters'))).toBe(true);
  });

  it('reports otherwise safe edits withheld because the same file has a manual item', () => {
    const outcome = migrate("import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.files.del('f');\nclient.vectorStores.files.del('vs', 'f');\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('del-to-delete') && item.reason.includes('withheld'))).toBe(true);
  });

  it('withholds edits from malformed files', () => {
    const outcome = migrate("import OpenAI from 'openai';\nconst client = new OpenAI(\nclient.files.del('x');\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('syntax'))).toBe(true);
  });

  it('does not confuse semantic top-level-await errors with syntax corruption', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2019 } });
    project.createSourceFile('/client.ts', `import OpenAI from 'openai';
const client = new OpenAI();
await Promise.resolve();
client.files.del('file_1');
`);
    const outcome = openaiV5.transform(project);
    expect(outcome.manual.some((item) => item.reason.includes('syntax'))).toBe(false);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("client.files.delete('file_1')");
  });

  it.each([
    "import OpenAI from 'openai'; class S { client = new OpenAI(); run() { return this.client.files.del('f'); } }",
    "const { OpenAI } = require('openai'); const client = new OpenAI(); client.files.del('f');",
    "import * as oa from 'openai'; const client = new oa.OpenAI(); client.files.del('f');",
    "import OpenAI from 'openai'; const client = new OpenAI(); client.beta.threads.runs.poll('r', {thread_id:'t'});",
    "import OpenAI from 'openai'; const client = new OpenAI(); client.beta.threads.runs.submitToolOutputsAndPoll('r', {thread_id:'t'});",
    "import OpenAI from 'openai'; const client = new OpenAI(); client.containers.files.retrieve('container_1', 'file_1');",
    "import OpenAI from 'openai'; const client = new OpenAI(); const vs = client.vectorStores; vs.files.del('vs', 'file');",
    "import { fileFromPath } from 'openai'; fileFromPath('/tmp/a');",
  ])('flags an unsupported v4 usage explicitly: %s', (source) => {
    const outcome = migrate(source);
    expect(outcome.manual.length).toBeGreaterThan(0);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('updates moved re-exports and CommonJS module paths', () => {
    const outcome = migrate("export { OpenAIError } from 'openai/error';\nconst errors = require('openai/error');\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/core/error'");
    expect(outcome.fileUpdates?.[0]?.contents).toContain("require('openai/core/error')");
  });

  it('flags v4 runTools event and final method names for manual review', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
const runner = client.chat.completions.runTools({tools: []});
runner.on('functionCall', () => {});
runner.finalFunctionCall();
`);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toMatch(/functionToolCall/);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toMatch(/finalFunctionToolCall/);
    expect(outcome.fileUpdates).toEqual([]);
  });
});
