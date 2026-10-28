import { describe, expect, it } from 'vitest';
import { parseBotFollowupPayload, validateBotPullRequest, type FetchJson } from '../src/action/bot-followup.js';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const payload = { prNumber: 17, headSha, headRef: 'dependabot/npm/firebase-admin-14', packageName: 'firebase-admin' };
const repo = { id: 8, default_branch: 'main' };
const pull = { number: 17, state: 'open', user: { login: 'dependabot[bot]' },
  head: { sha: headSha, ref: payload.headRef, repo: { id: 8 } },
  base: { sha: baseSha, ref: 'main', repo: { id: 8 } } };
function api(overrides: { pull?: Record<string, unknown>; files?: unknown[]; before?: unknown; after?: unknown } = {}): FetchJson {
  return async (suffix) => {
    if (!suffix) return repo;
    if (suffix === '/pulls/17') return { ...pull, ...overrides.pull };
    if (suffix.startsWith('/pulls/17/files')) return overrides.files ?? [{ filename: 'package.json', status: 'modified' }];
    if (suffix.startsWith('/contents/package.json')) {
      const manifest = suffix.endsWith(baseSha) ? overrides.before ?? { dependencies: { 'firebase-admin': '^13.0.0' } }
        : overrides.after ?? { dependencies: { 'firebase-admin': '^14.0.0' } };
      return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') };
    }
    throw new Error(`Unexpected API path ${suffix}`);
  };
}

describe('dependency bot PR follow-up read-only gates', () => {
  it('accepts a current same-repository Dependabot 13 to 14 manifest upgrade', async () => {
    await expect(validateBotPullRequest('owner/repo', payload, api())).resolves.toMatchObject({
      sourceMajor: 13, headSha, prNumber: 17, defaultBranch: 'main' });
  });
  it('accepts Renovate 12 to 14', async () => {
    await expect(validateBotPullRequest('owner/repo', payload, api({
      pull: { user: { login: 'renovate[bot]' } }, before: { dependencies: { 'firebase-admin': '^12.0.0' } }
    }))).resolves.toMatchObject({ sourceMajor: 12 });
  });
  it.each([
    ['human author', { user: { login: 'alice' } }],
    ['fork head', { head: { ...pull.head, repo: { id: 9 } } }],
    ['stale SHA', { head: { ...pull.head, sha: 'c'.repeat(40) } }],
    ['closed PR', { state: 'closed' }],
    ['wrong base', { base: { ...pull.base, ref: 'develop' } }],
  ])('rejects %s', async (_name, override) => {
    await expect(validateBotPullRequest('owner/repo', payload, api({ pull: override }))).rejects.toThrow();
  });
  it('rejects an upgrade outside the catalog', async () => {
    expect(() => parseBotFollowupPayload({ ...payload, packageName: 'react' })).toThrow();
    await expect(validateBotPullRequest('owner/repo', payload, api({
      before: { dependencies: { react: '^18.0.0' } }, after: { dependencies: { react: '^19.0.0' } }
    }))).rejects.toThrow();
  });
  it('rejects a PR that also edits source code', async () => {
    await expect(validateBotPullRequest('owner/repo', payload, api({ files: [
      { filename: 'package.json', status: 'modified' }, { filename: 'src/index.ts', status: 'modified' }
    ] }))).rejects.toThrow();
  });
});
