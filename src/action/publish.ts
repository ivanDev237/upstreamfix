import { maskSecrets, sanitizeTerminalText } from '../core/report.js';
import { migrations } from '../migrations/index.js';
import type { ActionConfig } from './config.js';
import { isDeepStrictEqual } from 'node:util';
import { Project, ts } from 'ts-morph';
import { guaranteesNodeMajor } from '../core/node-range.js';
import { isSupportedSourceMajor } from '../core/project-discovery.js';
import { addNodeEngineToManifest, addNodeTypeToTsconfig, addNodeTypesDependency, preserveManifestFormatting } from '../core/runner.js';
import type { PackageManifest } from '../core/types.js';

export interface Proposal {
  schema: 1;
  migration: string;
  status: 'ready' | 'manual' | 'none';
  base: string;
  branch: string;
  commit?: string;
  files: string[];
  verification: 'passed' | 'failed' | 'skipped';
  report: string;
  reviewers: string[];
  labels: string[];
  registryBefore?: string;
}

export interface ProposalPublisher {
  isDismissed?(proposal: Proposal): Promise<boolean>;
  findPullRequest(proposal: Proposal): Promise<number | undefined>;
  pushBranch(proposal: Proposal): Promise<void>;
  openPullRequest(body: string, proposal: Proposal): Promise<void>;
  updatePullRequest(number: number, body: string, proposal: Proposal): Promise<void>;
  closePullRequest(number: number): Promise<void>;
  upsertIssue(body: string, proposal: Proposal): Promise<void>;
  closeIssue(proposal: Proposal): Promise<void>;
}

interface ManagedIssueCandidate {
  number: number;
  title: string;
  body?: string | null;
  user?: { login?: string };
  pull_request?: unknown;
  state?: string;
}

interface ClosureRecord {
  state?: string;
  merged_at?: string | null;
  labels?: Array<{ name?: string }>;
}

/** A bot closing its own stale proposal does not mean the maintainer refused it. */
export function isDismissedClosure(record: ClosureRecord, events: Array<{ event?: string; actor?: { login?: string } }>): boolean {
  if (record.labels?.some((label) => label.name === 'upstreamfix:dismissed')) return true;
  if (record.state !== 'closed' || record.merged_at) return false;
  const lastClosure = [...events].reverse().find((event) => event.event === 'closed');
  const actor = lastClosure?.actor?.login;
  return Boolean(actor && actor !== 'github-actions[bot]' && actor !== 'upstreamfix[bot]');
}

export function findManagedIssue(issues: ManagedIssueCandidate[], migration: string): ManagedIssueCandidate | undefined {
  const marker = `<!-- upstreamfix:manual:${migration} -->`;
  return issues.find((item) => !item.pull_request && item.title === `UpstreamFix: manual ${migration}`
    && item.user?.login === 'github-actions[bot]' && item.body?.includes(marker));
}

export async function findManagedIssuePaginated(
  fetchPage: (page: number) => Promise<ManagedIssueCandidate[]>, migration: string,
): Promise<ManagedIssueCandidate | undefined> {
  for (let page = 1; page <= 1000; page++) {
    const issues = await fetchPage(page);
    const managed = findManagedIssue(issues, migration);
    if (managed) return managed;
    if (issues.length < 100) return undefined;
  }
  throw new Error('GitHub issue pagination exceeded the safety limit.');
}

export function isDismissedManualIssueForProposal(
  issue: ClosureRecord, events: Array<{ event?: string; actor?: { login?: string } }>, status: Proposal['status'],
): boolean {
  if (issue.labels?.some((label) => label.name === 'upstreamfix:dismissed')) return true;
  // Closing a manual-work ticket can mean that the user completed that work.
  // It should not prevent a later verified PR; the explicit label blocks both.
  return status === 'manual' && isDismissedClosure(issue, events);
}

const sha = /^[0-9a-f]{40}$/;
const safePath = /^(?:[A-Za-z0-9_.@()+ -]+\/)*[A-Za-z0-9_.@()+ -]+$/;

