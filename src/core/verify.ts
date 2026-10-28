import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { applyPatch, parsePatch } from 'diff';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { ProposedFileChange } from './types.js';
import { registerTemporaryCleanup, terminateProcessGroup, trackProcessGroup } from './process-cleanup.js';
import { IGNORED_PROJECT_DIRECTORIES } from './project-discovery.js';
import { parseManifest } from './manifest.js';

const ignoredFiles = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpm-workspace.yaml', 'yarn.config.cjs']);
const maxOutputLength = 4_000;
const maxCopyBytes = 100 * 1024 * 1024;
const maxCopyFileBytes = 20 * 1024 * 1024;
// Unchanged large project data can be needed by build/tests, but the isolated
// copy remains bounded even when the source repository contains large binaries.
const maxTotalCopyBytes = 500 * 1024 * 1024;
const lockfileNames = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro']);
const largeAssetExtensions = new Set(['.apk', '.aab', '.ipa', '.zip', '.tar', '.gz', '.7z', '.jar', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp3', '.mp4', '.mov', '.webm', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.wasm', '.sqlite', '.db', '.csv', '.dat', '.data', '.jsonl']);
const execFile = promisify(execFileCallback);

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'inconclusive';

export interface VerificationCheck {
  name: string;
  command: string;
  status: VerificationStatus;
  durationMs: number;
  output: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  checks: VerificationCheck[];
  note?: string;
}

