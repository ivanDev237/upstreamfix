#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { reconcileProposal, validateProposal, validateProposalEnvelope, validatePublishableBundle, parseExactRemoteHead, parseSafeRawDiff, parseCommitParents, findManagedIssue, findManagedIssuePaginated, isDismissedClosure, isDismissedManualIssueForProposal, type Proposal, type ProposalPublisher } from './publish.js';
import { parseActionConfig } from './config.js';
import { sanitizeTerminalText } from '../core/report.js';

const execFile = promisify(execFileCallback);
const token = process.env.GITHUB_TOKEN;
const repository = process.env.UPSTREAMFIX_REPOSITORY;
const artifactRoot = process.env.UPSTREAMFIX_INPUT_ROOT;
const expectedBase = process.env.UPSTREAMFIX_BASE_SHA;
const clientCiWorkflow = process.env.UPSTREAMFIX_CLIENT_CI_WORKFLOW?.trim();
if (!token || !repository || !artifactRoot || !expectedBase) throw new Error('Missing trusted publication environment.');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(expectedBase)) throw new Error('Invalid repository or base commit.');
if (clientCiWorkflow && !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(clientCiWorkflow)) throw new Error('Invalid client CI workflow filename.');
const [owner] = repository.split('/');
const apiRoot = `https://api.github.com/repos/${repository}`;
const gitUrl = `https://github.com/${repository}.git`;
const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
};

