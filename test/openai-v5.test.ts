import { describe, expect, it } from 'vitest';
import { Project, ModuleKind, ScriptTarget } from 'ts-morph';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { findApplicableMigrations, migrations } from '../src/migrations/index.js';
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

  it('rewrites beta chat on a typed field assigned a client in the constructor', () => {
    const outcome = migrate("import OpenAI from 'openai';\nclass Service { client: OpenAI; constructor() { this.client = new OpenAI(); } run() { return this.client.beta.chat.completions.runTools({model:'gpt-4o',messages:[],tools:[]}); } }\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('this.client.chat.completions.runTools(');
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

  it('moves the removed deep beta resource import to its unique public v5 module', () => {
    const outcome = migrate("import type { Message } from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = Message;\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/resources/beta/threads/messages'");
  });

  it('renames the moved MessageContentText type while preserving its local binding', () => {
    const outcome = migrate("import type { MessageContentText } from 'openai/resources/beta/threads/messages/messages';\nexport type Saved = MessageContentText;\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain('TextContentBlock as MessageContentText');
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

  it('updates moved re-exports and CommonJS module paths', () => {
    const outcome = migrate("export { OpenAIError } from 'openai/error';\nconst errors = require('openai/error');\n");
    expect(outcome.manual).toEqual([]);
    expect(outcome.fileUpdates?.[0]?.contents).toContain("from 'openai/core/error'");
    expect(outcome.fileUpdates?.[0]?.contents).toContain("require('openai/core/error')");
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
});
