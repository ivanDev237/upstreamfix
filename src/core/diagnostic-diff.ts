/** A TypeScript compiler diagnostic located in customer source. */
export interface TypeScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

/** Parse the ordinary, non-pretty `tsc` output without executing project code. */
export function parseTypeScriptDiagnostics(output: string): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const pattern = /^(.+?\.(?:[cm]?tsx?|jsx?))(?:\((\d+),(\d+)\):|:(\d+):(\d+)\s+-) error TS(\d+): (.+)$/;
  for (const line of clean.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const rawPath = match[1]!.trim().replace(/^npm error\s+/, '');
    const file = rawPath.replaceAll('\\', '/').replace(/^\/workspace\//, '').replace(/^\.\//, '');
    diagnostics.push({
      file,
      line: Number(match[2] ?? match[4]),
      column: Number(match[3] ?? match[5]),
      code: Number(match[6]),
      message: match[7]!.trim().replace(/\s+/g, ' '),
    });
  }
  return diagnostics;
}

/**
 * Compare diagnostic multisets by file, error code and message. Positions are
 * intentionally excluded: a harmless preceding edit must not create a finding.
 * These are candidates only; a changed SDK is not necessarily the cause.
 */
export function newTypeScriptDiagnostics(before: TypeScriptDiagnostic[], after: TypeScriptDiagnostic[]): TypeScriptDiagnostic[] {
  const existing = new Map<string, number>();
  for (const diagnostic of before) {
    const key = diagnosticKey(diagnostic);
    existing.set(key, (existing.get(key) ?? 0) + 1);
  }
  return after.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const previous = existing.get(key) ?? 0;
    if (previous === 0) return true;
    existing.set(key, previous - 1);
    return false;
  });
}

function diagnosticKey(diagnostic: TypeScriptDiagnostic): string {
  return `${diagnostic.file}\0${diagnostic.code}\0${diagnostic.message}`;
}
