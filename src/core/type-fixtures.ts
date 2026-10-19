import type { ApiFinding, ApiReport } from './diff-api.js';
import { validateExactVersion } from './diff-api.js';

/** A compile-only test case. It must never be executed as JavaScript. */
export interface TypeFixture {
  id: string;
  packageName: string;
  oldVersion: string;
  newVersion: string;
  source: string;
  expectedNewDiagnostic: number;
  expectedLine: number;
  derivedFrom: { symbol: string; source: string };
}
export interface TypeFixtureSet { fixtures: TypeFixture[]; manual: ApiFinding[] }

/** The supported shapes come from public type declarations; unknown shapes stay manual. */
export function generateTypeFixtures(report: ApiReport): TypeFixtureSet {
  validateExactVersion(report.oldVersion);
  validateExactVersion(report.newVersion);
  const fixtures: TypeFixture[] = [];
  const manual: ApiFinding[] = [];
  for (const finding of report.removed) {
    const symbol = finding.symbol.slice(finding.symbol.lastIndexOf(':') + 1);
    let source: string | undefined;
    if (report.package === 'stripe' && /^Stripe\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(symbol)) {
      const [, typeName, member] = symbol.split('.');
      source = `import type Stripe from 'stripe';\ntype Removed = Stripe.${typeName}['${member}'];\n`;
    } else if (report.package === 'firebase-admin' && /^[A-Za-z_$][\w$]*$/.test(symbol)) {
      source = `import * as admin from 'firebase-admin';\ntype Removed = typeof admin.${symbol};\n`;
    }
    if (!source) { manual.push(finding); continue; }
    fixtures.push({
      id: `${report.package}:${finding.symbol}`, packageName: report.package,
      oldVersion: report.oldVersion, newVersion: report.newVersion,
      source, expectedNewDiagnostic: 2339, expectedLine: 2,
      derivedFrom: { symbol: finding.symbol, source: finding.source },
    });
  }
  return { fixtures, manual };
}

export function validateFixtureDiagnostics(fixture: TypeFixture, before: Array<{ code: number; line: number }>, after: Array<{ code: number; line: number }>): boolean {
  return before.length === 0 && after.some((diagnostic) => diagnostic.code === fixture.expectedNewDiagnostic && diagnostic.line === fixture.expectedLine);
}
