import { maskSecrets } from '../core/report.js';
import { migrations } from '../migrations/index.js';
import type { ActionConfig } from './config.js';

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
  findPullRequest(proposal: Proposal): Promise<number | undefined>;
  pushBranch(proposal: Proposal): Promise<void>;
  openPullRequest(body: string, proposal: Proposal): Promise<void>;
  updatePullRequest(number: number, body: string, proposal: Proposal): Promise<void>;
  closePullRequest(number: number): Promise<void>;
  upsertIssue(body: string, proposal: Proposal): Promise<void>;
  closeIssue(proposal: Proposal): Promise<void>;
}

const sha = /^[0-9a-f]{40}$/;
const safePath = /^(?:[A-Za-z0-9_.@()+ -]+\/)*[A-Za-z0-9_.@()+ -]+$/;

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
export function validateProposal(proposal: Proposal, expectedBase: string, parents: string[], changedFiles: string[], config?: Pick<ActionConfig, 'reviewers' | 'labels'>): void {
  if (proposal.schema !== 1 || !migrations.some((migration) => migration.id === proposal.migration)) throw new Error('Unknown proposal schema or migration.');
  if (!sha.test(proposal.base) || proposal.base !== expectedBase) throw new Error('Proposal base does not match the reviewed default-branch commit.');
  const expectedBranch = `upstreamfix/${proposal.migration.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  if (proposal.branch !== expectedBranch) throw new Error('Proposal branch is outside the approved upstreamfix namespace.');
  if (!['ready', 'manual', 'none'].includes(proposal.status) || !['passed', 'failed', 'skipped'].includes(proposal.verification)) throw new Error('Invalid proposal status.');
  if (proposal.report.length > 100_000 || proposal.reviewers.length > 20 || proposal.labels.length > 20) throw new Error('Proposal metadata exceeds its limits.');
  if (!proposal.reviewers.every((value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value))) throw new Error('Proposal reviewers are invalid.');
  if (!proposal.labels.every((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,49}$/.test(value) && !/(?:auto[ _.-]*merge|merge[ _.-]*queue|merge[ _.-]*when[ _.-]*ready)/i.test(value))) throw new Error('Proposal labels are invalid or enable automatic merge.');
  if (config && (!sameList(proposal.reviewers, config.reviewers) || !sameList(proposal.labels, config.labels))) {
    throw new Error('Proposal reviewers or labels differ from the reviewed base configuration.');
  }
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

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function reconcileProposal(proposal: Proposal, publisher: ProposalPublisher, artifactUrl?: string): Promise<void> {
  const existing = await publisher.findPullRequest(proposal);
  const migration = migrations.find((candidate) => candidate.id === proposal.migration);
  if (!migration) throw new Error('Unknown migration.');
  const fullBody = maskSecrets([
    `UpstreamFix migration: \`${proposal.migration}\``,
    `Verification: **${proposal.verification}**`,
    `Official guide: ${migration.guideUrl}`,
    '', proposal.report,
    '', 'Review the diff and run your repository checks before merging. UpstreamFix never merges automatically.',
  ].join('\n'));
  const suffix = `\n\nReport truncated to fit GitHub's body limit. Full report: ${artifactUrl ?? 'upstreamfix-proposals artifact in this workflow run'}`;
  const body = fullBody.length <= 59_000 ? fullBody : `${fullBody.slice(0, 59_000 - suffix.length)}${suffix}`;
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
