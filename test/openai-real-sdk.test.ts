import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';
import { runRealSdkNpm, runRealSdkNode } from './helpers/real-sdk-command.js';

const roots: string[] = [];
const enabled = process.env.UPSTREAMFIX_RUN_REAL_SDK_TESTS === '1';
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe.skipIf(!enabled)('OpenAI v4 to v5 against published SDKs', () => {
  it('compiles multiple files before and after migration', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-sdk-'));
    roots.push(cwd);
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { openai: '4.104.0' } }));
    await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
      skipLibCheck: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['*.ts'] }));
    const files = new Map([
      ['files.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const remove = () => client.files.del('file_123');\n"],
      ['chat.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const parse = () => client.beta.chat.completions.parse({model:'gpt-4o', messages:[]});\n"],
      ['stream.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const stream = () => client.beta.chat.completions.stream({model:'gpt-4o', messages:[]});\n"],
      ['tools.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const run = () => client.beta.chat.completions.runTools({model:'gpt-4o', messages:[], tools:[]});\n"],
      ['class.ts', "import OpenAI from 'openai';\nclass Service { client: OpenAI; constructor() { this.client = new OpenAI({apiKey: 'sk-test-fixture'}); } run() { return this.client.beta.chat.completions.parse({model:'gpt-4o', messages:[]}); } }\nexport const service = new Service();\n"],
      ['moved.ts', "import type { OpenAIError } from 'openai/error';\nexport type MigrationError = OpenAIError;\n"],
    ]);
    for (const [name, source] of files) await writeFile(path.join(cwd, name), source);
    const install = (version: string) => runRealSdkNpm(cwd, ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', `openai@${version}`, '@types/node@22']);
    const check = () => runRealSdkNode(cwd, [path.join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--project', path.join(cwd, 'tsconfig.json')], 90_000);
    await install('4.104.0');
    await check();
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    for (const name of files.keys()) project.addSourceFileAtPath(path.join(cwd, name));
    const result = openaiV5.transform(project);
    expect(result.manual).toEqual([]);
    expect(result.fileUpdates).toHaveLength(6);
    for (const update of result.fileUpdates ?? []) await writeFile(update.file, update.contents);
    await install('5.0.0');
    await check();
    expect(await readFile(path.join(cwd, 'chat.ts'), 'utf8')).toContain('client.chat.completions.parse');
    expect(await readFile(path.join(cwd, 'stream.ts'), 'utf8')).toContain('client.chat.completions.stream');
    expect(await readFile(path.join(cwd, 'tools.ts'), 'utf8')).toContain('client.chat.completions.runTools');
    expect(await readFile(path.join(cwd, 'class.ts'), 'utf8')).toContain('this.client.chat.completions.parse');
    expect(await readFile(path.join(cwd, 'moved.ts'), 'utf8')).toContain("'openai/core/error'");
  }, 300_000);
});
