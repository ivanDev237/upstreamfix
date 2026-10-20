import { maskSecrets, sanitizeTerminalText } from '../core/report.js';
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
  const existing = new Set<string>();
  for (const [packagePath, entry] of Object.entries(oldPackages)) {
    for (const name of binaries(entry, packagePath)) existing.add(name);
  }
  const added = new Set<string>();
  for (const [packagePath, entry] of Object.entries(newPackages)) {
    const oldEntry = oldPackages[packagePath];
    if (oldEntry && !isDeepStrictEqual(record(oldEntry)?.bin, record(entry)?.bin)) {
      throw new Error('Bundle npm lockfile changes an existing executable package binary.');
    }
    if (oldEntry) continue;
    for (const name of binaries(entry, packagePath)) {
      if (dangerous.has(name.toLowerCase()) || existing.has(name) || added.has(name)) {
        throw new Error('Bundle npm lockfile adds an executable that shadows an existing command.');
      }
      added.add(name);
    }
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

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A fenced block prevents GitHub from parsing mentions, autolinks, HTML or client Markdown. */
function quotedUntrustedReport(report: string): string {
  const safe = maskSecrets(sanitizeTerminalText(report));
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