export interface VerificationOptions {
  timeoutMs?: number;
  /** Client-selected commands run only inside the disposable verification copy. */
  customCommands?: readonly string[];
  /** Package whose installed version makes this migration applicable. Defaults to firebase-admin for compatibility. */
  packageName?: string;
  /** Source package removed without a replacement in a changed manifest. */
  removedPackageName?: string;
  /** Exact migration results. When present these are applied directly; unified diffs are for display only. */
  fileChanges?: ProposedFileChange[];
  /** Override the UpstreamFix pnpm cache location (primarily for offline tests). */
  pnpmCacheRoot?: string;
  execute?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, allowInstallNetwork: boolean) => Promise<{ stdout?: string; stderr?: string } | undefined>;
}

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export async function verifyProposedMigration(
  cwd: string,
  diffs: string[],
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  if (diffs.length === 0 && (options.fileChanges?.length ?? 0) === 0) {
    return { status: 'skipped', checks: [], note: 'No proposed changes were available to verify.' };
  }

  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-verify-'));
  const projectCopy = path.join(temporaryRoot, 'project');
  const isolatedHome = path.join(temporaryRoot, 'home');
  const persistentPnpmStore = options.pnpmCacheRoot ?? (options.execute
    ? path.join(temporaryRoot, 'pnpm-store')
    : path.join(os.homedir(), '.cache', 'upstreamfix', 'pnpm-store'));
  const checks: VerificationCheck[] = [];
  const executedControls: Array<{ check: VerificationCheck; command: string; args: string[]; directory: string; output: string }> = [];
  const unregisterCleanup = registerTemporaryCleanup(() => rm(temporaryRoot, { recursive: true, force: true }));

  try {
    await mkdir(projectCopy, { recursive: true });
    await mkdir(isolatedHome, { recursive: true });
    // This cache is unique to the invocation and removed before returning. Project
    // scripts never receive the user's npm cache path or credentials through env.
    await mkdir(path.join(isolatedHome, 'npm-cache'), { recursive: true });
    await Promise.all([
      writeFile(path.join(isolatedHome, 'npmrc.user'), '', 'utf8'),
      writeFile(path.join(isolatedHome, 'npmrc.global'), '', 'utf8'),
    ]);
    const changedFiles = changedSourcePaths(diffs, options.fileChanges);
    const copiedLarge: string[] = [];
    const excluded = await copyProject(cwd, projectCopy, '--verify', [...changedFiles], copiedLarge);
    if (excluded.length) checks.push({ name: 'Excluded oversized files', command: 'copy isolated project', status: 'skipped',
      durationMs: 0, output: `Non-code assets excluded from the isolated copy because of file or project size limits: ${excluded.join(', ')}` });
    if (copiedLarge.length) checks.push({ name: 'Copied large files', command: 'copy isolated project', status: 'skipped',
      durationMs: 0, output: `Unchanged files larger than 20 MiB copied within the 500 MiB total budget: ${copiedLarge.join(', ')}` });
    if (options.fileChanges) await applyProposedFiles(projectCopy, options.fileChanges);
    else await applyProposedDiffs(projectCopy, diffs);

    const packageName = options.packageName ?? 'firebase-admin';
    const removedPackageDirs = options.removedPackageName && options.fileChanges
      ? await findRemovedPackageDirs(projectCopy, options.fileChanges, options.removedPackageName, packageName)
      : [];
    const packageDirs = [...new Set([
      ...await findRelevantPackageDirs(projectCopy, packageName),
      ...removedPackageDirs,
    ])];
    if (packageDirs.length === 0) {
      return { status: 'skipped', checks, note: `No package.json declaring ${packageName} was found in the temporary project copy.` };
    }

    const env = sanitizedEnvironment(isolatedHome);
    const installChecks: VerificationCheck[] = [];
    const installDirs = new Set(packageDirs);
    const installedRoots = new Set<string>();
    const rootPackage = await readPackageJson(projectCopy, projectCopy).catch(() => undefined);
    if (rootPackage && (rootPackage.scripts?.typecheck || rootPackage.scripts?.test || rootPackage.workspaces) && hasDependencies(rootPackage)) {
      installDirs.add(projectCopy);
    }
    for (const directory of installDirs) {
      const pkg = await readPackageJson(directory, projectCopy);
      if (!hasDependencies(pkg)) continue;
      const plan = await installCommand(projectCopy, directory, pkg);
      if (installedRoots.has(plan.cwd)) continue;
      installedRoots.add(plan.cwd);
      if (plan.command === 'yarn' && plan.yarnMajor && plan.yarnMajor >= 2) {
        const versionCheck = await runCheck('Check Yarn version', 'yarn', ['--version'], plan.cwd, env, timeoutMs, options.execute, true);
        checks.push(versionCheck);
        const actualMajor = Number(/^\s*(\d+)\./.exec(versionCheck.output)?.[1]);
        if (versionCheck.status !== 'passed' || !(actualMajor >= 2) || (plan.yarnExact && actualMajor !== plan.yarnMajor)) {
          return { status: 'failed', checks, note: `Yarn ${plan.yarnMajor} is required by this project, but the temporary copy resolved ${versionCheck.output || 'an unknown version'}. Dependency installation was refused.` };
        }
      }
      if (plan.command === 'pnpm') {
        const cacheInfo = await lstat(persistentPnpmStore).catch(() => undefined);
        if (cacheInfo?.isSymbolicLink() || (cacheInfo && !cacheInfo.isDirectory())) throw new Error('The private pnpm cache path is not a regular directory.');
        await mkdir(persistentPnpmStore, { recursive: true, mode: 0o700 });
        plan.args.push('--store-dir', persistentPnpmStore, '--prefer-offline');
      }
      const installLabel = path.relative(projectCopy, plan.cwd) || '.';
      const check = await runCheck(`Install dependencies (${installLabel})`, plan.command, plan.args, plan.cwd, env, timeoutMs, options.execute, true);
      installChecks.push(check);
      if (check.status !== 'passed') {
        checks.push(...installChecks);
        return { status: 'failed', checks, note: 'Type checks and tests were not run because dependency installation failed.' };
      }
      await readRegularFile(path.join(plan.cwd, 'package.json'), projectCopy);
    }
    checks.push(...installChecks);

    for (const directory of removedPackageDirs) {
      const relative = path.relative(projectCopy, directory) || '.';
      const candidateRoots = new Set([directory, ...installedRoots]);
      let current = directory;
      while (current !== projectCopy) {
        current = path.dirname(current);
        candidateRoots.add(current);
      }
      const installed = (await Promise.all([...candidateRoots].map(async (candidate) => {
        try {
          await lstat(path.join(candidate, 'node_modules', ...options.removedPackageName!.split('/')));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }))).some(Boolean);
      const manifest = await readPackageJson(directory, projectCopy);
      const declared = declaresPackage(manifest, options.removedPackageName!);
      const check: VerificationCheck = {
        name: `Confirm ${options.removedPackageName} is absent (${relative})`,
        command: 'inspect isolated installation',
        status: installed || declared ? 'failed' : 'passed',
        durationMs: 0,
        output: installed ? `${options.removedPackageName} is still installed in the temporary copy.`
          : declared ? `${options.removedPackageName} is still declared in the migrated package.json.`
            : `${options.removedPackageName} is absent from the migrated package and its installation.`,
      };
      checks.push(check);
      if (check.status === 'failed') return { status: 'failed', checks, note: check.output };
    }

    for (const directory of packageDirs) await readRegularFile(path.join(directory, 'package.json'), projectCopy);

    const checkDirs = await findCheckDirs(projectCopy, packageDirs);
    const runControl = async (name: string, command: string, args: string[], directory: string): Promise<void> => {
      let output = '';
      const check = await runCheck(name, command, args, directory, env, timeoutMs, options.execute, false, (value) => { output = value; });
      checks.push(check);
      executedControls.push({ check, command, args, directory, output });
    };
    for (const directory of checkDirs) {
      const pkg = await readPackageJson(directory, projectCopy);
      const relative = path.relative(projectCopy, directory) || '.';
      if (pkg.scripts?.typecheck) {
        const script = await scriptCommand(projectCopy, directory, pkg, 'typecheck');
        await runControl(`Typecheck (${relative})`, script.command, script.args, directory);
      } else if (await fileExists(path.join(directory, 'tsconfig.json'))) {
        const binary = path.join(projectCopy, 'node_modules', '.bin', 'tsc');
        const packageBinary = path.join(directory, 'node_modules', '.bin', 'tsc');
        const compiler = await installedCompiler(packageBinary, projectCopy) ? packageBinary
          : await installedCompiler(binary, projectCopy) ? binary : undefined;
        if (compiler) await runControl(`Typecheck (${relative})`, compiler, ['--noEmit'], directory);
        else checks.push({ name: `Typecheck (${relative})`, command: 'not configured', status: 'skipped',
          durationMs: 0, output: 'TypeScript is not installed in this project' });
      } else {
        checks.push({ name: `Typecheck (${relative})`, command: 'not configured', status: 'skipped', durationMs: 0, output: 'No typecheck script or tsconfig.json was found.' });
      }

      if (pkg.scripts?.build) {
        const script = await scriptCommand(projectCopy, directory, pkg, 'build');
        await runControl(`Build (${relative})`, script.command, script.args, directory);
      }

      if (pkg.scripts?.test && !isNpmInitPlaceholderTestScript(pkg.scripts.test)) {
        const script = await scriptCommand(projectCopy, directory, pkg, 'test');
        await runControl(`Tests (${relative})`, script.command, script.args, directory);
      } else {
        checks.push({ name: `Tests (${relative})`, command: 'not configured', status: 'skipped', durationMs: 0,
          output: pkg.scripts?.test ? 'The npm init placeholder test script is not configured.' : 'No test script was found.' });
      }
    }

    for (const [index, command] of (options.customCommands ?? []).entries()) {
      if (!command.trim() || command.length > 200) throw new Error('A custom verification command is empty or too long.');
      await runControl(`Custom check ${index + 1}`, '/bin/sh', ['-c', command], projectCopy);
    }

    if (!executedControls.some(({ check }) => /^(?:Typecheck|Build|Tests) \(/.test(check.name))) {
      const smoke = await runSmokeCheck(projectCopy, changedFiles, packageName, env, timeoutMs, options.execute);
      if (smoke) checks.push(smoke);
    }

    const failedControls = executedControls.filter(({ check }) => check.status === 'failed');
    let preExistingFailuresConfirmed = false;
    if (failedControls.length > 0) {
      const baselineCopy = path.join(temporaryRoot, 'baseline');
      await mkdir(baselineCopy, { recursive: true });
      await copyProject(cwd, baselineCopy, '--verify', [...changedFiles]);
      // A removed package may be malicious: the baseline copy compares the original code without ever installing it.
      if (options.removedPackageName) await stripDependency(baselineCopy, options.removedPackageName);
      const baselineInstalls = new Set<string>();
      for (const directory of installDirs) {
        const baselineDir = path.join(baselineCopy, path.relative(projectCopy, directory));
        const pkg = await readPackageJson(baselineDir, baselineCopy);
        if (!hasDependencies(pkg)) continue;
        const plan = await installCommand(baselineCopy, baselineDir, pkg);
        if (baselineInstalls.has(plan.cwd)) continue;
        baselineInstalls.add(plan.cwd);
        if (plan.command === 'yarn' && plan.yarnMajor && plan.yarnMajor >= 2) {
          const version = await runCheck('Baseline check Yarn version', 'yarn', ['--version'], plan.cwd, env, timeoutMs, options.execute, true);
          checks.push(version);
          const actualMajor = Number(/^\s*(\d+)\./.exec(version.output)?.[1]);
          if (version.status !== 'passed' || !(actualMajor >= 2) || (plan.yarnExact && actualMajor !== plan.yarnMajor)) {
            return { status: 'failed', checks, note: 'The original project could not be installed with the required Yarn version.' };
          }
        }
        if (plan.command === 'pnpm') {
          const cacheInfo = await lstat(persistentPnpmStore).catch(() => undefined);
          if (cacheInfo?.isSymbolicLink() || (cacheInfo && !cacheInfo.isDirectory())) throw new Error('The private pnpm cache path is not a regular directory.');
          await mkdir(persistentPnpmStore, { recursive: true, mode: 0o700 });
          plan.args.push('--store-dir', persistentPnpmStore, '--prefer-offline');
        }
        const label = path.relative(baselineCopy, plan.cwd) || '.';
        const install = await runCheck(`Baseline install dependencies (${label})`, plan.command, plan.args, plan.cwd, env, timeoutMs, options.execute, true);
        checks.push(install);
        if (install.status !== 'passed') return { status: 'failed', checks, note: 'The original project could not be installed for comparison.' };
        await readRegularFile(path.join(plan.cwd, 'package.json'), baselineCopy);
      }

      for (const control of failedControls) {
        const baselineDir = path.join(baselineCopy, path.relative(projectCopy, control.directory));
        const baselineCommand = path.isAbsolute(control.command) && control.command.startsWith(`${projectCopy}${path.sep}`)
          ? path.join(baselineCopy, path.relative(projectCopy, control.command)) : control.command;
        let baselineOutput = '';
        const baseline = await runCheck(`Baseline ${control.check.name}`, baselineCommand, control.args, baselineDir, env,
          timeoutMs, options.execute, false, (value) => { baselineOutput = value; });
        if (control.check.name.startsWith('Typecheck (') || control.check.name.startsWith('Build (')) {
          const after = parseTypeScriptDiagnostics(control.output, projectCopy, changedFiles);
          const before = baseline.status === 'failed'
            ? parseTypeScriptDiagnostics(baselineOutput, baselineCopy, changedFiles) : undefined;
          if (!await checksComparable(control.check.name, control.directory, baselineDir, projectCopy, baselineCopy)) {
            continue;
          }
          if (!after) {
            if (baseline.status === 'failed' && !control.output.startsWith('Timed out.') && !baselineOutput.startsWith('Timed out.')) {
              control.check.status = 'inconclusive';
              control.check.output = truncate(`${control.check.output}\n${control.check.name.split(' ')[0]} fails before and after the migration (not TypeScript diagnostics; often missing environment variables).`);
            } else if (baseline.status === 'passed') {
              control.check.output = truncate(`${control.check.output}\nThis check passed before the migration.`);
            }
            continue;
          }
          if (!before) continue;
          const introduced = [...after.entries()].filter(([key]) => !before.has(key)).map(([, value]) => value);
          const label = control.check.name.startsWith('Typecheck (') ? 'Typecheck' : 'Build';
          control.check.output = `${label}: ${before.size} pre-existing error${before.size === 1 ? '' : 's'}, `
            + `${introduced.length === 0 ? 'unchanged' : 'compared'}; ${introduced.length} introduced by the migration.`
            + (introduced.length ? `\nNew diagnostics (${Math.min(introduced.length, 20)} of ${introduced.length}):\n${introduced.slice(0, 20).join('\n')}` : '');
          control.check.output = truncate(control.check.output);
          if (introduced.length === 0) {
            control.check.status = 'passed';
            preExistingFailuresConfirmed = true;
          }
        } else if (control.check.name.startsWith('Tests (')
          && (control.output.startsWith('Timed out.') || baselineOutput.startsWith('Timed out.'))) {
          control.check.output = truncate(`${control.check.output}\nA timed-out test run cannot be treated as a pre-existing test failure.`);
        } else if (control.check.name.startsWith('Tests (') && baseline.status === 'failed'
          && !control.output.startsWith('Timed out.') && !baselineOutput.startsWith('Timed out.')) {
          control.check.status = 'inconclusive';
          control.check.output = truncate(`${control.check.output}\nTests fail before and after the migration; the effect of this migration is inconclusive.`);
        } else if (baseline.status === 'passed') {
          control.check.output = `${control.check.output}\nThis check passed before the migration.`;
        } else if (control.check.name.startsWith('Custom check ') && baseline.status === 'failed'
          && !control.output.startsWith('Timed out.') && !baselineOutput.startsWith('Timed out.')) {
          control.check.status = 'inconclusive';
          control.check.output = truncate(`${control.check.output}\nCustom check fails before and after the migration (not TypeScript diagnostics; often missing environment variables).`);
        } else {
          control.check.status = 'inconclusive';
          control.check.output = 'This check fails before and after the migration; its result is inconclusive.';
        }
      }
    }

    const ranChecks = checks.filter((check) => /^(?:Typecheck|Build|Tests|Custom check|Smoke check) /.test(check.name) && check.status !== 'skipped');
    let status: VerificationStatus = ranChecks.length === 0
      ? 'skipped'
      : ranChecks.some((check) => check.status === 'failed') ? 'failed'
        : ranChecks.some((check) => check.status === 'inconclusive') ? 'inconclusive' : 'passed';
    if (status === 'passed' && hasFirebaseFunctionsMajorBump(options.fileChanges)
      && !checks.some((check) => /^(?:Typecheck|Build|Tests) \(/.test(check.name) && check.status === 'passed')) {
      status = 'inconclusive';
      checks.push({ name: 'Firebase Functions compatibility', command: 'require substantive project check',
        status: 'inconclusive', durationMs: 0,
        output: 'A major firebase-functions upgrade requires a passing typecheck, build, or test; a syntax-only smoke check is insufficient.' });
    }
    return { status, checks, ...(status === 'skipped' ? { note: 'No typecheck, build, or test commands were configured.' }
      : status === 'passed' && checks.some((check) => check.name === 'Smoke check (syntax and imports)')
        && !checks.some((check) => check.name.startsWith('Custom check '))
        ? { note: 'only a smoke check was available: no typecheck, build or tests are configured' }
      : status === 'passed' && preExistingFailuresConfirmed
        ? { note: 'Passed (pre-existing TypeScript failures unchanged; no new diagnostics introduced by the migration).' }
        : {}) };
  } catch (error) {
    return {
      status: 'failed',
      checks,
      note: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unregisterCleanup();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function hasFirebaseFunctionsMajorBump(changes?: readonly ProposedFileChange[]): boolean {
  return (changes ?? []).some((change) => {
    if (!/(?:^|\/)package\.json$/.test(change.relativePath)) return false;
    try {
      const before = JSON.parse(change.before) as PackageJson;
      const after = JSON.parse(change.after) as PackageJson;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        const oldRange = before[section]?.['firebase-functions'];
        const newRange = after[section]?.['firebase-functions'];
        if (oldRange && newRange && /^\s*[~^]?[0-6](?:\.|$)/.test(oldRange) && /^\^7\.3\.0$/.test(newRange)) return true;
      }
    } catch { /* Invalid manifests are rejected earlier. */ }
    return false;
  });
}

export async function copyProject(source: string, destination: string, operation = '--verify', changedPaths: readonly string[] = [], copiedLarge: string[] = []): Promise<string[]> {
  let listing: string;
  try {
    ({ stdout: listing } = await execFile('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'ls-files', '-co', '--exclude-standard', '-z',
    ], {
      cwd: source,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    throw new Error(`${operation} requires a Git working tree so ignored and untracked files can be excluded safely.`);
  }
  let totalBytes = 0;
  let largeBytes = 0;
  const excluded: string[] = [];
  const changed = new Set(changedPaths.map((file) => path.normalize(file).replaceAll('\\', '/')));
  const candidates: Array<{ relative: string; portable: string; sourcePath: string; size: number; asset: boolean }> = [];
  for (const relative of listing.split('\0').filter(Boolean)) {
    const portable = relative.replaceAll('\\', '/');
    const parts = portable.split('/');
    if (parts.some((part) => IGNORED_PROJECT_DIRECTORIES.has(part))
      || ignoredFiles.has(parts.at(-1)!) || isSensitivePath(portable)) continue;
    const sourcePath = path.resolve(source, relative);
    const relativeCheck = path.relative(source, sourcePath);
    if (path.isAbsolute(relativeCheck) || relativeCheck === '..' || relativeCheck.startsWith(`..${path.sep}`)) continue;
    const info = await lstat(sourcePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const name = parts.at(-1)!.toLowerCase();
    const sizeLimited = changed.has(portable) || name === 'package.json' || lockfileNames.has(name);
    const asset = !sizeLimited && !sourceExtensions.has(path.extname(name)) && (largeAssetExtensions.has(path.extname(name))
      || parts.slice(0, -1).some((part) => ['public', 'assets'].includes(part.toLowerCase())));
    if (info.size > maxCopyFileBytes) {
      if (sizeLimited) throw new Error(`--verify refused a file larger than ${maxCopyFileBytes / (1024 * 1024)} MiB: ${portable}`);
      largeBytes += info.size;
      copiedLarge.push(portable);
    } else {
      totalBytes += info.size;
    }
    candidates.push({ relative, portable, sourcePath, size: info.size, asset });
  }
  if (totalBytes > maxCopyBytes) {
    for (const candidate of candidates) if (candidate.asset && candidate.size <= maxCopyFileBytes) {
      totalBytes -= candidate.size;
      excluded.push(candidate.portable);
    }
  }
  if (totalBytes > maxCopyBytes) throw new Error(`--verify refused a project copy larger than ${maxCopyBytes / (1024 * 1024)} MiB after excluding non-code assets.`);
  if (totalBytes + largeBytes > maxTotalCopyBytes)
    throw new Error(`--verify refused a project copy larger than ${maxTotalCopyBytes / (1024 * 1024)} MiB including unchanged large files.`);
  const excludedSet = new Set(excluded);
  for (const candidate of candidates) {
    if (excludedSet.has(candidate.portable)) continue;
    const destinationPath = path.join(destination, candidate.relative);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(candidate.sourcePath, destinationPath);
  }
  return excluded;
}

function isSensitivePath(relative: string): boolean {
  const parts = relative.split('/');
  const base = parts.at(-1)!.toLowerCase();
  return parts.some((part) => ['.aws', '.gcloud', '.ssh', 'secrets'].includes(part.toLowerCase()))
    || /(?:service[-_]?account[^/]*|firebase-adminsdk[^/]*|credentials?[^/]*|secrets?[^/]*|private[-_]?key[^/]*)\.json$/i.test(base)
    || /\.(?:pem|key)$/i.test(base)
    || /^\.env(?:\.|$)/i.test(base) && !/\.(?:example|sample|template)$/i.test(base);
}

export async function applyProposedDiffs(projectCopy: string, diffs: string[]): Promise<void> {
  for (const diff of diffs) {
    const patch = parsePatch(diff)[0];
    if (!patch) throw new Error('A proposed change could not be parsed as a unified diff.');
    const destination = patch.newFileName?.replace(/^b\//, '');
    if (!destination || destination === '/dev/null') continue;
    const portableDestination = destination.replaceAll('\\', '/');
    const normalized = path.normalize(portableDestination);
    if (path.isAbsolute(portableDestination) || /^[A-Za-z]:/.test(portableDestination)
      || normalized === '..' || normalized.startsWith(`..${path.sep}`)
      || portableDestination.split('/').includes('..')) {
      throw new Error(`A proposed change has an unsafe path: ${destination}`);
    }
    const target = path.join(projectCopy, normalized);
    const before = await readFile(target, 'utf8');
    const after = applyPatch(before, patch);
    if (after === false) throw new Error(`Could not apply the proposed change to ${destination} in the temporary copy.`);
    await writeFile(target, after, 'utf8');
  }
}

export async function applyProposedFiles(projectCopy: string, changes: ProposedFileChange[]): Promise<void> {
  const root = path.resolve(projectCopy);
  const seen = new Set<string>();
  for (const change of changes) {
    const absolute = path.resolve(root, change.relativePath);
    const relative = path.relative(root, absolute);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`A proposed change has an unsafe path: ${change.relativePath}`);
    }
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(key)) throw new Error(`A proposed change contains a duplicate path: ${change.relativePath}`);
    seen.add(key);
    let ancestor = root;
    for (const component of relative.split(path.sep)) {
      ancestor = path.join(ancestor, component);
      const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (info?.isSymbolicLink()) throw new Error(`A proposed change crosses a symbolic link: ${change.relativePath}`);
    }
    const current = await readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (current !== change.before) throw new Error(`The temporary project does not match the migration input for ${change.relativePath}.`);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, change.after, 'utf8');
  }
}

async function findRelevantPackageDirs(root: string, packageName: string): Promise<string[]> {
  const manifests = await findPackageFiles(root);
  const packageDirs: string[] = [];
  for (const manifestPath of manifests) {
    const pkg = await readPackageJson(path.dirname(manifestPath), root).catch(() => undefined);
    if (!pkg) continue;
    if (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .some((section) => typeof (pkg as Record<string, unknown>)[section] === 'object'
        && (pkg as Record<string, Record<string, string>>)[section]?.[packageName])) {
      packageDirs.push(path.dirname(manifestPath));
    }
  }
  const rootPackage = await readPackageJson(root, root).catch(() => undefined);
  if (rootPackage?.workspaces && packageDirs.length > 0) return [root];
  return [...new Set(packageDirs)];
}

function declaresPackage(pkg: PackageJson, packageName: string): boolean {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some((section) => Object.hasOwn((pkg as Record<string, Record<string, string>>)[section] ?? {}, packageName));
}

async function findRemovedPackageDirs(
  root: string,
  changes: ProposedFileChange[],
  removedPackageName: string,
  targetPackageName: string,
): Promise<string[]> {
  if (!/^(?:@[^/.][^/]*\/)?[^/.][^/]*$/.test(removedPackageName)) {
    throw new Error('Invalid removed package name for verification.');
  }
  const directories: string[] = [];
  for (const change of changes) {
    if (path.basename(change.relativePath) !== 'package.json') continue;
    const before = parseManifest<PackageJson>(change.before);
    const after = parseManifest<PackageJson>(change.after);
    if (!declaresPackage(before, removedPackageName) || declaresPackage(after, removedPackageName)
      || declaresPackage(after, targetPackageName)) continue;
    const directory = path.dirname(path.resolve(root, change.relativePath));
    const relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('A proposed package.json is outside the temporary project copy.');
    }
    await readRegularFile(path.join(directory, 'package.json'), root);
    directories.push(directory);
  }
  return [...new Set(directories)];
}

async function findCheckDirs(root: string, packageDirs: string[]): Promise<string[]> {
  const candidates = new Set([root, ...packageDirs]);
  const output: string[] = [];
  for (const directory of candidates) {
    const pkg = packageDirs.includes(directory) ? await readPackageJson(directory, root)
      : await readPackageJson(directory, root).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
    if (pkg) output.push(directory);
  }
  return output;
}

async function findPackageFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && entry.name === 'package.json') found.push(absolute);
    }
  }
  await visit(root);
  return found;
}

