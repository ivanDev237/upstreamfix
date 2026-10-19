import { describe, expect, it } from 'vitest';
import { diffPublishedApi } from '../src/core/diff-api.js';

describe.skipIf(process.env.UPSTREAMFIX_RUN_REAL_SDK_TESTS !== '1')('published Firebase API comparison', () => {
  it('reports namespace API removals from firebase-admin 13.10.0 to 14.0.0', async () => {
    const report = await diffPublishedApi('firebase-admin', '13.10.0', '14.0.0');
    const removed = report.removed.map((item) => item.symbol);
    expect(removed).toEqual(expect.arrayContaining([
      'lib/index.d.ts:firestore', 'lib/index.d.ts:auth', 'lib/index.d.ts:credential', 'lib/index.d.ts:apps',
    ]));
  }, 60_000);
});
