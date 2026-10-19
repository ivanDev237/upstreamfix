import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/core/runner.js';
import { renderMarkdownReport, renderTerminalReport } from '../src/core/report.js';

describe('migration report formatting', () => {
  it('shows readable console guidance while preserving escaped Markdown and code diffs', () => {
    const markdown = '# Report\n\n- Node\\.js requires `"engines": \\{ "node": "&gt;=22" \\}`.\n\n````diff\n+const raw = "&gt;=22";\n````\n';
    const terminal = renderTerminalReport(markdown);
    expect(terminal).toContain('Node.js requires `"engines": { "node": ">=22" }`');
    expect(terminal).toContain('+const raw = "&gt;=22";');
    expect(markdown).toContain('Node\\.js');
  });

  it('redacts a key embedded in escaped prose in both Markdown and terminal output', () => {
    const key = `sk_live_${'a'.repeat(25)}`;
    const report = renderMarkdownReport(
      { id: 'test', title: 'Test', fromMajor: 1, toMajor: 2, releasedAt: '2026-01-01', rules: [], guideUrl: 'https://example.com' },
      { changes: [], manual: [], filesChanged: [], proposedFiles: [], manifestNotes: [`Do not share ${key}.`], proposedDiff: [] },
      true,
    );
    expect(report).not.toContain(key);
    expect(report).not.toContain('sk\\_live');
    expect(report).toContain('[API key redacted]');
    expect(renderTerminalReport(report)).toContain('[API key redacted]');
    expect(renderTerminalReport(report)).not.toContain(key);
  });
  it('keeps distant edits in separate unified diff hunks', () => {
    const before = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const after = before.replace('line 4', 'changed 4').replace('line 45', 'changed 45');

    const diff = unifiedDiff('src/server.ts', before, after);

    expect(diff.match(/^@@ /gm)).toHaveLength(2);
    expect(diff).toContain('-line 4');
    expect(diff).toContain('+changed 4');
    expect(diff).toContain('-line 45');
    expect(diff).toContain('+changed 45');
  });

  it('summarizes a large lockfile without exposing its complete diff', () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0' } } }, null, 2) + '\n' + ' '.repeat(2_000_000);
    const after = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '2.0.0' }, 'node_modules/c': { version: '1.0.0' } } }, null, 2) + '\n' + ' '.repeat(2_000_000);
    const report = unifiedDiff('package-lock.json', before, after);
    expect(report).toContain('added: 1');
    expect(report).toContain('removed: 1');
    expect(report).toContain('changed: 1');
    expect(report.length).toBeLessThan(10_000);
    expect(report).not.toContain('@@');
  });

  it('bounds the diff for a large non-lockfile source', () => {
    const before = 'old line\n'.repeat(100_000);
    const after = 'new line\n'.repeat(100_000);
    const report = unifiedDiff('src/generated.ts', before, after);
    expect(report).toContain('diff withheld');
    expect(report.length).toBeLessThan(1_000);
  });

  it('escapes multiline and pipe characters in Markdown table cells', () => {
    const report = renderMarkdownReport(
      { id: 'test', title: 'Test', fromMajor: 1, toMajor: 2, releasedAt: '2026-01-01', rules: ['replace'], guideUrl: 'https://example.com' },
      {
        changes: [{ file: 'src/a.ts', line: 2, rule: 'replace', before: 'a | b\nc', after: 'x | y' }],
        manual: [],
        filesChanged: ['src/a.ts'],
        proposedFiles: [],
        manifestNotes: [],
        proposedDiff: [],
      },
      true,
    );

    expect(report).toContain('a \\| b<br>c');
    expect(report).toContain('x \\| y');
    expect(report).toContain('Proposed transformations');
    expect(report).toContain('use --write to verify and commit supported changes on a new Git branch');
  });

  it('includes verification commands and their outcome in the report', () => {
    const report = renderMarkdownReport(
      { id: 'test', title: 'Test', fromMajor: 1, toMajor: 2, releasedAt: '2026-01-01', rules: ['replace'], guideUrl: 'https://example.com' },
      { changes: [], manual: [], filesChanged: [], proposedFiles: [], manifestNotes: [], proposedDiff: [] },
      true,
      {
        status: 'failed',
        checks: [{ name: 'Typecheck (.)', command: 'npm --ignore-scripts run typecheck', status: 'failed', durationMs: 1250, output: 'TS2322: invalid assignment' }],
      },
    );

    expect(report).toContain('## Verification');
    expect(report).toContain('Result: **failed**');
    expect(report).toContain('npm --ignore-scripts run typecheck');
    expect(report).toContain('TS2322: invalid assignment');
  });
});
