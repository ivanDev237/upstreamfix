#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdownReport, renderTerminalReport, sanitizeTerminalText } from './core/report.js';
import { runMigration } from './core/runner.js';
import { verifyProposedMigration } from './core/verify.js';
import { writeMigrationOnBranch } from './core/write-branch.js';
import { assertWritesEnabled } from './core/safety.js';
import { findApplicableMigrations, migrations } from './migrations/index.js';
import { watchPackages } from './core/watch.js';
import { diffPublishedApi } from './core/diff-api.js';
import { generateTypeFixtures } from './core/type-fixtures.js';
import { analyzeImpact } from './core/impact.js';
import { probeProject } from './core/probe.js';

function existingMigration(value: string): string {
  if (!migrations.some((migration) => migration.id === value)) {
    throw new InvalidArgumentError(`Unknown migration "${value}". Available: ${migrations.map((migration) => migration.id).join(', ')}`);
  }
  return value;
}

export function createProgram(): Command {
  const program = new Command();
  const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  program
    .name('upstreamfix')
    .version(packageVersion)
    .description('Prepare and review automated code migrations for breaking SDK changes.')
    .showHelpAfterError()
    .exitOverride();

  program
    .command('probe')
    .description('Compare TypeScript diagnostics before and after an exact SDK upgrade in a temporary copy.')
    .argument('<package@version>', 'exact target, for example stripe@23.0.0')
    .option('-C, --cwd <directory>', 'Git project directory to probe', process.cwd())
    .option('--timeout <seconds>', 'maximum time per probe command', parsePositiveInteger)
    .option('--yes', 'confirm dependency and Docker image downloads after reviewing the estimate')
    .action(async (target: string, options: { cwd: string; yes?: boolean; timeout?: number }) => {
      const result = await probeProject(options.cwd, target, { confirmed: options.yes, ...(options.timeout ? { timeoutMs: options.timeout * 1000 } : {}) });
      console.log(result.estimatedDownload);
      if (result.status === 'confirmation-required') {
        console.log('No downloads started. Re-run with --yes to perform the probe.');
        return;
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'unavailable') process.exitCode = 1;
    });

  program
    .command('impact')
    .description('Estimate affected usages of catalog SDK upgrades in a project without writing files.')
    .option('-C, --cwd <directory>', 'project directory to analyze', process.cwd())
    .action(async (options: { cwd: string }) => {
      console.log(JSON.stringify(await analyzeImpact(options.cwd), null, 2));
    });

  program
    .command('type-fixtures')
    .description('Generate compile-only fixtures from published SDK declaration differences.')
    .argument('<package>', 'npm package name')
    .argument('<old>', 'exact old version')
    .argument('<new>', 'exact new version')
    .action(async (packageName: string, oldVersion: string, newVersion: string) => {
      const report = await diffPublishedApi(packageName, oldVersion, newVersion);
      console.log(JSON.stringify(generateTypeFixtures(report), null, 2));
    });

  program
    .command('diff-api')
    .description('Compare published TypeScript declarations of two exact npm package versions.')
    .argument('<package>', 'npm package name')
    .argument('<old>', 'exact old version')
    .argument('<new>', 'exact new version')
    .action(async (packageName: string, oldVersion: string, newVersion: string) => {
      const report = await diffPublishedApi(packageName, oldVersion, newVersion);
      console.log(JSON.stringify(report, null, 2));
    });

  program
    .command('watch')
    .description('Check npm for new major versions of catalog packages and update a JSON state file.')
    .requiredOption('--state <file>', 'JSON state file to update atomically')
    .action(async (options: { state: string }) => {
      const result = await watchPackages(options.state, migrations.map((migration) => migration.packageName));
      console.log(result.events.length ? JSON.stringify(result.events, null, 2) : 'No new major versions since the previous check.');
    });

  program
    .command('list')
    .description('List the migrations included in this UpstreamFix release.')
    .action(() => {
      if (migrations.length === 0) {
        console.log('No migrations are available in this release.');
        return;
      }
      console.log('| Migration | Package | From → To | Released | Status | Automated rules |');
      console.log('|---|---|---:|---|---|---|');
      for (const migration of migrations) {
        console.log(`| ${migration.id} | ${migration.packageName} | ${migration.fromMajor} → ${migration.toMajor} | ${migration.releasedAt} | ${migration.experimental ? 'experimental' : 'supported'} | ${migration.rules.join(', ')} |`);
      }
    });

  program
    .command('migrate')
    .description('Run a supported migration against a project.')
    .argument('<migration>', 'migration identifier, for example firebase-admin@14', existingMigration)
    .option('-C, --cwd <directory>', 'project directory to migrate', process.cwd())
    .option('--write', 'apply verified changes in a new Git branch and create a commit')
    .option('--allow-dirty', 'allow a dirty working tree; the migration branch is based on committed HEAD')
    .option('--verify', 'verify proposed changes in a temporary project copy')
    .option('--experimental', 'explicitly opt in to an experimental migration')
    .option('--node-runtime <major>', 'confirm Node.js 22 for Firebase Admin v14 or Node.js 20 for OpenAI v5; add engines.node when absent', parseNodeRuntime)
    .option('--verify-timeout <seconds>', 'maximum time per verification command', parsePositiveInteger)
    .option('--allow-yarn-lock-install', 'allow a full Yarn Classic installation to regenerate yarn.lock (estimated 50–400 MB)')
    .option('--report <file>', 'write the Markdown report to this explicit path (relative paths use --cwd)')
    .action(async (migrationId: string, options: { cwd: string; write?: boolean; allowDirty?: boolean; verify?: boolean; experimental?: boolean; verifyTimeout?: number; report?: string; nodeRuntime?: 20 | 22; allowYarnLockInstall?: boolean }) => {
      const migration = migrations.find((candidate) => candidate.id === migrationId)!;
      if (migration.experimental && !options.experimental) throw new Error(`${migration.id} is experimental. Re-run with --experimental after reviewing its limits.`);
      if (options.nodeRuntime && !((options.nodeRuntime === 22 && migration.id === 'firebase-admin@14') || (options.nodeRuntime === 20 && migration.id === 'openai@5'))) throw new Error('--node-runtime 22 applies to firebase-admin@14; --node-runtime 20 applies to openai@5.');
      const cwd = path.resolve(options.cwd);
      if (options.allowYarnLockInstall) console.log('Yarn Classic lockfile regeneration may download about 50–400 MB without a warm cache.');
      if (options.allowDirty && !options.write) throw new Error('--allow-dirty can only be used together with --write.');
      let writeResult;
      if (options.write) {
        assertWritesEnabled(false);
        writeResult = await writeMigrationOnBranch(migration, {
          cwd,
          allowDirty: options.allowDirty,
          nodeRuntime: options.nodeRuntime,
          allowYarnLockInstall: options.allowYarnLockInstall,
          timeoutMs: (options.verifyTimeout ?? 300) * 1000,
        });
      }
      const outcome = writeResult?.outcome ?? await runMigration(migration, { cwd, dryRun: true, nodeRuntime: options.nodeRuntime, allowYarnLockInstall: options.allowYarnLockInstall });
      const verification = writeResult?.verification ?? (options.verify
        ? await verifyProposedMigration(cwd, outcome.proposedDiff, { packageName: migration.packageName, fileChanges: outcome.proposedFiles, timeoutMs: (options.verifyTimeout ?? 300) * 1000 })
        : undefined);
      const report = renderMarkdownReport(migration, outcome, !options.write, verification);

      console.log(renderTerminalReport(report));
      if (options.report) {
        const reportPath = path.resolve(cwd, options.report);
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, report, 'utf8');
        console.log(`Report saved to ${path.relative(cwd, reportPath) || path.basename(reportPath)}`);
      }

      if (writeResult) console.log(`Committed on branch ${writeResult.branch}: ${writeResult.commit}`);

      if (verification?.status === 'failed') process.exitCode = 1;

      if (!options.write) console.log(options.report ? 'Preview only. Only the requested report file was written.' : 'Preview only. No project files were written.');
    });

  program
    .command('scan')
    .description('Run supported migrations that match dependencies declared in a project.')
    .option('-C, --cwd <directory>', 'project directory to scan', process.cwd())
    .option('--write', 'apply each verified migration in a new Git branch and create a commit')
    .option('--allow-dirty', 'allow a dirty working tree; migration branches use committed HEAD')
    .option('--verify', 'verify each proposed migration in a temporary project copy')
    .option('--include-experimental', 'include experimental migrations in this scan')
    .option('--node-runtime <major>', 'confirm Node.js 22 for Firebase Admin v14 or Node.js 20 for OpenAI v5; add engines.node when absent', parseNodeRuntime)
    .option('--verify-timeout <seconds>', 'maximum time per verification command', parsePositiveInteger)
    .option('--allow-yarn-lock-install', 'allow a full Yarn Classic installation to regenerate yarn.lock (estimated 50–400 MB)')
    .option('--report <file>', 'write Markdown reports to this explicit path (relative paths use --cwd)')
    .action(async (options: { cwd: string; write?: boolean; allowDirty?: boolean; verify?: boolean; includeExperimental?: boolean; verifyTimeout?: number; report?: string; nodeRuntime?: 20 | 22; allowYarnLockInstall?: boolean }) => {
      const cwd = path.resolve(options.cwd);
      if (options.allowYarnLockInstall) console.log('Yarn Classic lockfile regeneration may download about 50–400 MB without a warm cache.');
      if (options.allowDirty && !options.write) throw new Error('--allow-dirty can only be used together with --write.');
      const reports: string[] = [];
      const commits: Array<{ branch: string; commit: string }> = [];
      let verificationFailed = false;
      const applicable = await findApplicableMigrations(cwd, { includeExperimental: options.includeExperimental });
      if (applicable.length === 0) {
        console.log('No supported migration applies to the dependencies declared in this project.');
        return;
      }
      await withCompletedBranchNotice(async (recordCommit) => {
        for (const migration of applicable) {
          let writeResult;
          if (options.write) {
            assertWritesEnabled(false);
            writeResult = await writeMigrationOnBranch(migration, {
              cwd,
              allowDirty: options.allowDirty,
              nodeRuntime: (migration.id === 'firebase-admin@14' && options.nodeRuntime === 22) || (migration.id === 'openai@5' && options.nodeRuntime === 20) ? options.nodeRuntime : undefined,
              allowYarnLockInstall: options.allowYarnLockInstall,
              timeoutMs: (options.verifyTimeout ?? 300) * 1000,
            });
            recordCommit({ branch: writeResult.branch, commit: writeResult.commit });
          }
          const outcome = writeResult?.outcome ?? await runMigration(migration, { cwd, dryRun: true, nodeRuntime: (migration.id === 'firebase-admin@14' && options.nodeRuntime === 22) || (migration.id === 'openai@5' && options.nodeRuntime === 20) ? options.nodeRuntime : undefined, allowYarnLockInstall: options.allowYarnLockInstall });
          const verification = writeResult?.verification ?? (options.verify
            ? await verifyProposedMigration(cwd, outcome.proposedDiff, { packageName: migration.packageName, fileChanges: outcome.proposedFiles, timeoutMs: (options.verifyTimeout ?? 300) * 1000 })
            : undefined);
          if (verification?.status === 'failed') verificationFailed = true;
          reports.push(renderMarkdownReport(migration, outcome, !options.write, verification));
        }
      }, commits);
      const report = reports.join('\n---\n\n');
      console.log(renderTerminalReport(report));
      if (options.report) {
        const reportPath = path.resolve(cwd, options.report);
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, report, 'utf8');
        console.log(`Report saved to ${path.relative(cwd, reportPath) || path.basename(reportPath)}`);
      }
      for (const commit of commits) console.log(`Committed on branch ${commit.branch}: ${commit.commit}`);
      if (verificationFailed) process.exitCode = 1;
      if (!options.write) console.log(options.report ? 'Preview only. Only the requested report file was written.' : 'Preview only. No project files were written.');
    });

  return program;
}

