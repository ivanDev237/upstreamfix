import { sanitizeTerminalText } from '../core/report.js';
import { migrations } from '../migrations/index.js';
import type { ActionConfig } from './config.js';
import { isDeepStrictEqual } from 'node:util';
import { Project } from 'ts-morph';

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
export function validatePublishableBundle(proposal: Proposal, blobs: Record<string, BundleBlob>, identity: CommitIdentity): void {
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
    else if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/.test(file)) validateNpmLockDelta(blob.before, blob.after, migration.packageName, migration.toMajor);
    else if (/(?:^|\/)pnpm-lock\.yaml$/.test(file)) validatePnpmLockDelta(blob.before, blob.after, migration.packageName, migration.toMajor);
    else if (/(?:^|\/)yarn\.lock$/.test(file)) validateYarnLockDelta(blob.before, blob.after, migration.packageName, migration.toMajor);
    else throw new Error('Bundle changes a file outside the deterministic migration output.');
  }
  if (sources.size) {
    const result = migration.transform(project);
    if (result.manual.length) throw new Error('Bundle migration still has manual source work.');
    const generated = new Map(result.fileUpdates?.map((update) => [update.file, update.contents]));
    for (const [file, blob] of sources) {
      if (generated.get(`/proposal/${file}`) !== blob.after) {
        throw new Error(`Bundle source ${file} differs from the deterministic migration output.`);
      }
    }
    if (generated.size !== sources.size) throw new Error('Bundle omits a deterministic migration source change.');
  }
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  if (contents.length > 8 * 1024 * 1024) throw new Error(`Bundle ${label} exceeds the validation size limit.`);
  try {
    const value: unknown = JSON.parse(contents);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fixed error below */ }
  throw new Error(`Bundle ${label} is invalid JSON.`);
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
  const beforeEngines = record(before.engines);
  const afterEngines = record(after.engines);
  if (beforeEngines?.node === undefined && typeof afterEngines?.node === 'string') {
    const required = packageName === 'firebase-admin' ? 22 : packageName === 'openai' ? 20 : undefined;
    if (!required || afterEngines.node !== `>=${required}`) throw new Error('Bundle package.json adds an unexpected Node.js requirement.');
    if (beforeEngines) delete record(normalized.engines)!.node;
    else delete normalized.engines;
  }
  if (!isDeepStrictEqual(normalized, before)) throw new Error('Bundle package.json changes fields beyond the SDK version or approved Node.js requirement.');
}

