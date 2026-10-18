import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { inspectPackageContents } from '../scripts/check-package-files.mjs';
import { releaseTagError } from '../scripts/check-release-tag.mjs';

describe('release validation helpers', () => {
  it('accepts a matching semantic version tag and rejects malformed or mismatched tags', () => {
    expect(releaseTagError('v0.1.0', '0.1.0')).toBeUndefined();
    expect(releaseTagError('v0.1.1', '0.1.0')).toContain('does not match package.json');
    expect(releaseTagError('release-next', '0.1.0')).toContain('semantic version tag');
  });

  it('allows only package.json, README, LICENSE, and dist files in the npm archive', () => {
    const valid = [{ files: ['package.json', 'README.md', 'LICENSE', 'dist/cli.js'].map((path) => ({ path })) }];
    expect(inspectPackageContents(valid)).toEqual({ unexpected: [], missing: [], hasDist: true });

    const invalid = [{ files: [...valid[0].files, { path: '.env' }] }];
    expect(inspectPackageContents(invalid).unexpected).toEqual(['.env']);
  });

  it('keeps npm OIDC publishing separate from source execution and restricts release provenance', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const buildJob = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
    const publishJob = workflow.slice(workflow.indexOf('  publish:'));

    expect(buildJob).toContain('git merge-base --is-ancestor HEAD origin/main');
    expect(buildJob).toContain('npm ci --ignore-scripts');
    expect(buildJob).not.toContain('id-token: write');
    expect(buildJob).toContain('upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(publishJob).toContain('environment: npm-production');
    expect(publishJob).toContain('id-token: write');
    expect(publishJob).toContain('download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(publishJob).toContain('--tag next');
    expect(publishJob).toContain('--tag latest');
    expect(publishJob).not.toContain('npm ci');
    expect(publishJob).not.toContain('npm run');
    expect(publishJob).not.toContain('actions/checkout');
  });
});