export function parseExactRemoteHead(raw: string, branch: string): string {
  if (raw === '') return '';
  const match = /^([0-9a-f]{40})\t([^\r\n]+)\n$/.exec(raw);
  if (!match || match[2] !== `refs/heads/${branch}`) throw new Error('Remote branch response did not match the exact expected ref.');
  return match[1]!;
}

/** Accept only the single machine-readable line emitted by rev-list --parents. */
export function parseCommitParents(raw: string, expectedCommit: string): string[] {
  const fields = raw.trim().split(' ');
  if (!sha.test(expectedCommit) || fields[0] !== expectedCommit || fields.some((field) => !sha.test(field))) {
    throw new Error('Commit ancestry is malformed.');
  }
  return fields.slice(1);
}

/** Parse Git's NUL-separated raw diff; only regular file additions/edits are publishable. */
export function parseSafeRawDiff(raw: string): string[] {
  const records = raw.split('\0');
  if (records.at(-1) !== '') throw new Error('Malformed raw Git diff.');
  records.pop();
  if (records.length % 2 !== 0) throw new Error('Malformed raw Git diff.');
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index]!;
    const file = records[index + 1]!;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z])$/.exec(header);
    if (!match) throw new Error('Malformed raw Git diff status.');
    if (!['A', 'M'].includes(match[3]!)) throw new Error('Raw Git diff contains a deletion or unsupported status.');
    if (!['100644', '100755'].includes(match[2]!) || (match[3] === 'M' && !['100644', '100755'].includes(match[1]!))) {
      throw new Error('Raw Git diff contains a symlink, submodule or other unsafe mode.');
    }
    if (match[3] === 'A' && match[1] !== '000000') throw new Error('Malformed addition mode.');
    if (!file || file.includes('\n') || file.includes('\r')) throw new Error('Malformed raw Git diff path.');
    files.push(file);
  }
  return files;
}

