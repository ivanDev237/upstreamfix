import { execFile as callback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runMigration } from '../core/runner.js';
import { writeMigrationOnBranch } from '../core/write-branch.js';
import { renderMarkdownReport } from '../core/report.js';
import { firebaseAdminV14 } from '../migrations/firebase-admin-v14/index.js';
import { executeClientCommand } from './docker-execute.js';

const execFile = promisify(callback);
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

export interface BotFollowupPayload { prNumber: number; headSha: string; headRef: string; packageName: string }
export interface ValidatedBotPull { sourceMajor: 12 | 13; defaultBranch: string; headSha: string; headRef: string;
  prNumber: number; repository: string }
export interface BotFollowupArtifact { schema: 1; status: 'ready' | 'manual' | 'none';
  repository: string; prNumber: number; headSha: string; headRef: string; sourceMajor: 12 | 13;
  branch: string; files: string[]; commit?: string; report: string }

type Json = Record<string, any>;
export type FetchJson = (path: string) => Promise<unknown>;

export function parseBotFollowupPayload(value: unknown): BotFollowupPayload {
  const input = value as Partial<BotFollowupPayload> | null;
  if (!input || !Number.isSafeInteger(input.prNumber) || input.prNumber! < 1 || input.prNumber! > 2147483647 ||
    !SHA.test(input.headSha ?? '') || !REF.test(input.headRef ?? '') ||
    input.headRef!.includes('..') || input.headRef!.startsWith('/') || input.headRef!.endsWith('/') ||
    input.packageName !== 'firebase-admin') throw new Error('Invalid bot follow-up dispatch payload.');
  return input as BotFollowupPayload;
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function declaredMajor(value: unknown): number | null {
  const manifest = record(value);
  if (!manifest) return null;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const range = record(manifest[section])?.['firebase-admin'];
    if (typeof range !== 'string') continue;
    const match = /^\s*[~^]?(\d+)(?:\.(?:\d+|x|\*)){0,2}\s*$/i.exec(range);
    return match ? Number(match[1]) : null;
  }
  return null;
}

