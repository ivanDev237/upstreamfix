import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('package metadata', () => {
  it('exposes only the upstreamfix command', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(packageJson.bin).toEqual({ upstreamfix: 'dist/cli.js' });
  });

  it('uses only UpstreamFix-prefixed environment variables in the action', async () => {
    const action = await readFile(path.join(projectRoot, 'action.yml'), 'utf8');
    expect(action).toContain('UPSTREAMFIX_REPORT_FILE');
    expect(action).not.toContain('AUTOSCALEX_REPORT_FILE');
  });
});
