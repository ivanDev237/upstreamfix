import { execFile as execFileCallback, spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyPatch, parsePatch } from 'diff';
import type { ProposedFileChange } from './types.js';
import { registerTemporaryCleanup, terminateProcessGroup, trackProcessGroup } from './process-cleanup.js';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.codex', '.claude']);
const ignoredFiles = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnpmfile.mjs', 'yarn.config.cjs']);
const maxOutputLength = 4_000;
const maxCopyBytes = 100 * 1024 * 1024;
const maxCopyFileBytes = 20 * 1024 * 1024;
const execFile = promisify(execFileCallback);

export type VerificationStatus = 'passed' | 'failed' | 'skipped';

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
  /** Package whose installed version makes this migration applicable. Defaults to firebase-admin for compatibility. */
  packageName?: string;
  /** Exact migration results. When present these are applied directly; unified diffs are for display only. */
  fileChanges?: ProposedFileChange[];
  execute?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ stdout?: string; stderr?: string } | undefined>;
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
  const checks: VerificationCheck[] = [];
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
    await copyProject(cwd, projectCopy);
    if (options.fileChanges) await applyProposedFiles(projectCopy, options.fileChanges);
    else await applyProposedDiffs(projectCopy, diffs);

    const packageName = options.packageName ?? 'firebase-admin';
    const packageDirs = await findRelevantPackageDirs(projectCopy, packageName);
    if (packageDirs.length === 0) {
      return { status: 'skipped', checks, note: `No package.json declaring ${packageName} was found in the temporary project copy.` };
    }

    const env = sanitizedEnvironment(isolatedHome);
    const installChecks: VerificationCheck[] = [];
    const installDirs = new Set(packageDirs);
    const rootPackage = await readPackageJson(projectCopy).catch(() => undefined);
    if (rootPackage && (rootPackage.scripts?.typecheck || rootPackage.scripts?.test || rootPackage.workspaces) && hasDependencies(rootPackage)) {
      installDirs.add(projectCopy);
    }
    for (const directory of installDirs) {
      const pkg = await readPackageJson(directory);
      if (!hasDependencies(pkg)) continue;
      const plan = await installCommand(projectCopy, directory, pkg);
      const installLabel = path.relative(projectCopy, plan.cwd) || '.';
      const check = await runCheck(`Install dependencies (${installLabel})`, plan.command, plan.args, plan.cwd, env, timeoutMs, options.execute);
      installChecks.push(check);
      if (check.status !== 'passed') {
        checks.push(...installChecks);
        return { status: 'failed', checks, note: 'Type checks and tests were not run because dependency installation failed.' };
      }
    }
    checks.push(...installChecks);

    const checkDirs = await findCheckDirs(projectCopy, packageDirs);
    for (const directory of checkDirs) {
      const pkg = await readPackageJson(directory);
      const relative = path.relative(projectCopy, directory) || '.';
      if (pkg.scripts?.typecheck) {
        const script = await scriptCommand(projectCopy, directory, pkg, 'typecheck');
        checks.push(await runCheck(`Typecheck (${relative})`, script.command, script.args, directory, env, timeoutMs, options.execute));
      } else if (await fileExists(path.join(directory, 'tsconfig.json'))) {
        const binary = path.join(projectCopy, 'node_modules', '.bin', 'tsc');
        const packageBinary = path.join(directory, 'node_modules', '.bin', 'tsc');
        const compiler = await fileExists(packageBinary) ? packageBinary : binary;
        checks.push(await runCheck(`Typecheck (${relative})`, compiler, ['--noEmit'], directory, env, timeoutMs, options.execute));
      } else {
        checks.push({ name: `Typecheck (${relative})`, command: 'not configured', status: 'skipped', durationMs: 0, output: 'No typecheck script or tsconfig.json was found.' });
      }

      if (pkg.scripts?.test) {
        const script = await scriptCommand(projectCopy, directory, pkg, 'test');
        checks.push(await runCheck(`Tests (${relative})`, script.command, script.args, directory, env, timeoutMs, options.execute));
      } else {
        checks.push({ name: `Tests (${relative})`, command: 'not configured', status: 'skipped', durationMs: 0, output: 'No test script was found.' });
      }
    }

    const ranChecks = checks.filter((check) => /^(?:Typecheck|Tests) /.test(check.name) && check.status !== 'skipped');
    const status: VerificationStatus = ranChecks.length === 0
      ? 'skipped'
      : ranChecks.some((check) => check.status === 'failed') ? 'failed' : 'passed';
    return { status, checks, ...(status === 'skipped' ? { note: 'No typecheck or test commands were configured.' } : {}) };
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

