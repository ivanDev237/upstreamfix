import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
import { hasAffectedOpenAiV5Call } from '../migrations/openai-v5/index.js';

const execFile = promisify(execFileCallback);

function projectPath(root: string, candidate: string): string {
  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(absoluteRoot, candidate);
  const relative = path.relative(absoluteRoot, absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new Error('Migration produced a path outside the project root; no file content was included in the report.');
  return relative.split(path.sep).join('/') || '.';
}

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

function loadScopedProject(root: string, migration: Migration, excludedDirectories: readonly string[] = [], nodeRuntime?: number): ScopedProject {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  const manifests = findPackageManifests(root, excludedDirectories).filter((file) => isSafeProjectFile(root, file)).map((file) => {
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
  const runtimeBlocked = new Map<string, ManualItem>();
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
        reasonCode: 'manifest-refusal',
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
        reasonCode: 'manifest-refusal',
      });
      continue;
    }
    if (!isSupportedSourceMajor(declaration.range, migration.fromMajor)) {
      manual.push({
        file: sourcePath,
        line: 1,
        reason: `${migration.packageName} is declared as \`${declaration.range}\` in ${path.relative(root, declaration.file)}; this migration only analyzes major v${migration.fromMajor} ranges.`,
        snippet: readFileSync(sourcePath, 'utf8').split(/\r?\n/, 1)[0] ?? '',
        reasonCode: 'manifest-refusal',
      });
      continue;
    }
    if (!migration.declarativeRecipe && migration.id === 'openai@5' && !guaranteesNodeMajor(declaration.manifest.engines?.node ?? '', 20)
      && !(nodeRuntime === 20 && declaration.manifest.engines?.node === undefined)) {
      const probe = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
      if (hasAffectedOpenAiV5Call(probe.addSourceFileAtPath(sourcePath)) && !runtimeBlocked.has(declaration.file)) {
        runtimeBlocked.set(declaration.file, {
          file: declaration.file,
          line: 1,
          reason: `OpenAI SDK v5 requires Node.js 20 or later. Declare a compatible engines.node range in ${path.relative(root, declaration.file)} and confirm the deployed runtime before migrating; affected source files were left unchanged.`,
          snippet: `engines.node: ${declaration.manifest.engines?.node ?? 'not declared'}`,
          reasonCode: nodeRuntime === 20 && declaration.manifest.engines?.node !== undefined
            ? 'manifest-refusal' : 'runtime-confirmation',
        });
      }
      continue;
    }
    project.addSourceFileAtPath(sourcePath);
    manifestBySource.set(sourcePath, declaration.file);
  }

  manual.push(...runtimeBlocked.values());
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
  if (packageName === 'openai') return findOpenAiSourceFiles(root, excludedDirectories);
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

