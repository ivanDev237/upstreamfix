import { describe, expect, it } from 'vitest';
import { maskSecrets, renderMarkdownReport } from '../src/core/report.js';
import type { RunOutcome } from '../src/core/runner.js';
import type { MigrationInfo } from '../src/core/types.js';

const migration: MigrationInfo = {
  id: 'stripe@22', title: 'Stripe SDK v22 migration', fromMajor: 21, toMajor: 22,
  releasedAt: '2026-04-03', guideUrl: 'https://example.invalid/migration', rules: [],
};

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    changes: [{ file: 'src/payments.ts', line: 1, rule: 'constructor', before: "Stripe('sk_test_51AbCdEfGhIjKlMnOpQr')", after: "new Stripe('[API key redacted]')" }],
    manual: [{ file: 'src/payments.ts', line: 2, reason: 'Review <script>alert(1)</script> and `code`', snippet: "const key = 'sk_live_51SecretKeyExample123';" }],
    filesChanged: ['src/payments.ts'], proposedFiles: [], manifestNotes: ['redacted'], proposedDiff: [
      '--- a/src/payments.ts\n+++ b/src/payments.ts\n@@ -1 +1 @@\n-const x = ````;\n+const y = ````;\n',
    ],
    ...overrides,
  };
}

describe('security of Markdown reports', () => {
  it('redacts realistic Stripe, webhook, Google API, PEM, and Firebase private-key values everywhere', () => {
    const report = renderMarkdownReport(migration, outcome({
      manifestNotes: ['Stripe key sk_test_51AbCdEfGhIjKlMnOpQr and rk_live_51AbCdEfGhIjKlMnOpQr'],
      proposedDiff: ['const config = { private_key: "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----", api: "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345678" };'],
    }), true);

    expect(report).toContain('possible credentials were detected');
    expect(report).not.toContain('sk_test_51AbCdEfGhIjKlMnOpQr');
    expect(report).not.toContain('rk_live_51AbCdEfGhIjKlMnOpQr');
    expect(report).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(report).not.toContain('AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345678');
    expect(maskSecrets('sk_test_fake')).toBe('sk_test_fake');
  });

  it('renders untrusted snippets safely and picks a diff fence longer than embedded backticks', () => {
    const report = renderMarkdownReport(migration, outcome(), true);
    expect(report).toContain(String.raw`Review &lt;script&gt;alert\(1\)&lt;/script&gt;`);
    expect(report).toContain("``const key = '[API key redacted]';``");
    expect(report).toContain('const x = ````;');
    expect(report).toContain('`````diff');
    expect(report).toContain('`````\n');
  });
});
