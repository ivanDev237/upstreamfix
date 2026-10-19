import { maskSecrets } from '../core/report.js';
import { migrations } from '../migrations/index.js';

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

/** Metadata is untrusted until a separate Git bundle inspection confirms it. */
export function validateProposal(proposal: Proposal, expectedBase: string, parents: string[], changedFiles: string[]): void {
  if (proposal.schema !== 1 || !migrations.some((migration) => migration.id === proposal.migration)) throw new Error('Unknown proposal schema or migration.');
  if (!sha.test(proposal.base) || proposal.base !== expectedBase) throw new Error('Proposal base does not match the reviewed default-branch commit.');
  const expectedBranch = `upstreamfix/${proposal.migration.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  if (proposal.branch !== expectedBranch) throw new Error('Proposal branch is outside the approved upstreamfix namespace.');
  if (!['ready', 'manual', 'none'].includes(proposal.status) || !['passed', 'failed', 'skipped'].includes(proposal.verification)) throw new Error('Invalid proposal status.');
  if (proposal.report.length > 100_000 || proposal.reviewers.length > 20 || proposal.labels.length > 20) throw new Error('Proposal metadata exceeds its limits.');
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

export async function reconcileProposal(proposal: Proposal, publisher: ProposalPublisher): Promise<void> {
  const existing = await publisher.findPullRequest(proposal);
  const migration = migrations.find((candidate) => candidate.id === proposal.migration);
  if (!migration) throw new Error('Unknown migration.');
  const body = maskSecrets([
    `UpstreamFix migration: \`${proposal.migration}\``,
    `Verification: **${proposal.verification}**`,
    `Official guide: ${migration.guideUrl}`,
    '', proposal.report,
    '', 'Review the diff and run your repository checks before merging. UpstreamFix never merges automatically.',
  ].join('\n'));
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
