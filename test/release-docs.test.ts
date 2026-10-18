import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('npm release preparation', () => {
  it('publishes only on matching version tags with provenance and an explicit safety gate', async () => {
    const workflow = await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain("- 'v*'");
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish ./*.tgz --ignore-scripts --provenance --access public --tag next');
    expect(workflow).toContain('npm publish ./*.tgz --ignore-scripts --provenance --access public --tag latest');
    expect(workflow).toContain('UPSTREAMFIX_RELEASE_ENABLED');
    expect(workflow).toContain('P1.2');
    expect(workflow).toContain('P1.6');
    expect(workflow).toContain('P1.7');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm pack --dry-run --ignore-scripts --json');
    expect(workflow).toContain('environment: npm-production');
  });

  it('declares the exact source repository needed for npm provenance', async () => {
    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      repository: { type: string; url: string };
      files: string[];
    };
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'https://github.com/ivanDev237/upstreamfix.git',
    });
    expect(pkg.files).toEqual(['dist']);
  });

});

describe('public README', () => {
  it('documents the migration, demo, three-command quick start, limits, safety, and contribution path', async () => {
    const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
    const demo = await readFile(path.join(projectRoot, 'docs/upstreamfix-demo.gif'));
    expect(demo.subarray(0, 6).toString()).toBe('GIF89a');
    for (const section of ['## Demo', '## Quick start', '## Supported migrations', '## What is not supported', '## Safety and data', '## Contributing']) {
      expect(readme).toContain(section);
    }
    expect(readme.match(/npx --yes upstreamfix@latest/g)).toHaveLength(3);
    expect(readme).toContain('firebase-admin@14');
    expect(readme).toContain('stripe@22');
    expect(readme).toContain('stripe@23');
    expect(readme).toContain('does not upload project source');
    expect(readme).toContain('CONTRIBUTING.md');
  });
});
