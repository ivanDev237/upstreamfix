#!/usr/bin/env node
import { execFile as callback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { githubReadApi, parseBotFollowupPayload, validateBotPullRequest,
  type BotFollowupArtifact } from './bot-followup.js';
import { parseCommitParents, parseExactRemoteHead, parseSafeRawDiff,
  validatePublishableBundle, type Proposal } from './publish.js';
import { sanitizeTerminalText } from '../core/report.js';

const execFile = promisify(callback);
const token = process.env.GITHUB_TOKEN ?? '';
const repository = process.env.GITHUB_REPOSITORY ?? '';
const input = process.env.UPSTREAMFIX_INPUT_ROOT ?? '';
const sha = /^[0-9a-f]{40}$/;
if (!token || !input || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Missing trusted publication context.');
const [owner] = repository.split('/');
const apiRoot = `https://api.github.com/repos/${repository}`;
const gitUrl = `https://github.com/${repository}.git`;
const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
};
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
    ...args], { cwd, env: gitEnv, timeout: 45_000, maxBuffer: 9 * 1024 * 1024 });
  return stdout;
}
async function api<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${apiRoot}${suffix}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`GitHub API ${method} ${suffix} failed with HTTP ${response.status}.`);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
function assertArtifact(value: unknown): asserts value is BotFollowupArtifact {
  const item = value as Partial<BotFollowupArtifact>;
  if (!item || item.schema !== 1 || !['ready', 'manual', 'none'].includes(item.status ?? '') ||
    item.repository !== repository || !Number.isSafeInteger(item.prNumber) || !sha.test(item.headSha ?? '') ||
    ![12, 13].includes(item.sourceMajor ?? 0) || typeof item.report !== 'string' || item.report.length > 100_000 ||
    !Array.isArray(item.files) || item.files.length > 100 ||
    item.branch !== `upstreamfix/firebase-admin-14-followup-${item.prNumber}` ||
    (item.status === 'ready' && (!sha.test(item.commit ?? '') || item.files.length === 0)) ||
    (item.status !== 'ready' && (item.commit || item.files.length))) throw new Error('Invalid follow-up artifact.');
}
const artifact: unknown = JSON.parse(await readFile(path.join(input, 'bot-followup.json'), 'utf8'));
assertArtifact(artifact);
const payload = parseBotFollowupPayload({ prNumber: artifact.prNumber, headSha: artifact.headSha,
  headRef: artifact.headRef, packageName: 'firebase-admin' });
const validated = await validateBotPullRequest(repository, payload, githubReadApi(repository, token));
if (validated.sourceMajor !== artifact.sourceMajor) throw new Error('Bot PR source major changed.');
const marker = `<!-- upstreamfix:bot-followup:${artifact.prNumber} -->`;
const pulls = await api<Array<{ number: number; state?: string; body?: string | null; user?: { login?: string }; head?: { ref?: string } }>>(
  `/pulls?state=all&head=${encodeURIComponent(`${owner}:${artifact.branch}`)}&base=${encodeURIComponent(validated.defaultBranch)}&per_page=100`);
const managed = pulls.filter((pull) => pull.body?.includes(marker) &&
  ['github-actions[bot]', 'upstreamfix[bot]'].includes(pull.user?.login ?? '') && pull.head?.ref === artifact.branch);
if (pulls.length && managed.length !== pulls.length) throw new Error('Follow-up branch belongs to an unrelated PR.');
const existing = managed.find((pull) => pull.state === 'open');
const closed = managed.filter((pull) => pull.state === 'closed').sort((left, right) => right.number - left.number)[0];
let reopenable: typeof closed | undefined = undefined;
if (!existing && closed) {
  const events: Array<{ event?: string; actor?: { login?: string } }> = [];
  let complete = false;
  for (let page = 1; page <= 20; page++) {
    const batch = await api<typeof events>(`/issues/${closed.number}/events?per_page=100&page=${page}`);
    events.push(...batch);
    if (batch.length < 100) { complete = true; break; }
  }
  if (!complete) throw new Error('Follow-up PR closure history exceeds the safety limit.');
  const lastClosure = [...events].reverse().find((event) => event.event === 'closed');
  if (['github-actions[bot]', 'upstreamfix[bot]'].includes(lastClosure?.actor?.login ?? '')) reopenable = closed;
  else throw new Error('The maintainer closed the follow-up PR; refusing to reopen it.');
}
let followupNumber = existing?.number ?? reopenable?.number;
const safeReport = sanitizeTerminalText(artifact.report);
const boundedReport = safeReport.length > 50_000
  ? `${safeReport.slice(0, 50_000)}\n\nReport truncated; inspect the workflow artifact for the complete findings.`
  : safeReport;
const body = `${marker}\n\nThis follows dependency update #${artifact.prNumber} at \`${artifact.headSha}\`.\n\n${boundedReport}`;

