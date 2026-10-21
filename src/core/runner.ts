import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { registerTemporaryCleanup } from './process-cleanup.js';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { structuredPatch } from 'diff';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import type { ManualItem, Migration, MigrationResult, PackageManifest, ProposedFileChange } from './types.js';
import { IGNORED_PROJECT_DIRECTORIES, isSupportedSourceMajor } from './project-discovery.js';
import { parseManifest } from './manifest.js';
import { guaranteesNodeMajor } from './node-range.js';

const execFile = promisify(execFileCallback);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_DIFF_INPUT_BYTES = 1024 * 1024;
const MAX_DIFF_OUTPUT_CHARS = 64 * 1024;
const MAX_REPORT_DIFF_CHARS = 256 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const NODE_ONLY_GLOBALS = new Set([
  'Buffer', '__dirname', '__filename', 'clearImmediate', 'exports', 'global', 'module', 'process', 'require',
  'setImmediate', 'NodeJS',
]);
const NODE_BUILTIN_PATTERN = [...NODE_BUILTIN_MODULES].sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const NODE_GLOBAL_PATTERN = new RegExp(`\\b(?:${[...NODE_ONLY_GLOBALS].join('|')})\\b`);

export function loadProject(cwd: string, packageName = 'firebase-admin'): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  for (const sourcePath of findSourceFiles(cwd, packageName)) {
    if (statSync(sourcePath).size <= MAX_SOURCE_BYTES) project.addSourceFileAtPath(sourcePath);
  }
  return project;
}

interface ScopedProject {
  project: Project;
  manual: ManualItem[];
  manifestBySource: Map<string, string>;
}

function loadScopedProject(root: string, migration: Migration, excludedDirectories: readonly string[] = [], nodeRuntime?: number, analysisRuntimeOverride = false): ScopedProject {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  const manifests = findPackageManifests(root, excludedDirectories).map((file) => {
    let parsed: PackageManifest | undefined;
    let invalid = false;
    try {
      parsed = parseManifest<PackageManifest>(readFileSync(file, 'utf8'));
    } catch {
      invalid = true;
    }
    return { file, parsed, invalid };
  });
  const manual: ManualItem[] = [];
  const manifestBySource = new Map<string, string>();

  for (const sourcePath of findSourceFiles(root, migration.packageName, excludedDirectories)) {
    if (statSync(sourcePath).size > MAX_SOURCE_BYTES) {
      manual.push({ file: sourcePath, line: 1, reason: 'Source file exceeds the 2 MiB analysis size limit; review this SDK usage manually.', snippet: '' });
      continue;
    }
    const containingManifests = manifests
      .filter(({ file }) => {
        const directory = path.dirname(file);
        return sourcePath === directory || sourcePath.startsWith(directory + path.sep);
      })
      .sort((left, right) => right.file.length - left.file.length);

    let declaration: { file: string; range: string; manifest: PackageManifest } | undefined;
    let invalidManifest: { file: string; reason: string } | undefined;
    for (const candidate of containingManifests) {
      if (candidate.invalid) {
        invalidManifest = { file: candidate.file, reason: 'is invalid JSON' };
        break;
      }
      const manifest = candidate.parsed;
      if (!manifest) continue;
      const ranges = (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
        .map((section) => manifest[section]?.[migration.packageName])
        .filter((value): value is string => typeof value === 'string');
      if (ranges.length > 0) {
        if (new Set(ranges).size === 1) declaration = { file: candidate.file, range: ranges[0]!, manifest };
        else invalidManifest = { file: candidate.file, reason: 'declares conflicting dependency ranges' };
        break;
      }
    }

    if (invalidManifest) {
      manual.push({
        file: sourcePath,
        line: 1,
        reason: `The ${migration.packageName} version could not be confirmed because ${path.relative(root, invalidManifest.file)} ${invalidManifest.reason}.`,
        snippet: readFileSync(sourcePath, 'utf8').split(/\r?\n/, 1)[0] ?? '',
      });
      continue;
    }
    if (!declaration) {
      if (migration.packageName === 'stripe' && !hasLikelyStripeSdkUsage(sourcePath)) continue;
      manual.push({
        file: sourcePath,
        line: 1,
        reason: `No containing package.json declares ${migration.packageName}; this file was not transformed because its SDK version is unknown.`,
        snippet: readFileSync(sourcePath, 'utf8').split(/\r?\n/, 1)[0] ?? '',
      });
      continue;
    }
    if (!isSupportedSourceMajor(declaration.range, migration.fromMajor)) {
      manual.push({
        file: sourcePath,
        line: 1,
        reason: `${migration.packageName} is declared as \`${declaration.range}\` in ${path.relative(root, declaration.file)}; this migration only analyzes major v${migration.fromMajor} ranges.`,
        snippet: readFileSync(sourcePath, 'utf8').split(/\r?\n/, 1)[0] ?? '',
      });
      continue;
    }
    if (!migration.declarativeRecipe && migration.id === 'openai@5' && !guaranteesNodeMajor(declaration.manifest.engines?.node ?? '', 20)
      && !(nodeRuntime === 20 && declaration.manifest.engines?.node === undefined)) {
      if (!analysisRuntimeOverride) {
        manual.push({
          file: sourcePath,
          line: 1,
          reason: `OpenAI SDK v5 requires Node.js 20 or later. Declare a compatible engines.node range in ${path.relative(root, declaration.file)} and confirm the deployed runtime before migrating; this source file was left unchanged.`,
          snippet: `engines.node: ${declaration.manifest.engines?.node ?? 'not declared'}`,
        });
        continue;
      }
    }
    project.addSourceFileAtPath(sourcePath);
    manifestBySource.set(sourcePath, declaration.file);
  }

  return { project, manual, manifestBySource };
}

function hasLikelyStripeSdkUsage(sourcePath: string): boolean {
  const probe = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const source = probe.addSourceFileAtPath(sourcePath);
  if (source.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === 'stripe')) return true;
  if (source.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration).some((declaration) =>
    /^require\s*\(\s*['"]stripe['"]\s*\)$/.test(declaration.getModuleReference().getText()))) return true;
  if (source.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) =>
    ['require', 'import'].includes(call.getExpression().getText())
    && Node.isStringLiteral(call.getArguments()[0]) && call.getArguments()[0]!.getText().slice(1, -1) === 'stripe')) return true;
  const resources = new Set(['customers', 'products', 'accounts', 'checkout', 'billingPortal', 'paymentIntents', 'paymentMethods', 'subscriptions', 'subscriptionItems', 'invoices', 'charges', 'balance', 'prices', 'webhooks']);
  return source.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) =>
    resources.has(access.getName()) && ['stripe', 'this.stripe'].includes(access.getExpression().getText()));
}

