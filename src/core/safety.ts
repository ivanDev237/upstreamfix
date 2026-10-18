/** Verified migrations can be committed on an isolated Git branch. */
export const WRITES_ENABLED = true;

export function assertWritesEnabled(dryRun: boolean): void {
  if (!dryRun && !WRITES_ENABLED) {
    throw new Error(
      'Applying migrations with --write is unavailable in this build.',
    );
  }
}