async function copyProject(source: string, destination: string): Promise<void> {
  let listing: string;
  try {
    ({ stdout: listing } = await execFile('git', [
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'ls-files', '-co', '--exclude-standard', '-z',
    ], {
      cwd: source,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' },
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    throw new Error('--verify requires a Git working tree so ignored and untracked files can be excluded safely.');
  }
  let totalBytes = 0;
  for (const relative of listing.split('\0').filter(Boolean)) {
    const portable = relative.replaceAll('\\', '/');
    const parts = portable.split('/');
    if (parts.some((part) => ignoredDirectories.has(part))
      || ignoredFiles.has(parts.at(-1)!) || isSensitivePath(portable)) continue;
    const sourcePath = path.resolve(source, relative);
    const relativeCheck = path.relative(source, sourcePath);
    if (path.isAbsolute(relativeCheck) || relativeCheck === '..' || relativeCheck.startsWith(`..${path.sep}`)) continue;
    const info = await lstat(sourcePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    if (info.size > maxCopyFileBytes) throw new Error(`--verify refused a file larger than ${maxCopyFileBytes / (1024 * 1024)} MiB: ${portable}`);
    totalBytes += info.size;
    if (totalBytes > maxCopyBytes) throw new Error(`--verify refused a project copy larger than ${maxCopyBytes / (1024 * 1024)} MiB.`);
    const destinationPath = path.join(destination, relative);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
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
    const current = await readFile(absolute, 'utf8').catch(() => undefined);
    if (current !== change.before) throw new Error(`The temporary project does not match the migration input for ${change.relativePath}.`);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, change.after, 'utf8');
  }
}

async function findRelevantPackageDirs(root: string, packageName: string): Promise<string[]> {
  const manifests = await findPackageFiles(root);
  const packageDirs: string[] = [];
  for (const manifestPath of manifests) {
    const pkg = await readPackageJson(path.dirname(manifestPath));
    if (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .some((section) => typeof (pkg as Record<string, unknown>)[section] === 'object'
        && (pkg as Record<string, Record<string, string>>)[section]?.[packageName])) {
      packageDirs.push(path.dirname(manifestPath));
    }
  }
  const rootPackage = await readPackageJson(root).catch(() => undefined);
  if (rootPackage?.workspaces && packageDirs.length > 0) return [root];
  return [...new Set(packageDirs)];
}

async function findCheckDirs(root: string, packageDirs: string[]): Promise<string[]> {
  const candidates = new Set([root, ...packageDirs]);
  const output: string[] = [];
  for (const directory of candidates) {
    const pkg = await readPackageJson(directory).catch(() => undefined);
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
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && entry.name === 'package.json') found.push(absolute);
    }
  }
  await visit(root);
  return found;
}

async function readPackageJson(directory: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PackageJson;
}

function hasDependencies(pkg: PackageJson): boolean {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some((section) => Object.keys((pkg as Record<string, Record<string, string>>)[section] ?? {}).length > 0);
}

async function installCommand(
  root: string,
  directory: string,
  pkg: PackageJson,
): Promise<{ command: string; args: string[]; cwd: string }> {
  const lockRoot = await findLockfileRoot(root, directory);
  const lockfile = await findLockfileName(lockRoot);
  const rootPackage = await readPackageJson(lockRoot).catch(() => undefined);
  const declared: unknown = pkg.packageManager ?? rootPackage?.packageManager;
  let manager: string;
  if (declared === undefined) manager = lockfile === 'pnpm-lock.yaml' ? 'pnpm' : lockfile === 'yarn.lock' ? 'yarn' : 'npm';
  else {
    if (typeof declared !== 'string' || !/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/.test(declared)) {
      throw new Error(`Unsupported or unsafe packageManager field: ${String(declared)}. Use an exact npm, pnpm, or Yarn version.`);
    }
    manager = declared.slice(0, declared.indexOf('@'));
  }
  if (manager === 'pnpm') return { command: 'pnpm', args: ['install', '--ignore-scripts', '--no-frozen-lockfile'], cwd: lockRoot };
  if (manager === 'yarn') {
    const version = Number(/^yarn@(\d+)/.exec(declared ?? '')?.[1] ?? 1);
    const yarnBerry = version >= 2 || (await readFile(path.join(lockRoot, 'yarn.lock'), 'utf8').catch(() => '')).includes('__metadata:');
    return {
      command: 'yarn',
      args: ['install', ...(yarnBerry ? ['--mode=skip-builds'] : ['--ignore-scripts'])],
      cwd: lockRoot,
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
  return root;
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
  const lockRoot = await findLockfileRoot(root, directory);
  const lockfile = await findLockfileName(lockRoot);
  const rootPackage = await readPackageJson(lockRoot).catch(() => undefined);
  const manager = pkg.packageManager?.split('@')[0] ?? rootPackage?.packageManager?.split('@')[0]
    ?? (lockfile === 'pnpm-lock.yaml' ? 'pnpm' : lockfile === 'yarn.lock' ? 'yarn' : 'npm');
  if (manager === 'pnpm') return { command: 'pnpm', args: ['run', script] };
  if (manager === 'yarn') return { command: 'yarn', args: ['run', script] };
  return { command: 'npm', args: ['--ignore-scripts', 'run', script] };
}

async function runCheck(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  execute: VerificationOptions['execute'],
): Promise<VerificationCheck> {
  const start = Date.now();
  const commandText = [command, ...args].join(' ');
  try {
    const result = execute ? await execute(command, args, cwd, env, timeoutMs) : undefined;
    const output = result ?? await executeWithProcessGroup(command, args, cwd, env, timeoutMs);
    return { name, command: commandText, status: 'passed', durationMs: Date.now() - start, output: truncate(`${output.stdout ?? ''}${output.stderr ?? ''}`) };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; timedOut?: boolean };
    const output = `${cause.stdout ?? ''}${cause.stderr ?? ''}` || cause.message || 'Command failed without output.';
    const timedOut = cause.timedOut || cause.code === 'ETIMEDOUT' || cause.killed;
    return { name, command: commandText, status: 'failed', durationMs: Date.now() - start, output: truncate(`${timedOut ? 'Timed out. ' : ''}${output}`) };
  }
}

async function executeWithProcessGroup(
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
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 750);
    }, timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      const remaining = 2 * 1024 * 1024 - Buffer.byteLength(current);
      return remaining <= 0 ? current : current + chunk.toString('utf8').slice(0, remaining);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
    };
    child.once('error', async (error) => {
      if (child.pid) await terminateProcessGroup(child.pid, 0);
      unregisterGroup();
      const failure = Object.assign(error, { stdout, stderr, timedOut });
      finish(failure);
    });
    child.once('close', async (code, signal) => {
      if (child.pid) await terminateProcessGroup(child.pid);
      unregisterGroup();
      if (timedOut) {
        finish(Object.assign(new Error(`Command exceeded its ${timeoutMs} ms timeout.`), { code: 'ETIMEDOUT', stdout, stderr, timedOut: true }));
      } else if (code === 0) {
        finish();
        resolve({ stdout, stderr });
      } else {
        finish(Object.assign(new Error(`Command exited with ${signal ? `signal ${signal}` : `code ${code}`}.`), { stdout, stderr }));
      }
    });
  });
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
  env.HOME = home;
  env.USERPROFILE = home;
  env.NPM_CONFIG_USERCONFIG = path.join(home, 'npmrc.user');
  env.NPM_CONFIG_GLOBALCONFIG = path.join(home, 'npmrc.global');
  env.NPM_CONFIG_CACHE = path.join(home, 'npm-cache');
  env.YARN_NODE_LINKER = 'node-modules';
  env.YARN_ENABLE_SCRIPTS = 'false';
  env.CI = '1';
  env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = '0';
  return env;
}

function truncate(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= maxOutputLength ? trimmed : `${trimmed.slice(0, maxOutputLength)} … [truncated]`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