function isRegistryVersionSpec(spec: string): boolean {
  // A deliberately narrow subset: registry dist-tags or ordinary semver ranges.
  // Anything that can name a path, URL, Git host, workspace, alias, or patch is manual.
  if (/^(?:latest|next|beta|canary|rc)$/i.test(spec)) return true;
  return /^(?:\^|~|>=?|<=?|=)?\s*v?\d+(?:\.\d+|\.x|\.\*){0,2}(?:\s*(?:\|\||-\s*v?\d+(?:\.\d+|\.x|\.\*){0,2}|\s+(?:<|>|<=|>=)\s*v?\d+(?:\.\d+|\.x|\.\*){0,2}))*$/.test(spec.trim());
}

export function hasUnsafeDependencySpecs(manifest: PackageManifest): boolean {
  const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((section) => Object.values(manifest[section] ?? {}));
  if (dependencies.some((value) => typeof value !== 'string' || !isRegistryVersionSpec(value))) return true;
  const candidate = manifest as PackageManifest & { overrides?: unknown; resolutions?: unknown; pnpm?: { overrides?: unknown } };
  const nestedStrings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') nestedStrings.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(candidate.overrides);
  collect(candidate.resolutions);
  collect(candidate.pnpm?.overrides);
  return nestedStrings.some((spec) => !isRegistryVersionSpec(spec));
}

export function lockfileCommandEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_USERCONFIG: path.join(home, 'upstreamfix-empty-user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, 'upstreamfix-empty-global.npmrc'),
    NPM_CONFIG_CACHE: path.join(home, 'npm-cache'),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '0',
    COREPACK_HOME: path.join(home, 'corepack'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function findSourceFiles(root: string, packageName: string, excludedDirectories: readonly string[] = []): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name) && !isExcludedDirectory(root, absolutePath, excludedDirectories)) visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.d.ts')) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (statSync(absolutePath).size > MAX_SOURCE_BYTES) {
        if (packageName === '' || largeFileContainsPackage(absolutePath, packageName)) found.push(absolutePath);
      }
      else {
        const source = readFileSync(absolutePath, 'utf8');
        if (packageName === '' || source.includes(packageName) || (packageName === 'stripe' && /\bstripe\b/i.test(source))) found.push(absolutePath);
      }
    }
  };
  visit(root);
  return found;
}

function findAllSourceFiles(root: string, excludedDirectories: readonly string[] = []): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name) && !isExcludedDirectory(root, absolutePath, excludedDirectories)) visit(absolutePath);
      } else if (entry.isFile() && !entry.name.endsWith('.d.ts')
        && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && statSync(absolutePath).size <= MAX_SOURCE_BYTES) {
        found.push(absolutePath);
      }
    }
  };
  visit(root);
  return found;
}

function largeFileContainsPackage(file: string, packageName: string): boolean {
  const needle = packageName === 'stripe' ? 'stripe' : packageName;
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let tail = '';
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) return false;
      const chunk = tail + buffer.toString('utf8', 0, count);
      if ((packageName === 'stripe' ? chunk.toLowerCase() : chunk).includes(needle)) return true;
      tail = chunk.slice(-(needle.length - 1));
    }
  } finally {
    closeSync(descriptor);
  }
}

export interface RunOptions {
  cwd: string;
  dryRun: boolean;
  excludedDirectories?: readonly string[];
  /** Explicit confirmation of the SDK's required Node.js runtime. */
  nodeRuntime?: number;
  /** Yarn Classic needs a full dependency installation to regenerate yarn.lock. */
  allowYarnLockInstall?: boolean;
  /** Count source findings only; never regenerate lockfiles or prepare manifest writes. */
  analysisOnly?: boolean;
  /** Benchmark-only source analysis under Node 20; retains a manual runtime finding. */
  analysisRuntimeOverride?: boolean;
  /** Registry snapshot cutoff shared with independent publication verification. */
  registryBefore?: string;
}

export interface RunOutcome extends MigrationResult {
  manifestNotes: string[];
  proposedDiff: string[];
  proposedFiles: ProposedFileChange[];
}

interface ManifestFileChange {
  absolutePath: string;
  relativePath: string;
  before: string;
  after: string;
}

interface ManifestOutcome {
  notes: string[];
  changes: ManifestFileChange[];
  manual: ManualItem[];
}