/** Run in both the read-only analyzer and the permissioned publisher. Payload fields are hints only. */
export async function validateBotPullRequest(repository: string, payload: BotFollowupPayload,
  fetchJson: FetchJson): Promise<ValidatedBotPull> {
  if (!REPO.test(repository)) throw new Error('Invalid repository name.');
  parseBotFollowupPayload(payload);
  const repo = record(await fetchJson(''));
  const pull = record(await fetchJson(`/pulls/${payload.prNumber}`));
  if (!repo || !Number.isSafeInteger(repo.id) || !REF.test(repo.default_branch ?? '') || !pull ||
    pull.number !== payload.prNumber || pull.state !== 'open' ||
    !['dependabot[bot]', 'renovate[bot]'].includes(record(pull.user)?.login) ||
    !SHA.test(record(pull.head)?.sha ?? '') || pull.head.sha !== payload.headSha ||
    pull.head.ref !== payload.headRef || record(pull.head.repo)?.id !== repo.id ||
    record(pull.base)?.ref !== repo.default_branch || record(pull.base.repo)?.id !== repo.id ||
    !SHA.test(pull.base.sha ?? '')) throw new Error('Bot PR is closed, stale, from a fork, or not from an approved dependency bot.');

  let sourceMajor: 12 | 13 | undefined;
  for (let page = 1; page <= 30; page++) {
    const files = await fetchJson(`/pulls/${payload.prNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) throw new Error('Could not inspect the bot PR file list.');
    for (const item of files) {
      const file = record(item);
      if (!file || typeof file.filename !== 'string' ||
        !/(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file.filename) ||
        file.filename.includes('..') || !['modified', 'added'].includes(file.status))
        throw new Error('Bot PR changes files outside dependency manifests and lockfiles.');
      if (!/(?:^|\/)package\.json$/.test(file.filename) || file.status !== 'modified') continue;
      const filename = file.filename.split('/').map(encodeURIComponent).join('/');
      const [before, after] = await Promise.all([
        fetchJson(`/contents/${filename}?ref=${pull.base.sha}`),
        fetchJson(`/contents/${filename}?ref=${pull.head.sha}`),
      ]);
      const decode = (value: unknown): unknown => {
        const content = record(value);
        if (!content || content.type !== 'file' || content.encoding !== 'base64' ||
          typeof content.content !== 'string' || content.content.length > 2 * 1024 * 1024)
          throw new Error('Bot PR manifest is not a bounded regular file.');
        return JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')) as unknown;
      };
      const previous = declaredMajor(decode(before));
      const current = declaredMajor(decode(after));
      if ((previous === 12 || previous === 13) && current === 14) {
        if (sourceMajor !== undefined) throw new Error('Bot PR updates more than one Firebase Admin manifest.');
        sourceMajor = previous;
      }
    }
    if (files.length < 100) break;
    if (page === 30) throw new Error('Bot PR file list exceeds the safety limit.');
  }
  if (sourceMajor === undefined) throw new Error('Bot PR does not upgrade firebase-admin 12/13 to 14.');
  return { sourceMajor, defaultBranch: repo.default_branch, headSha: payload.headSha,
    headRef: payload.headRef, prNumber: payload.prNumber, repository };
}

export function githubReadApi(repository: string, token: string): FetchJson {
  if (!REPO.test(repository) || !token) throw new Error('Missing GitHub read context.');
  return async (suffix) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${suffix}`, {
      redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub read ${suffix} failed with HTTP ${response.status}.`);
    return await response.json() as unknown;
  };
}

export async function prepareBotFollowup(project: string, output: string, validated: ValidatedBotPull): Promise<BotFollowupArtifact> {
  const head = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: project, timeout: 10_000 })).stdout.trim();
  if (head !== validated.headSha) throw new Error('Client checkout differs from the validated bot PR head.');
  const branch = `upstreamfix/firebase-admin-14-followup-${validated.prNumber}`;
  const common = { schema: 1 as const, repository: validated.repository, prNumber: validated.prNumber,
    headSha: validated.headSha, headRef: validated.headRef, sourceMajor: validated.sourceMajor, branch };
  const preview = await runMigration(firebaseAdminV14, { cwd: project, dryRun: true, sourceMajor: validated.sourceMajor });
  const report = renderMarkdownReport(firebaseAdminV14, preview, true);
  await mkdir(output, { recursive: true, mode: 0o700 });
  let artifact: BotFollowupArtifact;
  if (preview.manual.length) artifact = { ...common, status: 'manual', files: [], report };
  else if (!preview.proposedFiles.length) artifact = { ...common, status: 'none', files: [], report };
  else {
    try {
      const result = await writeMigrationOnBranch(firebaseAdminV14, { cwd: project,
        sourceMajor: validated.sourceMajor, followupPullNumber: validated.prNumber,
        timeoutMs: 10 * 60_000,
        ...(process.env.UPSTREAMFIX_CONTAINER_VERIFY === '1' ? { verificationOptions: { execute: executeClientCommand } } : {}) });
      if (result.outcome.proposedFiles.some((file) => !/\.(?:[cm]?[jt]sx?)$/.test(file.relativePath)))
        throw new Error('Source-only follow-up attempted to edit a non-source file.');
      const bundle = path.join(output, 'bot-followup.bundle');
      await execFile('git', ['bundle', 'create', bundle, `${validated.headSha}..${result.branch}`], { cwd: project, timeout: 30_000 });
      const files = (await execFile('git', ['diff', '--name-only', '-z', validated.headSha, result.commit],
        { cwd: project, timeout: 30_000 })).stdout.split('\0').filter(Boolean);
      artifact = { ...common, status: 'ready', commit: result.commit, files,
        report: renderMarkdownReport(firebaseAdminV14, result.outcome, false, result.verification) };
    } catch (error) {
      artifact = { ...common, status: 'manual', files: [],
        report: `${report}\n\nVerification failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  await writeFile(path.join(output, 'bot-followup.json'), JSON.stringify(artifact) + '\n', { mode: 0o600 });
  return artifact;
}
