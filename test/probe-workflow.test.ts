import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('real probe validation workflow', () => {
  it('pins the reviewed signet commit, runs Docker probe on GitHub, and uploads its report', () => {
    const workflow = readFileSync(new URL('../.github/workflows/probe.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("github.event_name == 'pull_request' && github.sha || inputs.source_sha");
    expect(workflow).toContain('6aae309def8500dae9f60efc6e682a6fef9b169b');
    expect(workflow).toContain('probe stripe@23.0.0');
    expect(workflow).toContain('manualFindings');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).toContain('contents: read');
  });
});