export async function runMigration(migration: Migration, options: RunOptions): Promise<RunOutcome> {
  if (!options.dryRun) {
    throw new Error('Direct writes through runMigration are unavailable; use --write for verified Git branch commits.');
  }
  if (options.nodeRuntime && !((!migration.declarativeRecipe && options.nodeRuntime === 22 && migration.id === 'firebase-admin@14') || (!migration.declarativeRecipe && options.nodeRuntime === 20 && migration.id === 'openai@5') || options.nodeRuntime === migration.requiredNodeMajor)) {
    throw new Error('--node-runtime 22 applies to firebase-admin@14; --node-runtime 20 applies to openai@5; recipes require their declared nodeMajor.');
  }
  if (options.analysisRuntimeOverride && (!options.analysisOnly || migration.id !== 'openai@5' || options.nodeRuntime !== 20)) {
    throw new Error('The OpenAI runtime override is restricted to source-only benchmark analysis under Node.js 20.');
  }
  const scoped = loadScopedProject(options.cwd, migration, options.excludedDirectories, options.nodeRuntime, options.analysisRuntimeOverride === true);
  const project = scoped.project;
  const originalSources = new Map<string, string>(await Promise.all(
    project.getSourceFiles().map(async (file): Promise<[string, string]> => [file.getFilePath(), await readFile(file.getFilePath(), 'utf8')]),
  ));
  const result = migration.transform(project);
  result.manual.unshift(...scoped.manual);
  if (migration.id === 'openai@5' && !migration.declarativeRecipe) {
    result.manual.push(...inspectOpenAiTypeEnvironment(options.cwd, options.excludedDirectories));
  }
  const compatibilityNotes = migration.inspectManifest
    ? await inspectManifests(migration, options.cwd, options.excludedDirectories)
    : [];
  if (options.analysisOnly && options.nodeRuntime === 20 && !migration.declarativeRecipe && migration.id === 'openai@5') {
    for (let index = compatibilityNotes.length - 1; index >= 0; index--) {
      if (compatibilityNotes[index]?.includes('engines.node (not declared)')) compatibilityNotes.splice(index, 1);
    }
  }
  if (!options.dryRun && result.manual.length > 0) {
    throw new Error('This migration has manual review items; no files were written. Resolve them and preview again.');
  }
  const manifestsWithChangedCode = new Set(
    result.filesChanged.map((sourcePath) => scoped.manifestBySource.get(sourcePath)).filter((file): file is string => Boolean(file)),
  );
  const manifest = !options.analysisOnly && result.manual.length === 0 && result.changes.length > 0
    ? await migrateManifests(migration, options, manifestsWithChangedCode)
    : {
        notes: [options.analysisOnly
          ? 'Dependency versions were not modified during source-only benchmark analysis.'
          : result.manual.length > 0
          ? 'Dependency versions were left unchanged because this migration has items requiring manual review.'
          : 'Dependency versions were left unchanged because no safe source edit was proposed; inspect the source and package declarations.'],
        changes: [],
        manual: [],
      };
  if (!options.dryRun && manifest.manual.length > 0) {
    throw new Error('A dependency manifest needs manual review; no files were written. Resolve it and preview again.');
  }

  for (const update of result.fileUpdates ?? []) {
    if (originalSources.get(update.file)?.startsWith('\uFEFF') && !update.contents.startsWith('\uFEFF')) {
      update.contents = `\uFEFF${update.contents}`;
    }
  }
  const sourceUpdates = new Map((result.fileUpdates ?? []).map((update) => [update.file, update.contents]));
  const proposedFiles: ProposedFileChange[] = [];
  const proposedDiff = result.filesChanged.flatMap((filePath) => {
    const before = originalSources.get(filePath);
    const after = sourceUpdates.get(filePath);
    if (before === undefined || after === undefined) return [];
    const relativePath = path.relative(options.cwd, filePath);
    proposedFiles.push({ relativePath, before, after });
    const diff = unifiedDiff(relativePath, before, after);
    return diff ? [diff] : [];
  });
  for (const change of manifest.changes) {
    proposedFiles.push({ relativePath: change.relativePath, before: change.before, after: change.after });
    const diff = unifiedDiff(change.relativePath, change.before, change.after);
    if (diff) proposedDiff.push(diff);
  }
  let reportedCharacters = 0;
  for (let index = 0; index < proposedDiff.length; index++) {
    const remaining = MAX_REPORT_DIFF_CHARS - reportedCharacters;
    if (remaining < proposedDiff[index]!.length) {
      proposedDiff.splice(index, proposedDiff.length - index, `[Further diffs withheld: the report limit is ${MAX_REPORT_DIFF_CHARS} characters.]`);
      break;
    }
    reportedCharacters += proposedDiff[index]!.length;
  }

  return {
    ...result,
    filesChanged: [
      ...result.filesChanged.map((file) => path.relative(options.cwd, file)),
      ...manifest.changes.map((change) => change.relativePath),
    ],
    changes: result.changes.map((c) => ({ ...c, file: path.relative(options.cwd, c.file) })),
    manual: [...result.manual, ...manifest.manual].map((m) => ({ ...m, file: path.relative(options.cwd, m.file) })),
    manifestNotes: [...new Set([...compatibilityNotes, ...manifest.notes])],
    proposedDiff,
    proposedFiles,
  };
}

