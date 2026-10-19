import { describe, expect, it, vi } from 'vitest';
import { validateProposal, reconcileProposal, parseSafeRawDiff, parseCommitParents, findManagedIssue, type Proposal, type ProposalPublisher } from '../src/action/publish.js';

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const proposal: Proposal = {
  schema: 1, migration: 'firebase-admin@14', status: 'ready', base, branch: 'upstreamfix/firebase-admin-14',
  commit, files: ['package.json', 'server.ts'], verification: 'passed', report: '# Safe report',
  reviewers: ['ivanDev237'], labels: ['dependencies'],
};

describe('Action publication boundary', () => {
  it('finds only bot-authored manual issues with the exact hidden marker', () => {
    const human = { number: 1, title: 'UpstreamFix: manual firebase-admin@14', body: '<!-- upstreamfix:manual:firebase-admin@14 -->', user: { login: 'person' } };
    const bot = { number: 102, title: human.title, body: human.body, user: { login: 'github-actions[bot]' } };
    expect(findManagedIssue([human, bot], 'firebase-admin@14')?.number).toBe(102);
    expect(findManagedIssue([human], 'firebase-admin@14')).toBeUndefined();
  });
  it('does not treat a commit message containing parent metadata as a real parent', () => {
    expect(() => parseCommitParents(`${commit}\nparent ${base}\n`, commit)).toThrow('malformed');
    expect(parseCommitParents(commit, commit)).toEqual([]);
    expect(parseCommitParents(`${commit} ${base}`, commit)).toEqual([base]);
  });
  it('rejects deletions, symlinks, submodules and rename source deletions in raw bundle diffs', () => {
    expect(parseSafeRawDiff(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0server.ts\0`)).toEqual(['server.ts']);
    expect(() => parseSafeRawDiff(`:100644 000000 ${'a'.repeat(40)} ${'0'.repeat(40)} D\0.github/CODEOWNERS\0:000000 100644 ${'0'.repeat(40)} ${'b'.repeat(40)} A\0owners.json\0`)).toThrow('status');
    expect(() => parseSafeRawDiff(`:000000 120000 ${'0'.repeat(40)} ${'b'.repeat(40)} A\0server.ts\0`)).toThrow('mode');
    expect(() => parseSafeRawDiff(`:000000 160000 ${'0'.repeat(40)} ${'b'.repeat(40)} A\0server.ts\0`)).toThrow('mode');
  });
  it('bounds a large report so GitHub accepts the PR body and points to the artifact', async () => {
    const publisher: ProposalPublisher = {
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
      findPullRequest: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, report: 'x'.repeat(100_000) }, publisher);
    const body = vi.mocked(publisher.openPullRequest).mock.calls[0]?.[0] ?? '';
    expect(body.length).toBeLessThan(60_000);
    expect(body).toContain('artifact');
  });
  it('refuses an unexpected base, branch, parent or changed path', () => {
    expect(() => validateProposal(proposal, base, [base], ['package.json', 'server.ts'])).not.toThrow();
    expect(() => validateProposal(proposal, 'c'.repeat(40), [base], proposal.files)).toThrow('base');
    expect(() => validateProposal(proposal, base, [base, base], proposal.files)).toThrow('parent');
    expect(() => validateProposal(proposal, base, [base], ['.github/workflows/ci.yml', ...proposal.files])).toThrow('files');
    expect(() => validateProposal({ ...proposal, branch: 'main' }, base, [base], proposal.files)).toThrow('branch');
  });

  it('refuses artifact reviewers and labels not present in the reviewed base config', () => {
    expect(() => validateProposal({ ...proposal, labels: ['automerge'] }, base, [base], proposal.files, { reviewers: ['ivanDev237'], labels: ['dependencies'] })).toThrow('labels');
    expect(() => validateProposal({ ...proposal, reviewers: ['attacker'] }, base, [base], proposal.files, { reviewers: ['ivanDev237'], labels: ['dependencies'] })).toThrow('reviewers');
  });

  it('opens, updates and closes a PR as the migration changes', async () => {
    const publisher: ProposalPublisher = {
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
      findPullRequest: vi.fn(async () => undefined),
    };
    await reconcileProposal(proposal, publisher);
    expect(publisher.pushBranch).toHaveBeenCalledTimes(1);
    expect(publisher.openPullRequest).toHaveBeenCalledTimes(1);
    publisher.findPullRequest = vi.fn(async () => 42);
    await reconcileProposal(proposal, publisher);
    expect(publisher.updatePullRequest).toHaveBeenCalledWith(42, expect.stringContaining('# Safe report'), proposal);
    await reconcileProposal({ ...proposal, status: 'none', commit: undefined, files: [] }, publisher);
    expect(publisher.closePullRequest).toHaveBeenCalledWith(42);
  });

  it('respects a PR closed by a human and does not push or recreate its branch', async () => {
    const publisher: ProposalPublisher = {
      isDismissed: vi.fn(async () => true),
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
      findPullRequest: vi.fn(async () => undefined),
    };
    await reconcileProposal(proposal, publisher);
    expect(publisher.pushBranch).not.toHaveBeenCalled();
    expect(publisher.openPullRequest).not.toHaveBeenCalled();
  });

  it('opens one issue instead of a PR when manual work remains', async () => {
    const publisher: ProposalPublisher = {
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
      findPullRequest: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, status: 'manual', commit: undefined, files: [], verification: 'skipped' }, publisher);
    expect(publisher.upsertIssue).toHaveBeenCalledTimes(1);
    expect(publisher.pushBranch).not.toHaveBeenCalled();
    expect(publisher.openPullRequest).not.toHaveBeenCalled();
  });
});
