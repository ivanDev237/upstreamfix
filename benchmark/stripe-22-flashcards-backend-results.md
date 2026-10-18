# stripe v21 → v22 public repository benchmark

Generated: 2026-10-18T00:07:49.846Z

Run status: **complete** (1 of 1 repositories recorded).

Automatic migration rate: **50.0%** (1 of 2 detected migration items).
The denominator counts migration change groups plus manual API findings; it does not count individual API callsites. Node.js runtime prerequisites and temporary benchmark-only dependency overrides are reported as notes, not manual migration findings.

| Repository | Pinned commit | Status | Detected items | Migrated | Manual | Types before | Types after | Tests before | Tests after | Details |
|---|---|---:|---:|---:|---:|---|---|---|---|---|
| flashcards-backend | `eb73aff01561` | manual review required | 2 | 1 | 1 | not configured | not configured | not configured | not configured | `dependencies.stripe`: `^21.0.1` → `^22.0.0` backend/package.json was set to stripe ^22.0.0 in the disposable benchmark copy so post-migration checks could run, even when migration findings require manual review. The original lockfiles were retained in the disposable checkout and updated by the selected package manager for post-migration checks. |

Project checks run only inside Docker image `node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` with networking disabled. Dependency installation runs in Docker with no host credentials; lifecycle scripts are disabled.