function inspectOpenAiTypeEnvironment(root: string, excludedDirectories: readonly string[] = []): ManualItem[] {
  const findings: ManualItem[] = [];
  const sourceFiles = findAllSourceFiles(root, excludedDirectories);
  for (const manifestPath of findPackageManifests(root, excludedDirectories)) {
    let manifest: PackageManifest;
    try { manifest = parseManifest<PackageManifest>(readFileSync(manifestPath, 'utf8')); }
    catch { continue; }
    if (!(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
      .some((section) => isSupportedSourceMajor(manifest[section]?.openai ?? '', 4))) continue;

    const directory = path.dirname(manifestPath);
    const tooling = { ...manifest.dependencies, ...manifest.devDependencies };
    const typescriptVersion = /^\s*[~^]?(\d+)\.(\d+)/.exec(tooling.typescript ?? '');
    if (typescriptVersion && (Number(typescriptVersion[1]) < 4
      || (Number(typescriptVersion[1]) === 4 && Number(typescriptVersion[2]) < 9))) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5 requires TypeScript 4.9 or later; declared version ${tooling.typescript} can install an older compiler. Upgrade TypeScript and run typecheck.`,
        snippet: `typescript: ${tooling.typescript}` });
    }
    const jestVersion = /^\s*[~^]?(\d+)/.exec(tooling.jest ?? '');
    if (jestVersion && Number(jestVersion[1]) < 28) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5 requires Jest 28 or later; declared version ${tooling.jest} can install an older runner. Upgrade Jest and rerun tests.`,
        snippet: `jest: ${tooling.jest}` });
    }
    const tsconfigPath = path.join(directory, 'tsconfig.json');
    let compilerOptions: Record<string, unknown> | undefined;
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => undefined,
      });
      if (parsed) compilerOptions = parsed.options as unknown as Record<string, unknown>;
    } catch { /* Missing or invalid configuration cannot establish the active compiler environment. */ }
    const nodeTypes = manifest.devDependencies?.['@types/node'] ?? manifest.dependencies?.['@types/node'];
    const nodeTypesMajor = /^\s*[~^]?(\d+)/.exec(nodeTypes ?? '');
    const workersTypes = manifest.devDependencies?.['@cloudflare/workers-types'] ?? manifest.dependencies?.['@cloudflare/workers-types'];
    const workersVersion = /^\s*(?:[~^]|>=)?(\d+)\.(\d+)\.(\d+)/.exec(workersTypes ?? '');
    if (workersTypes && (!workersVersion || (Number(workersVersion[1]) === 0
      && Number(workersVersion[2]) < 20221111))) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5's Cloudflare Workers guide requires @cloudflare/workers-types >=0.20221111.0; declared ${workersTypes} needs review and typecheck.`,
        snippet: `@cloudflare/workers-types: ${workersTypes}` });
    }
    if (workersTypes && compilerOptions && (!Array.isArray(compilerOptions.types)
      || !compilerOptions.types.includes('@cloudflare/workers-types'))) {
      findings.push({ file: tsconfigPath, line: 1,
        reason: 'OpenAI v5 Cloudflare Workers tsconfig should include @cloudflare/workers-types in compilerOptions.types; review this runtime configuration and typecheck.',
        snippet: `compilerOptions.types: ${JSON.stringify(compilerOptions.types ?? null)}` });
    }
    const bunTypes = manifest.devDependencies?.['@types/bun'] ?? manifest.dependencies?.['@types/bun'];
    const bunVersion = /^\s*(?:[~^]|>=)?(\d+)\.(\d+)/.exec(bunTypes ?? '');
    if (bunTypes && (!bunVersion || Number(bunVersion[1]) < 1
      || (Number(bunVersion[1]) === 1 && Number(bunVersion[2]) < 2))) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5's Bun guide requires @types/bun >=1.2.0; declared ${bunTypes} needs review and typecheck.`,
        snippet: `@types/bun: ${bunTypes}` });
    }
    if (compilerOptions && Array.isArray(compilerOptions.lib)
      && !compilerOptions.lib.some((lib) => typeof lib === 'string' && /^dom(?:\.iterable)?$/i.test(lib))
      && nodeTypesMajor && Number(nodeTypesMajor[1]) < 20) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5 needs Web fetch types, but this tsconfig excludes DOM and @types/node ${nodeTypes} predates Node 20. Upgrade @types/node >=20 and typecheck; review runtime compatibility first.`,
        snippet: `@types/node: ${nodeTypes}` });
    }

    if (compilerOptions && Array.isArray(compilerOptions.lib)
      && !compilerOptions.lib.some((lib) => typeof lib === 'string' && /^dom(?:\.iterable)?$/i.test(lib))
      && !nodeTypes && !workersTypes && !bunTypes) {
      findings.push({ file: tsconfigPath, line: 1,
        reason: 'OpenAI v5 requires Web fetch types (RequestInit, Headers, Blob, File). This tsconfig excludes DOM and the package lacks @types/node; choose a compatible DOM lib or @types/node >=20, then typecheck. The correct runtime target cannot be inferred safely.',
        snippet: `compilerOptions.lib: ${JSON.stringify(compilerOptions.lib)}` });
    }
    const explicitlyLoadedTypes = Array.isArray(compilerOptions?.types)
      ? (compilerOptions.types as unknown[]).filter((value): value is string => typeof value === 'string')
      : undefined;
    const nodeTypesVisible = Boolean(nodeTypes) && (!explicitlyLoadedTypes || explicitlyLoadedTypes.includes('node'));
    const nodeTypesExcluded = Boolean(nodeTypes) && explicitlyLoadedTypes !== undefined && !explicitlyLoadedTypes.includes('node');
    if (nodeTypesExcluded) {
      const sourcePath = sourceFiles.find((candidate) => candidate === directory || candidate.startsWith(directory + path.sep))
        ?? tsconfigPath;
      findings.push({ file: path.relative(root, sourcePath), line: 1,
        reason: 'compilerOptions.types excludes @types/node, so Node built-ins and globals are unavailable despite the package dependency; include "node" and run typecheck.',
        snippet: 'compilerOptions.types excludes node' });
    }
    if (nodeTypesVisible) continue;
    for (const sourcePath of sourceFiles) {
      if (!(sourcePath === directory || sourcePath.startsWith(directory + path.sep))) continue;
      if (!/\.[cm]?tsx?$/.test(sourcePath) && !(compilerOptions?.checkJs === true && /\.[cm]?jsx?$/.test(sourcePath))) continue;
      if (statSync(sourcePath).size > MAX_SOURCE_BYTES) continue;
      const source = readFileSync(sourcePath, 'utf8');
      const usage = findNodeTypeUsage(source);
      if (!usage) continue;
      findings.push({ file: path.relative(root, sourcePath), line: usage.line,
        reason: 'OpenAI v4 may have supplied @types/node transitively; v5 does not. This file uses a Node built-in or global, but Node declarations are not visible to the compiler. Add a compatible @types/node devDependency, include "node" in compilerOptions.types when restricted, and run typecheck; otherwise review this runtime-specific use manually.',
        snippet: source.split('\n')[usage.line - 1]?.trim().slice(0, 500) ?? usage.name });
      break;
    }
  }
  return findings;
}

function findNodeTypeUsage(source: string): { line: number; name: string } | undefined {
  const patterns = [
    new RegExp(`(?:\\b(?:from|import)\\s*|\\b(?:import|require)\\s*\\(\\s*)['"](?:node:)?(?:${NODE_BUILTIN_PATTERN})(?:/[^'"]*)?['"]`),
    NODE_GLOBAL_PATTERN,
  ];
  const matches = patterns.map((pattern) => {
    const match = pattern.exec(source);
    return match?.index === undefined ? undefined : { index: match.index, text: match[0] };
  }).filter((match): match is { index: number; text: string } => Boolean(match));
  const first = matches.sort((a, b) => a.index - b.index)[0];
  if (!first) return undefined;
  const name = NODE_GLOBAL_PATTERN.exec(first.text)?.[0]
    ?? /['"]([^'"]+)['"]/.exec(first.text)?.[1]
    ?? 'Node API';
  return { line: source.slice(0, first.index).split('\n').length, name };
}

async function inspectManifests(migration: Migration, cwd: string, excludedDirectories: readonly string[] = []): Promise<string[]> {
  const notes: string[] = [];
  for (const manifestPath of findPackageManifests(cwd, excludedDirectories)) {
    const raw = await readFile(manifestPath, 'utf8');
    if (!raw.includes(JSON.stringify(migration.packageName))) continue;
    try {
      const manifest = parseManifest<PackageManifest>(raw);
      notes.push(...(migration.inspectManifest?.(manifest) ?? []));
    } catch {
      // Invalid manifests are already surfaced as manual review items for source files.
    }
  }
  return [...new Set(notes)];
}

async function migrateManifests(
  migration: Migration,
  options: RunOptions,
  manifestsWithChangedCode: Set<string>,
): Promise<ManifestOutcome> {
  if (!migration.updateManifest) return { notes: [], changes: [], manual: [] };
  const notes: string[] = [];
  const changes: ManifestFileChange[] = [];
  const manual: ManualItem[] = [];

  for (const manifestPath of findPackageManifests(options.cwd, options.excludedDirectories)) {
    const raw = await readFile(manifestPath, 'utf8');
    if (!raw.includes(JSON.stringify(migration.packageName))) continue;
    const relativePath = path.relative(options.cwd, manifestPath);
    if (!manifestsWithChangedCode.has(manifestPath)) {
      notes.push(`\`${relativePath}\` was left unchanged because no analyzed source file owned by this package received a code transformation.`);
      continue;
    }
    let manifest: PackageManifest;
    try {
      manifest = parseManifest<PackageManifest>(raw);
    } catch {
      manual.push({
        file: relativePath,
        line: 1,
        reason: 'This package.json is invalid JSON; its dependency version was left unchanged.',
        snippet: raw.split(/\r?\n/, 1)[0] ?? '',
      });
      continue;
    }

    const before = structuredClone(manifest);
    if (options.nodeRuntime !== undefined) {
      const major = options.nodeRuntime;
      if (manifest.engines !== undefined && (typeof manifest.engines !== 'object' || Array.isArray(manifest.engines) || manifest.engines === null)) {
        manual.push({
          file: relativePath,
          line: 1,
          reason: `engines must be an object in package.json before --node-runtime ${major} can add a Node.js range.`,
          snippet: 'engines',
        });
        continue;
      }
      const declared = manifest.engines?.node;
      if (declared !== undefined && (typeof declared !== 'string' || !guaranteesNodeMajor(declared, major))) {
        manual.push({
          file: relativePath,
          line: 1,
          reason: `engines.node is already declared as ${JSON.stringify(declared)}. Review and update it manually for Node.js ${major} before migrating ${migration.id}; --node-runtime never overrides a declared range.`,
          snippet: `engines.node: ${declared}`,
        });
        continue;
      }
      if (declared === undefined) manifest.engines = { ...manifest.engines, node: `>=${major}` };
    }
    const fileNotes = migration.updateManifest(manifest);
    if (options.nodeRuntime !== undefined && before.engines?.node === undefined) {
      fileNotes.unshift(`\`${relativePath}\`: added \`engines.node\` = \`>=${options.nodeRuntime}\` after explicit --node-runtime ${options.nodeRuntime} confirmation.`);
    }
    if (JSON.stringify(manifest) === JSON.stringify(before)) {
      notes.push(...fileNotes);
      continue;
    }

    const versionUpdated = preserveManifestFormatting(raw, before, manifest, migration.packageName);
    const updated = versionUpdated && options.nodeRuntime !== undefined && before.engines?.node === undefined
      ? addNodeEngineToManifest(versionUpdated, options.nodeRuntime)
      : versionUpdated;
    if (updated === undefined) {
      notes.push(...fileNotes.filter((note) => !note.includes(' → ')));
      manual.push({
        file: relativePath,
        line: 1,
        reason: 'The dependency version could not be updated without rewriting or ambiguously editing package.json; update it manually.',
        snippet: `${migration.packageName} dependency update withheld`,
      });
      continue;
    }

    const existingLocks = await findLockfiles(options.cwd, path.dirname(manifestPath));
    let lockChange: ManifestFileChange | undefined;
    if (existingLocks.length > 0) {
      const lockResult = existingLocks.length === 1 && path.basename(existingLocks[0]!) === 'package-lock.json'
        ? await regeneratePackageLock(manifestPath, path.resolve(options.cwd, existingLocks[0]!), updated, options.cwd, options.registryBefore)
        : existingLocks.length === 1 && path.basename(existingLocks[0]!) === 'pnpm-lock.yaml'
          ? await regeneratePnpmLock(manifestPath, path.resolve(options.cwd, existingLocks[0]!), updated, options.cwd)
          : existingLocks.length === 1 && path.basename(existingLocks[0]!) === 'yarn.lock'
            ? options.allowYarnLockInstall
              ? await regenerateYarnLock(manifestPath, path.resolve(options.cwd, existingLocks[0]!), updated, options.cwd)
              : { reason: 'Yarn Classic lockfile regeneration requires --allow-yarn-lock-install because it runs a full dependency installation (estimated 50–400 MB of downloads without a warm cache).' }
          : { reason: `This package uses unsupported lockfile(s): ${existingLocks.join(', ')}.` };
      if (!lockResult.contents) {
        notes.push(...fileNotes.filter((note) => !note.includes(' → ')));
        manual.push({
          file: relativePath,
          line: 1,
          reason: `${lockResult.reason} The dependency and lockfile were left unchanged.`,
          snippet: `${migration.packageName} dependency update withheld`,
        });
        continue;
      }
      const lockPath = path.resolve(options.cwd, existingLocks[0]!);
      lockChange = {
        absolutePath: lockPath,
        relativePath: path.relative(options.cwd, lockPath),
        before: lockResult.before ?? '',
        after: lockResult.contents,
      };
    }
    notes.push(...fileNotes);
    if (updated !== raw) changes.push({ absolutePath: manifestPath, relativePath, before: raw, after: updated });
    if (lockChange && lockChange.after !== lockChange.before) {
      changes.push(lockChange);
      const managerName = path.basename(lockChange.relativePath) === 'pnpm-lock.yaml'
        ? 'pnpm'
        : path.basename(lockChange.relativePath) === 'yarn.lock'
          ? 'Yarn Classic'
          : 'npm';
      notes.push(`\`${lockChange.relativePath}\` was regenerated by ${managerName} in a temporary directory; preview requires registry access and install scripts were disabled.`);
    }
  }

  if (manual.length > 0) changes.length = 0;

  if (changes.length === 0 && notes.length === 0 && manual.length === 0) {
    notes.push(`No package.json containing ${migration.packageName} was found.`);
  }
  return { notes, changes, manual };
}

