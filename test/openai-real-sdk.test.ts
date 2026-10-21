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
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    const tsconfig = { compilerOptions: { strict: true, noEmit: true,
      skipLibCheck: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
      include: ['files.ts', 'chat.ts', 'stream.ts', 'tools.ts', 'class.ts', 'events.ts', 'moved.ts', 'paths.ts', 'observed.ts', 'beta-chat-types.ts'] };
    await writeFile(tsconfigPath, JSON.stringify(tsconfig));
    const files = new Map([
      ['files.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const remove = () => client.files.del('file_123');\n"],
      ['chat.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const parse = () => client.beta.chat.completions.parse({model:'gpt-4o', messages:[]});\n"],
      ['stream.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const stream = () => client.beta.chat.completions.stream({model:'gpt-4o', messages:[]});\n"],
      ['tools.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const run = () => client.beta.chat.completions.runTools({model:'gpt-4o', messages:[], tools:[]});\n"],
      ['class.ts', "import OpenAI from 'openai';\nclass Service { client: OpenAI; constructor() { this.client = new OpenAI({apiKey: 'sk-test-fixture'}); } run() { return this.client.beta.chat.completions.parse({model:'gpt-4o', messages:[]}); } }\nexport const service = new Service();\n"],
      ['events.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nexport const observe = () => { const runner = client.beta.chat.completions.runTools({model:'gpt-4o', messages:[], tools:[]}); runner.on('functionCall', () => {}); return runner.finalFunctionCall(); };\n"],
      ['moved.ts', "import type { OpenAIError } from 'openai/error';\nexport type MigrationError = OpenAIError;\n"],
      ['deep.ts', "import type { Message, MessageContentText } from 'openai/resources/beta/threads/messages/messages';\nexport type SavedMessage = Message;\nexport type SavedText = MessageContentText;\n"],
      ['paths.ts', "import OpenAI from 'openai';\nconst client = new OpenAI({apiKey: 'sk-test-fixture'});\nconst runs: OpenAI.Beta.Threads.Runs = client.beta.threads.runs;\nexport const retrieveSubresourceRun = (threadId: string, runId: string) => runs.retrieve(threadId, runId);\nexport const retrieveRun = (threadId: string, runId: string) => client.beta.threads.runs.retrieve(threadId, runId);\nexport const retrieveMessage = (threadId: string, messageId: string) => client.beta.threads.messages.retrieve(threadId, messageId);\n"],
      ['beta-chat-types.ts', `import { ChatCompletionStream, ChatCompletionRunner, ChatCompletionStreamingRunner, Completions,
  type ParsedChoice, type ParsedChatCompletionMessage, type ParsedFunctionToolCall,
  type ChatCompletionStreamParams, type ChatCompletionToolRunnerParams } from 'openai/resources/beta/chat/completions';
export type SavedCompletion = ParsedChoice<ParsedChatCompletionMessage<ParsedFunctionToolCall>>;
export type StreamArgs = ChatCompletionStreamParams;
export type ToolArgs = ChatCompletionToolRunnerParams;
export const runtimeTypes = [ChatCompletionStream, ChatCompletionRunner, ChatCompletionStreamingRunner, Completions];
`],
      ['observed.ts', "import OpenAI from 'openai';\nfunction observeOpenAI<T extends OpenAI>(client: T): T { return client; }\nconst createOpenAIClient = async () => observeOpenAI(new OpenAI({apiKey: 'sk-test-fixture'}));\nexport async function parse() { const openai = await createOpenAIClient(); return openai.beta.chat.completions.parse({model:'gpt-4o', messages:[]}); }\n"],
    ]);
    for (const [name, source] of files) await writeFile(path.join(cwd, name), source);
    const install = (version: string) => runRealSdkNpm(cwd, ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', `openai@${version}`, '@types/node@22']);
    const check = async () => {
      try {
        await runRealSdkNode(cwd, [path.join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--project', path.join(cwd, 'tsconfig.json')], 90_000);
      } catch (error) {
        const output = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
        if (error instanceof Error) error.message += `\n${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`;
        throw error;
      }
    };
    await install('4.104.0');
    await check();
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    for (const name of files.keys()) project.addSourceFileAtPath(path.join(cwd, name));
    const result = openaiV5.transform(project);
    expect(result.manual).toEqual([]);
    // Only the truly removed nested message module moves; openai/error remains
    // a deprecated v5 re-export and therefore does not add a changed file.
    expect(result.fileUpdates).toHaveLength(10);
    for (const update of result.fileUpdates ?? []) await writeFile(update.file, update.contents);
    await writeFile(tsconfigPath, JSON.stringify({ ...tsconfig, include: ['*.ts'] }));
    await install('5.0.0');
    await check();
    expect(await readFile(path.join(cwd, 'chat.ts'), 'utf8')).toContain('client.chat.completions.parse');
    expect(await readFile(path.join(cwd, 'stream.ts'), 'utf8')).toContain('client.chat.completions.stream');
    expect(await readFile(path.join(cwd, 'tools.ts'), 'utf8')).toContain('client.chat.completions.runTools');
    expect(await readFile(path.join(cwd, 'class.ts'), 'utf8')).toContain('this.client.chat.completions.parse');
    expect(await readFile(path.join(cwd, 'events.ts'), 'utf8')).toContain("runner.on('functionToolCall'");
    expect(await readFile(path.join(cwd, 'events.ts'), 'utf8')).toContain('runner.finalFunctionToolCall()');
    expect(await readFile(path.join(cwd, 'moved.ts'), 'utf8')).toContain("'openai/error'");
    expect(await readFile(path.join(cwd, 'deep.ts'), 'utf8')).toContain("'openai/resources/beta/threads/messages'");
    expect(await readFile(path.join(cwd, 'deep.ts'), 'utf8')).toContain('TextContentBlock as MessageContentText');
    expect(await readFile(path.join(cwd, 'paths.ts'), 'utf8')).toContain('runs.retrieve(runId, { thread_id: threadId })');
    expect(await readFile(path.join(cwd, 'paths.ts'), 'utf8')).toContain('runs.retrieve(runId, { thread_id: threadId })');
    expect(await readFile(path.join(cwd, 'beta-chat-types.ts'), 'utf8')).toContain("'openai/resources/chat/completions'");
    expect(await readFile(path.join(cwd, 'observed.ts'), 'utf8')).toContain('openai.chat.completions.parse(');
  }, 300_000);

  it('reproduces the v5 tool message content union using the published SDK declarations', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-content-types-'));
    roots.push(cwd);
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { openai: '4.104.0' } }));
    await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
      skipLibCheck: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['index.ts'] }));
    await writeFile(path.join(cwd, 'index.ts'), `import OpenAI from 'openai';
const client = new OpenAI({apiKey:'sk-test-fixture'});
const runner = client.beta.chat.completions.runTools({model:'gpt-4o', messages:[], tools:[]});
for (const message of runner.messages) {
  if (message.role === 'tool' && message.content) {
    if (message.content.startsWith('created node')) console.log(message.content);
  }
}
`);
    const install = (version: string) => runRealSdkNpm(cwd, ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', `openai@${version}`, '@types/node@22']);
    const check = async () => {
      try {
        await runRealSdkNode(cwd, [path.join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--project', path.join(cwd, 'tsconfig.json')]);
      } catch (error) {
        const output = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
        if (error instanceof Error) error.message += `\n${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`;
        throw error;
      }
    };
    await install('4.20.1');
    await check();
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    project.addSourceFileAtPath(path.join(cwd, 'index.ts'));
    const migration = openaiV5.transform(project);
    expect(migration.manual).toEqual([]);
    expect(migration.fileUpdates).toHaveLength(1);
    await writeFile(migration.fileUpdates![0]!.file, migration.fileUpdates![0]!.contents);
    await install('5.0.0');
    let failedOutput = '';
    try { await check(); }
    catch (error) {
      const output = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
      failedOutput = `${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`;
    }
    expect(failedOutput).toContain('ChatCompletionContentPartText');
  }, 300_000);
});
