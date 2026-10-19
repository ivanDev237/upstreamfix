import { describe, expect, it } from 'vitest';
import { parseActionConfig, shouldRunOnSchedule } from '../src/action/config.js';

describe('.upstreamfix.yml', () => {
  it('accepts ignored migrations, excluded folders, custom checks, reviewers and labels', () => {
    expect(parseActionConfig(`frequency: weekly\nignore:\n  - stripe@23\nexclude:\n  - examples/generated\nverify:\n  - npm run typecheck\nreviewers:\n  - ivanDev237\nlabels:\n  - dependencies\n`)).toEqual({
      frequency: 'weekly', ignore: ['stripe@23'], exclude: ['examples/generated'],
      verify: ['npm run typecheck'], reviewers: ['ivanDev237'], labels: ['dependencies'], experimental: [],
    });
  });

  it('rejects unknown keys and unsafe exclusion paths with a clear error', () => {
    expect(() => parseActionConfig('permissions: write\n')).toThrow('Unknown .upstreamfix.yml key');
    expect(() => parseActionConfig('exclude:\n  - ../private\n')).toThrow('exclude');
    expect(() => parseActionConfig('exclude:\n  - .git/hooks\n')).toThrow('exclude');
  });

  it('refuses labels that could invoke automatic merge policies', () => {
    expect(() => parseActionConfig('labels:\n  - automerge\n')).toThrow('merge');
    expect(() => parseActionConfig('labels:\n  - auto-merge\n')).toThrow('merge');
  });

  it('does not allow configuration to turn off verification or authorize PR events', () => {
    expect(() => parseActionConfig('verify: false\n')).toThrow('verify');
    expect(() => parseActionConfig('triggers:\n  - pull_request_target\n')).toThrow('Unknown');
  });

  it('honors a weekly or manual schedule without changing workflow permissions', () => {
    expect(shouldRunOnSchedule('weekly', new Date('2026-10-19T09:00:00Z'))).toBe(true);
    expect(shouldRunOnSchedule('weekly', new Date('2026-10-20T09:00:00Z'))).toBe(false);
    expect(shouldRunOnSchedule('manual', new Date('2026-10-19T09:00:00Z'))).toBe(false);
  });
});
