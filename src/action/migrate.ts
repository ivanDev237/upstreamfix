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

export async function boundProposalReport(output: string, migrationId: string, report: string): Promise<string> {
  if (report.length <= 90_000) return report;
  const name = `report-${migrationId.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`;
  await writeFile(path.join(output, name), report, { mode: 0o600 });
  let prefix = report.slice(0, 88_000);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const lastLine = prefix.lastIndexOf('\n');
  if (lastLine > 80_000) prefix = prefix.slice(0, lastLine);
  return `${prefix}\n\nReport truncated. The full report is in the ${name} file of the upstreamfix-proposals artifact.`;
}

export async function prepareProposals(projectRoot: string, outputRoot: string, base: string, eventName: string): Promise<Proposal[]> {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('The source commit must be an exact Git SHA.');
  const project = path.resolve(projectRoot);
  const output = path.resolve(outputRoot);
  if (output === project || output.startsWith(`${project}${path.sep}`)) throw new Error('Reports and bundles must be outside the client checkout.');
  // repository_dispatch comes from the UpstreamFix GitHub App; the reusable workflow only runs it when the
  // payload names this repository, its default branch and its current head commit.
  if (!['schedule', 'workflow_dispatch', 'repository_dispatch'].includes(eventName))
    throw new Error('Only schedule, workflow_dispatch and repository_dispatch can prepare migrations.');
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
  const applicable = new Set((await findApplicableMigrations(project, { includeExperimental: config.experimental.length > 0 })).map((item) => item.id));
  const proposals: Proposal[] = [];
  const registryBefore = new Date().toISOString();
  for (const migration of migrations) {
    const branch = `upstreamfix/${migration.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    const common = {
      schema: 1 as const, migration: migration.id, base, branch, registryBefore,
      reviewers: config.reviewers, labels: config.labels,
    };
    if (config.ignore.includes(migration.id)) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: 'This migration is ignored by the current reviewed .upstreamfix.yml.' });
      continue;
    }
    if (migration.experimental && !config.experimental.includes(migration.id)) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: 'Experimental migration disabled. Add it to experimental in the reviewed .upstreamfix.yml to opt in.' });
      continue;
    }
    if (!applicable.has(migration.id)) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: 'This migration is no longer applicable to the repository.' });
      continue;
    }
    const preview = await runMigration(migration, { cwd: project, dryRun: true, excludedDirectories: config.exclude, registryBefore });
    if (preview.manual.length > 0) {
      proposals.push({ ...common, status: 'manual', files: [], verification: 'skipped', report: renderMarkdownReport(migration, preview, true, undefined, 'restricted-host', 'github-app') });
      continue;
    }
    const unsupportedLock = await findUnsupportedLockfile(project, preview.proposedFiles.map((file) => file.relativePath));
    if (unsupportedLock) {
      proposals.push({ ...common, status: 'manual', files: [], verification: 'skipped',
        report: `${renderMarkdownReport(migration, preview, true, undefined, 'restricted-host', 'github-app')}\n\nManual review required: ${escapeUntrustedMarkdownCell(unsupportedLock)} cannot yet be independently regenerated by the publisher. No migration branch was published.` });
      continue;
    }
    if (preview.proposedFiles.length === 0) {
      proposals.push({ ...common, status: 'none', files: [], verification: 'skipped', report: renderMarkdownReport(migration, preview, true, undefined, 'restricted-host', 'github-app') });
      continue;
    }
    try {
      const result = await writeMigrationOnBranch(migration, {
        cwd: project, excludedDirectories: config.exclude, customCommands: config.verify, registryBefore,
        timeoutMs: 10 * 60 * 1000,
        ...(process.env.UPSTREAMFIX_CONTAINER_VERIFY === '1' ? { verificationOptions: { execute: executeClientCommand } } : {}),
      });
      const bundle = path.join(output, `${migration.id.replace(/[^A-Za-z0-9._-]+/g, '-')}.bundle`);
      await execFile('git', ['bundle', 'create', bundle, `${base}..${result.branch}`], { cwd: project, timeout: 30_000 });
      proposals.push({
        ...common, status: 'ready', commit: result.commit, files: result.outcome.filesChanged,
        verification: result.verification.status,
        report: renderMarkdownReport(migration, result.outcome, false, result.verification,
          process.env.UPSTREAMFIX_CONTAINER_VERIFY === '1' ? 'network-isolated-container' : 'restricted-host', 'github-app'),
      });
    } catch (error) {
      const reason = escapeUntrustedMarkdownCell(error instanceof Error ? error.message : String(error)).replace(/@/g, '&#64;');
      proposals.push({
        ...common, status: 'manual', files: [], verification: 'failed',
        report: `${renderMarkdownReport(migration, preview, true, undefined, 'restricted-host', 'github-app')}\n\nVerification or branch preparation failed: ${reason}`,
      });
    }
  }
  for (const proposal of proposals) proposal.report = await boundProposalReport(output, proposal.migration, proposal.report);
  await writeFile(path.join(output, 'proposals.json'), `${JSON.stringify(proposals, null, 2)}\n`, { mode: 0o600 });
  return proposals;
}

async function findUnsupportedLockfile(root: string, proposedFiles: string[]): Promise<string | undefined> {
  for (const relative of proposedFiles) {
    if (/(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock)$/.test(relative)) return relative;
    if (!/(?:^|\/)package\.json$/.test(relative)) continue;
    let directory = path.dirname(path.resolve(root, relative));
    while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
      for (const name of ['pnpm-lock.yaml', 'yarn.lock']) {
        if (await lstat(path.join(directory, name)).catch(() => undefined)) return path.relative(root, path.join(directory, name));
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }
  return undefined;
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
      const urlRewriteBase = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/.exec(key)?.[1];
      if (/^credential(?:\.|$)/.test(key) || /^http(?:\.|$).*\.extraheader$/.test(key)
        || (/^remote\..*\.(?:url|pushurl)$/.test(key) && /^https?:\/\/[^/]*@/.test(value))
        || (urlRewriteBase && /^https?:\/\/[^/]*@/.test(urlRewriteBase))) {
        throw new Error('Git credentials are stored in the client checkout; use checkout with persist-credentials: false.');
      }
    }
  }
}