async function readPackageJson(directory: string, trustedRoot: string): Promise<PackageJson> {
  try {
    return parseManifest<PackageJson>(await readRegularFile(path.join(directory, 'package.json'), trustedRoot));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid package.json used for verification.');
    throw error;
  }
}

/** Removes a dependency from every package.json of a temporary copy, so that it is never installed there. */
async function stripDependency(root: string, packageName: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const manifest = parseManifest<Record<string, unknown>>(await readRegularFile(absolutePath, root));
        let changed = false;
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const dependencies = manifest[section] as Record<string, unknown> | undefined;
          if (dependencies && Object.hasOwn(dependencies, packageName)) {
            delete dependencies[packageName];
            changed = true;
          }
        }
        if (changed) await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      }
    }
  };
  await visit(root);
}

export async function readRegularFile(file: string, trustedRoot?: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const boundary = trustedRoot ? path.resolve(trustedRoot) : path.parse(path.resolve(file)).root;
  if (trustedRoot) {
    const relative = path.relative(boundary, path.resolve(file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Verification metadata is outside its trusted root.');
    if (!(await lstat(await realpath(boundary))).isDirectory()) throw new Error('Verification root must be a directory.');
  }
  let parent = path.dirname(path.resolve(file));
  while (parent !== boundary) {
    const info = await lstat(parent);
    if (info.isSymbolicLink()) throw new Error('Verification metadata has a symbolic link in its parent path.');
    if (!info.isDirectory()) throw new Error('Verification metadata parent must be a directory.');
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Verification metadata must be a regular file.');
    if (info.size > maxBytes) throw new Error('Verification metadata exceeds the size limit.');
    return await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
}

function hasDependencies(pkg: PackageJson): boolean {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some((section) => Object.keys((pkg as Record<string, Record<string, string>>)[section] ?? {}).length > 0);
}

function isNpmInitPlaceholderTestScript(script: string): boolean {
  const normalized = script.trim().replaceAll('\\"', '"');
  return /^echo\s+(?:"Error:\s*no\s+test\s+specified"|'Error:\s*no\s+test\s+specified'|Error:\s*no\s+test\s+specified)\s*&&\s*exit\s+1$/.test(normalized);
}

function changedSourcePaths(diffs: string[], changes?: ProposedFileChange[]): Set<string> {
  const paths = changes?.map((change) => change.relativePath) ?? diffs.flatMap((diff) =>
    parsePatch(diff).map((patch) => patch.newFileName?.replace(/^b\//, '') ?? ''));
  return new Set(paths.map((file) => path.normalize(file).replaceAll('\\', '/')));
}

async function runSmokeCheck(
  root: string,
  changedFiles: Set<string>,
  packageName: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  execute: VerificationOptions['execute'],
): Promise<VerificationCheck | undefined> {
  const files = [...changedFiles].filter((file) => /\.(?:js|mjs|cjs)$/i.test(file)).sort();
  if (files.length === 0) return undefined;
  const started = Date.now();
  const name = 'Smoke check (syntax and imports)';
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  let resolvedCount = 0;
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    const within = path.relative(root, absolute);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      return { name, command: 'node --check; resolve migrated package imports', status: 'failed',
        durationMs: Date.now() - started, output: `Unsafe changed JavaScript path: ${relative}` };
    }
    const syntax = await runCheck(name, process.execPath, ['--check', absolute], path.dirname(absolute), env, timeoutMs, execute);
    if (syntax.status !== 'passed') return { ...syntax, command: 'node --check; resolve migrated package imports',
      output: truncate(`${relative}: ${syntax.output}`) };
    try {
      const source = project.createSourceFile(relative, await readRegularFile(absolute, root, maxCopyFileBytes));
      const specifiers = new Set<string>();
      for (const declaration of source.getImportDeclarations()) specifiers.add(declaration.getModuleSpecifierValue());
      for (const declaration of source.getExportDeclarations()) {
        const specifier = declaration.getModuleSpecifierValue();
        if (specifier) specifiers.add(specifier);
      }
      for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (callee.getText() !== 'require' && callee.getKind() !== SyntaxKind.ImportKeyword) continue;
        const argument = call.getArguments()[0];
        if (argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
          specifiers.add(argument.getLiteralValue());
        }
      }
      const resolve = createRequire(absolute).resolve;
      for (const specifier of specifiers) {
        if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
        try {
          const target = resolve(specifier);
          const location = path.relative(root, target);
          if (location === '..' || location.startsWith(`..${path.sep}`) || path.isAbsolute(location)) {
            throw new Error('resolved outside the isolated installation');
          }
        } catch (error) {
          throw new Error(`Could not resolve ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
        }
        resolvedCount++;
      }
    } catch (error) {
      return { name, command: 'node --check; resolve migrated package imports', status: 'failed',
        durationMs: Date.now() - started, output: truncate(`${relative}: ${error instanceof Error ? error.message : String(error)}`) };
    }
  }
  return { name, command: 'node --check; resolve migrated package imports', status: 'passed',
    durationMs: Date.now() - started,
    output: `Checked syntax of ${files.length} changed JavaScript file${files.length === 1 ? '' : 's'} and resolved ${resolvedCount} migrated-package import${resolvedCount === 1 ? '' : 's'}.` };
}

function parseTypeScriptDiagnostics(output: string, root: string, changedFiles: Set<string>): Map<string, string> | undefined {
  if (!output || output.includes('[middle of command output omitted]') || output.includes('Timed out.')) return undefined;
  const diagnostics = new Map<string, string>();
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  let totalCodes = 0;
  let parsedCodes = 0;
  for (const line of clean.split(/\r?\n/)) {
    if (/\berror\s+TS\d+:/.test(line)) totalCodes++;
    const match = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/.exec(line.trim())
      ?? /^(.+?):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    parsedCodes++;
    const filename = path.normalize(path.isAbsolute(match[1]!) ? path.relative(root, match[1]!) : match[1]!).replaceAll('\\', '/');
    if (filename === '..' || filename.startsWith('../') || path.isAbsolute(filename)) return undefined;
    const location = changedFiles.has(filename) ? '' : `:${match[2]}:${match[3]}`;
    const message = match[5]!.replace(/\s+/g, ' ').trim();
    const key = `${filename}${location} ${match[4]} ${message}`;
    diagnostics.set(key, `${filename}${location}: ${match[4]}: ${message}`);
  }
  return diagnostics.size > 0 && parsedCodes === totalCodes ? diagnostics : undefined;
}

async function checksComparable(
  checkName: string,
  migratedDir: string,
  baselineDir: string,
  migratedRoot: string,
  baselineRoot: string,
): Promise<boolean> {
  const script = checkName.startsWith('Typecheck (') ? 'typecheck' : 'build';
  const [migrated, baseline] = await Promise.all([
    readPackageJson(migratedDir, migratedRoot), readPackageJson(baselineDir, baselineRoot),
  ]);
  return migrated.scripts?.[script] === baseline.scripts?.[script]
    && migrated.packageManager === baseline.packageManager;
}

async function installCommand(
  root: string,
  directory: string,
  pkg: PackageJson,
): Promise<{ command: string; args: string[]; cwd: string; yarnMajor?: number; yarnExact?: boolean }> {
  const { lockRoot, manager, declared } = await detectPackageManager(root, directory, pkg);
  if (manager === 'pnpm') return { command: 'pnpm', args: ['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.pnpmfile=/dev/null', '--config.global-pnpmfile=/dev/null'], cwd: lockRoot };
  if (manager === 'yarn') {
    const version = Number(/^yarn@(\d+)/.exec(declared ?? '')?.[1] ?? 1);
    const yarnBerry = version >= 2 || (await readRegularFile(path.join(lockRoot, 'yarn.lock'), root).catch(() => '')).includes('__metadata:');
    return {
      command: 'yarn',
      args: ['install', ...(yarnBerry ? ['--mode=skip-builds'] : ['--ignore-scripts'])],
      cwd: lockRoot,
      ...(yarnBerry ? { yarnMajor: Math.max(version, 2), yarnExact: version >= 2 } : {}),
    };
  }
  return { command: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], cwd: lockRoot };
}

async function findLockfileRoot(root: string, directory: string): Promise<string> {
  let current = directory;
  while (current === root || current.startsWith(root + path.sep)) {
    if (await findLockfileName(current)) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  return directory;
}

async function findLockfileName(directory: string): Promise<string | undefined> {
  for (const name of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']) {
    try {
      await stat(path.join(directory, name));
      return name;
    } catch {
      // Check the next supported lockfile name.
    }
  }
  return undefined;
}

async function scriptCommand(root: string, directory: string, pkg: PackageJson, script: string): Promise<{ command: string; args: string[] }> {
  const { manager } = await detectPackageManager(root, directory, pkg);
  if (manager === 'pnpm') return { command: 'pnpm', args: ['run', script] };
  if (manager === 'yarn') return { command: 'yarn', args: ['run', script] };
  return { command: 'npm', args: ['--ignore-scripts', 'run', script] };
}

async function detectPackageManager(root: string, directory: string, pkg: PackageJson): Promise<{ lockRoot: string; manager: 'npm' | 'pnpm' | 'yarn'; declared?: string }> {
  const lockRoot = await findLockfileRoot(root, directory);
  const lockfile = await findLockfileName(lockRoot);
  const rootPackage = await readPackageJson(lockRoot, root).catch(() => undefined);
  const declared: unknown = pkg.packageManager ?? rootPackage?.packageManager;
  if (declared !== undefined && (typeof declared !== 'string' || !/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/.test(declared))) {
    throw new Error(`Unsupported or unsafe packageManager field: ${String(declared)}. Use an exact npm, pnpm, or Yarn version.`);
  }
  const manager = declared === undefined
    ? lockfile === 'pnpm-lock.yaml' ? 'pnpm' : lockfile === 'yarn.lock' ? 'yarn' : 'npm'
    : declared.slice(0, declared.indexOf('@')) as 'npm' | 'pnpm' | 'yarn';
  return { lockRoot, manager, ...(typeof declared === 'string' ? { declared } : {}) };
}

async function runCheck(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  execute: VerificationOptions['execute'],
  allowInstallNetwork = false,
  captureOutput?: (output: string) => void,
): Promise<VerificationCheck> {
  const start = Date.now();
  const commandText = [command, ...args].join(' ');
  try {
    const result = execute ? await execute(command, args, cwd, env, timeoutMs, allowInstallNetwork) : undefined;
    if (execute && result === undefined && name.startsWith('Install dependencies')) {
      throw new Error('The supplied executor did not provide an installation result; refusing to run a real package install.');
    }
    const output = result ?? await executeWithProcessGroup(command, args, cwd, env, timeoutMs);
    captureOutput?.(`${output.stdout ?? ''}${output.stderr ?? ''}`);
    return { name, command: commandText, status: 'passed', durationMs: Date.now() - start, output: truncate(`${output.stdout ?? ''}${output.stderr ?? ''}`) };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; timedOut?: boolean };
    const output = `${cause.stdout ?? ''}${cause.stderr ?? ''}` || cause.message || 'Command failed without output.';
    const timedOut = cause.timedOut || cause.code === 'ETIMEDOUT' || cause.killed;
    captureOutput?.(`${timedOut ? 'Timed out. ' : ''}${output}`);
    return { name, command: commandText, status: 'failed', durationMs: Date.now() - start, output: truncate(`${timedOut ? 'Timed out. ' : ''}${output}`) };
  }
}

export async function executeWithProcessGroup(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const unregisterGroup = child.pid ? trackProcessGroup(child.pid) : () => undefined;
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    const timeout = setTimeout(() => {
      void finish(new Error(`Command exceeded its ${timeoutMs} ms timeout.`), true);
    }, timeoutMs);
    const append = (current: string, chunk: string): string => {
      const marker = '\n… [middle of command output omitted] …\n';
      const limit = 2 * 1024 * 1024;
      const next = current + chunk;
      if (next.length <= limit) return next;
      const middle = current.indexOf(marker);
      const head = middle >= 0 ? current.slice(0, middle) : next.slice(0, limit / 2);
      return head + marker + next.slice(-limit / 2);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, stdoutDecoder.write(chunk)); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, stderrDecoder.write(chunk)); });
    const finish = async (error?: Error, timedOut = false): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!timedOut) await new Promise((done) => setTimeout(done, 50));
      stdout = append(stdout, stdoutDecoder.end());
      stderr = append(stderr, stderrDecoder.end());
      if (child.pid) await terminateProcessGroup(child.pid, timedOut ? 100 : 0);
      child.stdout?.destroy();
      child.stderr?.destroy();
      unregisterGroup();
      if (error) reject(Object.assign(error, { stdout, stderr, ...(timedOut ? { code: 'ETIMEDOUT', timedOut: true } : {}) }));
      else resolve({ stdout, stderr });
    };
    child.once('error', (error) => {
      void finish(error);
    });
    child.once('exit', (code, signal) => {
      void finish(code === 0 ? undefined : new Error(`Command exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

export function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'TZ']);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
  env.HOME = home;
  env.USERPROFILE = home;
  env.NPM_CONFIG_USERCONFIG = path.join(home, 'npmrc.user');
  env.NPM_CONFIG_GLOBALCONFIG = path.join(home, 'npmrc.global');
  env.NPM_CONFIG_CACHE = path.join(home, 'npm-cache');
  env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  env.YARN_IGNORE_SCRIPTS = 'true';
  env.YARN_NODE_LINKER = 'node-modules';
  env.YARN_ENABLE_SCRIPTS = 'false';
  env.CI = '1';
  env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = '0';
  env.COREPACK_ENABLE_PROJECT_SPEC = '0';
  env.COREPACK_ENABLE_AUTO_PIN = '0';
  env.COREPACK_HOME = path.join(home, 'corepack');
  return env;
}

function truncate(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxOutputLength) return trimmed;
  const marker = '\n… [truncated middle; beginning and end retained] …\n';
  const headLength = Math.floor((maxOutputLength - marker.length) / 2);
  return trimmed.slice(0, headLength) + marker + trimmed.slice(-(maxOutputLength - marker.length - headLength));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function installedCompiler(file: string, projectRoot: string): Promise<boolean> {
  try {
    const target = await realpath(file);
    const relative = path.relative(projectRoot, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && (await stat(target)).isFile();
  } catch {
    return false;
  }
}
