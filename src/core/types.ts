import type { Project } from 'ts-morph';

export interface Location {
  file: string;
  line: number;
}

/** A rewrite the tool applied automatically. */
export interface Change extends Location {
  rule: string;
  before: string;
  after: string;
}

/** A usage the tool could not migrate safely and leaves to a human. */
export interface ManualItem extends Location {
  reason: string;
  snippet: string;
  reasonCode?: 'lockfile-refusal' | 'manifest-refusal' | 'runtime-confirmation' | 'openai-affected-call';
}

export interface MigrationResult {
  changes: Change[];
  manual: ManualItem[];
  filesChanged: string[];
  fileUpdates?: Array<{ file: string; contents: string }>;
}

/** Exact file contents for verification and writes; diffs are only a display format. */
export interface ProposedFileChange {
  relativePath: string;
  before: string;
  after: string;
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

export interface MigrationInfo {
  /** Identifier used on the command line. */
  id: string;
  title: string;
  /** SDK major version this migration starts from. */
  fromMajor: number;
  /** Additional source majors accepted by a single versioned migration. */
  additionalFromMajors?: readonly number[];
  /** SDK major version this migration targets. */
  toMajor: number;
  /** ISO date when the upstream target release became available. */
  releasedAt: string;
  guideUrl: string;
  /** Short names of the automated transformation rules exposed to users. */
  rules: string[];
  /** Requires an explicit opt-in because real-project verification remains incomplete. */
  experimental?: boolean;
  /** Migration-owned report notices, rendered before the findings. */
  reportNotices?: readonly string[];
  /** Loaded from a data-only recipe, not a catalog migration with special behavior. */
  declarativeRecipe?: boolean;
  /** Minimum Node.js major declared by a validated external recipe. */
  requiredNodeMajor?: number;
}

export interface Migration extends MigrationInfo {
  packageName: string;
  /** Set when the migration replaces the npm package itself. */
  targetPackageName?: string;
  /** Allow removal of an unused legacy dependency without installing the target. */
  removeUnusedDependency?: boolean;
  transform(project: Project): MigrationResult;
  /** Updates package.json in place and returns notes for the report. */
  updateManifest?(manifest: PackageManifest, context?: { sourceUsed: boolean }): string[];
  /** Reports compatibility risks from installed packages, independently of code migration. */
  inspectManifest?(manifest: PackageManifest): string[];
}
