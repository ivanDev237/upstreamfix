#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { githubReadApi, parseBotFollowupPayload, prepareBotFollowup, validateBotPullRequest,
  type ValidatedBotPull } from './bot-followup.js';

const repository = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? '';
const output = process.env.UPSTREAMFIX_OUTPUT_ROOT ?? '';
const stage = process.argv[2];
if (!output || !['validate', 'revalidate', 'prepare'].includes(stage ?? '')) throw new Error('Missing bot follow-up stage or output directory.');
const payload = parseBotFollowupPayload({
  prNumber: Number(process.env.UPSTREAMFIX_PR_NUMBER),
  headSha: process.env.UPSTREAMFIX_HEAD_SHA,
  headRef: process.env.UPSTREAMFIX_HEAD_REF,
  packageName: process.env.UPSTREAMFIX_PACKAGE,
});
if (stage === 'validate' || stage === 'revalidate') {
  const validated = await validateBotPullRequest(repository, payload, githubReadApi(repository, token));
  if (stage === 'revalidate') {
    const previous = JSON.parse(await readFile(path.join(output, 'validated.json'), 'utf8')) as ValidatedBotPull;
    if (JSON.stringify(previous) !== JSON.stringify(validated)) throw new Error('Bot PR changed after read-only preflight.');
  }
  await writeFile(path.join(output, 'validated.json'), JSON.stringify(validated) + '\n', { mode: 0o600 });
} else {
  const previous = JSON.parse(await readFile(path.join(output, 'validated.json'), 'utf8')) as ValidatedBotPull;
  if (previous.repository !== repository || previous.prNumber !== payload.prNumber || previous.headSha !== payload.headSha ||
    previous.headRef !== payload.headRef || ![12, 13].includes(previous.sourceMajor)) throw new Error('Validated bot PR context differs from dispatch.');
  const project = process.env.UPSTREAMFIX_CLIENT_ROOT;
  if (!project) throw new Error('Missing client checkout.');
  await prepareBotFollowup(project, output, previous);
}
