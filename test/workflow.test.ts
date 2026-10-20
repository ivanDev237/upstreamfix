import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('GitHub Actions CI workflow', () => {
  it('benchmarks the exact PR head named in the OpenAI report', async () => {
    const workflow = await readFile(path.join(projectRoot, '.github/workflows/benchmark.yml'), 'utf8');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('UPSTREAMFIX_SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
  });
  it('runs install, typecheck, build, and tests on Node 22 and 24 for pushes and pull requests', async () => {
    const workflow = await readFile(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('node-version: [22, 24]');
    expect(workflow).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(workflow).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('npm test');
  });
});