/** Metadata is untrusted until a separate Git bundle inspection confirms it. */
export function validateProposalEnvelope(proposal: Proposal, expectedBase: string, config?: Pick<ActionConfig, 'reviewers' | 'labels'>): void {
  if (!proposal || typeof proposal !== 'object') throw new Error('Invalid proposal metadata.');
  if (proposal.schema !== 1 || !migrations.some((migration) => migration.id === proposal.migration)) throw new Error('Unknown proposal schema or migration.');
  if (proposal.registryBefore !== undefined) {
    const parsed = Date.parse(proposal.registryBefore);
    const age = Date.now() - parsed;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(proposal.registryBefore)
      || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== proposal.registryBefore
      || age < 0 || age > 2 * 60 * 60 * 1000) {
      throw new Error('Proposal registry cutoff time is invalid, expired, or in the future; rerun the migration.');
    }
  }
  if (proposal.status === 'ready' && !proposal.registryBefore && proposal.files.some((file) => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/.test(file))) {
    throw new Error('A ready npm lockfile proposal requires a registry cutoff time.');
  }
  if (!sha.test(proposal.base) || proposal.base !== expectedBase) throw new Error('Proposal base does not match the reviewed default-branch commit.');
  const expectedBranch = `upstreamfix/${proposal.migration.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  if (proposal.branch !== expectedBranch) throw new Error('Proposal branch is outside the approved upstreamfix namespace.');
  if (!['ready', 'manual', 'none'].includes(proposal.status) || !['passed', 'failed', 'skipped'].includes(proposal.verification)) throw new Error('Invalid proposal status.');
  if (!Array.isArray(proposal.files) || !proposal.files.every((file) => typeof file === 'string')
    || !Array.isArray(proposal.reviewers) || !Array.isArray(proposal.labels) || typeof proposal.report !== 'string') throw new Error('Invalid proposal metadata types.');
  if (proposal.report.length > 100_000 || proposal.reviewers.length > 20 || proposal.labels.length > 20) throw new Error('Proposal metadata exceeds its limits.');
  if (!proposal.reviewers.every((value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value))) throw new Error('Proposal reviewers are invalid.');
  if (!proposal.labels.every((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,49}$/.test(value) && !/(?:auto[ _.-]*merge|merge[ _.-]*queue|merge[ _.-]*when[ _.-]*ready)/i.test(value))) throw new Error('Proposal labels are invalid or enable automatic merge.');
  if (config && (!sameList(proposal.reviewers, config.reviewers) || !sameList(proposal.labels, config.labels))) {
    throw new Error('Proposal reviewers or labels differ from the reviewed base configuration.');
  }
  if (proposal.status === 'ready' && (!proposal.commit || !sha.test(proposal.commit))) throw new Error('A ready proposal requires a valid commit SHA.');
  if (proposal.status !== 'ready' && proposal.commit) throw new Error('A non-ready proposal cannot contain a commit.');
}

export function validateProposal(proposal: Proposal, expectedBase: string, parents: string[], changedFiles: string[], config?: Pick<ActionConfig, 'reviewers' | 'labels'>): void {
  validateProposalEnvelope(proposal, expectedBase, config);
  if (proposal.status === 'ready') {
    if (!proposal.commit || !sha.test(proposal.commit) || proposal.verification !== 'passed' || parents.length !== 1 || parents[0] !== proposal.base) {
      throw new Error('A ready proposal requires one verified commit with exactly the expected base parent.');
    }
    const expected = [...proposal.files].sort();
    const actual = [...changedFiles].sort();
    if (expected.length === 0 || expected.length !== actual.length || expected.some((file, index) => file !== actual[index])) {
      throw new Error('Bundle changed files do not match the proposal report.');
    }
    if (actual.some((file) => !safePath.test(file) || file.startsWith('.') || file.includes('/.') || file.includes('..') || file.startsWith('.github/') || !/(?:\.(?:[cm]?[jt]sx?|json|lock|yaml|yml)|^yarn\.lock$)$/.test(file))) {
      throw new Error('Bundle changed files include an unsafe path.');
    }
  } else if (proposal.commit || proposal.files.length || changedFiles.length || parents.length) {
    throw new Error('A manual or empty proposal cannot carry a commit or changed files.');
  }
}

interface BundleBlob { before?: string; after: string }
interface CommitIdentity { author: string; authorEmail: string; committer: string; committerEmail: string; subject: string }

/** Recheck client-controlled commit contents in the permissioned publication job. */
export function validatePublishableBundle(proposal: Proposal, blobs: Record<string, BundleBlob>, identity: CommitIdentity, regeneratedLocks: Record<string, string> = {}): void {
  const bot = 'upstreamfix[bot]';
  const email = '41898282+github-actions[bot]@users.noreply.github.com';
  if (identity.author !== bot || identity.committer !== bot || identity.authorEmail !== email || identity.committerEmail !== email
    || identity.subject !== `Apply ${proposal.migration} migration with UpstreamFix`) {
    throw new Error('Bundle commit identity or message is not the reviewed UpstreamFix bot identity.');
  }
  const migration = migrations.find((item) => item.id === proposal.migration);
  if (!migration) throw new Error('Unknown bundle migration.');
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const sources = new Map<string, BundleBlob>();
  const manifestDirectories = new Set(proposal.files.filter((file) => /(?:^|\/)package\.json$/.test(file)).map((file) => file.replace(/(?:^|\/)package\.json$/, '')));
  if (proposal.files.length > 100) throw new Error('Bundle contains too many changed files.');
  for (const file of proposal.files) {
    const blob = blobs[file];
    if (!blob || typeof blob.before !== 'string' || blob.before.length > 8 * 1024 * 1024 || blob.after.length > 8 * 1024 * 1024) {
      throw new Error('Bundle file has no bounded reviewed base version.');
    }
    if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
      if (blob.before.length > 2 * 1024 * 1024) throw new Error('Bundle source exceeds the migration size limit.');
      project.createSourceFile(`/proposal/${file}`, blob.before);
      sources.set(file, blob);
      continue;
    }
    if (/(?:^|\/)package\.json$/.test(file)) validateManifestDelta(blob.before, blob.after, migration.packageName, migration.toMajor);
    else if (/(?:^|\/)tsconfig\.json$/.test(file)) {
      const directory = file.replace(/(?:^|\/)tsconfig\.json$/, '');
      if (!manifestDirectories.has(directory)) throw new Error('Bundle tsconfig is not owned by the package manifest being migrated.');
      const packageManifest = blobs[directory ? `${directory}/package.json` : 'package.json'];
      let nodeTypesAddedInBundle = false;
      if (packageManifest?.before !== undefined) {
        const beforePackage = parseJsonObject(packageManifest.before, 'package.json');
        const afterPackage = parseJsonObject(packageManifest.after, 'package.json');
        const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        nodeTypesAddedInBundle = sections.every((section) => typeof record(beforePackage[section])?.['@types/node'] !== 'string')
          && typeof record(afterPackage.devDependencies)?.['@types/node'] === 'string';
      }
      validateNodeTypesTsconfigDelta(blob.before, blob.after, migration.packageName, migration.toMajor, nodeTypesAddedInBundle);
    }
    else if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/.test(file)) {
      const lock = parseJsonObject(blob.after, file);
      if (![2, 3].includes(lock.lockfileVersion as number) || !record(lock.packages)) throw new Error('Bundle npm lockfile format is unsupported.');
      if (regeneratedLocks[file] === undefined || regeneratedLocks[file] !== blob.after) {
        throw new Error('Bundle npm lockfile differs from the independently regenerated lockfile.');
      }
      rejectExecutableShadowing(parseJsonObject(blob.before, file), lock);
    }
    else if (/(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock)$/.test(file)) {
      throw new Error('Bundle pnpm and Yarn lockfile changes require manual review until deterministic regeneration is available.');
    }
    else throw new Error('Bundle changes a file outside the deterministic migration output.');
  }
  if (sources.size) {
    const result = migration.transform(project);
    if (result.manual.length) throw new Error('Bundle migration still has manual source work.');
    const generated = new Map(result.fileUpdates?.map((update) => [update.file, update.contents]));
    for (const [file, blob] of sources) {
      const produced = generated.get(`/proposal/${file}`);
      const expected = blob.before?.startsWith('\uFEFF') && produced && !produced.startsWith('\uFEFF') ? `\uFEFF${produced}` : produced;
      if (expected !== blob.after) {
        throw new Error(`Bundle source ${file} differs from the deterministic migration output.`);
      }
    }
    if (generated.size !== sources.size) throw new Error('Bundle omits a deterministic migration source change.');
  }
}

function rejectExecutableShadowing(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const oldPackages = record(before.packages);
  const newPackages = record(after.packages);
  if (!oldPackages || !newPackages) throw new Error('Bundle npm lockfile has no package entries.');
  const dangerous = new Set(['node', 'npm', 'npx', 'corepack', 'pnpm', 'yarn', 'sh', 'bash', 'dash', 'zsh', 'cmd', 'powershell', 'pwsh']);
  const binaries = (entry: unknown, packagePath: string): string[] => {
    const value = record(entry)?.bin;
    if (typeof value === 'string') return [packagePath.split('/').at(-1)!];
    return Object.keys(record(value) ?? {});
  };
  const topLevel = (packagePath: string): boolean => /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(packagePath);
  const existing = new Set<string>();
  for (const [packagePath, entry] of Object.entries(oldPackages)) {
    if (topLevel(packagePath)) for (const name of binaries(entry, packagePath)) existing.add(name);
  }
  const added = new Set<string>();
  for (const [packagePath, entry] of Object.entries(newPackages)) {
    const oldEntry = oldPackages[packagePath];
    if (oldEntry) {
      const beforeNames = binaries(oldEntry, packagePath).sort();
      const afterNames = binaries(entry, packagePath).sort();
      if (!isDeepStrictEqual(beforeNames, afterNames)) throw new Error('Bundle npm lockfile changes an existing executable command name.');
    }
    if (oldEntry) continue;
    for (const name of binaries(entry, packagePath)) {
      if (dangerous.has(name.toLowerCase()) || (topLevel(packagePath) && (existing.has(name) || added.has(name)))) {
        throw new Error('Bundle npm lockfile adds an executable that shadows an existing command.');
      }
      if (topLevel(packagePath)) added.add(name);
    }
  }
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  if (contents.length > 8 * 1024 * 1024) throw new Error(`Bundle ${label} exceeds the validation size limit.`);
  try {
    const syntax = ts.parseJsonText(label, contents);
    const diagnostics = (syntax as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length || hasDuplicateJsonKeys(syntax)) throw new Error('duplicate or invalid JSON keys');
    const value: unknown = JSON.parse(contents);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fixed error below */ }
  throw new Error(`Bundle ${label} is invalid JSON.`);
}

function hasDuplicateJsonKeys(source: ts.JsonSourceFile): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text : undefined;
        if (name !== undefined && names.has(name)) return true;
        if (name !== undefined) names.add(name);
      }
    }
    return node.forEachChild(visit) ?? false;
  };
  return visit(source);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validateManifestDelta(beforeText: string, afterText: string, packageName: string, targetMajor: number): void {
  const before = parseJsonObject(beforeText, 'package.json');
  const after = parseJsonObject(afterText, 'package.json');
  const normalized = structuredClone(after);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const oldValue = record(before[section])?.[packageName];
    const nextValue = record(after[section])?.[packageName];
    if (oldValue !== nextValue) {
      if (typeof oldValue !== 'string' || nextValue !== `^${targetMajor}.0.0`) throw new Error('Bundle package.json changes an unexpected SDK dependency.');
      record(normalized[section])![packageName] = oldValue;
    }
  }
  if (packageName === 'firebase-admin' && targetMajor === 14) {
    const beforeAdmin = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .map((section) => record(before[section])?.['firebase-admin']).find((value) => typeof value === 'string');
    const afterAdmin = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .map((section) => record(after[section])?.['firebase-admin']).find((value) => typeof value === 'string');
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const oldValue = record(before[section])?.['firebase-functions'];
      const nextValue = record(after[section])?.['firebase-functions'];
      if (oldValue === nextValue) continue;
      if (typeof oldValue !== 'string' || !/^\s*[~^]?(?:[0-6](?:\.\d+){0,2}|7\.[0-2](?:\.\d+)?)\s*$/.test(oldValue) || nextValue !== '^7.3.0' ||
        typeof beforeAdmin !== 'string' || !isSupportedSourceMajor(beforeAdmin, 13) || afterAdmin !== '^14.0.0') {
        throw new Error('Bundle package.json changes firebase-functions outside the approved v14 peer repair.');
      }
      record(normalized[section])!['firebase-functions'] = oldValue;
    }
  }
  const beforeEngines = record(before.engines);
  const afterEngines = record(after.engines);
  if (beforeEngines?.node === undefined && typeof afterEngines?.node === 'string') {
    const required = packageName === 'firebase-admin' ? 22 : packageName === 'openai' ? 20 : undefined;
    if (!required || afterEngines.node !== `>=${required}`) throw new Error('Bundle package.json adds an unexpected Node.js requirement.');
    if (beforeEngines) delete record(normalized.engines)!.node;
    else delete normalized.engines;
  }
  const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const beforeOpenAi = dependencySections.map((section) => record(before[section])?.openai).find((value) => typeof value === 'string');
  const afterOpenAi = dependencySections.map((section) => record(after[section])?.openai).find((value) => typeof value === 'string');
  const beforeNodeTypes = dependencySections.map((section) => record(before[section])?.['@types/node']);
  const afterNodeTypes = dependencySections.map((section) => record(after[section])?.['@types/node']);
  if (JSON.stringify(beforeNodeTypes) !== JSON.stringify(afterNodeTypes)) {
    const runtimeMajor = typeof afterEngines?.node === 'string'
      ? [20, 22].find((major) => guaranteesNodeMajor(afterEngines.node as string, major)) : undefined;
    const added = afterNodeTypes[1];
    if (packageName !== 'openai' || targetMajor !== 5 || typeof beforeOpenAi !== 'string'
      || !isSupportedSourceMajor(beforeOpenAi, 4) || afterOpenAi !== '^5.0.0'
      || beforeNodeTypes.some((value) => value !== undefined)
      || typeof added !== 'string' || runtimeMajor === undefined || added !== `^${runtimeMajor}.0.0`
      || afterNodeTypes.some((value, index) => index !== 1 && value !== undefined)) {
      throw new Error('Bundle package.json adds or changes @types/node outside the deterministic Node runtime repair.');
    }
    const normalizedDevDependencies = record(normalized.devDependencies);
    if (normalizedDevDependencies) {
      delete normalizedDevDependencies['@types/node'];
      if (!record(before.devDependencies) && Object.keys(normalizedDevDependencies).length === 0) delete normalized.devDependencies;
    }
    const migration = migrations.find((candidate) => candidate.id === 'openai@5');
    const expectedManifest = structuredClone(before) as PackageManifest;
    if (record(expectedManifest.engines)?.node === undefined)
      expectedManifest.engines = { ...record(expectedManifest.engines), node: '>=20' } as Record<string, string>;
    const notes = migration?.updateManifest?.(expectedManifest) ?? [];
    if (!migration || notes.some((note) => note.includes('requires Node.js'))) throw new Error('Bundle package.json is not eligible for the OpenAI Node type repair.');
    let expectedText = preserveManifestFormatting(beforeText, before as PackageManifest, expectedManifest, 'openai');
    if (expectedText && record(before.engines)?.node === undefined) expectedText = addNodeEngineToManifest(expectedText, 20);
    if (expectedText) expectedText = addNodeTypesDependency(expectedText, runtimeMajor!);
    if (expectedText !== afterText) throw new Error('Bundle package.json differs from the exact deterministic Node type repair.');
  }
  if (!isDeepStrictEqual(normalized, before)) throw new Error('Bundle package.json changes fields beyond the SDK version or approved Node.js requirement.');
}

function validateNodeTypesTsconfigDelta(beforeText: string, afterText: string, packageName: string, targetMajor: number, nodeTypesAddedInBundle: boolean): void {
  if (packageName !== 'openai' || targetMajor !== 5) throw new Error('Bundle tsconfig changes are only allowed for the OpenAI Node type repair.');
  const beforeSyntax = ts.parseJsonText('tsconfig.json', beforeText);
  const afterSyntax = ts.parseJsonText('tsconfig.json', afterText);
  if (hasDuplicateJsonKeys(beforeSyntax) || hasDuplicateJsonKeys(afterSyntax)) throw new Error('Bundle tsconfig contains duplicate JSON keys.');
  const beforeParsed = ts.parseConfigFileTextToJson('tsconfig.json', beforeText);
  const afterParsed = ts.parseConfigFileTextToJson('tsconfig.json', afterText);
  if (beforeParsed.error || afterParsed.error || !record(beforeParsed.config) || !record(afterParsed.config))
    throw new Error('Bundle tsconfig is invalid JSONC.');
  const before = structuredClone(beforeParsed.config) as Record<string, unknown>;
  const after = structuredClone(afterParsed.config) as Record<string, unknown>;
  const beforeOptions = record(before.compilerOptions);
  const afterOptions = record(after.compilerOptions);
  const beforeTypes = beforeOptions?.types;
  const afterTypes = afterOptions?.types;
  if (!nodeTypesAddedInBundle || !afterOptions || !Array.isArray(afterTypes)
    || !afterTypes.every((item) => typeof item === 'string')
    || afterTypes.at(-1) !== 'node') {
    throw new Error('Bundle tsconfig must end the compilerOptions.types array with the Node type.');
  }
  if (!Array.isArray(beforeTypes) && before.extends === undefined)
    throw new Error('Bundle tsconfig adds compilerOptions.types even though the source config has no local types array or extends; the runner does not produce this change.');
  if (before.extends !== undefined && !Array.isArray(beforeTypes))
    throw new Error('Bundle tsconfig extends an unbundled config with inherited types; the exact deterministic Node types change cannot be independently established.');
  const effectiveTypes = Array.isArray(beforeTypes) ? beforeTypes : [];
  if (!effectiveTypes.every((item) => typeof item === 'string') || effectiveTypes.includes('node'))
    throw new Error('Bundle tsconfig has an invalid inherited Node types repair.');
  const expected = addNodeTypeToTsconfig(beforeText, effectiveTypes as string[]);
  if (expected !== afterText) throw new Error('Bundle tsconfig differs from the exact deterministic Node types repair.');
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A fenced block prevents GitHub from parsing mentions, autolinks, HTML or client Markdown. */
function quotedUntrustedReport(report: string): string {
  const safe = maskSecrets(sanitizeTerminalText(report)).replace(/&#(91|93|124|96|33);/g, (_entity, code: string) => String.fromCharCode(Number(code)));
  let longest = 0;
  for (const [run] of safe.matchAll(/~+/g)) longest = Math.max(longest, run.length);
  const fence = '~'.repeat(Math.max(4, longest + 1));
  return `${fence}report\n${safe}\n${fence}`;
}

function completeExcerpt(report: string): string {
  const lines = report.split('\n');
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^(`{3,})(?:[A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (marker) fence = fence ? undefined : marker[1];
  }
  return fence ? `${report}\n${fence}` : report;
}

