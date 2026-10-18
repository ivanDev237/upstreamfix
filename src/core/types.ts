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
  /** SDK major version this migration targets. */
  toMajor: number;
  /** ISO date when the upstream target release became available. */
  releasedAt: string;
  guideUrl: string;
  /** Short names of the automated transformation rules exposed to users. */
  rules: string[];
}

export interface Migration extends MigrationInfo {
  packageName: string;
  transform(project: Project): MigrationResult;
  /** Updates package.json in place and returns notes for the report. */
  updateManifest?(manifest: PackageManifest): string[];
  /** Reports compatibility risks from installed packages, independently of code migration. */
  inspectManifest?(manifest: PackageManifest): string[];
}
