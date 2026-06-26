/**
 * Shared types for pnpm-airgap
 */

// Result statuses
export const Status = {
  SUCCESS: 'success',
  ERROR: 'error',
  SKIPPED: 'skipped',
} as const;

export type StatusType = (typeof Status)[keyof typeof Status];

// Package existence states (tri-state)
export const Existence = {
  EXISTS: 'exists',
  NOT_EXISTS: 'not_exists',
  UNCERTAIN: 'uncertain',
} as const;

export type ExistenceType = (typeof Existence)[keyof typeof Existence];

// Package info extracted from tarball
export interface PackageInfo {
  name: string;
  version: string;
  [key: string]: unknown;
}

// Package from lockfile
export interface LockfilePackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  fromSnapshots?: boolean;
}

// Result of existence check
export interface ExistenceResult {
  status: ExistenceType;
  certain: boolean;
  error?: string;
}

// Result of a package operation
export interface OperationResult {
  status: StatusType;
  package: string;
  name?: string;
  version?: string;
  path?: string;
  size?: number;
  error?: string;
  reason?: string;
  tag?: string;
  attempt?: number;
  note?: string;
  dryRun?: boolean;
  /**
   * True when a 409 conflict was found to be an ORPHAN: a tarball exists on the
   * registry's storage but the version is missing from the package manifest
   * (a raced/partial publish). Cannot be healed over HTTP — needs server-side
   * storage cleanup. Surfaced as an error, never silently skipped.
   */
  orphan?: boolean;
}

// Fetch configuration
export interface FetchConfig {
  lockfilePath: string;
  outputDir: string;
  concurrency: number;
  registryUrl: string;
  registryStatePath?: string | null;
  skipOptional: boolean;
  debug: boolean;
}

// Publish configuration
export interface PublishConfig {
  packagesDir: string;
  registryUrl: string;
  concurrency: number;
  skipExisting: boolean;
  dryRun: boolean;
  debug: boolean;
}

// Sync configuration
export interface SyncConfig {
  sourceRegistry: string;
  destRegistry: string;
  outputDir: string;
  scope?: string | null;
  packageList?: string | null;
  maxVersions?: number | null;
  sinceDate?: string | null;
  concurrency: number;
  skipExisting: boolean;
  downloadOnly: boolean;
  publishOnly: boolean;
  dryRun: boolean;
  debug: boolean;
}

// Registry state configuration
export interface RegistryStateConfig {
  registryUrl: string;
  outputPath: string;
  scope?: string | null;
  concurrency: number;
  debug: boolean;
}

// Registry state file format
export interface RegistryState {
  version: number;
  exportedAt: string;
  registry: string;
  stats: {
    totalPackages: number;
    totalVersions: number;
  };
  packages: Record<string, string[]>;
}

// Progress callback type
export type ProgressCallback = (completed: number, total: number, current?: string) => void;

// Statistics for operations
export interface OperationStats {
  total: number;
  success: number;
  skipped: number;
  failed: number;
  errors: OperationResult[];
}
