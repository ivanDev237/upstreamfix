import { expect, it } from 'vitest';
import { newTypeScriptDiagnostics, parseTypeScriptDiagnostics } from '../src/core/diagnostic-diff.js';

it('ignores preexisting errors and line shifts but counts a second occurrence', () => {
  const before = parseTypeScriptDiagnostics('src/a.ts(4,2): error TS2322: existing');
  const after = parseTypeScriptDiagnostics('src/a.ts(10,2): error TS2322: existing\nsrc/a.ts(20,2): error TS2322: existing');
  expect(newTypeScriptDiagnostics(before, after)).toEqual([after[1]]);
});

it('normalizes pretty and workspace paths and detects payment_method_types', () => {
  const after = parseTypeScriptDiagnostics('\u001b[31m/workspace/src/pay.ts:243:5 - error TS2561: payment_method_types does not exist\u001b[0m');
  expect(after).toMatchObject([{ file: 'src/pay.ts', line: 243, code: 2561 }]);
});