async function request<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${apiRoot}${suffix}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${suffix} failed with HTTP ${response.status}.`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function dispatchClientChecks(branch: string): Promise<void> {
  if (!clientCiWorkflow) return;
  try {
    await request(`/actions/workflows/${encodeURIComponent(clientCiWorkflow)}/dispatches`, 'POST', { ref: branch });
  } catch (error) {
    console.warn(`Migration PR exists, but client CI dispatch failed: ${String(error)}`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', [
    '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', ...args,
  ], { cwd, env: gitEnv, timeout: 45_000, maxBuffer: 9 * 1024 * 1024 });
  return stdout;
}

const repoInfo = await request<{ default_branch: string }>('', 'GET');
if (!/^[A-Za-z0-9._/-]+$/.test(repoInfo.default_branch) || repoInfo.default_branch.includes('..')) throw new Error('Invalid default branch.');
const defaultBranch = repoInfo.default_branch;
const headRef = await request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
if (headRef.object.sha !== expectedBase) throw new Error('The default branch changed during migration; retry on its new head.');
const configResponse = await fetch(`${apiRoot}/contents/.upstreamfix.yml?ref=${expectedBase}`, {
  headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
});
if (!configResponse.ok && configResponse.status !== 404) throw new Error(`Could not read reviewed .upstreamfix.yml: HTTP ${configResponse.status}.`);
const configObject = configResponse.ok ? await configResponse.json() as { type?: string; encoding?: string; content?: string } : undefined;
if (configObject && (configObject.type !== 'file' || configObject.encoding !== 'base64' || !configObject.content)) throw new Error('Reviewed .upstreamfix.yml is not a regular base64 file.');
const reviewedConfig = parseActionConfig(configObject ? Buffer.from(configObject.content!, 'base64').toString('utf8') : '');
const proposals = JSON.parse(await readFile(path.join(artifactRoot, 'proposals.json'), 'utf8')) as Proposal[];
if (!Array.isArray(proposals) || proposals.length > 50) throw new Error('Invalid proposal artifact.');

async function findPullRequest(proposal: Proposal): Promise<number | undefined> {
  const pulls = await request<Array<{ number: number }>>(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${proposal.branch}`)}&base=${encodeURIComponent(defaultBranch)}`);
  return pulls[0]?.number;
}

async function closureEvents(number: number): Promise<Array<{ event?: string; actor?: { login?: string } }>> {
  const events: Array<{ event?: string; actor?: { login?: string } }> = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await request<typeof events>(`/issues/${number}/events?per_page=100&page=${page}`);
    events.push(...batch);
    if (batch.length < 100) break;
  }
  return events;
}

async function hasDismissedPullRequest(proposal: Proposal): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const pulls = await request<Array<{ number: number; state?: string; merged_at?: string | null; labels?: Array<{ name?: string }> }>>(
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${proposal.branch}`)}&base=${encodeURIComponent(defaultBranch)}&per_page=100&page=${page}`);
    for (const pull of pulls) if (isDismissedClosure(pull, pull.state === 'closed' ? await closureEvents(pull.number) : [])) return true;
    if (pulls.length < 100) break;
  }
  return false;
}

async function findIssue(proposal: Proposal, state = 'open'): Promise<number | undefined> {
  const managed = await findManagedIssuePaginated(async (page) =>
    await request<Array<{ number: number; title: string; body?: string | null; state?: string; user?: { login?: string }; pull_request?: unknown; labels?: Array<{ name?: string }> }>>(`/issues?state=${state}&per_page=100&page=${page}`), proposal.migration);
  return managed?.number;
}

async function hasDismissedIssue(proposal: Proposal): Promise<boolean> {
  for (let page = 1; page <= 1000; page++) {
    const issues = await request<Array<{ number: number; title: string; body?: string | null; state?: string; user?: { login?: string }; pull_request?: unknown; labels?: Array<{ name?: string }> }>>(`/issues?state=all&per_page=100&page=${page}`);
    for (const issue of issues) {
      if (!findManagedIssue([issue], proposal.migration)) continue;
      if (isDismissedManualIssueForProposal(issue, issue.state === 'closed' ? await closureEvents(issue.number) : [], proposal.status)) return true;
    }
    if (issues.length < 100) break;
  }
  return false;
}

for (const proposal of proposals) {
  let bareRoot: string | undefined;
  let pushed = false;
  try {
    validateProposalEnvelope(proposal, expectedBase, reviewedConfig);
    let parents: string[] = [];
    let changedFiles: string[] = [];
    if (proposal.status === 'ready') {
      bareRoot = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-publish-'));
      await git(bareRoot, ['init', '--bare', '-q']);
      await git(bareRoot, ['fetch', '--no-tags', gitUrl, expectedBase]);
      const bundle = path.join(artifactRoot, `${proposal.migration.replace(/[^A-Za-z0-9._-]+/g, '-')}.bundle`);
      await git(bareRoot, ['bundle', 'verify', bundle]);
      await git(bareRoot, ['fetch', '--no-tags', bundle, proposal.branch]);
      if ((await git(bareRoot, ['cat-file', '-t', proposal.commit!])).trim() !== 'commit') throw new Error('Bundle target is not a commit.');
      parents = parseCommitParents(await git(bareRoot, ['rev-list', '--parents', '-n1', '--end-of-options', proposal.commit!]), proposal.commit!);
      changedFiles = parseSafeRawDiff(await git(bareRoot, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', expectedBase, proposal.commit!]));
    }
    validateProposal(proposal, expectedBase, parents, changedFiles, reviewedConfig);
    if (proposal.status === 'ready') {
      const identityFields = (await git(bareRoot!, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%s', proposal.commit!])).trimEnd().split('\0');
      if (identityFields.length !== 5) throw new Error('Bundle commit identity is malformed.');
      const blobs: Record<string, { before?: string; after: string }> = Object.create(null);
      for (const file of proposal.files) {
        blobs[file] = {
          before: await git(bareRoot!, ['show', `${expectedBase}:${file}`]),
          after: await git(bareRoot!, ['show', `${proposal.commit!}:${file}`]),
        };
      }
      validatePublishableBundle(proposal, blobs, {
        author: identityFields[0]!, authorEmail: identityFields[1]!, committer: identityFields[2]!,
        committerEmail: identityFields[3]!, subject: identityFields[4]!,
      });
    }
    const publisher: ProposalPublisher = {
      isDismissed: async (item) => await hasDismissedPullRequest(item) || await hasDismissedIssue(item),
      findPullRequest,
      pushBranch: async (item) => {
        if (!bareRoot || !item.commit) throw new Error('Verified bundle is required before pushing.');
        const remote = await git(bareRoot, ['ls-remote', '--refs', gitUrl, `refs/heads/${item.branch}`]);
        const previous = parseExactRemoteHead(remote, item.branch);
        if (previous) {
          await git(bareRoot, ['fetch', '--no-tags', gitUrl, previous]);
          const oldTree = (await git(bareRoot, ['rev-parse', `${previous}^{tree}`])).trim();
          const newTree = (await git(bareRoot, ['rev-parse', `${item.commit}^{tree}`])).trim();
          if (oldTree === newTree) return;
          const previousCommit = (await git(bareRoot, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%s%n%P', previous])).trim().split('\n');
          const bot = 'upstreamfix[bot]';
          const botEmail = '41898282+github-actions[bot]@users.noreply.github.com';
          if (previousCommit[0] !== bot || previousCommit[1] !== botEmail || previousCommit[2] !== bot
            || previousCommit[3] !== botEmail || previousCommit[4] !== `Apply ${item.migration} migration with UpstreamFix`
            || !/^[0-9a-f]{40}$/.test(previousCommit[5] ?? '')) {
            throw new Error('Existing migration branch contains a non-bot commit; refusing to overwrite human work.');
          }
        }
        await git(bareRoot, [
          'push', `--force-with-lease=refs/heads/${item.branch}:${previous}`,
          gitUrl, `${item.commit}:refs/heads/${item.branch}`,
        ]);
        pushed = true;
      },
      openPullRequest: async (body, item) => {
        const opened = await request<{ number: number }>('/pulls', 'POST', {
          title: `UpstreamFix: migrate ${item.migration}`, head: item.branch,
          base: defaultBranch, body,
        });
        if (item.reviewers.length) {
          try { await request(`/pulls/${opened.number}/requested_reviewers`, 'POST', { reviewers: item.reviewers }); }
          catch (error) { console.warn(`PR ${opened.number} was created, but reviewer assignment failed: ${String(error)}`); }
        }
        if (item.labels.length) {
          try { await request(`/issues/${opened.number}/labels`, 'POST', { labels: item.labels }); }
          catch (error) { console.warn(`PR ${opened.number} was created, but label assignment failed: ${sanitizeTerminalText(String(error))}`); }
        }
        await dispatchClientChecks(item.branch);
      },
      updatePullRequest: async (number, body, item) => {
        await request(`/pulls/${number}`, 'PATCH', { body, title: `UpstreamFix: migrate ${item.migration}` });
        if (pushed) await dispatchClientChecks(item.branch);
      },
      closePullRequest: async (number) => { await request(`/pulls/${number}`, 'PATCH', { state: 'closed' }); },
      upsertIssue: async (body, item) => {
        const existing = await findIssue(item);
        if (existing) await request(`/issues/${existing}`, 'PATCH', { body });
        else await request('/issues', 'POST', { title: `UpstreamFix: manual ${item.migration}`, body, labels: item.labels });
      },
      closeIssue: async (item) => {
        const existing = await findIssue(item);
        if (existing) await request(`/issues/${existing}`, 'PATCH', { state: 'closed' });
      },
    };
    const artifactUrl = process.env.GITHUB_RUN_ID && /^\d+$/.test(process.env.GITHUB_RUN_ID)
      ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}#artifacts` : undefined;
    await reconcileProposal(proposal, publisher, artifactUrl);
  } catch (error) {
    console.error(`Publication of ${sanitizeTerminalText(String(proposal.migration))} failed: ${sanitizeTerminalText(String(error))}`);
    process.exitCode = 1;
  } finally {
    if (bareRoot) await rm(bareRoot, { recursive: true, force: true });
  }
}