if (artifact.status === 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-bot-publish-'));
  try {
    await git(root, ['init', '--bare', '-q']);
    await git(root, ['fetch', '--no-tags', gitUrl, artifact.headSha]);
    const bundle = path.join(input, 'bot-followup.bundle');
    await git(root, ['bundle', 'verify', bundle]);
    await git(root, ['fetch', '--no-tags', bundle, artifact.branch]);
    const parents = parseCommitParents(await git(root, ['rev-list', '--parents', '-n1', artifact.commit!]), artifact.commit!);
    const changed = parseSafeRawDiff(await git(root, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z',
      artifact.headSha, artifact.commit!]));
    if (parents.length !== 1 || parents[0] !== artifact.headSha ||
      changed.length !== artifact.files.length || changed.some((file) => !artifact.files.includes(file)) ||
      changed.some((file) => !/^(?:[A-Za-z0-9_.@()+ -]+\/)*[A-Za-z0-9_.@()+ -]+$/.test(file) ||
        file.startsWith('.') || file.includes('/.') || file.includes('..') ||
        !/\.(?:[cm]?[jt]sx?)$/.test(file))) throw new Error('Bundle is not a source-only child of the current bot PR head.');
    const identity = (await git(root, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%s', artifact.commit!]))
      .trimEnd().split('\0');
    if (identity.length !== 5) throw new Error('Bundle commit identity is malformed.');
    const blobs: Record<string, { before: string; after: string }> = Object.create(null);
    for (const file of changed) blobs[file] = {
      before: await git(root, ['show', `${artifact.headSha}:${file}`]),
      after: await git(root, ['show', `${artifact.commit!}:${file}`]),
    };
    const proposal: Proposal = { schema: 1, migration: 'firebase-admin@14', status: 'ready',
      base: artifact.headSha, branch: artifact.branch, commit: artifact.commit, files: changed,
      verification: 'passed', report: artifact.report, reviewers: [], labels: [] };
    validatePublishableBundle(proposal, blobs, { author: identity[0]!, authorEmail: identity[1]!,
      committer: identity[2]!, committerEmail: identity[3]!, subject: identity[4]! });
    const remote = await git(root, ['ls-remote', '--refs', gitUrl, `refs/heads/${artifact.branch}`]);
    const previous = parseExactRemoteHead(remote, artifact.branch);
    if (previous) {
      await git(root, ['fetch', '--no-tags', gitUrl, previous]);
      const oldIdentity = (await git(root, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%s', previous]))
        .trimEnd().split('\0');
      if (oldIdentity.join('\0') !== identity.join('\0')) throw new Error('Existing follow-up branch contains a non-bot commit.');
      if (!existing && !reopenable) {
        // Recover a previous run that pushed but failed before creating the PR.
        const oldParents = parseCommitParents(await git(root, ['rev-list', '--parents', '-n1', previous]), previous);
        const oldTree = (await git(root, ['rev-parse', `${previous}^{tree}`])).trim();
        const newTree = (await git(root, ['rev-parse', `${artifact.commit}^{tree}`])).trim();
        if (oldParents.length !== 1 || oldParents[0] !== artifact.headSha || oldTree !== newTree) {
          throw new Error('Existing follow-up branch has no managed PR and does not match this verified run.');
        }
      }
    }
    // The bot can synchronize while the bundle is inspected. Recheck immediately before writing.
    await validateBotPullRequest(repository, payload, githubReadApi(repository, token));
    // Never push to the dependency bot branch. The lease protects concurrent human edits.
    await git(root, ['push', `--force-with-lease=refs/heads/${artifact.branch}:${previous}`, gitUrl,
      `${artifact.commit}:refs/heads/${artifact.branch}`]);
    if (existing) await api(`/pulls/${existing.number}`, 'PATCH', { body });
    else if (reopenable) await api(`/pulls/${reopenable.number}`, 'PATCH', { state: 'open', body });
    else {
      const created = await api<{ number: number }>('/pulls', 'POST', {
        title: 'UpstreamFix: fix firebase-admin 14 breaking calls', head: artifact.branch,
        base: validated.defaultBranch, body });
      followupNumber = created.number;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
} else if (existing) {
  await api(`/pulls/${existing.number}`, 'PATCH', { state: 'closed' });
}

// The marker is unique to the bot PR. Update the existing managed comment in place.
let comment: { id: number; body: string } | undefined;
let commentsExhausted = false;
for (let page = 1; page <= 100; page++) {
  const batch = await api<Array<{ id: number; body: string; user?: { login?: string } }>>(
    `/issues/${artifact.prNumber}/comments?per_page=100&page=${page}`);
  comment = batch.find((item) => item.body?.includes(marker) &&
    ['github-actions[bot]', 'upstreamfix[bot]'].includes(item.user?.login ?? ''));
  if (comment || batch.length < 100) { commentsExhausted = true; break; }
}
if (!commentsExhausted) throw new Error('Bot PR comment pagination exceeded the safety limit.');
const message = artifact.status === 'ready'
  ? `${marker}\n\nThis major update breaks the old firebase-admin namespace calls. A verified source fix is available in #${followupNumber}. Please review that PR instead of merging this dependency-only update.`
  : artifact.status === 'manual'
    ? `${marker}\n\nThe firebase-admin 14 update needs manual review.\n\n${boundedReport}`
    : `${marker}\n\nThe current bot PR no longer needs a source follow-up.`;
if (comment) {
  if (comment.body !== message) await api(`/issues/comments/${comment.id}`, 'PATCH', { body: message });
} else if (artifact.status !== 'none') await api(`/issues/${artifact.prNumber}/comments`, 'POST', { body: message });
