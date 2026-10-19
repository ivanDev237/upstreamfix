/** Shared traversal exclusions for migration, scan, verification, and benchmark discovery. */
export const IGNORED_PROJECT_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  '.codex', '.claude', '.venv', 'venv', '.yarn',
]);

/** A single-major npm declaration the migration engine can reason about safely. */
export function isSupportedSourceMajor(range: string, major: number): boolean {
  const match = /^\s*[~^]?(\d+)(?:\.(?:\d+|x|\*)){0,2}\s*$/i.exec(range);
  return match !== null && Number(match[1]) === major;
}
