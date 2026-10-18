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
  // A failed command can prepend text on the same line as the first tsc
  // diagnostic; begin at the source path, never at the command wrapper.
  const pattern = /(?:^|\s)([^\s():]+\.(?:[cm]?tsx?|jsx?))\((\d+),(\d+)\): error TS(\d+): ([^\r\n]+)/g;
  for (const match of output.matchAll(pattern)) {
    const file = match[1]!.replaceAll('\\', '/').replace(/^\/workspace\//, '').replace(/^\.\//, '');
    diagnostics.push({
      file,
      line: Number(match[2]),
      column: Number(match[3]),
      code: Number(match[4]),
      message: match[5]!.trim().replace(/\s+/g, ' '),
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