function findOpenAiSourceFiles(root: string, excludedDirectories: readonly string[]): string[] {
  const smallFiles = findAllSourceFiles(root, excludedDirectories);
  const contents = new Map(smallFiles.map((file) => [file, readFileSync(file, 'utf8')]));
  const tsconfigs: string[] = [];
  const findTsconfigs = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name) && !isExcludedDirectory(root, absolutePath, excludedDirectories)) findTsconfigs(absolutePath);
      } else if (entry.isFile() && /^tsconfig(?:\.[^/]+)?\.json$/.test(entry.name)) tsconfigs.push(absolutePath);
    }
  };
  findTsconfigs(root);
  const pathMappings: Array<{ base: string; paths: Record<string, string[]> }> = [];
  for (const configPath of tsconfigs) {
    try {
      const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
      const options = parsed.config?.compilerOptions;
      if (!options || typeof options !== 'object' || !options.paths || typeof options.paths !== 'object') continue;
      const base = typeof options.baseUrl === 'string' ? path.resolve(path.dirname(configPath), options.baseUrl) : path.dirname(configPath);
      pathMappings.push({ base, paths: options.paths as Record<string, string[]> });
    } catch { /* An unresolved or malformed config cannot safely establish a local source link. */ }
  }
  const retained = new Set<string>();
  for (const [file, source] of contents) if (/openai/i.test(source)) retained.add(file);
  const largeFiles: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name) && !isExcludedDirectory(root, absolutePath, excludedDirectories)) visit(absolutePath);
      } else if (entry.isFile() && !entry.name.endsWith('.d.ts') && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && statSync(absolutePath).size > MAX_SOURCE_BYTES && largeFileContainsPackage(absolutePath, 'openai')) largeFiles.push(absolutePath);
    }
  };
  visit(root);
  for (const file of largeFiles) retained.add(file);

  const exportedClients = new Map<string, Set<string>>();
  const directExports = (source: string): Set<string> => {
    const constructors = new Set(['OpenAI', 'AzureOpenAI']);
    for (const match of source.matchAll(/import\s+([^;\n]+?)\s+from\s*['"]openai['"]/g)) {
      const clause = match[1] ?? '';
      const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
      if (defaultName && defaultName !== 'type') constructors.add(defaultName);
      const named = /\{([^}]+)\}/.exec(clause)?.[1];
      for (const item of (named ?? '').split(',')) {
        const [imported, alias] = item.trim().split(/\s+as\s+/);
        if (['OpenAI', 'AzureOpenAI'].includes(imported ?? '')) constructors.add(alias ?? imported!);
      }
    }
    const constructorPattern = [...constructors].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const constructed = new Set([...source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;\\n]+)?=\\s*(?:new\\s+)?(?:${constructorPattern})\\b`, 'g'))].map((match) => match[1]!));
    const exported = new Set([...source.matchAll(new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;\\n]+)?=\\s*(?:new\\s+)?(?:${constructorPattern})\\b`, 'g'))].map((match) => match[1]!));
    for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/g)) {
      for (const item of (match[1] ?? '').split(',')) {
        const [local, alias] = item.trim().split(/\s+as\s+/);
        if (local && constructed.has(local)) exported.add(alias ?? local);
      }
    }
    for (const match of source.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g)) {
      if (constructed.has(match[1]!)) exported.add('default');
    }
    return exported;
  };
  const imports = (source: string): Array<{ specifier: string; names: string[] }> => {
    const found: Array<{ specifier: string; names: string[] }> = [];
    const pattern = /import\s+(?:type\s+)?([^;\n]+?)\s+from\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const clause = match[1] ?? '';
      const named = /\{([^}]+)\}/.exec(clause)?.[1];
      const names = named ? named.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]!).filter(Boolean) : [];
      const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
      if (defaultName && defaultName !== 'type') names.push('default');
      found.push({ specifier: match[2]!, names });
    }
    return found;
  };
  const resolveLocal = (file: string, specifier: string): string | undefined => {
    const bases = specifier.startsWith('.') ? [path.resolve(path.dirname(file), specifier)] : [];
    if (!specifier.startsWith('.')) {
      for (const mapping of pathMappings) {
        for (const [pattern, targets] of Object.entries(mapping.paths)) {
          const wildcard = pattern.indexOf('*');
          const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
          const suffix = wildcard < 0 ? '' : pattern.slice(wildcard + 1);
          if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue;
          const middle = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
          for (const target of targets) bases.push(path.resolve(mapping.base, target.replace('*', middle)));
        }
      }
    }
    for (const base of bases) {
      const candidates = [base, ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`), ...[...SOURCE_EXTENSIONS].map((extension) => path.join(base, `index${extension}`))];
      const found = candidates.find((candidate) => contents.has(candidate));
      if (found) return found;
    }
    return undefined;
  };
  for (const [file, source] of contents) {
    const names = directExports(source);
    if (names.size > 0) exportedClients.set(file, names);
  }
  for (const [file, source] of contents) {
    for (const match of source.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{([^}]+)\})\s*from\s*['"]([^'"]+)['"]/g)) {
      if (resolveLocal(file, match[2]!)) continue;
      const names = exportedClients.get(file) ?? new Set<string>();
      const specifiers = match[1];
      if (!specifiers) names.add('*');
      else for (const item of specifiers.split(',')) {
        const [, exportedName] = item.trim().split(/\s+as\s+/);
        names.add(exportedName ?? item.trim());
      }
      exportedClients.set(file, names);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, source] of contents) {
      const clientImports = imports(source).filter((entry) => {
        const dependency = resolveLocal(file, entry.specifier);
        const names = dependency ? exportedClients.get(dependency) : undefined;
        return Boolean(names && entry.names.some((name) => names.has(name) || names.has('*')));
      });
      if (clientImports.length > 0 && !retained.has(file)) { retained.add(file); changed = true; }
      const reexported = new Set<string>();
      for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const dependency = resolveLocal(file, match[2]!);
        const known = dependency ? exportedClients.get(dependency) : undefined;
        for (const part of (match[1] ?? '').split(',')) {
          const original = part.trim().split(/\s+as\s+/)[0];
          if (original && known?.has(original)) reexported.add(part.trim().split(/\s+as\s+/).at(-1)!);
        }
      }
      for (const match of source.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
        const dependency = resolveLocal(file, match[1]!);
        const known = dependency ? exportedClients.get(dependency) : undefined;
        if (known) for (const name of known) reexported.add(name);
      }
      if (reexported.size > 0) {
        const known = exportedClients.get(file) ?? new Set<string>();
        const previousSize = known.size;
        for (const name of reexported) known.add(name);
        if (known.size !== previousSize) { exportedClients.set(file, known); changed = true; }
        if (!retained.has(file)) { retained.add(file); changed = true; }
      }
    }
  }
  return [...retained].sort();
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
  /** Analyze without writing the checkout or regenerating lockfiles. */
  analysisOnly?: boolean;
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
  nodeTypesManifestPaths?: Set<string>;
}

export async function runMigration(migration: Migration, options: RunOptions): Promise<RunOutcome> {
  if (!options.dryRun) {
    throw new Error('Direct writes through runMigration are unavailable; use --write for verified Git branch commits.');
  }
  if (options.nodeRuntime && !((!migration.declarativeRecipe && options.nodeRuntime === 22 && migration.id === 'firebase-admin@14') || (!migration.declarativeRecipe && options.nodeRuntime === 20 && migration.id === 'openai@5') || options.nodeRuntime === migration.requiredNodeMajor)) {
    throw new Error('--node-runtime 22 applies to firebase-admin@14; --node-runtime 20 applies to openai@5; recipes require their declared nodeMajor.');
  }
  const scoped = loadScopedProject(options.cwd, migration, options.excludedDirectories, options.nodeRuntime);
  const project = scoped.project;
  const originalSources = new Map<string, string>(await Promise.all(
    project.getSourceFiles().map(async (file): Promise<[string, string]> => [file.getFilePath(), await readFile(file.getFilePath(), 'utf8')]),
  ));
  const result = migration.transform(project);
  result.manual.unshift(...scoped.manual);
  if (migration.id === 'openai@5' && !migration.declarativeRecipe) {
    result.manual.push(...inspectOpenAiTypeEnvironment(options.cwd, options.excludedDirectories));
  }
  const manifestsWithChangedCode = new Set(
    result.filesChanged.map((sourcePath) => scoped.manifestBySource.get(sourcePath)).filter((file): file is string => Boolean(file)),
  );
  const nodeTypesRepair = migration.id === 'openai@5' && !migration.declarativeRecipe
    ? await prepareNodeTypesRepair(options, manifestsWithChangedCode)
    : { notes: [], changes: [], manual: [] } satisfies ManifestOutcome;
  if (nodeTypesRepair.nodeTypesManifestPaths?.size || nodeTypesRepair.changes.length > 0) {
    const packagePaths = findPackageManifests(options.cwd, options.excludedDirectories);
    const repairedManifestPaths = nodeTypesRepair.nodeTypesManifestPaths ?? new Set<string>();
    for (let index = result.manual.length - 1; index >= 0; index--) {
      const finding = result.manual[index]!;
      if (/OpenAI v4 may have supplied @types\/node|OpenAI v5 requires Web fetch types/.test(finding.reason)
        && [...repairedManifestPaths].some((manifestPath) =>
          closestManifest(path.resolve(options.cwd, finding.file), packagePaths) === manifestPath)) {
        result.manual.splice(index, 1);
      }
    }
    for (const manifestPath of repairedManifestPaths) {
      result.changes.push({ file: manifestPath, line: 1, rule: 'node-types', before: 'Node declarations unavailable', after: '@types/node added alongside OpenAI v5 after isolated typecheck verification' });
    }
    for (const change of nodeTypesRepair.changes) {
      if (!result.filesChanged.includes(change.absolutePath))
        result.filesChanged.push(change.absolutePath);
      result.changes.push({ file: change.absolutePath, line: 1, rule: 'node-types', before: 'Node declarations unavailable', after: 'Node types enabled after isolated typecheck verification' });
    }
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
  const manualManifestPaths = new Set(result.manual.map((finding) => closestManifest(
    path.resolve(options.cwd, finding.file), findPackageManifests(options.cwd, options.excludedDirectories),
  )).filter((file): file is string => Boolean(file)));
  const manifestsEligibleForManifestChanges = options.analysisOnly
    ? new Set([...manifestsWithChangedCode].filter((file) => !manualManifestPaths.has(file)))
    : manifestsWithChangedCode;
  const baseManifest = (!options.analysisOnly || migration.id === 'openai@5')
      && (result.manual.length === 0 || options.analysisOnly) && result.changes.length > 0
    ? await migrateManifests(
      migration,
      options,
      manifestsEligibleForManifestChanges,
      nodeTypesRepair.nodeTypesManifestPaths?.size ? 20 : undefined,
      nodeTypesRepair.nodeTypesManifestPaths ?? new Set<string>(),
    )
    : {
        notes: [options.analysisOnly
          ? 'Dependency versions were not modified during source-only benchmark analysis.'
          : result.manual.length > 0
          ? 'Dependency versions were left unchanged because this migration has items requiring manual review.'
          : 'Dependency versions were left unchanged because no safe source edit was proposed; inspect the source and package declarations.'],
        changes: [],
        manual: [],
      };
  const manifest: ManifestOutcome = {
    notes: [...nodeTypesRepair.notes, ...baseManifest.notes],
    changes: [
      ...nodeTypesRepair.changes.filter((change) => path.basename(change.absolutePath) !== 'package.json'),
      ...nodeTypesRepair.changes.filter((change) => path.basename(change.absolutePath) === 'package.json'),
      ...baseManifest.changes,
    ],
    manual: [...nodeTypesRepair.manual, ...baseManifest.manual],
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
    const relativePath = projectPath(options.cwd, filePath);
    proposedFiles.push({ relativePath, before, after });
    const diff = unifiedDiff(relativePath, before, after);
    return diff ? [diff] : [];
  });
  for (const change of manifest.changes) {
    const relativePath = projectPath(options.cwd, change.absolutePath);
    proposedFiles.push({ relativePath, before: change.before, after: change.after });
    const diff = unifiedDiff(relativePath, change.before, change.after);
    if (diff) proposedDiff.push(diff);
  }
  const seenPaths = new Set<string>();
  for (const file of proposedFiles) {
    if (seenPaths.has(file.relativePath)) throw new Error(`Migration generated duplicate changes for ${file.relativePath}; no files were proposed.`);
    seenPaths.add(file.relativePath);
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
    filesChanged: [...new Set([
      ...result.filesChanged.map((file) => projectPath(options.cwd, file)),
      ...manifest.changes.map((change) => projectPath(options.cwd, change.absolutePath)),
    ])],
    changes: result.changes.map((c) => ({ ...c, file: projectPath(options.cwd, c.file) })),
    manual: [...result.manual, ...manifest.manual].map((m) => ({ ...m, file: projectPath(options.cwd, m.file) })),
    manifestNotes: [...new Set([...compatibilityNotes, ...manifest.notes])],
    proposedDiff,
    proposedFiles,
  };
}

function inspectOpenAiTypeEnvironment(root: string, excludedDirectories: readonly string[] = []): ManualItem[] {
  const findings: ManualItem[] = [];
  const sourceFiles = findAllSourceFiles(root, excludedDirectories);
  const manifestPaths = findPackageManifests(root, excludedDirectories);
  for (const manifestPath of manifestPaths) {
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
      let configExists = false;
      try { configExists = statSync(tsconfigPath).isFile(); } catch { /* no local tsconfig */ }
      const unsafeConfig = configExists && unsafeTsconfigReference(root, tsconfigPath);
      if (unsafeConfig) {
        findings.push({ file: tsconfigPath, line: 1,
          reason: 'The OpenAI type environment includes a symlinked or out-of-project tsconfig; it was not read. Review the configuration manually.',
          snippet: 'tsconfig path withheld' });
        compilerOptions = undefined;
      } else {
      const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => undefined,
      });
      if (parsed) compilerOptions = parsed.options as unknown as Record<string, unknown>;
      }
    } catch { /* Missing or invalid configuration cannot establish the active compiler environment. */ }
    const nodeTypes = manifest.devDependencies?.['@types/node'] ?? manifest.dependencies?.['@types/node'];
    const nodeTypesMajor = /^\s*[~^]?(\d+)/.exec(nodeTypes ?? '');
    const explicitlyLoadedTypes = Array.isArray(compilerOptions?.types)
      ? (compilerOptions.types as unknown[]).filter((value): value is string => typeof value === 'string')
      : undefined;
    const nodeTypesVisible = Boolean(nodeTypes) && (!explicitlyLoadedTypes || explicitlyLoadedTypes.includes('node'));
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
    const hasDomTypes = hasDomLibrary(compilerOptions);
    if (compilerOptions && Array.isArray(compilerOptions.lib)
      && !hasDomTypes
      && nodeTypesVisible
      && nodeTypesMajor && Number(nodeTypesMajor[1]) < 20) {
      findings.push({ file: manifestPath, line: 1,
        reason: `OpenAI v5 needs Web fetch types, but this tsconfig excludes DOM and @types/node ${nodeTypes} predates Node 20. Upgrade @types/node >=20 and typecheck; review runtime compatibility first.`,
        snippet: `@types/node: ${nodeTypes}` });
    }

    if (compilerOptions && Array.isArray(compilerOptions.lib)
      && !hasDomTypes
      && !nodeTypesVisible && !workersTypes && !bunTypes) {
      findings.push({ file: tsconfigPath, line: 1,
        reason: 'OpenAI v5 requires Web fetch types (RequestInit, Headers, Blob, File). This tsconfig excludes DOM and the package lacks @types/node; choose a compatible DOM lib or @types/node >=20, then typecheck. The correct runtime target cannot be inferred safely.',
        snippet: `compilerOptions.lib: ${JSON.stringify(compilerOptions.lib)}` });
    }
    if (nodeTypesVisible) continue;
    for (const sourcePath of sourceFiles) {
      const owner = closestManifest(sourcePath, manifestPaths);
      if (owner !== manifestPath) continue;
      if (!/\.[cm]?tsx?$/.test(sourcePath) && !(compilerOptions?.checkJs === true && /\.[cm]?jsx?$/.test(sourcePath))) continue;
      if (statSync(sourcePath).size > MAX_SOURCE_BYTES) continue;
      const source = readFileSync(sourcePath, 'utf8');
      const usage = findNodeTypeUsage(source);
      if (!usage) continue;
      findings.push({ file: sourcePath, line: usage.line,
        reason: 'OpenAI v4 may have supplied @types/node transitively; v5 does not. This file uses a Node built-in or global, but Node declarations are not visible to the compiler. Add a compatible @types/node devDependency, include "node" in compilerOptions.types when restricted, and run typecheck; otherwise review this runtime-specific use manually.',
        snippet: source.split('\n')[usage.line - 1]?.trim().slice(0, 500) ?? usage.name });
      break;
    }
  }
  return findings;
}

async function prepareNodeTypesRepair(options: RunOptions, eligibleManifestPaths: Set<string>): Promise<ManifestOutcome> {
  const findings = inspectOpenAiTypeEnvironment(options.cwd, options.excludedDirectories)
    .filter((finding) => /OpenAI v4 may have supplied @types\/node|OpenAI v5 requires Web fetch types/.test(finding.reason));
  if (findings.length === 0) return { notes: [], changes: [], manual: [] };
  const notes: string[] = [];
  const changes: ManifestFileChange[] = [];
  const manual: ManualItem[] = [];
  const nodeTypesManifestPaths = new Set<string>();
  for (const manifestPath of findPackageManifests(options.cwd, options.excludedDirectories)) {
    const raw = await readFile(manifestPath, 'utf8');
    let manifest: PackageManifest;
    try { manifest = parseManifest<PackageManifest>(raw); } catch { continue; }
    if (!(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
      .some((section) => isSupportedSourceMajor(manifest[section]?.openai ?? '', 4))) continue;
    if (!eligibleManifestPaths.has(manifestPath)) continue;
    const packageDirectory = path.dirname(manifestPath);
    const packageManifests = findPackageManifests(options.cwd, options.excludedDirectories);
    const relevant = findings.some((finding) => closestManifest(path.resolve(options.cwd, finding.file), packageManifests) === manifestPath);
    if (!relevant) continue;
    if (hasUnsafeDependencySpecs(manifest)) {
      manual.push({ file: path.relative(options.cwd, manifestPath), line: 1,
        reason: 'The Node type repair was withheld because Git, URL, local, aliased, override dependency specs require a manual lockfile update.',
        snippet: 'Node type repair withheld', reasonCode: 'lockfile-refusal' });
      continue;
    }
    const locks = await findLockfiles(options.cwd, packageDirectory);
    const unsafeLock = locks.find((lock) => !isSafeProjectFile(options.cwd, path.resolve(options.cwd, lock)));
    if (unsafeLock) {
      manual.push({ file: path.resolve(options.cwd, unsafeLock), line: 1,
        reason: 'The Node type repair was withheld because the lockfile is symlinked or resolves outside the project.',
        snippet: 'lockfile repair withheld', reasonCode: 'lockfile-refusal' });
      continue;
    }
    if ((['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
      .some((section) => typeof manifest[section]?.['@types/node'] === 'string')) continue;
    const scripts = manifest.scripts as Record<string, unknown> | undefined;
    const typecheckConfigured = typeof scripts?.typecheck === 'string';
    if (!typecheckConfigured) continue;
    const declaredNodeRange = manifest.engines?.node;
    const runtimeMajor = typeof declaredNodeRange === 'string'
      ? guaranteesNodeMajor(declaredNodeRange, 20) ? 20 : undefined
      : options.nodeRuntime;
    if (runtimeMajor === undefined || runtimeMajor < 20) continue;
    const tsconfigPath = path.join(packageDirectory, 'tsconfig.json');
    let tsconfigChange: ManifestFileChange | undefined;
    try {
      if (await exists(tsconfigPath) && unsafeTsconfigReference(options.cwd, tsconfigPath)) {
        manual.push({ file: tsconfigPath, line: 1,
          reason: 'The Node type repair was withheld because tsconfig.json or an extends target is symlinked or outside the project.',
          snippet: 'tsconfig repair withheld' });
        continue;
      }
      if (await exists(tsconfigPath)) {
        const configBefore = await readFile(tsconfigPath, 'utf8');
        const localConfig = ts.parseConfigFileTextToJson(tsconfigPath, configBefore);
        if (localConfig.error || !localConfig.config || typeof localConfig.config !== 'object') {
          manual.push({ file: tsconfigPath, line: 1,
            reason: 'The Node type repair was withheld because tsconfig.json is malformed; repair its JSONC syntax and rerun typecheck.',
            snippet: 'tsconfig repair withheld' });
          continue;
        }
        const localTypes = (localConfig.config as { compilerOptions?: { types?: unknown } }).compilerOptions?.types;
        if ((localConfig.config as { extends?: unknown }).extends !== undefined && !Array.isArray(localTypes)) {
          manual.push({ file: tsconfigPath, line: 1,
            reason: 'The types are inherited from an extended configuration; add "node" manually to the appropriate compilerOptions.types array in that configuration.',
            snippet: 'inherited tsconfig types' });
          continue;
        }
        const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => undefined,
        });
        if (!parsed || parsed.errors.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
          manual.push({ file: tsconfigPath, line: 1,
            reason: 'The Node type repair was withheld because the effective TypeScript configuration could not be resolved safely.',
            snippet: 'tsconfig repair withheld' });
          continue;
        }
        const types = (parsed.options as unknown as { types?: string[] }).types;
        if (Array.isArray(types) && !types.includes('node')) {
          const configAfter = addNodeTypeToTsconfig(configBefore, types);
          if (!configAfter) {
            manual.push({ file: tsconfigPath, line: 1,
              reason: 'The Node type repair was withheld because compilerOptions.types contains comments, a trailing comma, or a structure that cannot be edited without changing its formatting.',
              snippet: 'tsconfig repair withheld' });
            continue;
          }
          tsconfigChange = { absolutePath: tsconfigPath, relativePath: path.relative(options.cwd, tsconfigPath), before: configBefore, after: configAfter };
        }
      }
    } catch {
      manual.push({ file: tsconfigPath, line: 1,
        reason: 'The Node type repair was withheld because tsconfig.json could not be read safely.',
        snippet: 'tsconfig repair withheld' });
      continue;
    }
    if (tsconfigChange) changes.push(tsconfigChange);
    nodeTypesManifestPaths.add(manifestPath);
    notes.push(`Added @types/node ^${runtimeMajor}.0.0 to ${path.relative(options.cwd, manifestPath)} together with its OpenAI v5 upgrade; the isolated verifier must pass its typecheck before commit.`);
  }
  return { notes, changes, manual, nodeTypesManifestPaths };
}

export function addNodeTypeToTsconfig(raw: string, effectiveTypes: readonly string[]): string | undefined {
  if (effectiveTypes.includes('node')) return raw;
  const parsed = ts.parseJsonText('tsconfig.json', raw);
  const root = parsed.statements[0]?.expression;
  const diagnostics = (parsed as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0 || !root || !ts.isObjectLiteralExpression(root)) return undefined;
  const findProperty = (object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined =>
    object.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name);
  const compilerOptions = findProperty(root, 'compilerOptions');
  const insertProperty = (object: ts.ObjectLiteralExpression, propertyText: string): string => {
    const close = object.end - 1;
    const content = raw.slice(object.getStart(parsed) + 1, close);
    const whitespace = content.match(/\s*$/)?.[0] ?? '';
    const insertAt = close - whitespace.length;
    const multiline = raw.includes('\n');
    const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
    const parentIndent = raw.slice(0, object.getStart(parsed)).split(/\r?\n/).at(-1)?.match(/^\s*/)?.[0] ?? '';
    const childIndent = `${parentIndent}  `;
    const comma = object.properties.length > 0 ? ',' : '';
    const addition = multiline ? `${comma}${lineEnding}${childIndent}${propertyText}` : `${comma}${propertyText}`;
    return raw.slice(0, insertAt) + addition + raw.slice(insertAt);
  };
  let updated: string;
  if (compilerOptions && ts.isObjectLiteralExpression(compilerOptions.initializer)) {
    const optionsObject = compilerOptions.initializer;
    const typesProperty = findProperty(optionsObject, 'types');
    if (typesProperty && ts.isArrayLiteralExpression(typesProperty.initializer)) {
      const array = typesProperty.initializer;
      const close = array.end - 1;
      const content = raw.slice(array.getStart(parsed) + 1, close);
      if (/\/\/|\/\*/.test(content)) return undefined;
      const whitespace = content.match(/\s*$/)?.[0] ?? '';
      const insertAt = close - whitespace.length;
      const hasValues = array.elements.length > 0;
      const hasTrailingComma = content.trimEnd().endsWith(',');
      if (hasTrailingComma) return undefined;
      const multiline = content.includes('\n');
      const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
      const arrayIndent = raw.slice(0, array.getStart(parsed)).split(/\r?\n/).at(-1)?.match(/^\s*/)?.[0] ?? '';
      const addition = multiline
        ? `${hasValues && !hasTrailingComma ? ',' : ''}${lineEnding}${arrayIndent}  "node"`
        : `${hasValues ? ', ' : ''}"node"`;
      updated = raw.slice(0, insertAt) + addition + raw.slice(insertAt);
    } else if (typesProperty) return undefined;
    else updated = insertProperty(optionsObject, `"types": ${JSON.stringify([...effectiveTypes, 'node'])}`);
  } else if (compilerOptions) return undefined;
  else updated = insertProperty(root, `"compilerOptions": { "types": ${JSON.stringify([...effectiveTypes, 'node'])} }`);
  const validated = ts.parseJsonText('tsconfig.json', updated);
  return ((validated as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length === 0
    ? updated : undefined;
}

export function addNodeTypesDependency(raw: string, major: number): string | undefined {
  const rootStart = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const dependencyMember = findJsonObjectMember(raw, rootStart, 'devDependencies');
  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
  const separatorMatch = /"(\s*:\s*)"/.exec(raw);
  const keyValueSeparator = separatorMatch?.[1] ?? ': ';
  const indent = raw.match(/(?:\r?\n)([ \t]+)"[^"\r\n]+"\s*:/)?.[1] ?? '  ';
  const specifier = `^${major}.0.0`;
  let updated: string;
  if (dependencyMember) {
    if (raw[dependencyMember.valueStart] !== '{') return undefined;
    const end = jsonValueEnd(raw, dependencyMember.valueStart);
    if (end < 0) return undefined;
    const close = end - 1;
    const multilineDependencies = /\r?\n/.test(raw.slice(dependencyMember.valueStart + 1, close));
    const whitespace = raw.slice(dependencyMember.valueStart + 1, close).match(/\s*$/)?.[0] ?? '';
    const insertAt = close - whitespace.length;
    const hasEntries = raw.slice(dependencyMember.valueStart + 1, insertAt).trim().length > 0;
    const childIndent = multilineDependencies ? `${indent}${indent}` : '';
    const addition = multilineDependencies
      ? `${hasEntries ? ',' : ''}${lineEnding}${childIndent}"@types/node"${keyValueSeparator}"${specifier}"`
      : `${hasEntries ? ', ' : ''}"@types/node"${keyValueSeparator}"${specifier}"`;
    updated = raw.slice(0, insertAt) + addition + raw.slice(insertAt);
  } else {
    const end = jsonValueEnd(raw, rootStart);
    if (end < 0) return undefined;
    const close = end - 1;
    const multilineRoot = /\r?\n/.test(raw.slice(rootStart + 1, close));
    const whitespace = raw.slice(rootStart + 1, close).match(/\s*$/)?.[0] ?? '';
    const insertAt = close - whitespace.length;
    const hasEntries = raw.slice(rootStart + 1, insertAt).trim().length > 0;
    const addition = multilineRoot
      ? `${hasEntries ? ',' : ''}${lineEnding}${indent}"devDependencies"${keyValueSeparator}{${lineEnding}${indent}${indent}"@types/node"${keyValueSeparator}"${specifier}"${lineEnding}${indent}}`
      : `${hasEntries ? ', ' : ''}"devDependencies"${keyValueSeparator}{"@types/node"${keyValueSeparator}"${specifier}"}`;
    updated = raw.slice(0, insertAt) + addition + raw.slice(insertAt);
  }
  try {
    const parsed = parseManifest<PackageManifest>(updated);
    return parsed.devDependencies?.['@types/node'] === specifier ? updated : undefined;
  } catch { return undefined; }
}

function hasDomLibrary(compilerOptions: Record<string, unknown> | undefined): boolean {
  const libraries = compilerOptions?.lib;
  return Array.isArray(libraries) && libraries.some((lib) => typeof lib === 'string'
    && /^(?:lib\.)?dom(?:\.iterable)?(?:\.d\.ts)?$/i.test(lib));
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
  nodeTypesMajor?: number,
  nodeTypesManifestPaths: Set<string> = new Set(),
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
        reasonCode: 'manifest-refusal',
      });
      continue;
    }

    const before = structuredClone(manifest);
    const addNodeTypes = nodeTypesMajor !== undefined && nodeTypesManifestPaths.has(manifestPath)
      && !(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
        .some((section) => typeof manifest[section]?.['@types/node'] === 'string');
    if (options.nodeRuntime !== undefined) {
      const major = options.nodeRuntime;
      if (manifest.engines !== undefined && (typeof manifest.engines !== 'object' || Array.isArray(manifest.engines) || manifest.engines === null)) {
        manual.push({
          file: relativePath,
          line: 1,
          reason: `engines must be an object in package.json before --node-runtime ${major} can add a Node.js range.`,
          snippet: 'engines',
          reasonCode: 'manifest-refusal',
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
          reasonCode: 'manifest-refusal',
        });
        continue;
      }
      if (declared === undefined) manifest.engines = { ...manifest.engines, node: `>=${major}` };
    }
    const fileNotes = migration.updateManifest(manifest);
    const versionChanged = (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)
      .some((section) => before[section]?.[migration.packageName] !== manifest[section]?.[migration.packageName]);
    if (!versionChanged && fileNotes.some((note) => /could not safely update|could not be updated|non-modifiable|unsupported/i.test(note))) {
      notes.push(...fileNotes.filter((note) => !note.includes(' → ')));
      manual.push({ file: relativePath, line: 1,
        reason: `The ${migration.packageName} dependency version could not be updated safely; the package was left unchanged.`,
        snippet: `${migration.packageName} dependency update withheld`, reasonCode: 'manifest-refusal' });
      continue;
    }
    if (addNodeTypes) {
      manifest.devDependencies = { ...manifest.devDependencies, '@types/node': `^${nodeTypesMajor}.0.0` };
      fileNotes.push(`Added @types/node ^${nodeTypesMajor}.0.0 after detecting Node API use; the isolated verifier must pass typecheck before commit.`);
    }
    if (options.nodeRuntime !== undefined && before.engines?.node === undefined) {
      fileNotes.unshift(`\`${relativePath}\`: added \`engines.node\` = \`>=${options.nodeRuntime}\` after explicit --node-runtime ${options.nodeRuntime} confirmation.`);
    }
    if (JSON.stringify(manifest) === JSON.stringify(before)) {
      notes.push(...fileNotes);
      continue;
    }

    const versionUpdated = preserveManifestFormatting(raw, before, manifest, migration.packageName);
    let updated = versionUpdated && options.nodeRuntime !== undefined && before.engines?.node === undefined
      ? addNodeEngineToManifest(versionUpdated, options.nodeRuntime)
      : versionUpdated;
    if (updated && addNodeTypes) updated = addNodeTypesDependency(updated, nodeTypesMajor!);
    if (updated === undefined) {
      notes.push(...fileNotes.filter((note) => !note.includes(' → ')));
      manual.push({
        file: relativePath,
        line: 1,
        reason: 'The dependency version could not be updated without rewriting or ambiguously editing package.json; update it manually.',
        snippet: `${migration.packageName} dependency update withheld`,
        reasonCode: 'manifest-refusal',
      });
      continue;
    }

    if (options.analysisOnly && hasUnsafeDependencySpecs(manifest)) {
      manual.push({ file: relativePath, line: 1,
        reason: 'This package uses Git, URL, local, aliased, or override dependency specs; the lockfile cannot be regenerated safely for this migration.',
        snippet: 'dependency repair withheld', reasonCode: 'lockfile-refusal' });
      continue;
    }
    if (options.analysisOnly) {
      const rendered = updated;
      changes.push({ absolutePath: manifestPath, relativePath, before: raw, after: rendered });
      notes.push(...fileNotes);
      notes.push(`Lockfiles for ${relativePath} were not proposed during source-only analysis.`);
      continue;
    }
    const existingLocks = await findLockfiles(options.cwd, path.dirname(manifestPath));
    let lockChange: ManifestFileChange | undefined;
    if (existingLocks.length > 0) {
      const unsafeLock = existingLocks.find((lock) => !isSafeProjectFile(options.cwd, path.resolve(options.cwd, lock)));
      if (unsafeLock) {
        notes.push(...fileNotes.filter((note) => !note.includes(' → ')));
        manual.push({ file: path.resolve(options.cwd, unsafeLock), line: 1,
          reason: 'This package lockfile is symlinked or resolves outside the project; it was not read or regenerated.',
          snippet: 'lockfile update withheld', reasonCode: 'lockfile-refusal' });
        continue;
      }
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
          reasonCode: 'lockfile-refusal',
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
  root = path.resolve(root);
  packageDirectory = path.resolve(packageDirectory);
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

function closestManifest(sourcePath: string, manifests: readonly string[]): string | undefined {
  const source = path.resolve(sourcePath);
  return manifests
    .filter((manifest) => {
      const directory = path.dirname(path.resolve(manifest));
      return source === directory || source.startsWith(directory + path.sep);
    })
    .sort((left, right) => path.dirname(path.resolve(right)).length - path.dirname(path.resolve(left)).length)[0];
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isSafeProjectFile(root: string, candidate: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(candidate);
  if (!isPathWithin(absoluteRoot, absolute)) return false;
  try {
    let current = absoluteRoot;
    for (const part of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return false;
    }
    return statSync(absolute).isFile() && isPathWithin(realpathSync(absoluteRoot), realpathSync(absolute));
  } catch { return false; }
}

function unsafeTsconfigReference(root: string, initialConfig: string): boolean {
  const visited = new Set<string>();
  const visit = (configPath: string): boolean => {
    const absolute = path.resolve(configPath);
    if (!isPathWithin(root, absolute) || !isSafeProjectFile(root, absolute)) return true;
    const canonical = realpathSync(absolute);
    if (visited.has(canonical)) return true;
    visited.add(canonical);
    let parsed: ReturnType<typeof ts.parseConfigFileTextToJson>;
    try { parsed = ts.parseConfigFileTextToJson(absolute, readFileSync(absolute, 'utf8')); }
    catch { return false; }
    if (parsed.error || !parsed.config || typeof parsed.config !== 'object') return false;
    const extendsValue: unknown = parsed.config.extends;
    const references = typeof extendsValue === 'string' ? [extendsValue]
      : Array.isArray(extendsValue) ? extendsValue.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const reference of references) {
      let base: string | undefined;
      if (reference.startsWith('.') || path.isAbsolute(reference)) {
        const target = path.resolve(path.dirname(absolute), reference);
        const candidates = path.extname(target) ? [target] : [target, `${target}.json`, path.join(target, 'tsconfig.json')];
        base = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } }) ?? target;
      } else {
        base = ts.resolveModuleName(reference, absolute, {}, ts.sys).resolvedModule?.resolvedFileName;
        if (!base) return true;
      }
      if (visit(base)) return true;
    }
    return false;
  };
  return visit(initialConfig);
}

export function addNodeEngineToManifest(raw: string, major: number): string | undefined {
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

export function preserveManifestFormatting(
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