function validateNpmLockDelta(beforeText: string, afterText: string, packageName: string, targetMajor: number): void {
  const before = parseJsonObject(beforeText, 'package-lock.json');
  const after = parseJsonObject(afterText, 'package-lock.json');
  const oldPackages = record(before.packages);
  const newPackages = record(after.packages);
  if (before.lockfileVersion !== 3 || after.lockfileVersion !== 3 || !oldPackages || !newPackages) throw new Error('Bundle lockfile format is unsupported.');
  const targetPath = `node_modules/${packageName}`;
  const target = record(newPackages[targetPath]);
  const version = typeof target?.version === 'string' ? target.version : '';
  const resolved = typeof target?.resolved === 'string' ? target.resolved : '';
  const exactUrl = registryTarballUrl(packageName, version);
  if (!new RegExp(`^${targetMajor}\\.\\d+\\.\\d+$`).test(version)
    || resolved !== exactUrl
    || target?.hasInstallScript === true || typeof target?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(target.integrity)) {
    throw new Error('Bundle lockfile target package is not a verified npm registry artifact.');
  }
  const oldTarget = record(oldPackages[targetPath]);
  const allowedTargetKeys = new Set(['version', 'resolved', 'integrity', 'license', 'engines', 'funding', 'deprecated', 'dev', 'devOptional', 'optional', 'peer', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'dependencies', 'bin']);
  for (const key of Object.keys(target!)) {
    if (!allowedTargetKeys.has(key) || (['bin', 'dependencies', 'optionalDependencies'].includes(key) && !Object.hasOwn(oldTarget ?? {}, key))) {
      throw new Error('Bundle lockfile target package adds an unexpected capability.');
    }
  }
  const oldRoot = record(oldPackages['']);
  const newRoot = record(newPackages['']);
  if (!oldRoot || !newRoot) throw new Error('Bundle lockfile root package is missing.');
  const normalizedRoot = structuredClone(newRoot);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const oldValue = record(oldRoot[section])?.[packageName];
    const newValue = record(newRoot[section])?.[packageName];
    if (oldValue !== newValue) {
      if (typeof oldValue !== 'string' || newValue !== `^${targetMajor}.0.0`) throw new Error('Bundle lockfile changes an unexpected SDK dependency.');
      record(normalizedRoot[section])![packageName] = oldValue;
    }
  }
  if (!isDeepStrictEqual(normalizedRoot, oldRoot)) throw new Error('Bundle lockfile changes unexpected root fields.');
  const beforeTop = structuredClone(before);
  const afterTop = structuredClone(after);
  delete beforeTop.packages;
  delete afterTop.packages;
  if (!isDeepStrictEqual(beforeTop, afterTop)) throw new Error('Bundle lockfile changes unexpected metadata.');
  const aliasTargets = npmAliasTargets(newPackages);
  for (const [packagePath, value] of Object.entries(newPackages)) {
    if (packagePath === '' || isDeepStrictEqual(value, oldPackages[packagePath])) continue;
    const packageEntry = record(value);
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(packagePath);
    const actualName = match?.[1];
    if (!packageEntry || !actualName || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(actualName)) {
      throw new Error('Bundle lockfile contains an unsupported package path.');
    }
    const itemVersion = packageEntry.version;
    const resolvedName = npmAliasTarget(actualName, packageEntry.resolved, aliasTargets, itemVersion);
    if (typeof itemVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(itemVersion)
      || !resolvedName || packageEntry.resolved !== registryTarballUrl(resolvedName, itemVersion)
      || typeof packageEntry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(packageEntry.integrity)
      || packageEntry.hasInstallScript === true || Object.hasOwn(packageEntry, 'scripts')) {
      throw new Error('Bundle lockfile contains an unverified npm registry package.');
    }
    if (Object.hasOwn(packageEntry, 'name') && (resolvedName === actualName || packageEntry.name !== resolvedName)) {
      throw new Error('Bundle lockfile contains an invalid npm alias name.');
    }
    const oldEntry = record(oldPackages[packagePath]);
    for (const [key] of Object.entries(packageEntry)) {
      if (!allowedTargetKeys.has(key) && !['cpu', 'os', 'libc', 'funding', 'deprecated', 'name'].includes(key)) {
        throw new Error('Bundle lockfile contains an unexpected package capability.');
      }
      if (key === 'bin' && !Object.hasOwn(oldEntry ?? {}, key)) {
        // npm may add a genuine new transitive package with a binary. Never
        // allow an existing package's binary map to change through the bundle.
        if (oldEntry || packagePath === targetPath || !safeNpmBin(packageEntry.bin)) {
          throw new Error('Bundle lockfile adds an unexpected executable package binary.');
        }
      }
    }
  }
}

function registryTarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}

function npmAliasTargets(packages: Record<string, unknown>): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const value of Object.values(packages)) {
    const entry = record(value);
    if (!entry) continue;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [alias, spec] of Object.entries(record(entry[section]) ?? {})) {
        const match = typeof spec === 'string' ? /^npm:((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@[^\s]+$/.exec(spec) : null;
        if (!match) continue;
        const targets = aliases.get(alias) ?? new Set<string>();
        targets.add(match[1]!);
        aliases.set(alias, targets);
      }
    }
  }
  return aliases;
}

function npmAliasTarget(alias: string, resolved: unknown, aliases: Map<string, Set<string>>, version: unknown): string | undefined {
  if (typeof version !== 'string' || typeof resolved !== 'string') return undefined;
  if (resolved === registryTarballUrl(alias, version)) return alias;
  const names = aliases.get(alias);
  if (!names) return undefined;
  if (names.size !== 1) return undefined;
  const name = [...names][0]!;
  return resolved === registryTarballUrl(name, version) ? name : undefined;
}

function safeNpmBin(value: unknown): boolean {
  const bins = record(value);
  if (!bins || !Object.keys(bins).length || Object.keys(bins).length > 20) return false;
  return Object.entries(bins).every(([name, location]) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    && typeof location === 'string' && location.length <= 200
    && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(location)
    && !location.split('/').some((part) => part === '.' || part === '..'));
}

function boundedLockfile(text: string): void {
  if (text.length > 8 * 1024 * 1024 || /[\0\r]/.test(text)) throw new Error('Bundle lockfile is malformed or too large.');
}

function lockSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = '';
  for (const line of text.split('\n')) {
    const top = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (top) {
      current = top[1]!;
      if (sections.has(current)) throw new Error('Bundle lockfile contains a duplicate YAML section.');
    }
    if (current) sections.set(current, `${sections.get(current) ?? ''}${line}\n`);
    else if (line.trim() && !line.trim().startsWith('#')) throw new Error('Bundle lockfile has an unsupported YAML structure.');
  }
  return sections;
}

function indentedEntries(section: string): Map<string, string> {
  const entries = new Map<string, string>();
  let key = '';
  for (const line of section.split('\n').slice(1)) {
    const head = /^  (['"]?)([^\s'"]+)\1:(?:\s.*)?$/.exec(line);
    if (head) {
      key = head[2]!;
      if (entries.has(key)) throw new Error('Bundle lockfile contains a duplicate package entry.');
    }
    if (key) entries.set(key, `${entries.get(key) ?? ''}${line}\n`);
    else if (line.trim()) throw new Error('Bundle lockfile has an unsupported package entry.');
  }
  return entries;
}

function packageFromPnpmKey(key: string): { name: string; version: string } {
  const match = /^((?:@[^/]+\/)?[^@]+)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\([^)]*\))?$/.exec(key);
  if (!match) throw new Error('Bundle lockfile has an unsupported pnpm package key.');
  return { name: match[1]!, version: match[2]! };
}