export function completedBranchNotice(commits: Array<{ branch: string; commit: string }>): string {
  return `The scan stopped after creating these branches:\n${commits.map((item) => `- ${item.branch}: ${item.commit}`).join('\n')}`;
}

export async function withCompletedBranchNotice<T>(
  work: (record: (commit: { branch: string; commit: string }) => void) => Promise<T>,
  commits: Array<{ branch: string; commit: string }> = [],
): Promise<T> {
  try {
    return await work((commit) => commits.push(commit));
  } catch (error) {
    if (commits.length > 0) console.error(completedBranchNotice(commits));
    throw error;
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400) {
    throw new InvalidArgumentError('Verification timeout must be an integer from 1 to at most 86400 seconds (24 hours).');
  }
  return parsed;
}

function parseNodeRuntime(value: string): 20 | 22 {
  if (value !== '20' && value !== '22') throw new InvalidArgumentError('Use --node-runtime 22 for firebase-admin@14 or --node-runtime 20 for openai@5.');
  return Number(value) as 20 | 22;
}

let invokedPath = '';
export function safeCliError(error: unknown): string {
  return `upstreamfix: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`;
}
try { invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''; } catch { /* An unresolved argv path is not this CLI. */ }
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  createProgram().parseAsync().catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) {
      process.exitCode = 0;
      return;
    }
    console.error(safeCliError(error));
    process.exitCode = 1;
  });
}
