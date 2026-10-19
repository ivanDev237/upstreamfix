import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = () => readFileSync(path.join(root, '.github/workflows/client-migrations.yml'), 'utf8');

describe('client migration workflow security boundary', () => {
  it('separates migration and publication into jobs with different permissions', () => {
    const source = workflow();
    expect(source).toMatch(/\n  migrate:[\s\S]*?permissions:\n      contents: read/);
    expect(source).toMatch(/\n  publish:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write\n      issues: write/);
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('timeout-minutes:');
  });

  it('runs only on schedule, dispatch or a reusable workflow call, never on PR events', () => {
    const source = workflow();
    expect(source).toContain('workflow_call:');
    expect(source).toContain('workflow_dispatch:');
    expect(source).not.toMatch(/^\s+pull_request(?:_target)?:/m);
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
});
