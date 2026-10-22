import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { analyzeBenchmarkMigration, assertPinnedCommitIsBranchAncestor, benchmarkOne, buildBenchmarkInstallDockerArgs, compilerRegressionFindings, confirmBenchmarkNodeRuntime, containerEnvArgs, countLogicalMigrationGroups, countNodeTypesGroups, countRuntimeConfirmationFindings, runtimeConfirmationFindings, installArgs, parseBenchmarkArgs, prepareBenchmarkCache, readBenchmarkManifest, readBenchmarkRepos, renderBenchmarkReport, requiresRuntimeReviewFromNotes, hasVerificationRegression, resolveBenchmarkConfig, resolveDockerLimits, validatePackageManagerField, validatePatchPaths, validateRepoEntry } from '../scripts/benchmark.js';

it('P3.4 marks the LUMEN pass-to-fail typecheck as needing review', () => {
  expect(hasVerificationRegression('pass', 'fail: src/components/ErrorBoundary.tsx TS2580')).toBe(true);
  expect(hasVerificationRegression('fail: existing', 'fail: existing')).toBe(false);
});
it('does not count a benchmark-only Node types repair as an automatic migration', async () => {
  const source = await readFile(new URL('../scripts/benchmark.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/tryNodeTypesRepair|acceptedNodeTypesRepair/);
  expect(source).not.toMatch(/result\.migrated\s*\+=\s*1/);
});
it('counts Node type setup once per package, not once per edited file', () => {
  const changes = [
    { file: '/repo/package.json', rule: 'node-types', before: '', after: '', line: 1 },
    { file: '/repo/tsconfig.json', rule: 'node-types', before: '', after: '', line: 1 },
    { file: '/repo/package-lock.json', rule: 'node-types', before: '', after: '', line: 1 },
    { file: '/repo/packages/worker/package.json', rule: 'node-types', before: '', after: '', line: 1 },
    { file: '/repo/src/a.ts', rule: 'rename', before: '', after: '', line: 1 },
  ];
  const outcome = { changes, proposedFiles: [
    { relativePath: 'package.json', before: '{"dependencies":{"openai":"^4.0.0"}}', after: '{"dependencies":{"openai":"^5.0.0"}}' },
    { relativePath: 'packages/worker/package.json', before: '{"dependencies":{"openai":"^4.0.0"}}', after: '{"dependencies":{"openai":"^5.0.0"}}' },
  ] } as Parameters<typeof countLogicalMigrationGroups>[0];
  expect(countNodeTypesGroups(outcome, '/repo')).toBe(2);
  expect(countLogicalMigrationGroups(outcome, '/repo')).toBe(3);
  expect(countNodeTypesGroups({ changes }, '/repo')).toBe(0);
});
it('resolves benchmark change paths from the analyzed checkout, not process.cwd()', () => {
  const root = path.join(os.tmpdir(), 'upstreamfix-bench-checkout');
  const outcome = { changes: [
    { file: 'package.json', rule: 'node-types', before: '', after: '', line: 1 },
    { file: 'tsconfig.json', rule: 'node-types', before: '', after: '', line: 1 },
  ], proposedFiles: [{ relativePath: 'package.json',
    before: '{"dependencies":{"openai":"^4.0.0"}}', after: '{"dependencies":{"openai":"^5.0.0"}}' }] } as Parameters<typeof countNodeTypesGroups>[0];
  expect(countNodeTypesGroups(outcome, root)).toBe(1);
  expect(countLogicalMigrationGroups(outcome, root)).toBe(1);
});
it('counts one runtime decision per affected manifest and ignores comment-only files', () => {
  const root = path.join(os.tmpdir(), 'upstreamfix-runtime-checkout');
  const manifests = [
    { directory: root, supported: false },
    { directory: path.join(root, 'packages', 'other'), supported: false },
  ];
  const change = { file: 'src/client.ts', line: 1, rule: 'beta-chat', before: 'beta.chat', after: 'chat' };
  expect(countRuntimeConfirmationFindings(root, manifests, { changes: [change], manual: [] } as never)).toBe(1);
  expect(countRuntimeConfirmationFindings(root, manifests, { changes: [], manual: [] } as never)).toBe(0);
  expect(runtimeConfirmationFindings(root, manifests, { changes: [change], manual: [] } as never)).toHaveLength(1);
});
it('counts a runtime decision once in the denominator and only reports it separately as a subtotal', () => {
  const report = renderBenchmarkReport([{
    name: 'sample', commit: 'a'.repeat(40), status: 'manual review required', usages: 2, migrated: 1, manual: 1,
    runtimeConfirmationNeeded: true, runtimeConfirmationCount: 1,
    typecheck: { before: 'pass', after: 'pass' }, tests: { before: 'pass', after: 'pass' }, details: '',
    manualFindings: [{ file: 'package.json', line: 1, reason: 'Confirm Node runtime.', classification: 'legitimate' }],
  }], 'complete', 1, openaiV5);
  expect(report).toContain('Automatic migration rate: **50.0%** (1 of 2 detected migration items).');
  expect(report).toContain('Criterion rate excluding legitimate manual items: **100.0%** (1 of 1 eligible items; 1 legitimate manual items excluded).');
  expect(report).toContain('Repositories requiring explicit `--node-runtime 20` confirmation: **1**');
});
it('records a newly failing typecheck at its source line without claiming the SDK caused it', () => {
  const findings = compilerRegressionFindings('pass', "fail: src/conversation.ts(49,32): error TS2339: Property 'chat' does not exist on type 'Beta'.");
  expect(findings).toEqual([{ file: 'src/conversation.ts', line: 49,
    reason: expect.stringContaining('TS2339') }]);
  expect(findings[0]?.reason).toContain('cause is not attributed automatically');
  expect(compilerRegressionFindings('fail: existing', 'fail: other')).toEqual([]);
  expect(compilerRegressionFindings('pass', "fail: Command failed (exit code 2). … src/run.ts(7,3): error TS2580: Cannot find name 'process'.")[0]?.file)
    .toBe('src/run.ts');
});
it('explains v5 tool message content widening with a specific manual fix', () => {
  const diagnostics = [
    "fail: src/TextToGraph.ts(44,31): error TS2339: Property 'startsWith' does not exist on type 'string | ChatCompletionContentPartText[]'.",
    "src/TextToGraph.ts(45,40): error TS2345: Argument of type 'string | ChatCompletionContentPartText[]' is not assignable to parameter of type 'string'.",
  ].join('\n');
  const findings = compilerRegressionFindings('pass', diagnostics);
  expect(findings).toHaveLength(2);
  expect(findings.every((finding) => finding.reason.includes('ChatCompletionContentPartText[]'))).toBe(true);
  expect(findings.every((finding) => finding.reason.includes('tool message content'))).toBe(true);
});
it('P3.4 marks experimental status in benchmark reports', () => {
  expect(renderBenchmarkReport([], 'complete', 0, openaiV5)).toContain('**Experimental migration:**');
});
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { openaiV5 } from '../src/migrations/openai-v5/index.js';

const execFile = promisify(execFileCallback);

describe('public repository benchmark helpers', () => {
  it('W4 rejects a symlinked benchmark manifest without leaking the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-link-'));
    try {
      const secret = path.join(root, 'secret.txt');
      await writeFile(secret, 'root:x:0:0:secret-data');
      await symlink(secret, path.join(root, 'package.json'));
      const message = await readBenchmarkManifest(path.join(root, 'package.json'))
        .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
      expect(message).toContain('Unsafe package.json');
      expect(message).not.toContain('root:x:0:0');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('T34 does not turn benchmark-only Node confirmation into manual review', () => {
    expect(requiresRuntimeReviewFromNotes([
      'Node.js >=20 was declared in the disposable benchmark copy after explicit benchmark-only confirmation of its Node 24 container; the repository production runtime remains unverified.',
    ])).toBe(false);
    expect(requiresRuntimeReviewFromNotes(['OpenAI SDK v5 requires Node.js 20 or later; review engines.node (>=18) before upgrading.'])).toBe(true);
  });
  it('T34 commits the latest measured OpenAI report with exact gross and eligible rates', async () => {
    const report = await readFile(new URL('../benchmark/openai-5-results.md', import.meta.url), 'utf8');
    expect(report).toContain('Automatic migration rate: **57.1%** (32 of 56 detected migration items).');
    expect(report).toContain('Criterion rate excluding legitimate manual items: **66.7%** (32 of 48 eligible items; 8 legitimate manual items excluded).');
    expect(report).toContain('Run ID: `39591178352`');
    expect(report).toContain('Tool SHA: `1a3e7fd36cd6ef721a58190963fd99f1f67a8ec2`');
    expect(report).toContain('Run status: **complete** (20 of 20 repositories recorded).');
    expect(report).toContain('| convex-title-generator | `f77f2d452bc7` | manual review required | 7 | 3 | 4 |');
    expect(report).toContain('| stackwise | `c49a192df253` | manual review required |');
    expect(report).toContain('| is-even-ai | src/IsEvenAiOpenAi.ts | 45 | not automated |');
    expect(report).toContain('| rowfill | src/core/extractTable.ts | 58 | legitimate |');
  });
  it('mirrors explicit CLI Node 20 confirmation in the disposable verification manifest', () => {
    const manifest = { dependencies: { openai: '^4.0.0' } } as { dependencies: { openai: string }; engines?: { node: string } };
    expect(confirmBenchmarkNodeRuntime(manifest, openaiV5)).toContain('--node-runtime 20 confirmation');
    expect(manifest.engines?.node).toBe('>=20');
  });
  it('confirms Node 20 only in the disposable OpenAI benchmark checkout', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-openai-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"}}\n');
      await writeFile(path.join(cwd, 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('file_1');\n");
      const outcome = await analyzeBenchmarkMigration(openaiV5, cwd);
      expect(outcome.changes.length).toBeGreaterThan(0);
      expect(outcome.manual.some((item) => item.reason.includes('Node.js 20'))).toBe(false);
      expect(outcome.manifestNotes.join(' ')).not.toContain('no safe source edit');
      expect(outcome.manifestNotes.join(' ')).toContain('--node-runtime 20 confirmation');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('uses the CLI runtime confirmation and refuses a pre-existing incompatible engines range', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-openai-runtime-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=18"}}\n');
      await writeFile(path.join(cwd, 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.beta.chat.completions.stream({model:'gpt-4o',messages:[]});\n");
      const outcome = await analyzeBenchmarkMigration(openaiV5, cwd);
      expect(outcome.changes.some((change) => change.rule === 'beta-chat')).toBe(false);
      expect(outcome.manual.some((item) => item.reason.includes('requires Node.js 20 or later'))).toBe(true);
      expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json')).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('does not credit OpenAI groups that the CLI lockfile safeguards reject', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-openai-lock-gates-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}');
      await writeFile(path.join(cwd, 'index.ts'), "import OpenAI from 'openai'; const client = new OpenAI(); client.files.del('id');\n");
      const unsupportedLocks = [
        [['package-lock.json', '{"lockfileVersion":2}']],
        [['package-lock.json', '{"lockfileVersion":3}'], ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"]],
        [['package-lock.json', '{"lockfileVersion":3}'], ['.npmrc', 'registry=https://registry.example.invalid/\n']],
        [['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"]],
      ] as const;
      for (const files of unsupportedLocks) {
        for (const name of ['package-lock.json', 'pnpm-lock.yaml', '.npmrc']) await rm(path.join(cwd, name), { force: true });
        for (const [name, content] of files) await writeFile(path.join(cwd, name), content);
        const outcome = await analyzeBenchmarkMigration(openaiV5, cwd);
        expect(outcome.manual.length, files.map(([name]) => name).join(',')).toBeGreaterThan(0);
        expect(outcome.manual.some((finding) => finding.reasonCode === 'lockfile-refusal')).toBe(true);
        expect(outcome.proposedFiles.some((file) => file.relativePath === 'package.json')).toBe(false);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it('reports repositories that require explicit runtime confirmation as a separate count', () => {
    const report = renderBenchmarkReport([
      { name: 'one', commit: 'a'.repeat(40), status: 'manual', usages: 1, migrated: 0, manual: 1,
        runtimeConfirmationNeeded: true, typecheck: { before: 'not run', after: 'not run' }, tests: { before: 'not run', after: 'not run' }, details: '' },
    ], 'complete', 1, openaiV5);
    expect(report).toContain('Repositories requiring explicit `--node-runtime 20` confirmation: **1**');
  });
  it('uses CLI lockfile refusal rules without invoking host npm for unsupported inputs', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-analysis-'));
    const originalPath = process.env.PATH;
    try {
      const bin = path.join(cwd, 'bin');
      const marker = path.join(cwd, 'host-npm-ran');
      await mkdir(bin);
      await writeFile(path.join(bin, 'npm'), `#!/bin/sh\ntouch '${marker}'\nexit 9\n`);
      await chmod(path.join(bin, 'npm'), 0o755);
      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'firebase-admin': '^13.0.0' }, engines: { node: '>=22' } }));
      await writeFile(path.join(cwd, 'index.ts'), "import * as admin from 'firebase-admin';\nadmin.initializeApp();\n");
      await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":2}');
      const result = await analyzeBenchmarkMigration(firebaseAdminV14, cwd);
      expect(result.proposedFiles.some((file) => file.relativePath === 'package-lock.json')).toBe(false);
      expect(result.proposedFiles.some((file) => file.relativePath === 'package.json')).toBe(false);
      expect(result.manual.some((finding) => /lockfileVersion|v3|lockfile/i.test(finding.reason))).toBe(true);
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
    } finally { process.env.PATH = originalPath; await rm(cwd, { recursive: true, force: true }); }
  });
  it('reports the automatic rate using migration changes and manual items', () => {
    const report = renderBenchmarkReport([
      { name: 'sample', commit: 'a'.repeat(40), status: 'completed', usages: 3, migrated: 1, manual: 2, typecheck: { before: 'pass', after: 'fail: TS error' }, tests: { before: 'fail: existing test', after: 'pass' }, details: '',
        manualFindings: [
          { file: 'src/a.ts', line: 1, reason: 'Human choice', classification: 'legitimate' },
          { file: 'src/b.ts', line: 2, reason: 'Still automatable', classification: 'not automated' },
          { file: 'src/generated.ts', line: 3, reason: 'Compiler regression produced by benchmark fixture', classification: 'benchmark regression' },
        ] },
    ]);

    expect(report).toContain('33.3%');
    expect(report).toContain('1 of 3 detected migration items');
    expect(report).toContain('Criterion rate excluding legitimate manual items: **50.0%** (1 of 2 eligible items; 1 legitimate manual items excluded).');
    expect(report).toContain('Rate excluding benchmark-generated compiler regressions as well: **100.0%** (1 of 1 items; 1 generated regressions excluded separately).');
    expect(report).toContain('| sample | src/a.ts | 1 | legitimate | Human choice |');
    expect(report).toContain('| sample | src/b.ts | 2 | not automated | Still automatable |');
    expect(report).toContain('| sample | src/generated.ts | 3 | benchmark regression | Compiler regression produced by benchmark fixture |');
  });
  it('Z3 shows the file, line and reason for each benchmark manual finding', () => {
    const report = renderBenchmarkReport([{
      name: 'sample', commit: 'a'.repeat(40), status: 'manual review required', usages: 1, migrated: 0, manual: 1,
      typecheck: { before: 'pass', after: 'pass' }, tests: { before: 'pass', after: 'pass' }, details: '',
      manualFindings: [{ file: 'src/stripe.ts', line: 42, reason: 'Variable RequestOptions need review.', classification: 'not automated' }],
    }]);
    expect(report).toContain('| sample | src/stripe.ts | 42 | not automated | Variable RequestOptions need review. |');
  });

  it('identifies the exact GitHub run and tool commit behind a benchmark report', () => {
    const oldRun = process.env.GITHUB_RUN_ID;
    const oldSha = process.env.GITHUB_SHA;
    try {
      process.env.GITHUB_RUN_ID = '123456789';
      process.env.GITHUB_SHA = 'c'.repeat(40);
      const report = renderBenchmarkReport([]);
      expect(report).toContain('Run ID: `123456789`');
      expect(report).toContain(`Tool SHA: \`${'c'.repeat(40)}\``);
    } finally {
      if (oldRun === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = oldRun;
      if (oldSha === undefined) delete process.env.GITHUB_SHA; else process.env.GITHUB_SHA = oldSha;
    }
  });

  it('escapes hostile test output before writing a public Markdown table', () => {
    const report = renderBenchmarkReport([{
      name: 'sample', commit: 'a'.repeat(40), status: 'failed', usages: 0, migrated: 0, manual: 0,
      typecheck: { before: 'pass', after: 'fail: </td>\n| forged | row | \u001b[31m' },
      tests: { before: 'pass', after: 'fail: `code` [link](javascript:alert(1))' },
      details: '<script>alert(1)</script>',
    }]);
    expect(report).not.toContain('</td>');
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('\u001b');
    expect(report).not.toContain('\n| forged | row |');
    expect(report).toContain('&lt;script&gt;');
    expect(report).toContain('&#124; forged &#124; row &#124;');
  });

  it('rejects repositories that have not been reviewed', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: false, reviewNote: '',
    })).toThrow('must be reviewed');
  });

  it('rejects a commit that is not a full SHA', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'deadbeef',
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed package scripts and project scope.',
    })).toThrow('40-character SHA');
  });

  it('rejects secret-shaped values under any benchmark environment variable and unsafe package paths', () => {
    const base = {
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm' as const, reviewed: true, reviewNote: 'Reviewed repository scope and package scripts.',
    };
    expect(() => validateRepoEntry({ ...base, env: { RANDOM_VALUE: 'whsec_live_12345678901234567890' } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, env: { SOME_KEY: '-----BEGIN PRIVATE KEY-----' } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, env: { CUSTOM_NAME: 'a'.repeat(40) } }))
      .toThrow('resembles a real secret');
    expect(() => validateRepoEntry({ ...base, packageManagerPaths: { '../../outside': 'npm' } }))
      .toThrow('relative paths inside the checkout');
  });

  it('rejects repository URLs outside public GitHub HTTPS', () => {
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://evil.example/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed package scripts and project scope.',
    })).toThrow('GitHub HTTPS');
  });

  it('rejects an unknown migration before reading repositories or cloning anything', () => {
    expect(() => resolveBenchmarkConfig({ migrationId: 'stripe@99' }, '/tmp/upstreamfix-test'))
      .toThrow('Unknown migration "stripe@99"');
  });

  it('reports a clear error when the selected repository manifest is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-manifest-test-'));
    try {
      await expect(readBenchmarkRepos(path.join(root, 'missing.json')))
        .rejects.toThrow('Benchmark repository manifest not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('chooses a migration-specific default report path for Stripe', () => {
    const config = resolveBenchmarkConfig({ migrationId: 'stripe@22' }, '/tmp/upstreamfix-test');
    expect(config.reportPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-22-results.md');
    expect(config.reposPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-22-repos.json');
  });

  it('passes configured dummy credentials as container environment variables', () => {
    expect(containerEnvArgs({ STRIPE_SECRET_KEY: 'sk_test_fake' }))
      .toEqual(['--env', 'STRIPE_SECRET_KEY=sk_test_fake']);
    expect(() => validateRepoEntry({
      name: 'sample', url: 'https://github.com/example/sample', branch: 'main', commit: 'a'.repeat(40),
      packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed repository scope and test commands.',
      env: { STRIPE_SECRET_KEY: 'sk_live_do_not_use' },
    })).toThrow('resembles a real secret');
  });

  it('rejects unsafe project packageManager values and disables Corepack custom URLs', () => {
    expect(() => validatePackageManagerField('yarn@https://attacker.invalid/yarn.tgz', 'package.json')).toThrow('unsafe packageManager');
    expect(() => validatePackageManagerField({ name: 'npm' }, 'package.json')).toThrow('unsafe packageManager');
    expect(validatePackageManagerField('pnpm@9.15.0', 'package.json')).toBeUndefined();
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout', 'yarn', ['install'], '/tmp/cache/yarn', { memoryMb: 1024, tempMb: 128 });
    expect(args).toContain('COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0');
  });
  it('uses a bind volume when a checkout path contains a comma', () => {
    const args = buildBenchmarkInstallDockerArgs('/tmp/a,b', '/tmp/a,b', 'npm', ['install'], '/tmp/cache', { memoryMb: 2048, tempMb: 128 });
    expect(args).toContain('--volume');
    expect(args).toContain('/tmp/a,b:/workspace');
  });

  it('loads the reviewed Stripe corpus as eight v22 repositories and four v23 repositories', async () => {
    const stripe22 = await readBenchmarkRepos(path.resolve('benchmark/stripe-22-repos.json'));
    const stripe23 = await readBenchmarkRepos(path.resolve('benchmark/stripe-23-repos.json'));

    expect(stripe22).toHaveLength(8);
    expect(stripe23).toHaveLength(4);
    for (const repo of [...stripe22, ...stripe23]) validateRepoEntry(repo);
    expect(stripe22.find((repo) => repo.name === 'libera-donations')?.env?.STRIPE_SECRET_KEY).toBe('sk_test_fake');
    expect(stripe23.find((repo) => repo.name === 'signet')?.env?.STRIPE_SECRET_KEY).toBe('sk_test_fake');
  });

  it('selects an install command for each supported package manager', () => {
    expect(installArgs('npm', 'baseline')[0]).toBe('npm');
    expect(installArgs('pnpm', 'baseline')[0]).toBe('pnpm');
    expect(installArgs('yarn', 'baseline')[0]).toBe('yarn');
    expect(installArgs('yarn', 'baseline')[1]).toContain('--ignore-scripts');
    expect(installArgs('yarn', 'baseline', 'berry')[1]).toContain('--mode=skip-builds');
    expect(installArgs('npm', 'baseline')[1][0]).toBe('ci');
    expect(installArgs('npm', 'post-migration')[1][0]).toBe('install');
    expect(installArgs('npm', 'baseline')[1]).toContain('--prefer-offline');
    expect(installArgs('pnpm', 'baseline')[1]).toContain('/cache/pnpm');
  });

  it('uses a persistent install cache and caps RAM and swap equally', () => {
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout', 'npm', ['ci'], '/tmp/cache/npm', { memoryMb: 768, tempMb: 128 });
    expect(args).toContain('type=bind,source=/tmp/cache/npm,target=/cache');
    expect(args).toContain('NPM_CONFIG_CACHE=/cache/npm');
    expect(args).toContain('--memory=768m');
    expect(args).toContain('--memory-swap=768m');
    expect(args.join(' ')).not.toContain('size=512m');
    expect(resolveDockerLimits(2048, 2 * 1024 ** 3).memoryMb).toBeLessThan(2048);
    expect(() => resolveDockerLimits(undefined, 1024 ** 3)).toThrow('RAM is free');
  });

  it('keeps cache paths local and rejects a symlinked cache directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-cache-test-'));
    try {
      const cache = path.join(root, 'cache');
      expect(await prepareBenchmarkCache(cache, 'npm')).toBe(path.join(cache, 'npm'));
      expect(await prepareBenchmarkCache(cache, 'npm')).toBe(path.join(cache, 'npm'));
      const link = path.join(root, 'link');
      await symlink(cache, link);
      await expect(prepareBenchmarkCache(link, 'npm')).rejects.toThrow('symbolic link');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('selects a single repository without overwriting the full report', () => {
    const options = parseBenchmarkArgs(['--migration', 'stripe@23', '--only', 'signet', '--memory-mb', '1024']);
    const config = resolveBenchmarkConfig(options, '/tmp/upstreamfix-test');
    expect(config.only).toBe('signet');
    expect(config.memoryMb).toBe(1024);
    expect(config.reportPath).toBe('/tmp/upstreamfix-test/benchmark/stripe-23-signet-results.md');
    expect(() => parseBenchmarkArgs(['--memory-mb', '99999'])).toThrow('--memory-mb');
  });

  it('runs benchmark installs inside a credential-free Docker container without exposing the Git directory', () => {
    const args = buildBenchmarkInstallDockerArgs('/tmp/checkout', '/tmp/checkout/functions', 'npm', ['ci', '--ignore-scripts'], '/tmp/cache/npm', { memoryMb: 1024, tempMb: 128 });
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--network=bridge');
    expect(args).toContain('--env');
    expect(args).toContain('type=bind,source=/tmp/checkout/.git,target=/workspace/.git,readonly');
    expect(args).toContain('/workspace/functions');
    expect(args.slice(args.indexOf('node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5') + 1))
      .toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(args.join(' ')).not.toContain('NPM_TOKEN');
  });

  it('accepts only pinned commits reachable from the reviewed upstream branch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-ancestry-test-'));
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    const checkout = path.join(root, 'checkout');
    const home = path.join(root, 'home');
    const git = async (cwd: string, ...args: string[]) => execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    try {
      await execFile('git', ['init', '--bare', '--initial-branch=main', origin]);
      await execFile('git', ['init', '--initial-branch=main', work]);
      await git(work, 'config', 'user.name', 'Fixture');
      await git(work, 'config', 'user.email', 'fixture@example.invalid');
      await git(work, 'remote', 'add', 'origin', origin);
      const fs = await import('node:fs/promises');
      await fs.writeFile(path.join(work, 'source.txt'), 'main 1\n');
      await git(work, 'add', 'source.txt');
      await git(work, 'commit', '-m', 'main 1');
      const pinnedMain = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
      await git(work, 'push', 'origin', 'main');
      await git(work, 'checkout', '-b', 'unmerged');
      await fs.writeFile(path.join(work, 'source.txt'), 'unmerged fork commit\n');
      await git(work, 'commit', '-am', 'unmerged fork commit');
      const forkCommit = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
      await git(work, 'checkout', 'main');
      await fs.writeFile(path.join(work, 'source.txt'), 'main 2\n');
      await git(work, 'commit', '-am', 'main 2');
      await git(work, 'push', 'origin', 'main');
      await git(work, 'push', 'origin', 'unmerged');
      await execFile('git', ['clone', '--depth=1', '--branch', 'main', `file://${origin}`, checkout]);

      await expect(assertPinnedCommitIsBranchAncestor(checkout, { name: 'fixture', branch: 'main', commit: pinnedMain }, home)).resolves.toBeUndefined();
      await expect(assertPinnedCommitIsBranchAncestor(checkout, { name: 'fixture', branch: 'main', commit: forkCommit }, home)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects migration patches that escape the temporary checkout', async () => {
    await expect(validatePatchPaths(['--- a/server.ts\n+++ b/../../outside.ts\n@@ -1 +1 @@\n-old\n+new']))
      .rejects.toThrow('unsafe patch path');
  });

  it('records a reviewed invalid baseline without cloning or installing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-test-'));
    try {
      const result = await benchmarkOne({
        name: 'fitpro', url: 'https://github.com/Qasim-016/Fitpro', branch: 'master', commit: 'a'.repeat(40),
        packageManager: 'npm', reviewed: true, reviewNote: 'Reviewed the package manifest and installation failure.',
        invalidReason: 'The pinned package lock does not match package.json.',
      }, root, root);

      expect(result.status).toBe('invalid repository');
      expect(result.details).toContain('does not match');
      expect(result.usages).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
