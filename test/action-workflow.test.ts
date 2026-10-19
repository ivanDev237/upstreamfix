import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = () => readFileSync(path.join(root, '.github/workflows/client-migrations.yml'), 'utf8');

describe('client migration workflow security boundary', () => {
  it('has no empty step env mapping and lints every workflow in CI with a pinned actionlint release', () => {
    expect(workflow()).not.toMatch(/^\s+env:\s*\n\s+uses:/m);
    const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('actionlint_1.7.12_linux_amd64.tar.gz');
    expect(ci).toContain('8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8');
    expect(ci).toContain('actionlint -color');
  });
  it('T34 fails discovery if every public search provider fails', () => {
    const discovery = readFileSync(path.join(root, '.github/workflows/openai-corpus-discovery.yml'), 'utf8');
    expect(discovery).not.toContain('continue-on-error: true');
  });
  it('separates migration and publication into jobs with different permissions', () => {
    const source = workflow();
    expect(source).toMatch(/\n  migrate:[\s\S]*?permissions:\n      contents: read/);
    expect(source).toMatch(/\n  publish:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write\n      issues: write/);
    expect(source.split('\n  publish:')[1]).toContain('actions: write');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('timeout-minutes:');
  });

  it('accepts only reviewed tool commits on main or an official release tag in both jobs', () => {
    const source = workflow();
    expect(source.match(/merge-base --is-ancestor/g)).toHaveLength(2);
    expect(source.match(/tag --points-at/g)).toHaveLength(2);
    expect((source.match(/fetch-depth: 0/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('uses workflow_call input SHA, cancels stale PR runs, and covers supporting source paths', () => {
    for (const name of ['probe.yml', 'type-fixtures.yml']) {
      const source = readFileSync(path.join(root, '.github/workflows', name), 'utf8');
      expect(source).toContain('inputs.source_sha || github.sha');
      expect(source).toContain('cancel-in-progress: true');
    }
    expect(readFileSync(path.join(root, '.github/workflows/probe.yml'), 'utf8')).toContain('src/core/verify.ts');
    expect(readFileSync(path.join(root, '.github/workflows/type-fixtures.yml'), 'utf8')).toContain('src/migrations/firebase-admin-v14/**');
    expect(readFileSync(path.join(root, '.github/workflows/client-migrations-pr.yml'), 'utf8')).toContain('src/core/**');
  });

  it('keeps the privileged workflow off PR events and checks it in a read-only companion', () => {
    const source = workflow();
    expect(source).toContain('workflow_call:');
    expect(source).toContain('workflow_dispatch:');
    expect(source).not.toContain('  pull_request:');
    expect(source).not.toContain('pull_request_target:');
    const prCheck = readFileSync(path.join(root, '.github/workflows/client-migrations-pr.yml'), 'utf8');
    expect(prCheck).toContain('  pull_request:');
    expect(prCheck).toContain('branches: [main]');
    expect(prCheck).toContain("'.github/workflows/client-migrations.yml'");
    expect(prCheck).toContain('contents: read');
    expect(prCheck).toContain('persist-credentials: false');
    expect(prCheck).not.toContain('contents: write');
    expect(prCheck).not.toContain('secrets.');
    expect(prCheck).not.toContain('pull_request_target:');
    expect(source.split('\n  migrate:')[1]!.split('\n  publish:')[0]).toContain("if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'");
    expect(source.split('\n  publish:')[1]).toContain("if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'");
  });

  it('never checks out or executes customer code in the write-permission job', () => {
    const source = workflow().split('\n  publish:')[1];
    expect(source).toBeDefined();
    expect(source).toContain('actions/download-artifact@');
    expect(source).toContain('repository: ivanDev237/upstreamfix');
    expect(source).not.toContain('npm test');
    expect(source).not.toContain('repository: ${{ github.repository }}');
  });

  it('has one bounded run per branch and never supplies secrets to the migration job', () => {
    const source = workflow();
    expect(source).toContain('concurrency:');
    const migrate = source.split('\n  migrate:')[1]!.split('\n  publish:')[0]!;
    expect(migrate).toContain('timeout-minutes:');
    expect(migrate).not.toContain('GITHUB_TOKEN:');
    expect(migrate).not.toContain('secrets.');
  });

  it('runs client verification commands in isolated containers before artifact upload', () => {
    const migrate = workflow().split('\n  migrate:')[1]!.split('\n  publish:')[0]!;
    expect(migrate).toContain('UPSTREAMFIX_CONTAINER_VERIFY:');
    const source = readFileSync(path.join(root, 'src/action/docker-execute.ts'), 'utf8');
    expect(source).toContain('--network');
    expect(source).toContain('none');
    expect(source).toContain('--cap-drop=ALL');
    expect(source).toContain('--read-only');
  });

  it('ships an enabled migration action and a client example with safe triggers', () => {
    const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
    const example = readFileSync(path.join(root, 'examples/action-test/.github/workflows/upstreamfix.yml'), 'utf8');
    expect(action).not.toContain('Disabled pending security review');
    expect(example).toContain('schedule:');
    expect(example).toContain('workflow_dispatch:');
    expect(example).toContain('client-migrations.yml@');
    expect(example).not.toMatch(/^\s+pull_request(?:_target)?:/m);
  });

  it('documents the live action boundary and exercises timeout and post-migrate trap', () => {
    const policy = readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
    expect(policy).not.toContain('The current GitHub Action is disabled.');
    const source = workflow();
    expect(source).toContain('UPSTREAMFIX_TRAP_SECRET:');
    const migrate = source.split('\n  migrate:')[1]!.split('\n  publish:')[0]!;
    expect(migrate).toContain('UPSTREAMFIX_TRAP_SECRET:');
    expect(migrate).toContain('timeout-minutes: 35');
    const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(action).toContain('GIT_AUTHOR_NAME:');
    expect(action).toContain('UPSTREAMFIX_CONTAINER_VERIFY:');
    const prCheck = readFileSync(path.join(root, '.github/workflows/client-migrations-pr.yml'), 'utf8');
    expect(prCheck).toContain('test/verify.test.ts');
    expect(prCheck).toContain('concurrency:');
    const publisher = readFileSync(path.join(root, 'src/action/publish-cli.ts'), 'utf8');
    expect(publisher).toContain('/dispatches');
  });

  it('keeps the client example pinned to a future main commit and dispatches CI only after a push', () => {
    const example = readFileSync(path.join(root, 'examples/action-test/.github/workflows/upstreamfix.yml'), 'utf8');
    expect(example).toContain('REPLACE_WITH_REVIEWED_MAIN_SHA');
    expect(example).not.toContain('6d4221f4c8f459cc19c6ab573ab49c2857697ea1');
    const publisher = readFileSync(path.join(root, 'src/action/publish-cli.ts'), 'utf8');
    expect(publisher).toContain('if (pushed) await dispatchClientChecks');
  });

  it('sets an unprivileged Git author for the read-only migration job', () => {
    const migrate = workflow().split('\n  migrate:')[1]!.split('\n  publish:')[0]!;
    expect(migrate).toContain('GIT_AUTHOR_NAME:');
    expect(migrate).toContain('GIT_AUTHOR_EMAIL:');
    expect(migrate).toContain('GIT_COMMITTER_NAME:');
    expect(migrate).toContain('GIT_COMMITTER_EMAIL:');
  });
});