function validatePnpmLockDelta(beforeText: string, afterText: string, packageName: string, targetMajor: number): void {
  boundedLockfile(beforeText);
  boundedLockfile(afterText);
  const before = lockSections(beforeText);
  const after = lockSections(afterText);
  if (!before.has('packages') || !after.has('packages') || !before.has('importers') || !after.has('importers')) {
    throw new Error('Bundle pnpm lockfile has no packages or importers.');
  }
  if (before.get('lockfileVersion') !== after.get('lockfileVersion')) throw new Error('Bundle pnpm lockfile changes its format.');
  for (const [section, value] of after) {
    if (!['packages', 'snapshots', 'importers'].includes(section) && value !== before.get(section)) throw new Error('Bundle pnpm lockfile changes unsupported metadata.');
  }
  const oldImporters = before.get('importers')!;
  const newImporters = after.get('importers')!;
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetBlock = new RegExp(`(^[ ]{6}${escapedName}:\\n[ ]{8}specifier: )\\^${targetMajor}\\.0\\.0(\\n[ ]{8}version: )${targetMajor}[^\\n]*`, 'gm');
  const oldTargetBlock = new RegExp(`^[ ]{6}${escapedName}:\\n[ ]{8}specifier: [^\\n]+\\n[ ]{8}version: [^\\n]+`, 'gm');
  const oldMatches = [...oldImporters.matchAll(oldTargetBlock)].map((match) => match[0]);
  let index = 0;
  const normalizedImporters = newImporters.replace(targetBlock, () => oldMatches[index++] ?? '');
  if (!index || index !== oldMatches.length || normalizedImporters !== oldImporters) throw new Error('Bundle pnpm lockfile changes unapproved importers.');
  const oldPackages = indentedEntries(before.get('packages')!);
  const newPackages = indentedEntries(after.get('packages')!);
  let targetSeen = false;
  for (const [key, block] of newPackages) {
    const { name, version } = packageFromPnpmKey(key);
    if (name === packageName && version.startsWith(`${targetMajor}.`)) targetSeen = true;
    if (block === oldPackages.get(key)) continue;
    if (!/\bintegrity: sha512-[A-Za-z0-9+/=]+/.test(block) || /\b(?:scripts|hasInstallScript|requiresBuild|hasBin):/.test(block)) {
      throw new Error('Bundle pnpm lockfile contains an unverified package.');
    }
    const tarball = /\btarball:\s*['"]?([^\s,'"}]+)/.exec(block)?.[1];
    if (tarball && tarball !== registryTarballUrl(name, version)) throw new Error('Bundle pnpm lockfile contains a foreign registry tarball.');
    if (/^    (?!resolution:|id:|engines:|peerDependencies:|peerDependenciesMeta:|dependencies:|optionalDependencies:|deprecated:|cpu:|os:|libc:|dev:|optional:)[A-Za-z][^\n]*:/m.test(block)) {
      throw new Error('Bundle pnpm lockfile contains an unexpected package field.');
    }
  }
  if (!targetSeen) throw new Error('Bundle pnpm lockfile does not contain the target SDK.');
  const newSnapshots = indentedEntries(after.get('snapshots') ?? 'snapshots:\n');
  for (const [key, block] of newSnapshots) {
    const { name, version } = packageFromPnpmKey(key);
    if (!newPackages.has(`${name}@${version}`) && !newPackages.has(key)) throw new Error('Bundle pnpm lockfile snapshot has no verified package.');
    if (/\b(?:tarball|scripts|hasInstallScript|requiresBuild|hasBin):/.test(block)
      || /^    (?!dependencies:|optionalDependencies:|transitivePeerDependencies:|peerDependencies:)[A-Za-z][^\n]*:/m.test(block)) {
      throw new Error('Bundle pnpm lockfile snapshot contains an unexpected field.');
    }
  }
}

function validateYarnLockDelta(beforeText: string, afterText: string, packageName: string, targetMajor: number): void {
  boundedLockfile(beforeText);
  boundedLockfile(afterText);
  const parse = (text: string): Map<string, string> => {
    const blocks = new Map<string, string>();
    let key = '';
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      if (!/^\s/.test(line)) {
        if (!line.endsWith(':') || line.startsWith('__metadata')) throw new Error('Bundle Yarn lockfile format is unsupported.');
        key = line.slice(0, -1);
        if (blocks.has(key)) throw new Error('Bundle Yarn lockfile contains a duplicate package entry.');
      } else if (!key) throw new Error('Bundle Yarn lockfile has an unexpected entry.');
      blocks.set(key, `${blocks.get(key) ?? ''}${line}\n`);
    }
    return blocks;
  };
  const oldBlocks = parse(beforeText);
  const newBlocks = parse(afterText);
  let targetSeen = false;
  for (const [key, block] of newBlocks) {
    const selectors = key.split(/,\s*/).map((selector) => selector.replace(/^"|"$/g, ''));
    const names = selectors.map((selector) => /^(@[^/]+\/[^@]+|[^@]+)@/.exec(selector)?.[1]);
    const name = names[0];
    if (!name || names.some((candidate) => candidate !== name)) throw new Error('Bundle Yarn lockfile mixes package names in an entry.');
    if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) throw new Error('Bundle Yarn lockfile has an invalid package name.');
    const version = /^  version "(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)"$/m.exec(block)?.[1];
    if (!version) throw new Error('Bundle Yarn lockfile package lacks a valid version.');
    if (name === packageName && version.startsWith(`${targetMajor}.`)) targetSeen = true;
    if (block === oldBlocks.get(key)) continue;
    const resolved = /^  resolved "([^"]+)"$/m.exec(block)?.[1];
    const canonical = registryTarballUrl(name, version);
    if (!resolved || (resolved !== canonical && !new RegExp(`^${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#[a-fA-F0-9]{40}$`).test(resolved))
      || !/^  integrity sha512-[A-Za-z0-9+/=]+$/m.test(block)
      || /^  (?:scripts|hasInstallScript|bin)\b/m.test(block)) {
      throw new Error('Bundle Yarn lockfile contains an unverified npm registry package.');
    }
  }
  if (!targetSeen) throw new Error('Bundle Yarn lockfile does not contain the target SDK.');
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The report is Markdown already. Escape HTML once, then keep it inside a quote. */
function quotedUntrustedReport(report: string): string {
  return sanitizeTerminalText(report)
    .replace(/&(?:amp|lt|gt|quot|#(?:\d+|x[0-9a-f]+));|https?:\/\/|www\.|GH-\d+|[&<>@!\[\]]|#(?=\d)/gi, (token) => {
      if (token.startsWith('&') && token.endsWith(';')) return token;
      if (/^https?:\/\//i.test(token)) return token.replace(':', '&#58;');
      if (/^www\./i.test(token)) return token.slice(0, -1) + '&#46;';
      if (/^GH-\d+$/i.test(token)) return token.replace('-', '&#45;');
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '@': '&#64;', '!': '&#33;', '[': '&#91;', ']': '&#93;', '#': '&#35;' } as Record<string, string>)[token] ?? token;
    })
    .split('\n').map((line) => `> ${line}`).join('\n');
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
