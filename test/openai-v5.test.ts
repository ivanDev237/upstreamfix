import { describe, expect, it } from 'vitest';
import { Project, ModuleKind, ScriptTarget } from 'ts-morph';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { findApplicableMigrations, migrations } from '../src/migrations/index.js';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('P10 keeps uncertain client aliases manual and recognizes computed path suffixes', () => {
    for (const source of [
      `import OpenAI from 'openai'; let t1: OpenAI = new OpenAI(); [t1] = [fake]; t1.files.del('f');`,
      `import OpenAI from 'openai'; let t2 = new OpenAI(); [t2] = [fake]; t2.files.del('f');`,
      `import OpenAI from 'openai'; const client = new OpenAI(); client[key].threads.runs.retrieve('a', 'b');`,
    ]) {
      const outcome = migrate(source);
      expect(outcome.fileUpdates).toEqual([]);
      expect(outcome.manual.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('P10 allows duplicate imports but gates response helpers and broad path matches', () => {
    const duplicate = migrate(`import type { ThreadMessage } from 'openai/resources/beta/threads/messages/messages'; import { Messages } from 'openai/resources/beta/threads/messages/messages';`);
    expect(duplicate.manual).toEqual([]);
    expect(duplicate.fileUpdates?.[0]?.contents.match(/from 'openai\/resources\/beta\/threads\/messages'/g)).toHaveLength(2);
    const unrelated = migrate(`const openai = 'a note'; this.files.del('f'); this.models.del('m'); const a = client.messages.create().withResponse();`);
    expect(unrelated.manual).toEqual([]);
    const anthropic = migrate(`const a = client.messages.create().withResponse();`);
    expect(anthropic.manual).toEqual([]);
  });

  it('P10 follows chained runTools listeners and reports variable stream listeners', () => {
    const runners = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); const runner = client.beta.chat.completions.runTools({}); runner.on('message', () => {}).on('functionCall', () => {}); client.beta.chat.completions.runTools({}).on('content', () => {}).on('functionCallResult', () => {});`);
    expect(runners.manual).toEqual([]);
    expect(runners.fileUpdates?.[0]?.contents).toContain(".on('functionToolCall'");
    expect(runners.fileUpdates?.[0]?.contents).toContain(".on('functionToolCallResult'");
    const stream = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); const stream = client.beta.chat.completions.stream({}); stream.on('functionCall', () => {});`);
    expect(stream.manual.some((item) => /stream event names/.test(item.reason))).toBe(true);
    const content = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); const stream = client.beta.chat.completions.stream({}); stream.on('content', () => {});`);
    expect(content.manual.some((item) => /stream event names/.test(item.reason))).toBe(false);
  });

  it('holds ambiguous affected method suffixes and ignores unrelated property assignments', () => {
    for (const source of [
      `import OpenAI from 'openai'; const client = new OpenAI(); client[key].threads.runs.retrieve('a', 'b');`,
      `import OpenAI from 'openai'; function f(ctx: any) { ctx.api.threads.runs.retrieve('a', 'b'); }`,
    ]) expect(migrate(source).manual.length).toBeGreaterThan(0);
    const safe = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); client.maxRetries = 3; client.chat.completions.create = vi.fn(); client.files.del('f');`);
    expect(safe.manual).toEqual([]);
    expect(safe.fileUpdates?.[0]?.contents).toContain("client.files.delete('f')");
  });

  it('counts no-substitution require templates as module evidence and scopes response helpers to the receiver', () => {
    const openai = migrate("const OpenAI = require(`openai`); const client = new OpenAI(); client.files.list().withResponse();");
    expect(openai.manual.some((item) => /Web response/.test(item.reason))).toBe(true);
    const anthropic = migrate("import OpenAI from 'openai'; const other = new Anthropic(); other.messages.create().withResponse();");
    expect(anthropic.manual.some((item) => /Web response/.test(item.reason))).toBe(false);
  });

  it('P10 moves beta chat completion type imports removed by OpenAI v5', () => {
    const outcome = migrate(`import type { ChatCompletionStreamParams } from 'openai/resources/beta/chat/completions'; type Result = ChatCompletionStreamParams;`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/resources/chat/completions'");
  });
  it('keeps beta chat imports manual when a named export cannot be confirmed in v5', () => {
    const outcome = migrate(`import { DefinitelyNotExported } from 'openai/resources/beta/chat/completions';`);
    expect(outcome.manual.some((item) => /DefinitelyNotExported/.test(item.reason))).toBe(true);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('does not rewrite methods below an overwritten OpenAI resource prefix', () => {
    const outcome = migrate("import OpenAI from 'openai'; const client = new OpenAI(); client.files = fakeFiles; await client.files.del(id);");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => /overridden|assigned|receiver|resource/i.test(item.reason))).toBe(true);
    const safe = migrate("import OpenAI from 'openai'; const client = new OpenAI(); client.maxRetries = 3; client.chat.completions.create = vi.fn(); client.files.del('f');");
    expect(safe.fileUpdates?.[0]?.contents).toContain("client.files.delete('f')");
    expect(safe.manual).toEqual([]);
  });

  it('holds every affected call when a tracked client escapes through opaque uses', () => {
    for (const source of [
      "import OpenAI from 'openai'; const c = new OpenAI(); Object.assign(c, { files: fake }); c.files.del('x');",
      "import OpenAI from 'openai'; const c = new OpenAI(); c.files.del = vi.fn(); c.files.del('x');",
      "import OpenAI from 'openai'; const c = new OpenAI(); const c2 = c; c2.files = fake; c.files.del('x');",
      "import OpenAI from 'openai'; class Store { client = new OpenAI(); go() { this.client.files = fake; this.client.files.del('x'); } }",
      "import OpenAI from 'openai'; const c = new OpenAI(); c.beta = fake; c.beta.chat.completions.parse({});",
    ]) {
      const outcome = migrate(source);
      expect(outcome.fileUpdates).toEqual([]);
      expect(outcome.manual.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('reports complete affected method paths on short or indexed untracked receivers', () => {
    for (const receiver of ['ctx.openai.files.del', 'ctx.openai.models.del', "list[0].files.del", 'S.client.files.del']) {
      const outcome = migrate(`import OpenAI from 'openai'; ${receiver}('x');`);
      expect(outcome.manual.length, receiver).toBeGreaterThan(0);
      expect(outcome.fileUpdates, receiver).toEqual([]);
    }
  });

  it('keeps downstream stream and runner calls manual after client escape', () => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI();
const runner = client.beta.chat.completions.runTools({}); runner.on('functionCall', () => {}); runner.finalFunctionCall();
const stream = client.beta.chat.completions.stream({}); stream.on('functionCall', () => {});
Object.assign(client, {});`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => /event.*uncertain|runTools/.test(item.reason))).toBe(true);
    expect(outcome.manual.some((item) => /stream event names/.test(item.reason))).toBe(true);
    expect(outcome.manual.some((item) => /finalFunctionCall/.test(item.reason))).toBe(true);
  });

  it('holds typed subresource and direct client calls after extracting a client subresource', () => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI();
const runs: OpenAI.Beta.Threads.Runs = client.beta.threads.runs;
runs.retrieve(threadId, runId); client.beta.threads.runs.retrieve(threadId, runId);`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.snippet.includes('runs.retrieve(threadId, runId)'))).toBe(true);
    expect(outcome.manual.some((item) => item.snippet.includes('client.beta.threads.runs.retrieve'))).toBe(true);
  });

  it('does not flag unrelated this.files methods merely because the file imports OpenAI', () => {
    const outcome = migrate("import OpenAI from 'openai'; class Store { files = { update(a: string, b: string) {} }; go() { this.files.update('a','b'); } }");
    expect(outcome.manual).toEqual([]);
  });

  it('tracks default, aliased and star reexports through barrel graphs', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/lib.ts', "import OpenAI from 'openai'; const client = new OpenAI(); export { client as default, client as ai };");
    project.createSourceFile('/star.ts', "export * from './lib';");
    project.createSourceFile('/consumer.ts', "import c, { ai } from './star'; c.files.del('x'); ai.models.del('y');");
    const outcome = openaiV5.transform(project);
    expect(outcome.manual.length).toBe(0);
    expect(outcome.fileUpdates?.find((item) => item.file === '/consumer.ts')?.contents).toContain('c.files.delete');
  });

  it('keeps runner discovery through default and star reexports stable across cycles', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-star-default-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'lib.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); export { client as default, client as ai };");
      await writeFile(path.join(cwd, 'star.ts'), "export * from './cycle'; export * from './lib';");
      await writeFile(path.join(cwd, 'cycle.ts'), "export * from './star';");
      await writeFile(path.join(cwd, 'consumer.ts'), "import c, { ai } from './star'; c.files.del('x'); ai.models.del('y');");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      const consumer = outcome.proposedFiles.find((item) => item.relativePath === 'consumer.ts');
      expect(consumer?.after).toContain('c.files.delete');
      expect(consumer?.after).toContain('ai.models.delete');
      expect(outcome.manual).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not treat resolved ordinary objects or comment-only OpenAI mentions as SDK evidence', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/lib.ts', "import OpenAI from 'openai'; export const client = new OpenAI(); export const store = { files: { del() {} } };");
    project.createSourceFile('/consumer.ts', "import { store } from './lib'; store.files.del('id');\n// openai\nconst db = getDatabase(); db.messages.delete(a, id); db.files.update(a, id);");
    const outcome = openaiV5.transform(project);
    expect(outcome.fileUpdates?.some((file) => file.file === '/consumer.ts')).toBe(false);
    expect(outcome.manual.filter((item) => item.file === '/consumer.ts')).toEqual([]);
  });

  it('follows client re-exports through barrels and flags unresolved re-exports', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/lib.ts', "import OpenAI from 'openai'; const client = new OpenAI(); export { client };");
    project.createSourceFile('/barrel/index.ts', "export { client } from '../lib';");
    project.createSourceFile('/consumer.ts', "import { client } from './barrel'; client.files.del('id');");
    const outcome = openaiV5.transform(project);
    expect(outcome.fileUpdates?.some((file) => file.file === '/consumer.ts' && file.contents.includes('client.files.delete'))).toBe(true);
    expect(outcome.manual).toEqual([]);
    const unresolved = new Project({ useInMemoryFileSystem: true });
    unresolved.createSourceFile('/barrel.ts', "export { client } from './missing-client';");
    unresolved.createSourceFile('/consumer.ts', "import { client } from './barrel'; client.files.del('id');");
    const uncertain = openaiV5.transform(unresolved);
    expect(uncertain.fileUpdates).toEqual([]);
    expect(uncertain.manual.some((item) => item.file === '/consumer.ts')).toBe(true);
  });

  it('discovers default-plus-named client imports and post-declaration barrel exports', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-post-export-barrel-'));
    try {
      await mkdir(path.join(cwd, 'barrel'));
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'lib.ts'), "import DefaultOpenAI, { OpenAI as SDK } from 'openai'; const client = new SDK(); export { client }; export const defaultClient = new DefaultOpenAI();");
      await writeFile(path.join(cwd, 'barrel', 'index.ts'), "export { client } from '../lib';");
      await writeFile(path.join(cwd, 'consumer.ts'), "import unused, { client } from './barrel'; client.files.del('id');");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'consumer.ts')?.after).toContain("client.files.delete('id')");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('surfaces uncertain barrel re-exports as manual through the CLI source prefilter', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-unresolved-barrel-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'barrel.ts'), "export { client } from './missing-client';\n");
      await writeFile(path.join(cwd, 'consumer.ts'), "import { client } from './barrel'; client.files.del('id');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'consumer.ts')).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'consumer.ts')).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('moves ParsedChatCompletion from the beta chat module because v5 exports it', () => {
    const outcome = migrate("import { ParsedChatCompletion } from 'openai/resources/beta/chat/completions';");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/resources/chat/completions'");
  });

  it('P10 loads local modules that export a constructed OpenAI client end to end', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-local-client-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'lib.ts'), "import { AzureOpenAI as Azure } from 'openai'; export const client = new Azure({ azureADTokenProvider: async () => 'token' });\n");
      await writeFile(path.join(cwd, 'app.ts'), "import { client } from './lib'; client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual).toEqual([]);
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'app.ts')?.after).toContain("client.files.delete('f')");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('ignores unrelated packages and large bundles while following exported local clients', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-source-filter-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}');
      const unrelated = path.join(cwd, 'packages', 'plain');
      await mkdir(unrelated, { recursive: true });
      await writeFile(path.join(unrelated, 'package.json'), '{"name":"plain","dependencies":{"left-pad":"^1.0.0"}}');
      await writeFile(path.join(unrelated, 'plain.ts'), 'export const plain = true;\n');
      await writeFile(path.join(cwd, 'vendor.js'), ' '.repeat(2_400_000));
      await writeFile(path.join(cwd, 'lib.ts'), "import OpenAI from 'openai'; export const client = new OpenAI();\n");
      await writeFile(path.join(cwd, 'app.ts'), "import { client } from './lib'; client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual.some((finding) => finding.file.includes('packages/plain'))).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'vendor.js')).toBe(false);
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'app.ts')?.after).toContain("client.files.delete('f')");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('surfaces path-alias imported clients for manual review when ownership cannot be followed', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-path-alias-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}');
      await mkdir(path.join(cwd, 'src'), { recursive: true });
      await writeFile(path.join(cwd, 'src', 'lib.ts'), "import OpenAI from 'openai'; export const client = new OpenAI();\n");
      await writeFile(path.join(cwd, 'src', 'app.ts'), "import { client } from '@/lib'; client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true });
      expect(outcome.manual.some((finding) => finding.file === 'src/app.ts' && /receiver|récepteur/i.test(finding.reason))).toBe(true);
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'src/app.ts')?.after).toBeUndefined();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not repair Node types unless code in the same package is upgraded with a configured typecheck', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-safe-scope-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"scripts":{"typecheck":"tsc --noEmit"},"engines":{"node":">=18"}}');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":[],"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const untouched = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(untouched.proposedFiles.some((file) => file.relativePath.endsWith('package.json') || file.relativePath.endsWith('tsconfig.json'))).toBe(false);
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const transformed = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(transformed.proposedFiles.some((file) => file.relativePath === 'package.json' || file.relativePath === 'tsconfig.json')).toBe(false);
      expect(transformed.manual.some((finding) => finding.reason.includes('Node.js 20'))).toBe(true);
      expect(new Set(transformed.proposedFiles.map((file) => file.relativePath)).size).toBe(transformed.proposedFiles.length);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('P3.4 requires explicit selection before discovering an experimental OpenAI migration', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-optin-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"}}');
      expect(openaiV5.experimental).toBe(true);
      expect((await findApplicableMigrations(cwd)).map((item) => item.id)).not.toContain('openai@5');
      expect((await findApplicableMigrations(cwd, { includeExperimental: true })).map((item) => item.id)).toContain('openai@5');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('has at least 15 pinned and reviewed public repositories with at least 10 relevant uses', () => {
    const repos = JSON.parse(readFileSync(new URL('../benchmark/openai-5-repos.json', import.meta.url), 'utf8')) as BenchRepo[];
    const validCandidates = repos.filter((repo) => !repo.invalidReason);
    expect(validCandidates.length).toBeGreaterThanOrEqual(15);
    expect(validCandidates.filter((repo) => /beta\.chat|files\.del|moved import|named path/.test(repo.reviewNote)).length).toBeGreaterThanOrEqual(10);
    expect(new Set(repos.map((repo) => repo.url)).size).toBe(repos.length);
    expect(repos.some((repo) => repo.name === 'lumen')).toBe(true);
    expect(repos.some((repo) => repo.name === 'ai-icon-generator')).toBe(true);
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

  it('accepts explicit Node 20 confirmation and includes the runtime declaration in the proposal', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-confirmed-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"}}\n');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.files.del('file_1');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.find((item) => item.relativePath === 'client.ts')?.after).toContain("files.delete('file_1')");
      expect(outcome.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('"node": ">=20"');
      expect(outcome.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('"openai":"^5.0.0"');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports a missing Node type environment outside the OpenAI source file', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { lib: ['ES2022'] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'other.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.file === 'other.ts' && item.reason.includes('@types/node'))).toBe(true);
      expect(outcome.manual.some((item) => item.file === 'tsconfig.json' && item.reason.includes('Web'))).toBe(true);
      expect(outcome.proposedFiles.some((item) => item.relativePath === 'package.json')).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports Node built-ins and globals when their declarations are absent', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-builtins-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), "import { readFile } from 'node:fs'; const data = readFile; const bytes = Buffer.from('x'); console.log(__dirname, __filename, require, global, setImmediate);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.file === 'server.ts' && item.reason.includes('@types/node'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('proposes @types/node itself only when a project typecheck is configured', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-repair-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{\n  "dependencies": { "openai": "^4.28.0" },\n  "scripts": { "typecheck": "tsc --noEmit" },\n  "engines": { "node": ">=20" }\n}\n');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{ "compilerOptions": { "lib": ["ES2022"] } }');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), "import { readFile } from 'node:fs'; console.log(readFile, process.env.NODE_ENV);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after).toContain('"@types/node"');
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after).toMatch(/"devDependencies"\s*:\s*\{\s*"@types\/node"\s*:\s*"\^20\./);
      expect(outcome.manual.some((item) => item.file === 'server.ts' && item.reason.includes('@types/node'))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('withholds automatic Node types when effective types are inherited through extends', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-inherited-types-repair-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"scripts":{"typecheck":"tsc --noEmit"}}');
      await mkdir(path.join(cwd, 'cfg'));
      await writeFile(path.join(cwd, 'cfg', 'base.json'), '{"compilerOptions":{"types":["x"],"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"extends":"./cfg/base.json"}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), "import { readFile } from 'node:fs'; console.log(readFile, process.env.NODE_ENV);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'tsconfig.json')).toBe(false);
      expect(outcome.manual.some((item) => /types are inherited from an extended configuration; add "node" manually/i.test(item.reason))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not auto-add Node types when no typecheck is configured', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-no-check-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), "console.log(process.env.NODE_ENV);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json' && file.after.includes('@types/node'))).toBe(false);
      expect(outcome.manual.some((item) => item.file === 'server.ts' && item.reason.includes('@types/node'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('adds node to a restricted JSONC tsconfig without dropping other ambient types', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-restricted-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"scripts":{"typecheck":"tsc --noEmit"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{\n  "compilerOptions": {\n    // Keep test globals available.\n    "types": ["jest"],\n    "lib": ["ES2022"]\n  }\n}\n');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), "console.log(process.env.NODE_ENV);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      const config = outcome.proposedFiles.find((file) => file.relativePath === 'tsconfig.json')?.after;
      expect(config).toContain('"jest"');
      expect(config).toContain('"node"');
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after).toContain('"@types/node"');
      expect(outcome.manual.some((item) => item.file === 'server.ts' && item.reason.includes('@types/node'))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('keeps Node type repair manual when the lockfile cannot be regenerated safely', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-unsafe-lock-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
        dependencies: { openai: '^4.28.0', 'private-dep': 'git+https://example.invalid/private-dep.git' },
        scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' },
      }));
      await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { openai: '^4.28.0', 'private-dep': 'git+https://example.invalid/private-dep.git' } } } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json' && file.after.includes('@types/node'))).toBe(false);
      expect(outcome.manual.some((item) => item.reason.includes('Git, URL, local, aliased, override'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not read symlinked tsconfig or lockfile contents outside the project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-symlink-config-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-secret-'));
    const sentinel = 'DO_NOT_LEAK_CONFIG_SECRET';
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(outside, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: ['node'], secret: sentinel } }));
      await writeFile(path.join(outside, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { secret: sentinel } } }));
      await symlink(path.join(outside, 'tsconfig.json'), path.join(cwd, 'tsconfig.json'));
      await symlink(path.join(outside, 'package-lock.json'), path.join(cwd, 'package-lock.json'));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => /(?:tsconfig|package-lock|package\.json)$/.test(file.relativePath))).toBe(false);
      expect(outcome.manual.some((finding) => finding.reason.includes('symlinked or out-of-project'))).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain(sentinel);
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it('refuses a tsconfig extends target that is a symlink outside the project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-extends-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-extends-secret-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(outside, 'base.json'), JSON.stringify({ compilerOptions: { types: ['node'], privateSetting: 'EXTENDS_SECRET' } }));
      await symlink(path.join(outside, 'base.json'), path.join(cwd, 'linked-base.json'));
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"extends":"./linked-base.json"}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json' || file.relativePath === 'tsconfig.json')).toBe(false);
      expect(outcome.manual.some((finding) => finding.reason.includes('symlinked or out-of-project'))).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain('EXTENDS_SECRET');
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it('refuses a symlinked lockfile without reading or reporting its target', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-lock-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-lock-secret-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(outside, 'package-lock.json'), '{"lockfileVersion":3,"secret":"LOCK_SECRET"}');
      await symlink(path.join(outside, 'package-lock.json'), path.join(cwd, 'package-lock.json'));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath.endsWith('package.json') || file.relativePath.endsWith('package-lock.json'))).toBe(false);
      expect(outcome.manual.some((finding) => finding.reason.includes('lockfile is symlinked'))).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain('LOCK_SECRET');
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it('keeps nested package findings when only the root package Node types are repaired', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-monorepo-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], lib: ['ES2022'] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const nested = path.join(cwd, 'packages', 'worker');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, devDependencies: { '@types/node': '^18.0.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(nested, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], lib: ['ES2022'] } }));
      await writeFile(path.join(nested, 'worker.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('w'); console.log(process.env.NODE_ENV);\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after).toContain('"@types/node"');
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'packages/worker/package.json')).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'packages/worker/worker.ts' && finding.reason.includes('@types/node'))).toBe(true);
      expect(outcome.changes.filter((change) => change.rule === 'node-types').every((change) => !change.file.includes('packages/worker'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves single-line package.json formatting during the Node type repair', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-format-'));
    const manifest = '{"dependencies":{"openai":"^4.28.0"},"scripts":{"typecheck":"tsc --noEmit"},"engines":{"node":">=20"}}\n';
    try {
      await writeFile(path.join(cwd, 'package.json'), manifest);
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      const updated = outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after;
      expect(updated).toContain('"devDependencies":{"@types/node":"^20.0.0"}');
      expect(updated).toBe('{"dependencies":{"openai":"^5.0.0"},"scripts":{"typecheck":"tsc --noEmit"},"engines":{"node":">=20"}, "devDependencies":{"@types/node":"^20.0.0"}}\n');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves a compact devDependencies object inside a multiline package manifest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-devdeps-format-'));
    try {
      const before = '{\n  "dependencies": {"openai":"^4.28.0"},\n  "devDependencies": {"jest":"^29.0.0"},\n  "scripts": {"typecheck":"tsc --noEmit"},\n  "engines": {"node":">=20"}\n}\n';
      await writeFile(path.join(cwd, 'package.json'), before);
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      const updated = outcome.proposedFiles.find((file) => file.relativePath === 'package.json')?.after;
      expect(updated).toContain('"devDependencies": {"jest":"^29.0.0", "@types/node":"^20.0.0"}');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves an existing trailing comma when appending Node to tsconfig types', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-trailing-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":["jest",],"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      const config = outcome.proposedFiles.find((file) => file.relativePath === 'tsconfig.json')?.after;
      expect(config).toBeUndefined();
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json')).toBe(false);
      expect(outcome.manual.some((finding) => finding.reason.includes('trailing comma'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('returns project-relative paths when process.cwd differs from options.cwd', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-relative-paths-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.filesChanged.every((file) => !path.isAbsolute(file) && file !== '..' && !file.startsWith('../'))).toBe(true);
      expect(outcome.changes.every((change) => !path.isAbsolute(change.file) && !change.file.startsWith('../'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports a manual finding instead of silently skipping a commented Node types array', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-commented-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, scripts: { typecheck: 'tsc --noEmit' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":["jest" /* keep test globals */],"lib":["ES2022"]}}');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(process.env.NODE_ENV);\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true, nodeRuntime: 20 });
      expect(outcome.proposedFiles.some((file) => file.relativePath.endsWith('package.json') || file.relativePath.endsWith('tsconfig.json'))).toBe(false);
      expect(outcome.manual.some((finding) => finding.file === 'tsconfig.json' && finding.reason.includes('comments'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('holds a union client when it has instanceof and branch-assignment references', () => {
    const outcome = migrate(`import OpenAI, { type ClientOptions } from 'openai';
function remove(client: ClientOptions | OpenAI) {
  if (client instanceof OpenAI) client.files.del('f');
  else client.files.del('not-openai');
}`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.snippet.includes("client.files.del('f')"))).toBe(true);
  });

  it('follows an explicitly typed OpenAI receiver through non-null and parenthesized access', () => {
    const outcome = migrate(`import OpenAI from 'openai';
let openAi: OpenAI;
const existing: OpenAI | undefined = undefined;
if (existing instanceof OpenAI) openAi = existing;
else openAi = new OpenAI();
(openAi!).beta.chat.completions.stream({model: 'gpt-4o', messages: []});
`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.snippet.includes('(openAi!).beta.chat'))).toBe(true);
  });

  it('holds a tracked client assigned to another variable', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
let alias;
alias = client;
alias.files.del('f');
`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((finding) => finding.snippet.includes("alias.files.del('f')"))).toBe(true);
  });

  it('keeps an alias manual when any assignment comes from an untracked value', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
declare const other: { files: { del(id: string): void } };
let alias;
alias = client;
alias = other;
alias.files.del('f');
`);
    expect(outcome.manual.some((item) => item.reason.includes('receiver is not tracked safely'))).toBe(true);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('follows JSONC tsconfig extends and detects Node types excluded by compilerOptions.types', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-node-extends-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, devDependencies: { '@types/node': '^22.0.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'base.json'), '{\n  // Keep only project supplied ambient types.\n  "compilerOptions": { "types": [], "lib": ["ES2022"] }\n}\n');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{ "extends": "./base.json", "include": ["**/*.ts"] }\n');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      await writeFile(path.join(cwd, 'server.ts'), 'console.log(Buffer.from(__dirname));\n');
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.file === 'server.ts' && item.reason.includes('compilerOptions.types'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('recognizes inherited DOM libraries as the Web fetch type environment', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-dom-extends-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'base.json'), '{\n  // Browser build includes fetch declarations.\n  "compilerOptions": { "lib": ["DOM", "ES2022"] }\n}\n');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{ "extends": "./base.json", "include": ["**/*.ts"] }\n');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.reason.includes('Web fetch types'))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not flag excluded Node declarations when an inherited DOM library suffices', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-types-dom-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, devDependencies: { '@types/node': '^22.0.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'base.json'), '{\n  "compilerOptions": { "types": [], "lib": ["DOM", "ES2022"] }\n}\n');
      await writeFile(path.join(cwd, 'tsconfig.json'), '{ "extends": "./base.json", "include": ["**/*.ts"] }\n');
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => /compilerOptions\.types|Web fetch types/.test(item.reason))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not infer a TypeScript type error from process in a JavaScript-only project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-js-process-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'server.js'), "const OpenAI = require('openai'); const client = new OpenAI(); console.log(process.env.NODE_ENV); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.reason.includes('@types/node'))).toBe(false);
      expect(outcome.changes.some((change) => change.rule === 'del-to-delete')).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports unsupported TypeScript and Jest versions from the v5 guide', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-tooling-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.28.0' }, devDependencies: { typescript: '4.8.4', jest: '^27.0.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.reason.includes('TypeScript 4.9'))).toBe(true);
      expect(outcome.manual.some((item) => item.reason.includes('Jest 28'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports Node declarations older than v20 when the project excludes DOM types', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-old-node-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, devDependencies: { '@types/node': '16.x' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { lib: ['ES2022'], types: ['node'] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.file === 'package.json' && item.reason.includes('@types/node >=20'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports an obsolete Cloudflare Workers type environment precisely', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-workers-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, devDependencies: { '@cloudflare/workers-types': '0.20210101.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020'], types: [] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.reason.includes('@cloudflare/workers-types >=0.20221111.0'))).toBe(true);
      expect(outcome.manual.some((item) => item.reason.includes('tsconfig') && item.reason.includes('@cloudflare/workers-types'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports Bun types older than the v5 guide requires', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-bun-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, devDependencies: { '@types/bun': '1.1.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.reason.includes('@types/bun >=1.2.0'))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('accepts declared supported Worker and Bun type ranges without a false manual finding', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-runtime-types-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, devDependencies: { '@cloudflare/workers-types': '>=0.20221111.0', '@types/bun': '>=1.2.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020'], types: ['@cloudflare/workers-types'] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => /@cloudflare\/workers-types >=|@types\/bun >=/.test(item.reason))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not block a lower TypeScript target without a proven typecheck error', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'upstreamfix-openai-old-target-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.29.1' }, devDependencies: { '@types/node': '^22.0.0' }, engines: { node: '>=20' } }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['DOM', 'ES2017'] } }));
      await writeFile(path.join(cwd, 'client.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('f');\n");
      const outcome = await runMigration(openaiV5, { cwd, dryRun: true, analysisOnly: true });
      expect(outcome.manual.some((item) => item.file === 'tsconfig.json' && item.reason.includes('ES2018'))).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('rewrites only bound client methods and beta chat paths', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
client.files.del('file_1');
client.beta.chat.completions.parse({model:'gpt-4o', messages:[]});
unrelated.files.del('file_2');
`);
    expect(outcome.manual.some((item) => item.snippet === "unrelated.files.del('file_2')" && item.reason.includes('receiver'))).toBe(true);
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

  it('holds beta chat when its typed variable is reassigned from another value', () => {
    const outcome = migrate(`import { OpenAI, ClientOptions } from 'openai';
function make(obj: ClientOptions | OpenAI) {
  let openAi: OpenAI;
  if (obj instanceof OpenAI) openAi = obj;
  else openAi = new OpenAI(obj);
  return openAi.beta.chat.completions.stream({model: 'gpt-4o', messages: []});
}
`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.snippet.includes('openAi.beta.chat'))).toBe(true);
  });

  it('rewrites a parameter explicitly typed as the imported OpenAI client', () => {
    const outcome = migrate("import type OpenAI from 'openai';\nfunction run(client: OpenAI) { return client.beta.chat.completions.parse({model:'gpt-4o',messages:[]}); }\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('client.chat.completions.parse(');
  });

  it('T33 rewrites an OpenAI constructor property in a NestJS-style service', () => {
    const outcome = migrate("import OpenAI from 'openai';\nclass Service { constructor(private readonly openai: OpenAI) {} run() { return this.openai.files.del('f'); } }\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("this.openai.files.delete('f')");
  });

  it('T33 rewrites a declared class field and a nullable OpenAI value', () => {
    const outcome = migrate("import OpenAI from 'openai';\nclass Service { client!: OpenAI; run() { return this.client.files.del('f'); } }\nlet maybe: OpenAI | undefined;\nmaybe?.files.del('g');\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("this.client.files.delete('f')");
    expect(outcome.fileUpdates?.[0]?.contents).toContain("maybe?.files.delete('g')");
  });

  it('rewrites beta chat on a class field initialized with a new OpenAI client', () => {
    const outcome = migrate("import OpenAI from 'openai';\nclass Service { client = new OpenAI(); run() { return this.client.beta.chat.completions.parse({model:'gpt-4o',messages:[]}); } }\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('this.client.chat.completions.parse(');
  });

  it('does not infer a JavaScript class field can never hold another receiver', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    project.createSourceFile('/client.js', "const OpenAI = require('openai');\nclass Service { client = new OpenAI(); reset(value) { this.client = value; } run() { return this.client.beta.chat.completions.parse({model:'gpt-4o',messages:[]}); } }\n");
    const outcome = openaiV5.transform(project);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('receiver review'))).toBe(true);
  });

  it('holds an affected method on a typed field assigned via this in the constructor', () => {
    const outcome = migrate("import OpenAI from 'openai';\nclass Service { client: OpenAI; constructor() { this.client = new OpenAI(); } run() { return this.client.beta.chat.completions.runTools({model:'gpt-4o',messages:[],tools:[]}); } }\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.snippet.includes('this.client.beta.chat'))).toBe(true);
  });

  it.each([
    ['an object literal method', "class Service { client!: OpenAI; nested = { run() { return this.client.files.del('f'); } }; }"],
    ['a nested function', "class Service { client!: OpenAI; run() { function inner() { return this.client.files.del('f'); } return inner(); } }"],
  ])('does not treat this as a class instance inside %s', (_context, body) => {
    const outcome = migrate(`import OpenAI from 'openai';\n${body}\n`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.map((item) => item.reason).join('\n')).toMatch(/this|receiver|récepteur|manual/i);
  });

  it('keeps lexical this tracking through a nested arrow in a class method', () => {
    const outcome = migrate("import OpenAI from 'openai'; class Service { client!: OpenAI; run() { const inner = () => this.client.files.del('f'); return inner(); } }\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("this.client.files.delete('f')");
  });

  it('tracks an OpenAI instance returned through a local observation factory', () => {
    const outcome = migrate(`import OpenAI from 'openai';
function observeOpenAI<T extends OpenAI>(client: T): T { return client; }
const createOpenAIClient = async () => observeOpenAI(new OpenAI());
async function run() {
  const openai = await createOpenAIClient();
  return openai.beta.chat.completions.parse({model: 'gpt-4o', messages: []});
}
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('openai.chat.completions.parse(');
  });

  it('tracks a directly constructed OpenAI client exported from a local module', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/convex/index.ts', `import OpenAI from 'openai';
export const openai = new OpenAI();
`);
    project.createSourceFile('/convex/agents.ts', `import { openai } from '.';
export const result = openai.beta.chat.completions.parse({ model: 'gpt-4o', messages: [] });
`);
    const outcome = openaiV5.transform(project);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.find((update) => update.file.endsWith('/convex/agents.ts'))?.contents)
      .toContain('openai.chat.completions.parse');
  });

  it('T33 reports destructured typed clients and bound runner methods instead of silently upgrading', () => {
    const outcome = migrate("import OpenAI from 'openai';\nfunction run({ files }: OpenAI) { files.del('f'); }\nconst client = new OpenAI();\nconst runner = client.chat.completions.runTools({tools: []});\nrunner.finalFunctionCall.bind(runner);\nconst { finalFunctionCall } = runner;\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toMatch(/valeur OpenAI non suivie/);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('finalFunctionToolCall');
  });

  it('withholds the removed fileFromPath export instead of moving it to an invalid module', () => {
    const outcome = migrate("import { fileFromPath } from 'openai/uploads';\nfileFromPath('/tmp/x');\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('fileFromPath'))).toBe(true);
  });

  it('moves the removed deep beta resource module and renames its moved type', () => {
    const outcome = migrate("import type { Message } from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = Message;\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/resources/beta/threads/messages'");
  });

  it('renames the moved MessageContentText type while preserving its local binding', () => {
    const outcome = migrate("import type { MessageContentText } from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = MessageContentText;\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('TextContentBlock as MessageContentText');
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/resources/beta/threads/messages'");
    expect(outcome.fileUpdates?.[0]?.contents).toContain('export type Saved = MessageContentText');
  });

  it('preserves inline type modifiers and renames all moved message type imports', () => {
    const outcome = migrate("import { type MessageContentText as TextPart, type ThreadMessage as LegacyMessage, type MessageContentImageFile as ImagePart } from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = [TextPart, LegacyMessage, ImagePart];\n");
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(outcome.manual).toEqual([]);
    expect(output).toContain("import { type TextContentBlock as TextPart, type Message as LegacyMessage, type ImageFileContentBlock as ImagePart } from 'openai/resources/beta/threads/messages'");
  });

  it('renames moved message types referenced through a namespace import', () => {
    const outcome = migrate("import * as Messages from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = Messages.MessageContentText | Messages.ThreadMessage | Messages.MessageContentImageFile;\n");
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(output).toContain("from 'openai/resources/beta/threads/messages'");
    expect(output).toContain('Messages.TextContentBlock');
    expect(output).toContain('Messages.Message');
    expect(output).toContain('Messages.ImageFileContentBlock');
    expect(output).not.toContain('Messages.ThreadMessage');
  });

  it('renames moved message types in public re-exports', () => {
    const outcome = migrate("export type { MessageContentText, ThreadMessage, MessageContentImageFile } from 'openai/resources/beta/threads/messages/messages';\n");
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(output).toContain('export type { TextContentBlock as MessageContentText');
    expect(output).toContain('Message as ThreadMessage');
    expect(output).toContain('ImageFileContentBlock as MessageContentImageFile');
    expect(output).toContain("from 'openai/resources/beta/threads/messages'");
  });

  it('renames message types in import type queries', () => {
    const outcome = migrate("export type Saved = import('openai/resources/beta/threads/messages/messages').ThreadMessage;\n");
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(output).toContain("import('openai/resources/beta/threads/messages').Message");
    expect(output).not.toContain('ThreadMessage');
  });

  it.each([
    "export { fileFromPath } from 'openai/uploads';\n",
    "const { fileFromPath: upload } = require('openai/uploads');\nupload('/tmp/x');\n",
    "import * as uploads from 'openai/uploads';\nuploads.fileFromPath('/tmp/x');\n",
    "const uploads = require('openai/uploads');\nuploads['fileFromPath']('/tmp/x');\n",
  ])('T32 withholds every removed fileFromPath form: %s', (source) => {
    const outcome = migrate(source);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('fileFromPath'))).toBe(true);
  });

  it('flags changed path calls, destructured subclients and aliased runner methods', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
client.beta.threads.runs.submitToolOutputsStream('run', 'thread', {tool_outputs: []});
const { vectorStores } = client;
const runner = client.chat.completions.runTools({tools: []});
const finish = runner.finalFunctionCall;
`);
    expect(outcome.fileUpdates).toEqual([]);
    const reasons = outcome.manual.map((item) => item.reason).join(' ');
    expect(reasons).toMatch(/named path|path parameters/);
    expect(reasons).toContain('subclient');
    expect(reasons).toContain('finalFunctionToolCall');
  });
  it('withholds spread delete arguments whose v5 path shape cannot be proven', () => {
    const outcome = migrate("import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.vectorStores.files.del(...args);\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('path parameters'))).toBe(true);
  });

  it('rewrites tracked retrieve calls with exact known OpenAI named path parameters', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
client.beta.threads.runs.retrieve(threadId, runId);
client.beta.threads.messages.retrieve(threadId, messageId);
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('runs.retrieve(runId, { thread_id: threadId })');
    expect(outcome.fileUpdates?.[0]?.contents).toContain('messages.retrieve(messageId, { thread_id: threadId })');
  });

  it('rewrites the real Threads retrieve and submitToolOutputs path shapes', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
async function poll(threadId: string, run: OpenAI.Beta.Threads.Runs.Run) {
  await client.beta.threads.runs.retrieve(threadId!, run.id);
  await client.beta.threads.runs.submitToolOutputs(threadId!, run.id, { tool_outputs: [] });
}
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('runs.retrieve(run.id, { thread_id: threadId! })');
    expect(outcome.fileUpdates?.[0]?.contents).toContain('runs.submitToolOutputs(run.id, { ...({ tool_outputs: [] }), thread_id: threadId! })');
  });

  it('keeps named path calls manual when the OpenAI client receiver is untracked', () => {
    const outcome = migrate(`import OpenAI from 'openai';
declare function createClient(): OpenAI;
const client = createClient();
client.beta.threads.runs.retrieve(threadId, runId);
`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('receiver'))).toBe(true);
  });

  it.each([
    ['a tsconfig path alias', "import { client } from '@/lib/openai'; client.files.del('f');"],
    ['a computed OpenAI method name', "import OpenAI from 'openai'; const client = new OpenAI(); client['files'][method]('f');"],
    ['a computed method name on an aliased client', "import { client } from '@/lib/openai'; client['files'][method]('f');"],
    ['computed method access', "import OpenAI from 'openai'; const client = new OpenAI(); client['files']['del']('f');"],
    ['a bound deleted method', "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del.call(client.files, 'f');"],
    ['an applied changed method', "import OpenAI from 'openai'; const client = new OpenAI(); client.beta.threads.runs.retrieve.apply(client.beta.threads.runs, [threadId, runId]);"],
  ])('keeps an affected untracked receiver manual for %s', (_case, source) => {
    const outcome = migrate(source);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.map((item) => item.reason).join('\n')).toMatch(/receiver|récepteur|suivi|manual/i);
  });

  it('tracks AzureOpenAI and typed OpenAI Runs subresources', () => {
    const outcome = migrate(`import { AzureOpenAI, type OpenAI } from 'openai';
const client = new AzureOpenAI({ endpoint: 'https://example.invalid', apiKey: 'x' });
client.files.del('f');
declare const runs: OpenAI.Beta.Threads.Runs;
runs.retrieve(threadId, runId);
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("client.files.delete('f')");
    expect(outcome.fileUpdates?.[0]?.contents).toContain('runs.retrieve(runId, { thread_id: threadId })');
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

  it.each([
    ["client.files.retrieve(encodeURIComponent(id));", 'URI'],
    ["client.files.list({ headers: { 'X-Test': '1' } });", 'request options'],
    ["client.files.list().then(page => page.nextPageParams());", 'pagination'],
    ["client.files.retrieve('id').asResponse().then(response => response.body.pipe(out));", 'Web'],
  ])('flags official guide behavior changes: %s', (usage, expected) => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); ${usage}`);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain(expected);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('flags removed APIClient, root openai/src, runtime page classes, and Zod optionality', () => {
    const cases = [
      "import { APIClient } from 'openai/core';",
      "import OpenAI from 'openai/src';",
      "import { FineTuningJobsPage } from 'openai/resources/fine-tuning/jobs'; console.log(FineTuningJobsPage);",
      "import { zodResponseFormat } from 'openai/helpers/zod'; const schema = zodResponseFormat(z.object({ name: z.string().optional() }), 'x');",
    ];
    for (const source of cases) {
      const outcome = migrate(source);
      expect(outcome.manual.length, source).toBeGreaterThan(0);
      expect(outcome.fileUpdates, source).toEqual([]);
    }
  });

  it.each(['BlobPart', 'BlobLike', 'FileLike', 'ResponseLike', 'isResponseLike', 'isBlobLike',
    'isFileLike', 'isUploadable', 'isMultipartBody', 'maybeMultipartFormRequestOptions',
    'multipartFormRequestOptions', 'createForm'])('keeps removed uploads export %s for manual review', (name) => {
    const outcome = migrate(`import { ${name} } from 'openai/uploads';\nconsole.log(${name});\n`);
    expect(outcome.manual.some((item) => item.reason.includes(name))).toBe(true);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('flags indirect URI pre-encoding and request options stored in a variable', () => {
    const source = "import OpenAI from 'openai'; const client = new OpenAI(); const id = encodeURIComponent(raw); const options = { headers: { 'X-Test': '1' } }; client.files.retrieve(id); client.files.list(options);";
    const outcome = migrate(source);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('URI');
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('request options');
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('flags APIError.headers access and a direct openai/core import for review', () => {
    const source = "import OpenAI, { APIError } from 'openai'; import { APIPromise } from 'openai/core'; function read(error: APIError) { return error.headers['x']; }";
    const outcome = migrate(source);
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('Headers');
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('openai/core');
  });

  it('flags aliased httpAgent configuration and removed uploads exports in CommonJS', () => {
    const outcome = migrate("import OpenAI from 'openai'; const options = { httpAgent: agent }; const client = new OpenAI(options); const { BlobPart } = require('openai/uploads');");
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('httpAgent');
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('BlobPart');
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('flags the exact openai/shims import and Web response helper use', () => {
    const outcome = migrate("import 'openai/shims'; import OpenAI from 'openai'; const client = new OpenAI(); const value = client.files.list().withResponse();");
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('shim');
    expect(outcome.manual.map((item) => item.reason).join(' ')).toContain('Web');
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

  it('applies independent safe edits while retaining unrelated manual findings', () => {
    const outcome = migrate(`import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
const client = new OpenAI();
client.files.del('f');
client.vectorStores.files.del('vs', 'f');
client.beta.chat.completions.parse({ model: 'gpt-4o', messages: [], response_format: zodResponseFormat(z.object({ name: z.string().optional() }), 'x') });
`);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("client.files.delete('f')");
    expect(outcome.fileUpdates?.[0]?.contents).toContain('client.chat.completions.parse');
    expect(outcome.manual.some((item) => item.reason.includes('path parameters'))).toBe(true);
    expect(outcome.manual.some((item) => item.reason.includes('optional Zod'))).toBe(true);
    expect(outcome.manual.some((item) => item.reason.includes('withheld'))).toBe(false);
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

  it('keeps deprecated re-export and CommonJS module paths stable', () => {
    const outcome = migrate("export { OpenAIError } from 'openai/error';\nconst errors = require('openai/error');\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('rewrites literal v4 runTools event and final method names from the official guide', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
const runner = client.chat.completions.runTools({tools: []});
runner.on('functionCall', () => {});
runner.finalFunctionCall();
`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("runner.on('functionToolCall'");
    expect(outcome.fileUpdates?.[0]?.contents).toContain('runner.finalFunctionToolCall()');
  });

  it('holds a runTools event name stored in a variable for manual review', () => {
    const outcome = migrate("import OpenAI from 'openai'; const client = new OpenAI(); const runner = client.chat.completions.runTools({tools: []}); const event = 'functionCall'; runner.on(event, () => {});\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('runTools event'))).toBe(true);
  });

  it.each([
    ['functionCall', 'functionToolCall'],
    ['functionCallResult', 'functionToolCallResult'],
    ['finalFunctionCall', 'finalFunctionToolCall'],
    ['finalFunctionCallResult', 'finalFunctionToolCallResult'],
  ])('renames the direct runTools event %s to %s', (before, after) => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); const runner = client.chat.completions.runTools({tools: []}); runner.on('${before}', () => {});\n`);
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain(`runner.on('${after}'`);
  });

  it('renames both direct final methods but keeps a bound method manual', () => {
    const direct = migrate("import OpenAI from 'openai'; const client = new OpenAI(); const runner = client.chat.completions.runTools({tools: []}); runner.finalFunctionCall(); runner.finalFunctionCallResult();\n");
    expect(direct.manual).toEqual([]);
    expect(direct.fileUpdates?.[0]?.contents).toContain('runner.finalFunctionToolCall()');
    expect(direct.fileUpdates?.[0]?.contents).toContain('runner.finalFunctionToolCallResult()');
    const bound = migrate("import OpenAI from 'openai'; const client = new OpenAI(); const runner = client.chat.completions.runTools({tools: []}); const fn = runner.finalFunctionCall.bind(runner);\n");
    expect(bound.fileUpdates).toEqual([]);
    expect(bound.manual.some((item) => item.reason.includes('bound or aliased'))).toBe(true);
  });

  it('does not rename runTools-shaped methods on unrelated receivers', () => {
    const outcome = migrate(`import OpenAI from 'openai';
const client = new OpenAI();
const agent = { runTools() { return { on() {}, finalFunctionCall() {} }; } };
agent.runTools({}).on('functionCall');
agent.runTools({}).finalFunctionCall();
client.chat.completions.runTools({tools: []}).on('functionCall');
`);
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(output).toContain("agent.runTools({}).on('functionCall')");
    expect(output).toContain('agent.runTools({}).finalFunctionCall()');
    expect(output).toContain(".on('functionToolCall')");
  });

  it.each(['vi.mock', 'jest.mock', 'declare module', 'import'])('keeps deprecated openai subpath %s references in place', (kind) => {
    const source = kind === 'import' ? "import type { Stream } from 'openai/streaming';" : `${kind}('openai/streaming');`;
    const outcome = migrate(`${source}\n`);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it('holds a necessary deep import move when the old path also names a mock', () => {
    const outcome = migrate("import type { MessageContentText } from 'openai/resources/beta/threads/messages/messages';\nvi.mock('openai/resources/beta/threads/messages/messages');\n");
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('old specifier also appears elsewhere'))).toBe(true);
  });

  it.each([
    '[client] = [other];',
    '({ client } = other);',
    'client ??= other;',
    'client ||= other;',
    'client &&= other;',
    'for (client of clients) { client.files.del("x"); }',
  ])('invalidates client aliases after complex assignment: %s', (assignment) => {
    const outcome = migrate(`import OpenAI from 'openai'; const original = new OpenAI(); let client = original; declare const other: any; ${assignment}\nclient.files.del('x');`);
    expect(outcome.fileUpdates).toEqual([]);
    expect(outcome.manual.some((item) => item.reason.includes('receiver is not tracked safely'))).toBe(true);
  });

  it.each([
    "chunk.choices[0]?.delta?.content?.toLowerCase()",
    "message.tool_calls[0].function.name.startsWith('x')",
    "models.records[0].get('m').split(';').filter(Boolean)",
    'args[0].toString()',
    'decorator.getArguments()[0].toString()',
    "completion.choices[0]?.message?.content?.trim()",
    "headers.map((h) => String(row[h])).join(', ')",
    'expect(response.choices[0].message).toBeTruthy()',
    "handlers['x']()",
  ])('does not flag unrelated computed access: %s', (snippet) => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); const value = ${snippet}; client.models.list();`);
    expect(outcome.manual).toEqual([]);
  });

  it.each([
    "client[key].beta.threads.runs.retrieve('a', 'b')",
    "openai['chat'].completions.create({model:'x', messages:[]})",
    "deps.openai.beta.threads.runs.retrieve('a', 'b')",
  ])('flags affected method suffixes behind dynamic and aliased paths: %s', (snippet) => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); declare const deps: any; declare const S: any; declare const key: string; ${snippet};`);
    expect(outcome.manual.length).toBeGreaterThan(0);
  });

  it('does not infer this as an OpenAI receiver without a tracked client field', () => {
    const outcome = migrate("import OpenAI from 'openai'; class Store { go() { this.services.openai.files.del('id'); } }");
    expect(outcome.manual).toEqual([]);
  });

  it.each(["ctx.openai.files.del('x')", "ctx.openai.models.del('id')", "list[0].files.del('x')", "S.client.files.del('id')"])
    ('reports complete affected method paths from OpenAI import evidence at any depth: %s', (snippet) => {
      const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); declare const ctx: any; declare const list: any[]; declare const S: any; ${snippet};`);
      expect(outcome.manual.length).toBeGreaterThan(0);
      expect(outcome.fileUpdates).toEqual([]);
    });

  it('tracks OpenAI clients imported from another local module without the openai token', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/lib.ts', "import OpenAI from 'openai'; export const client = new OpenAI();");
    project.createSourceFile('/consumer.ts', "import { client } from './lib'; client.files.del('f');");
    const outcome = openaiV5.transform(project);
    expect(outcome.fileUpdates?.some((file) => file.file === '/consumer.ts' && file.contents.includes("client.files.delete('f')"))).toBe(true);
  });

  it('follows explicit OpenAI aliases and reports complete affected paths on uncertain receivers', () => {
    const typed = migrate("import OpenAI from 'openai'; type Client = OpenAI; declare const receiver: Client; receiver.files.del('f');");
    expect(typed.fileUpdates?.[0]?.contents).toContain('receiver.files.delete');
    for (const type of ['any', 'ReturnType<typeof makeClient>', 'Array<$OpenAI>']) {
      const outcome = migrate(`import OpenAI from 'openai'; declare const receiver: ${type}; receiver.files.del('f');`);
      expect(outcome.manual.length).toBeGreaterThan(0);
    }
  });

  it('preserves optional call, type arguments, and comments in named path rewrites', () => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI();
client.beta.threads.runs.retrieve?.<string>(/* thread */ threadId, runId);`);
    const output = outcome.fileUpdates?.[0]?.contents ?? '';
    expect(output).toContain('retrieve?.<string>(/* thread */ runId, { thread_id: threadId })');
  });

  it.each([
    "client.vectorStores.files.poll('store', 'file')",
    "client.vectorStores.fileBatches.poll('store', 'batch')",
    "client.vectorStores.fileBatches.uploadAndPoll('store', files)",
    "client.vectorStores.files.uploadAndPoll('store', files)",
  ])('flags vector store polling helpers pending v5 signature review: %s', (call) => {
    const outcome = migrate(`import OpenAI from 'openai'; const client = new OpenAI(); ${call};`);
    expect(outcome.manual.length).toBeGreaterThan(0);
    expect(outcome.fileUpdates).toEqual([]);
  });

  it.each(['RunnableFunction', 'RunnableFunctionWithParse', 'RunnableFunctionWithoutParse', 'ChatCompletionRunFunctionsParams'])
    ('flags removed v4 type %s for manual review', (name) => {
      const outcome = migrate(`import OpenAI from 'openai'; type Legacy = OpenAI.${name};`);
      expect(outcome.manual.length).toBeGreaterThan(0);
      expect(outcome.fileUpdates).toEqual([]);
    });

  it('flags Web Headers access after an OpenAI.APIError instance check', () => {
    const outcome = migrate(`import OpenAI from 'openai';
function read(error: unknown) { if (error instanceof OpenAI.APIError) return error.headers['x-request-id']; }
`);
    expect(outcome.manual.some((item) => item.reason.includes('Headers.get'))).toBe(true);
  });

  it('flags OpenAI Beta Chat Completions type paths and function-call stream events', () => {
    const outcome = migrate(`import OpenAI from 'openai';
type Legacy = OpenAI.Beta.Chat.Completions.ChatCompletionMessageParam;
const client = new OpenAI(); client.beta.chat.completions.stream({model:'gpt-4o', messages:[]}).on('functionCall', () => {}).finalFunctionCall();
`);
    expect(outcome.manual.some((item) => item.reason.includes('type'))).toBe(true);
    expect(outcome.manual.some((item) => item.reason.includes('function-call'))).toBe(true);
  });

  it('flags TypeScript import-equals OpenAI interop for manual review', () => {
    const outcome = migrate("import OpenAI = require('openai'); const client = new OpenAI(); client.files.del('f');");
    expect(outcome.manual.some((item) => item.reason.includes('import-equals'))).toBe(true);
  });
});
