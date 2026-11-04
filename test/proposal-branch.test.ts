import { describe, expect, it } from 'vitest';
import { proposalBranch } from '../src/action/config.js';

describe('proposal branch', () => {
  it('drops the separator a scoped package would leave at the start', () => {
    expect(proposalBranch('@getbrevo/brevo@6')).toBe('upstreamfix/getbrevo-brevo-6');
    expect(proposalBranch('firebase-admin@14')).toBe('upstreamfix/firebase-admin-14');
  });
});