interface LockfileRegenerationResult {
  contents?: string;
  before?: string;
  reason?: string;
}

async function regeneratePackageLock(
  manifestPath: string,
  lockPath: string,
  updatedManifest: string,
  projectRoot: string,
  registryBefore?: string,
): Promise<LockfileRegenerationResult> {
  const directory = path.dirname(manifestPath);
  if (directory !== path.dirname(lockPath)) {
    return { reason: 'The package-lock.json is not beside the package.json; workspace lockfile updates are not supported yet.' };
  }
  if (directory !== projectRoot) {
    return { reason: 'Nested package manifests require workspace-aware lockfile regeneration, which is not supported yet.' };
  }

  let manifest: PackageManifest;
  let before: string;
  let lock: { lockfileVersion?: unknown };
  try {
    manifest = parseManifest<PackageManifest>(updatedManifest);
    before = await readFile(lockPath, 'utf8');
    lock = JSON.parse(before) as { lockfileVersion?: unknown };
  } catch {
    return { reason: 'The package.json or package-lock.json could not be parsed for a safe lockfile update.' };
  }

  if (lock.lockfileVersion !== 3) {
    return { reason: 'Only npm package-lock.json version 3 can currently be regenerated automatically.' };
  }
  if ('workspaces' in manifest) {
    return { reason: 'npm workspaces are not supported by the isolated lockfile updater yet.' };
  }
  if (hasUnsafeDependencySpecs(manifest)) {
    return { reason: 'Only ordinary npm registry versions and approved dist-tags are supported; Git, URL, local, aliased, override, resolution, and non-registry specs require manual lockfile updates.' };
  }
  let configDirectory = directory;
  while (configDirectory === projectRoot || configDirectory.startsWith(projectRoot + path.sep)) {
    if (await exists(path.join(configDirectory, '.npmrc'))) {
      return { reason: 'A project .npmrc may contain registry or resolution settings that the isolated updater cannot safely reproduce.' };
    }
    if (configDirectory === projectRoot) break;
    configDirectory = path.dirname(configDirectory);
  }

  let temporaryDirectory: string | undefined;
  let unregisterCleanup: (() => void) | undefined;
  try {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'upstreamfix-npm-lock-'));
    unregisterCleanup = registerTemporaryCleanup(() => rm(temporaryDirectory!, { recursive: true, force: true }));
    await writeFile(path.join(temporaryDirectory, 'package.json'), updatedManifest, 'utf8');
    await writeFile(path.join(temporaryDirectory, 'package-lock.json'), before, 'utf8');
    const args = ['install', '--package-lock-only', '--lockfile-version=3', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (registryBefore) args.push(`--before=${registryBefore}`);
    // npm_execpath may be pnpm or Yarn when launched through dlx; resolve npm from PATH instead.
    await execFile('npm', args, { cwd: temporaryDirectory, env: lockfileCommandEnvironment(temporaryDirectory), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const contents = await readFile(path.join(temporaryDirectory, 'package-lock.json'), 'utf8');
    return { before, contents };
  } catch {
    return { reason: 'npm could not regenerate package-lock.json in an isolated temporary directory.' };
  } finally {
    unregisterCleanup?.();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function regeneratePnpmLock(
  manifestPath: string,
  lockPath: string,
  updatedManifest: string,
  projectRoot: string,
): Promise<LockfileRegenerationResult> {
  const directory = path.dirname(manifestPath);
  if (directory !== path.dirname(lockPath)) {
    return { reason: 'The pnpm-lock.yaml is not beside the package.json; workspace lockfile updates are not supported yet.' };
  }
  if (directory !== projectRoot) {
    return { reason: 'Nested package manifests require workspace-aware lockfile regeneration, which is not supported yet.' };
  }

  let manifest: PackageManifest;
  let before: string;
  try {
    manifest = parseManifest<PackageManifest>(updatedManifest);
    before = await readFile(lockPath, 'utf8');
  } catch {
    return { reason: 'The package.json or pnpm-lock.yaml could not be read for a safe lockfile update.' };
  }

  const lockVersion = /^lockfileVersion:\s*["']?([\d]+(?:\.[\d]+)?)/m.exec(before)?.[1];
  if (!lockVersion) return { reason: 'The pnpm lockfile version could not be identified safely.' };
  if ('workspaces' in manifest) return { reason: 'pnpm workspaces are not supported by the isolated lockfile updater yet.' };

  if (hasUnsafeDependencySpecs(manifest)) {
    return { reason: 'Only ordinary npm registry versions and approved dist-tags are supported; Git, URL, local, aliased, override, resolution, and non-registry specs require manual lockfile updates.' };
  }

  let configDirectory = directory;
  while (configDirectory === projectRoot || configDirectory.startsWith(projectRoot + path.sep)) {
    for (const configName of ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpm-workspace.yaml']) {
      if (await exists(path.join(configDirectory, configName))) {
        return { reason: `A project ${configName} may contain registry, resolution, hook, or workspace settings that the isolated updater cannot safely reproduce.` };
      }
    }
    if (configDirectory === projectRoot) break;
    configDirectory = path.dirname(configDirectory);
  }

  const declaredManager = manifest.packageManager;
  if (declaredManager !== undefined && (typeof declaredManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+(?:[-+].*)?$/.test(declaredManager))) {
    return { reason: 'The packageManager field does not pin an exact pnpm version, so lockfile regeneration cannot be version-checked safely.' };
  }

  let temporaryDirectory: string | undefined;
  let unregisterCleanup: (() => void) | undefined;
  try {
    const probeHome = await mkdtemp(path.join(tmpdir(), 'upstreamfix-pnpm-home-'));
    const unregisterProbeHome = registerTemporaryCleanup(() => rm(probeHome, { recursive: true, force: true }));
    let versionOutput: string;
    try {
      ({ stdout: versionOutput } = await execFile('pnpm', ['--version'], {
      cwd: tmpdir(),
      env: lockfileCommandEnvironment(probeHome),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      }));
    } finally {
      unregisterProbeHome();
      await rm(probeHome, { recursive: true, force: true });
    }
    const installedVersion = versionOutput.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(installedVersion)) {
      return { reason: 'The installed pnpm version could not be identified safely.' };
    }
    if (typeof declaredManager === 'string') {
      const pinnedVersion = /^pnpm@([^+]+)(?:\+.*)?$/.exec(declaredManager)?.[1];
      if (pinnedVersion !== installedVersion) {
        return { reason: `This project pins ${declaredManager}, but the installed package manager is pnpm@${installedVersion}; lockfile regeneration was withheld.` };
      }
    }

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'upstreamfix-pnpm-lock-'));
    unregisterCleanup = registerTemporaryCleanup(() => rm(temporaryDirectory!, { recursive: true, force: true }));
    // pnpm reads packageManager and may download a different CLI automatically. The exact
    // version was checked above, so omit this metadata from the isolated temporary manifest.
    delete manifest.packageManager;
    await writeFile(path.join(temporaryDirectory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await writeFile(path.join(temporaryDirectory, 'pnpm-lock.yaml'), before, 'utf8');
    await execFile('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'], {
      cwd: temporaryDirectory,
      env: lockfileCommandEnvironment(temporaryDirectory),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const contents = await readFile(path.join(temporaryDirectory, 'pnpm-lock.yaml'), 'utf8');
    const generatedVersion = /^lockfileVersion:\s*["']?([\d]+(?:\.[\d]+)?)/m.exec(contents)?.[1];
    if (generatedVersion !== lockVersion) {
      return { reason: `The installed pnpm would change the lockfile format from ${lockVersion} to ${generatedVersion ?? 'unknown'}; update it manually with the project's pinned package manager.` };
    }
    return { before, contents };
  } catch {
    return { reason: 'pnpm could not regenerate pnpm-lock.yaml in an isolated temporary directory; ensure the pinned pnpm version is installed and registry access is available.' };
  } finally {
    unregisterCleanup?.();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function regenerateYarnLock(
  manifestPath: string,
  lockPath: string,
  updatedManifest: string,
  projectRoot: string,
): Promise<LockfileRegenerationResult> {
  const directory = path.dirname(manifestPath);
  if (directory !== path.dirname(lockPath)) {
    return { reason: 'The yarn.lock is not beside the package.json; workspace lockfile updates are not supported yet.' };
  }
  if (directory !== projectRoot) {
    return { reason: 'Nested package manifests require workspace-aware lockfile regeneration, which is not supported yet.' };
  }

  let manifest: PackageManifest;
  let before: string;
  try {
    manifest = parseManifest<PackageManifest>(updatedManifest);
    before = await readFile(lockPath, 'utf8');
  } catch {
    return { reason: 'The package.json or yarn.lock could not be read for a safe lockfile update.' };
  }

  if ('workspaces' in manifest) return { reason: 'Yarn workspaces are not supported by the isolated lockfile updater yet.' };
  if (!before.startsWith('# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.')) {
    return { reason: 'Only Yarn Classic lockfile format can currently be regenerated automatically.' };
  }
  if (hasUnsafeDependencySpecs(manifest)) {
    return { reason: 'Only ordinary npm registry versions and approved dist-tags are supported; Git, URL, local, aliased, override, resolution, and non-registry specs require manual lockfile updates.' };
  }

  let configDirectory = directory;
  while (configDirectory === projectRoot || configDirectory.startsWith(projectRoot + path.sep)) {
    for (const configName of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'yarn.config.cjs']) {
      if (await exists(path.join(configDirectory, configName))) {
        return { reason: `A project ${configName} may contain registry, resolution, hook, or workspace settings that the isolated updater cannot safely reproduce.` };
      }
    }
    if (await exists(path.join(configDirectory, '.yarn'))) {
      return { reason: 'A project .yarn directory may contain Yarn Berry releases, plugins, patches, or configuration that cannot be safely reproduced in isolation.' };
    }
    if (configDirectory === projectRoot) break;
    configDirectory = path.dirname(configDirectory);
  }

  const declaredManager = manifest.packageManager;
  if (declaredManager !== undefined && (typeof declaredManager !== 'string' || !/^yarn@1\.\d+\.\d+(?:[-+].*)?$/.test(declaredManager))) {
    return { reason: 'Only an exact Yarn Classic 1.x packageManager pin is supported for automatic lockfile regeneration.' };
  }

  let temporaryDirectory: string | undefined;
  let unregisterCleanup: (() => void) | undefined;
  try {
    const probeHome = await mkdtemp(path.join(tmpdir(), 'upstreamfix-yarn-home-'));
    const unregisterProbeHome = registerTemporaryCleanup(() => rm(probeHome, { recursive: true, force: true }));
    let versionOutput: string;
    try {
      ({ stdout: versionOutput } = await execFile('yarn', ['--version'], {
      cwd: tmpdir(),
      env: lockfileCommandEnvironment(probeHome),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      }));
    } finally {
      unregisterProbeHome();
      await rm(probeHome, { recursive: true, force: true });
    }
    const installedVersion = versionOutput.trim();
    if (!/^1\.\d+\.\d+$/.test(installedVersion)) {
      return { reason: `Yarn ${installedVersion || '(unknown version)'} is not Yarn Classic 1.x; this version's lockfile updater is not supported yet.` };
    }
    if (typeof declaredManager === 'string') {
      const pinnedVersion = /^yarn@([^+]+)(?:\+.*)?$/.exec(declaredManager)?.[1];
      if (pinnedVersion !== installedVersion) {
        return { reason: `This project pins ${declaredManager}, but the installed package manager is yarn@${installedVersion}; lockfile regeneration was withheld.` };
      }
    }

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'upstreamfix-yarn-lock-'));
    unregisterCleanup = registerTemporaryCleanup(() => rm(temporaryDirectory!, { recursive: true, force: true }));
    delete manifest.packageManager;
    await writeFile(path.join(temporaryDirectory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await writeFile(path.join(temporaryDirectory, 'yarn.lock'), before, 'utf8');
    await execFile('yarn', ['install', '--ignore-scripts', '--non-interactive', '--no-progress'], {
      cwd: temporaryDirectory,
      env: lockfileCommandEnvironment(temporaryDirectory),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const contents = await readFile(path.join(temporaryDirectory, 'yarn.lock'), 'utf8');
    if (!contents.startsWith('# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.')) {
      return { reason: 'Yarn generated an unrecognized lockfile format; the lockfile update was withheld.' };
    }
    return { before, contents };
  } catch {
    return { reason: 'Yarn Classic could not regenerate yarn.lock in an isolated temporary directory; ensure the pinned Yarn 1.x version is installed and registry access is available.' };
  } finally {
    unregisterCleanup?.();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function findLockfiles(root: string, packageDirectory: string): Promise<string[]> {
  const names = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const found: string[] = [];
  let directory = packageDirectory;
  while (directory === root || directory.startsWith(root + path.sep)) {
    for (const name of names) {
      try {
        await stat(path.join(directory, name));
        found.push(path.relative(root, path.join(directory, name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  return found;
}

function isExcludedDirectory(root: string, directory: string, excludedDirectories: readonly string[]): boolean {
  const relative = path.relative(root, directory).split(path.sep).join('/');
  return excludedDirectories.some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`));
}

function findPackageManifests(root: string, excludedDirectories: readonly string[] = []): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name) && !isExcludedDirectory(root, absolutePath, excludedDirectories)) visit(absolutePath);
      } else if (entry.isFile() && entry.name === 'package.json') {
        found.push(absolutePath);
      }
    }
  };
  visit(root);
  return found;
}

function addNodeEngineToManifest(raw: string, major: number): string | undefined {
  const rootStart = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (raw[rootStart] !== '{') return undefined;
  const engineMember = findJsonObjectMember(raw, rootStart, 'engines');
  if (!engineMember && Object.hasOwn(parseManifest<PackageManifest>(raw), 'engines')) return undefined;
  const objectStart = engineMember?.valueStart ?? rootStart;
  if (raw[objectStart] !== '{') return undefined;
  const objectEnd = jsonValueEnd(raw, objectStart);
  if (objectEnd < 0) return undefined;
  const close = objectEnd - 1;
  const whitespace = raw.slice(objectStart + 1, close).match(/\s*$/)?.[0] ?? '';
  const insertAt = close - whitespace.length;
  const hasMembers = raw.slice(objectStart + 1, insertAt).trim().length > 0;
  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = raw.match(/(?:\r?\n)([ \t]+)"[^"\r\n]+"\s*:/)?.[1] ?? '  ';
  const childIndent = engineMember ? indent + indent : indent;
  const addition = raw.includes('\n')
    ? `${hasMembers ? ',' : ''}${lineEnding}${childIndent}${engineMember ? `"node": ">=${major}"` : `"engines": { "node": ">=${major}" }`}`
    : `${hasMembers ? ', ' : ''}${engineMember ? `"node": ">=${major}"` : `"engines": { "node": ">=${major}" }`}`;
  const updated = raw.slice(0, insertAt) + addition + raw.slice(insertAt);
  try {
    const parsed = parseManifest<PackageManifest>(updated);
    return parsed.engines?.node === `>=${major}` ? updated : undefined;
  } catch {
    return undefined;
  }
}

function preserveManifestFormatting(
  raw: string,
  before: PackageManifest,
  after: PackageManifest,
  packageName: string,
): string | undefined {
  let updated = raw;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const oldValue = before[section]?.[packageName];
    const newValue = after[section]?.[packageName];
    if (typeof oldValue !== 'string' || typeof newValue !== 'string' || oldValue === newValue) continue;
    const rootStart = updated.charCodeAt(0) === 0xfeff ? 1 : 0;
    const sectionMember = findJsonObjectMember(updated, rootStart, section);
    if (!sectionMember || updated[sectionMember.valueStart] !== '{') return undefined;
    const dependencyMember = findJsonObjectMember(updated, sectionMember.valueStart, packageName);
    if (!dependencyMember || updated[dependencyMember.valueStart] !== '"') return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(updated.slice(dependencyMember.valueStart, dependencyMember.valueEnd));
    } catch {
      return undefined;
    }
    if (decoded !== oldValue) return undefined;
    updated =
      updated.slice(0, dependencyMember.valueStart) +
      JSON.stringify(newValue) +
      updated.slice(dependencyMember.valueEnd);
  }
  return updated;
}

interface JsonMemberRange {
  valueStart: number;
  valueEnd: number;
}

function findJsonObjectMember(text: string, objectStart: number, targetKey: string): JsonMemberRange | undefined {
  if (text[objectStart] !== '{') return undefined;
  let cursor = objectStart + 1;
  let found: JsonMemberRange | undefined;
  while (cursor < text.length) {
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === '}') return found;
    if (text[cursor] !== '"') return undefined;
    const keyEnd = jsonStringEnd(text, cursor);
    if (keyEnd < 0) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(cursor, keyEnd));
    } catch {
      return undefined;
    }
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ':') return undefined;
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    if (valueEnd < 0) return undefined;
    if (key === targetKey) {
      if (found) return undefined;
      found = { valueStart, valueEnd };
    }
    cursor = skipWhitespace(text, valueEnd);
    if (text[cursor] === ',') cursor++;
    else if (text[cursor] !== '}') return undefined;
  }
  return undefined;
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? '')) cursor++;
  return cursor;
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor]!;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') return cursor + 1;
  }
  return -1;
}

function jsonValueEnd(text: string, start: number): number {
  if (text[start] === '"') return jsonStringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    const stack: string[] = [text[start] === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let cursor = start + 1; cursor < text.length; cursor++) {
      const char = text[cursor]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack.pop() !== char) return -1;
        if (stack.length === 0) return cursor + 1;
      }
    }
    return -1;
  }
  let cursor = start;
  while (cursor < text.length && !',}]'.includes(text[cursor]!)) cursor++;
  while (cursor > start && /\s/.test(text[cursor - 1]!)) cursor--;
  return cursor > start ? cursor : -1;
}

export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return '';
  if (LOCKFILE_NAMES.has(path.basename(file))) return summarizeLockfile(file, before, after);
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_DIFF_INPUT_BYTES) {
    return `${file}: diff withheld because the source exceeds ${MAX_DIFF_INPUT_BYTES} bytes.`;
  }
  const beforeLines = before.match(/\n/g)?.length ?? 0;
  const afterLines = after.match(/\n/g)?.length ?? 0;
  if (beforeLines + afterLines > 4_000) {
    return `${file}: diff withheld because this file has too many lines for a bounded report.`;
  }
  const patch = structuredPatch(
    `a/${file}`,
    `b/${file}`,
    before.replace(/\r\n/g, '\n'),
    after.replace(/\r\n/g, '\n'),
    '',
    '',
    { context: 3 },
  );
  const output = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of patch.hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    output.push(...hunk.lines);
  }
  const rendered = output.join('\n');
  return rendered.length <= MAX_DIFF_OUTPUT_CHARS
    ? rendered
    : `${file}: diff withheld because it exceeds ${MAX_DIFF_OUTPUT_CHARS} characters.`;
}

export function summarizeLockfile(file: string, before: string, after: string): string {
  const previous = lockfilePackages(file, before);
  const next = lockfilePackages(file, after);
  if (!previous || !next) return `${file}: lockfile changed; package counts unavailable (file too large or unrecognized format). Full diff withheld.`;
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [name, version] of next) {
    if (!previous.has(name)) added++;
    else if (previous.get(name) !== version) changed++;
  }
  for (const name of previous.keys()) if (!next.has(name)) removed++;
  return `${file}: lockfile summary — added: ${added}, removed: ${removed}, changed: ${changed}. Full diff withheld.`;
}

function lockfilePackages(file: string, contents: string): Map<string, string> | undefined {
  if (Buffer.byteLength(contents) > 30 * 1024 * 1024) return undefined;
  if (file.endsWith('.json')) {
    try {
      const parsed = JSON.parse(contents) as { packages?: Record<string, { version?: unknown }> };
      if (!parsed.packages || typeof parsed.packages !== 'object') return undefined;
      return new Map(Object.entries(parsed.packages)
        .filter(([name, value]) => name !== '' && value && typeof value.version === 'string')
        .map(([name, value]) => [name, value.version as string]));
    } catch {
      return undefined;
    }
  }
  const packages = new Map<string, string>();
  let section = '';
  let name = '';
  for (const line of contents.split(/\r?\n/)) {
    if (file.endsWith('pnpm-lock.yaml')) {
      if (/^(packages|snapshots):\s*$/.test(line)) { section = line.slice(0, -1); name = ''; continue; }
      if (/^[^\s#]/.test(line)) { section = ''; name = ''; }
      const entry = section === 'packages' ? /^  (['"]?)(.+?)\1:\s*$/.exec(line) : null;
      if (entry) {
        const rawName = entry[2]!.replace(/^\//, '').replace(/\(.*$/, '');
        const separator = rawName.lastIndexOf('@');
        name = separator > 0 ? rawName.slice(0, separator) : rawName;
        packages.set(name, separator > 0 ? rawName.slice(separator + 1).split('(')[0]! : rawName);
      }
      const version = /^    version:\s*['"]?([^\s'"]+)/.exec(line);
      if (name && version) packages.set(name, version[1]!);
    } else {
      if (/^[^\s#].*:\s*$/.test(line)) {
        const selector = line.slice(0, -1).split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
        const separator = selector.lastIndexOf('@');
        name = separator > 0 ? selector.slice(0, separator) : selector;
      }
      const version = /^  version\s+['"]([^'"]+)['"]/.exec(line);
      if (name && version) packages.set(name, version[1]!);
    }
  }
  return packages.size > 0 ? packages : undefined;
}
