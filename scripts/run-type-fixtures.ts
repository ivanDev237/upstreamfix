import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diffPublishedApi } from '../src/core/diff-api.js';
import { generateTypeFixtures, validateFixtureDiagnostics, type TypeFixture } from '../src/core/type-fixtures.js';

const cases = [
  { packageName: 'stripe', oldVersion: '22.4.0', newVersion: '23.0.0', member: 'payment_method_types' },
  { packageName: 'firebase-admin', oldVersion: '13.10.0', newVersion: '14.0.0', member: 'firestore' },
] as const;
const image = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

async function command(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-100_000); });
    child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-100_000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function compile(fixture: TypeFixture, version: string): Promise<Array<{ code: number; line: number }>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-type-fixture-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [fixture.packageName]: version },
      devDependencies: { typescript: '7.0.2', '@types/node': '22.10.0' } }));
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true,
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true }, files: ['fixture.ts'] }));
    await writeFile(path.join(root, 'fixture.ts'), fixture.source);
    const home = path.join(root, '.home');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_userconfig: path.join(root, 'npmrc.user'),
      npm_config_globalconfig: path.join(root, 'npmrc.global') };
    await writeFile(env.npm_config_userconfig!, '');
    await writeFile(env.npm_config_globalconfig!, '');
    const install = await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], root, env);
    if (install.code !== 0) throw new Error(`Fixture install failed for ${fixture.id}@${version}: ${install.output.slice(-2000)}`);
    const result = await command('docker', [
      'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--memory=1536m', '--memory-swap=1536m', '--pids-limit=128', '--user=65534:65534',
      `--mount=type=bind,src=${root},dst=/workspace,readonly`, '-w', '/workspace', image,
      'node', '/workspace/node_modules/typescript/bin/tsc', '--pretty', 'false', '--noEmit',
    ], root, { PATH: process.env.PATH, HOME: '/tmp' });
    if (result.code !== 0 && !/error TS\d+/.test(result.output)) throw new Error(`Typecheck could not run: ${result.output.slice(-2000)}`);
    const diagnostics = [...result.output.matchAll(/fixture\.ts\((\d+),\d+\): error TS(\d+):/g)]
      .map((match) => ({ line: Number(match[1]), code: Number(match[2]) }));
    if (result.code !== 0 && diagnostics.length === 0) throw new Error(`No fixture diagnostics found: ${result.output.slice(-2000)}`);
    return diagnostics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const findings: Array<{ package: string; oldVersion: string; newVersion: string; symbol: string; oldDiagnostics: unknown; newDiagnostics: unknown; passed: boolean }> = [];
for (const target of cases) {
  const report = await diffPublishedApi(target.packageName, target.oldVersion, target.newVersion);
  if (process.env.UPSTREAMFIX_DIFF_DIR) await writeFile(path.join(process.env.UPSTREAMFIX_DIFF_DIR, `api-diff-${target.packageName}.json`), JSON.stringify(report, null, 2));
  const generated = generateTypeFixtures(report);
  const fixture = generated.fixtures.find((item) => item.derivedFrom.symbol.endsWith(`.${target.member}`)
    || item.derivedFrom.symbol === target.member);
  if (!fixture) throw new Error(`No reproducible ${target.member} fixture derived from ${target.packageName} declarations. Removed candidates: ${report.removed.filter((item) => item.symbol.includes(target.member)).map((item) => item.symbol).join(', ') || 'none'}. Changed candidates: ${report.changed.filter((item) => item.symbol.includes(target.member)).map((item) => item.symbol).join(', ') || 'none'}. Review the full uploaded type diff.`);
  const oldDiagnostics = await compile(fixture, target.oldVersion);
  const newDiagnostics = await compile(fixture, target.newVersion);
  const passed = validateFixtureDiagnostics(fixture, oldDiagnostics, newDiagnostics);
  findings.push({ package: target.packageName, oldVersion: target.oldVersion, newVersion: target.newVersion,
    symbol: fixture.derivedFrom.symbol, oldDiagnostics, newDiagnostics, passed });
  if (!passed) break;
}
const output = ['# Type-derived compatibility fixtures', '',
  'Compiled against exact published SDK releases inside network-disabled Docker containers. The generated TypeScript was never executed.', '',
  '| SDK | Removed symbol | Baseline diagnostics | Target diagnostics | Result |', '|---|---|---|---|---|',
  ...findings.map((item) => `| ${item.package} ${item.oldVersion} → ${item.newVersion} | \`${item.symbol}\` | ${JSON.stringify(item.oldDiagnostics)} | ${JSON.stringify(item.newDiagnostics)} | ${item.passed ? 'pass' : 'fail'} |`),
  '', 'Type errors prove a declaration incompatibility; they do not prove any suggested business behavior is safe.', ''].join('\n');
const reportFile = process.env.UPSTREAMFIX_FIXTURE_REPORT;
if (reportFile) await writeFile(reportFile, output);
else process.stdout.write(output);
if (findings.some((item) => !item.passed)) process.exitCode = 1;
