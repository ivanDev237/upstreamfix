import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseActionConfig, shouldRunOnSchedule } from './config.js';
import type { Proposal } from './publish.js';
import { escapeUntrustedMarkdownCell, renderMarkdownReport } from '../core/report.js';
import { runMigration } from '../core/runner.js';
import { writeMigrationOnBranch } from '../core/write-branch.js';
import { findApplicableMigrations, migrations } from '../migrations/index.js';
import { executeClientCommand } from './docker-execute.js';

const execFile = promisify(execFileCallback);

export async function prepareProposals(projectRoot: string, outputRoot: string, base: string, eventName: string): Promise<Proposal[]> {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('The source commit must be an exact Git SHA.');
  const project = path.resolve(projectRoot);
  const output = path.resolve(outputRoot);
  if (output === project || output.startsWith(`${project}${path.sep}`)) throw new Error('Reports and bundles must be outside the client checkout.');
  if (!['schedule', 'workflow_dispatch'].includes(eventName)) throw new Error('Only schedule and workflow_dispatch can prepare migrations.');
  const configFile = path.join(project, '.upstreamfix.yml');
  const configInfo = await lstat(configFile).catch(() => undefined);
  if (configInfo && !configInfo.isFile()) throw new Error('.upstreamfix.yml must be a regular file.');
  const config = parseActionConfig(configInfo ? await readFile(configFile, 'utf8') : '');
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (eventName === 'schedule' && !shouldRunOnSchedule(config.frequency)) {
    await writeFile(path.join(output, 'proposals.json'), '[]\n', { mode: 0o600 });
    return [];
  }
  const actualHead = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: project, timeout: 10_000 })).stdout.trim();
  if (actualHead !== base) throw new Error('The checked-out client commit differs from the workflow base SHA.');
  await assertNoCheckoutCredentials(project);
  const applicable = new Set((await findApplicableMigrations(project)).map((item) => item.id));
  const proposals: Proposal[] = [];
  for (const migration of migrations) {
    const branch = `upstreamfix/${migration.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    const common = {
      schema: 1 as const, migration: migration.id, base, branch,
      reviewers: config.reviewers, labels: config.labels,
    };
    if (config.ignore.includes(migration.id)) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: 'This migration is ignored by the current reviewed .upstreamfix.yml.' });
      continue;
    }
    if (!applicable.has(migration.id)) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: 'This migration is no longer applicable to the repository.' });
      continue;
    }
    const preview = await runMigration(migration, { cwd: project, dryRun: true, excludedDirectories: config.exclude });
    if (preview.manual.length > 0) {
      proposals.push({ ...common, status: 'manual', files: [], verification: 'skipped', report: renderMarkdownReport(migration, preview, true) });
      continue;
    }
    if (preview.proposedFiles.length === 0) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: renderMarkdownReport(migration, preview, true) });
      continue;
    }
    try {
      const result = await writeMigrationOnBranch(migration, {
        cwd: project, excludedDirectories: config.exclude, customCommands: config.verify,
        timeoutMs: 10 * 60 * 1000,
        ...(process.env.UPSTREAMFIX_CONTAINER_VERIFY === '1' ? { verificationOptions: { execute: executeClientCommand } } : {}),
      });
      const bundle = path.join(output, `${migration.id.replace(/[^A-Za-z0-9._-]+/g, '-')}.bundle`);
      await execFile('git', ['bundle', 'create', bundle, `${base}..${result.branch}`], { cwd: project, timeout: 30_000 });
      proposals.push({
        ...common, status: 'ready', commit: result.commit, files: result.outcome.filesChanged,
        verification: result.verification.status,
        report: renderMarkdownReport(migration, result.outcome, false, result.verification),
      });
    } catch (error) {
      const reason = escapeUntrustedMarkdownCell(error instanceof Error ? error.message : String(error)).replace(/@/g, '&#64;');
      proposals.push({
        ...common, status: 'manual', files: [], verification: 'failed',
        report: `${renderMarkdownReport(migration, preview, true)}\n\nVerification or branch preparation failed: ${reason}`,
      });
    }
  }
  await writeFile(path.join(output, 'proposals.json'), `${JSON.stringify(proposals, null, 2)}\n`, { mode: 0o600 });
  return proposals;
}

async function assertNoCheckoutCredentials(project: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(),
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  };
  for (const scope of ['--local', '--worktree']) {
    const { stdout } = await execFile('git', ['config', scope, '--includes', '--null', '--list'], {
      cwd: project, env, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    for (const record of stdout.split('\0').filter(Boolean)) {
      const index = record.indexOf('\n');
      if (index < 0) continue;
      const key = record.slice(0, index).toLowerCase();
      const value = record.slice(index + 1);
      if (/^credential(?:\.|$)/.test(key) || /^http(?:\.|$).*\.extraheader$/.test(key)
        || (/^remote\..*\.url$/.test(key) && /^https?:\/\/[^/]*@/.test(value))) {
        throw new Error('Git credentials are stored in the client checkout; use checkout with persist-credentials: false.');
      }
    }
  }
}
