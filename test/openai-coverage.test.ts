import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sections = [
  'Environment requirements', 'Web types', 'Named path parameters',
  'URI encoded path parameters', 'Removed request options overloads',
  'HTTP method naming', 'Removed `httpAgent`', 'Changed exports', 'Resource classes',
  'uploads exports', 'APIClient', 'File handling', 'Shims removal',
  'Zod helpers optionality', 'Pagination changes', 'Removed unnecessary classes',
  'Beta chat namespace', 'Removed deprecated `.runFunctions`', '`.runTools()`', '`openai/src`',
  'TypeScript troubleshooting',
];

describe('OpenAI v5 migration coverage record', () => {
  it('maps every official v5 guide section to a rule or manual finding and a test', () => {
    const document = readFileSync(new URL('../docs/research/openai-v5-coverage.md', import.meta.url), 'utf8');
    expect(document).toContain('524080c001a22998cf12b91025187f6993fc66dc');
    for (const section of sections) {
      const row = document.split('\n').find((line) => line.startsWith(`| ${section}`));
      expect(row, section).toBeDefined();
      expect(row?.split('|').length).toBeGreaterThanOrEqual(5);
      expect(row).toContain('test/');
    }
  });
});
