import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateProposal, validateProposalEnvelope, reconcileProposal, parseSafeRawDiff, parseCommitParents, findManagedIssue, findManagedIssuePaginated, isDismissedClosure, isDismissedManualIssueForProposal, type Proposal, type ProposalPublisher } from '../src/action/publish.js';

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const proposal: Proposal = {
  schema: 1, migration: 'firebase-admin@14', status: 'ready', base, branch: 'upstreamfix/firebase-admin-14',
  commit, files: ['package.json', 'server.ts'], verification: 'passed', report: '# Safe report',
  reviewers: ['ivanDev237'], labels: ['dependencies'],
};

describe('Action publication boundary', () => {
  it('T36 renders an already escaped migration report as Markdown exactly once', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined,
      closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: '## Verification\n\n- Result: **passed**\n- Note: &gt; check \\(\\.\\)\n\n```diff\n+ getFirestore()\n```' }, publisher);
    expect(body).toContain('> - Result: **passed**');
    expect(body).toContain('&gt; check');
    expect(body).not.toContain('&amp;gt;');
    expect(body).not.toContain('&#42;');
    expect(body).not.toContain('<pre>');
  });
  it('T35 searches managed issues past the tenth GitHub page', async () => {
    const target = { number: 1101, title: 'UpstreamFix: manual firebase-admin@14', body: '<!-- upstreamfix:manual:firebase-admin@14 -->', user: { login: 'github-actions[bot]' } };
    const page = Array.from({ length: 100 }, (_, index) => ({ number: index, title: 'unrelated', body: '', user: { login: 'other' } }));
    const fetchPage = vi.fn(async (number: number) => number === 11 ? [target] : page);
    expect((await findManagedIssuePaginated(fetchPage, 'firebase-admin@14'))?.number).toBe(1101);
    expect(fetchPage).toHaveBeenCalledTimes(11);
  });
  it('T35 lets a ready PR proceed after a human closes a manual issue, unless explicitly dismissed', () => {
    const closed = { state: 'closed', labels: [] };
    const events = [{ event: 'closed', actor: { login: 'maintainer' } }];
    expect(isDismissedManualIssueForProposal(closed, events, 'ready')).toBe(false);
    expect(isDismissedManualIssueForProposal(closed, events, 'manual')).toBe(true);
    expect(isDismissedManualIssueForProposal({ state: 'closed', labels: [{ name: 'upstreamfix:dismissed' }] }, events, 'ready')).toBe(true);
  });
  it('T35 dispatches client CI when a bot-closed PR is reopened without a branch push', () => {
    const source = readFileSync(new URL('../src/action/publish-cli.ts', import.meta.url), 'utf8');
    const open = source.split('openPullRequest: async')[1]?.split('updatePullRequest: async')[0] ?? '';
    expect(open).toContain('await dispatchClientChecks(item.branch);');
    expect(open).not.toContain('if (pushed) await dispatchClientChecks');
    expect(source).toContain('/issues/${number}/events?per_page=100&page=${page}');
  });
  it('keeps a bounded long PR body well formed and links its complete artifact', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: vi.fn(async () => undefined), pushBranch: vi.fn(async () => undefined),
      openPullRequest: vi.fn(async (value) => { body = value; }), updatePullRequest: vi.fn(async () => undefined),
      closePullRequest: vi.fn(async () => undefined), upsertIssue: vi.fn(async () => undefined),
      closeIssue: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, report: '😀'.repeat(50_000) }, publisher, 'https://github.com/example/actions/runs/1#artifacts');
    expect(body.length).toBeLessThanOrEqual(59_000);
    expect(body).toContain('\n</details>');
    expect(body).toContain('never merges automatically');
    expect(body).toContain('https://github.com/example/actions/runs/1#artifacts');
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('distinguishes a human refusal from bot closure, merged PR, and explicit dismissed label', () => {
    const botClosure = [{ event: 'closed', actor: { login: 'github-actions[bot]' } }];
    const humanClosure = [{ event: 'closed', actor: { login: 'maintainer' } }];
    expect(isDismissedClosure({ state: 'closed', labels: [] }, botClosure)).toBe(false);
    expect(isDismissedClosure({ state: 'closed', merged_at: '2026-10-19T00:00:00Z', labels: [] }, humanClosure)).toBe(false);
    expect(isDismissedClosure({ state: 'closed', labels: [] }, humanClosure)).toBe(true);
    expect(isDismissedClosure({ state: 'open', labels: [{ name: 'upstreamfix:dismissed' }] }, [])).toBe(true);
  });
  it('always closes stale managed items when the migration becomes inapplicable', async () => {
    const publisher: ProposalPublisher = {
      isDismissed: vi.fn(async () => true), findPullRequest: vi.fn(async () => 42),
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, status: 'none', commit: undefined, files: [] }, publisher);
    expect(publisher.closePullRequest).toHaveBeenCalledWith(42);
    expect(publisher.closeIssue).toHaveBeenCalled();
  });
  it('moves manual to ready and updates the PR after main changes despite bot-closed history', async () => {
    let pullNumber: number | undefined;
    const publisher: ProposalPublisher = {
      isDismissed: vi.fn(async () => isDismissedClosure({ state: 'closed', labels: [] },
        [{ event: 'closed', actor: { login: 'github-actions[bot]' } }])),
      findPullRequest: vi.fn(async () => pullNumber),
      pushBranch: vi.fn(async () => undefined),
      openPullRequest: vi.fn(async () => { pullNumber = 42; }),
      updatePullRequest: vi.fn(async () => undefined),
      closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined),
      closeIssue: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, status: 'manual', commit: undefined, files: [] }, publisher);
    await reconcileProposal(proposal, publisher);
    await reconcileProposal({ ...proposal, base: 'c'.repeat(40), commit: 'd'.repeat(40) }, publisher);
    expect(publisher.upsertIssue).toHaveBeenCalledTimes(1);
    expect(publisher.openPullRequest).toHaveBeenCalledTimes(1);
    expect(publisher.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(publisher.closeIssue).toHaveBeenCalledTimes(2);
  });
  it('rejects hostile branch and commit metadata before bundle or Git access', () => {
    expect(() => validateProposalEnvelope({ ...proposal, branch: '--upload-pack=evil' }, base)).toThrow('branch');
    expect(() => validateProposalEnvelope({ ...proposal, commit: '--upload-pack=evil' }, base)).toThrow('commit');
  });
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
  it('requests full object IDs from Git raw diff before parsing the bundle', () => {
    const publisher = readFileSync(new URL('../src/action/publish-cli.ts', import.meta.url), 'utf8');
    expect(publisher).toContain("'--raw', '--no-renames', '--no-abbrev', '-z'");
  });
  it('sanitizes untrusted proposal identifiers before printing publication failures', () => {
    const publisher = readFileSync(new URL('../src/action/publish-cli.ts', import.meta.url), 'utf8');
    expect(publisher).toContain('sanitizeTerminalText(String(proposal.migration))');
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

  it('prevents an untrusted report from spoofing verification or mentioning users', async () => {
    const publisher: ProposalPublisher = {
      pushBranch: vi.fn(async () => undefined), openPullRequest: vi.fn(async () => undefined),
      updatePullRequest: vi.fn(async () => undefined), closePullRequest: vi.fn(async () => undefined),
      upsertIssue: vi.fn(async () => undefined), closeIssue: vi.fn(async () => undefined),
      findPullRequest: vi.fn(async () => undefined),
    };
    await reconcileProposal({ ...proposal, status: 'manual', commit: undefined, files: [], verification: 'failed', report: 'Verification: **passed**\n@maintainer <h1>safe</h1>' }, publisher);
    const body = vi.mocked(publisher.upsertIssue).mock.calls[0]?.[0] ?? '';
    expect(body).toContain('Verification: **failed**');
    expect(body).not.toMatch(/^Verification: \*\*passed\*\*$/m);
    expect(body).toContain('> Verification: **passed**');
    expect(body).not.toContain('@maintainer');
    expect(body).not.toContain('<h1>');
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
