#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { reconcileProposal, validateProposal, parseSafeRawDiff, type Proposal, type ProposalPublisher } from './publish.js';
import { parseActionConfig } from './config.js';

const execFile = promisify(execFileCallback);
const token = process.env.GITHUB_TOKEN;
const repository = process.env.UPSTREAMFIX_REPOSITORY;
const artifactRoot = process.env.UPSTREAMFIX_INPUT_ROOT;
const expectedBase = process.env.UPSTREAMFIX_BASE_SHA;
if (!token || !repository || !artifactRoot || !expectedBase) throw new Error('Missing trusted publication environment.');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(expectedBase)) throw new Error('Invalid repository or base commit.');
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
  return await response.json() as T;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', [
    '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', ...args,
  ], { cwd, env: gitEnv, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
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

async function findIssue(proposal: Proposal): Promise<number | undefined> {
  const title = `UpstreamFix: manual ${proposal.migration}`;
  const issues = await request<Array<{ number: number; title: string; pull_request?: unknown }>>('/issues?state=open&per_page=100');
  return issues.find((item) => !item.pull_request && item.title === title)?.number;
}

for (const proposal of proposals) {
  let bareRoot: string | undefined;
  try {
    let parents: string[] = [];
    let changedFiles: string[] = [];
    if (proposal.status === 'ready') {
      bareRoot = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-publish-'));
      await git(bareRoot, ['init', '--bare', '-q']);
      await git(bareRoot, ['fetch', '--no-tags', gitUrl, expectedBase]);
      const bundle = path.join(artifactRoot, `${proposal.migration.replace(/[^A-Za-z0-9._-]+/g, '-')}.bundle`);
      await git(bareRoot, ['bundle', 'verify', bundle]);
      await git(bareRoot, ['fetch', '--no-tags', bundle, proposal.branch]);
      const commitInfo = await git(bareRoot, ['cat-file', '-p', proposal.commit!]);
      parents = [...commitInfo.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]!);
      changedFiles = parseSafeRawDiff(await git(bareRoot, ['diff', '--raw', '--no-renames', '-z', expectedBase, proposal.commit!]));
    }
    validateProposal(proposal, expectedBase, parents, changedFiles, reviewedConfig);
    const publisher: ProposalPublisher = {
      findPullRequest,
      pushBranch: async (item) => {
        if (!bareRoot || !item.commit) throw new Error('Verified bundle is required before pushing.');
        const remote = await git(bareRoot, ['ls-remote', gitUrl, `refs/heads/${item.branch}`]);
        const previous = remote.split('\t')[0]?.trim() ?? '';
        if (previous && !/^[0-9a-f]{40}$/.test(previous)) throw new Error('Invalid existing branch SHA.');
        await git(bareRoot, [
          'push', `--force-with-lease=refs/heads/${item.branch}:${previous}`,
          gitUrl, `${item.commit}:refs/heads/${item.branch}`,
        ]);
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
        if (item.labels.length) await request(`/issues/${opened.number}/labels`, 'POST', { labels: item.labels });
      },
      updatePullRequest: async (number, body, item) => {
        await request(`/pulls/${number}`, 'PATCH', { body, title: `UpstreamFix: migrate ${item.migration}` });
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
    console.error(`Publication of ${String(proposal.migration)} failed: ${String(error)}`);
    process.exitCode = 1;
  } finally {
    if (bareRoot) await rm(bareRoot, { recursive: true, force: true });
  }
}