export async function reconcileProposal(proposal: Proposal, publisher: ProposalPublisher, artifactUrl?: string): Promise<void> {
  if (proposal.status !== 'none' && await publisher.isDismissed?.(proposal)) return;
  const existing = await publisher.findPullRequest(proposal);
  const migration = migrations.find((candidate) => candidate.id === proposal.migration);
  if (!migration) throw new Error('Unknown migration.');
  const introduction = [
    ...(proposal.status === 'manual' ? [`<!-- upstreamfix:manual:${proposal.migration} -->`] : []),
    `UpstreamFix migration: \`${proposal.migration}\``,
    `Verification: **${proposal.verification}**`,
    `Official guide: ${migration.guideUrl}`,
    '', '<details><summary>Migration report (untrusted project output)</summary>', '',
  ].join('\n');
  const conclusion = '\n\n</details>\n\nReview the diff and run your repository checks before merging. UpstreamFix never merges automatically.';
  const truncatedNote = `\n\n> Report truncated to fit GitHub's body limit. Full report: ${artifactUrl ?? 'upstreamfix-proposals artifact in this workflow run'}`;
  const safeReport = sanitizeTerminalText(proposal.report);
  const makeBody = (excerpt: string, truncated: boolean) => `${introduction}\n${quotedUntrustedReport(truncated ? completeExcerpt(excerpt) : excerpt)}${truncated ? truncatedNote : ''}${conclusion}`;
  let body = makeBody(safeReport, false);
  if (body.length > 59_000) {
    let lower = 0;
    let upper = safeReport.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      const candidate = safeReport.slice(0, middle).replace(/[\uD800-\uDBFF]$/, '');
      if (makeBody(candidate, true).length <= 59_000) lower = middle;
      else upper = middle - 1;
    }
    let excerpt = safeReport.slice(0, lower).replace(/[\uD800-\uDBFF]$/, '');
    const lastLine = excerpt.lastIndexOf('\n');
    if (lastLine > excerpt.length - 2_000) excerpt = excerpt.slice(0, lastLine);
    body = makeBody(excerpt, true);
  }
  if (proposal.status === 'ready') {
    await publisher.pushBranch(proposal);
    if (existing) await publisher.updatePullRequest(existing, body, proposal);
    else await publisher.openPullRequest(body, proposal);
    await publisher.closeIssue(proposal);
  } else if (proposal.status === 'manual') {
    if (existing) await publisher.closePullRequest(existing);
    await publisher.upsertIssue(body, proposal);
  } else {
    if (existing) await publisher.closePullRequest(existing);
    await publisher.closeIssue(proposal);
  }
}
