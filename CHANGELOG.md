# Changelog

All notable changes to UpstreamFix are documented here. Versions in the 0.x
series are experimental; review proposed migrations before applying them.

## Unreleased

## 0.2.0

- Added a two-job GitHub Action: migration and verification run without a write token in isolated Docker containers; a separate, permissioned job validates the artifact before opening a PR or a manual-work issue. The Action never merges changes.
- Added a strict `.upstreamfix.yml` for schedule, exclusions, custom verification commands, reviewers, labels, and explicit experimental opt-ins.
- Expanded `probe` with Docker-backed real-project diagnostic comparison and added type-derived fixtures to investigate exact SDK version changes without inventing migration rules.
- Hardened report rendering, credential redaction, Git operations, container isolation, timeout handling, and benchmark execution.
- Expanded Stripe v23 migration coverage and real-SDK checks while keeping payment-sensitive changes for manual review.
- Added OpenAI v4-to-v5 rules as **experimental**. The migration is excluded from `scan` and the GitHub Action by default and requires explicit opt-in; real-project type regressions still require manual work.

## 0.1.3

- Fixed the CLI entry point: `0.1.2` exited silently when invoked through `npx` or a global installation.
- Added `--version`, `watch`, `diff-api`, `impact`, and `probe` for version monitoring, TypeScript API comparison, impact estimates, and isolated diagnostic probes.
- Prevented unsafe Firebase rewrites involving nested calls, retained arguments, type references, and stored app instances.
- Hardened Git writes, package installation, verification, reports, secret masking, and benchmark isolation.
- Improved Stripe diagnostics and migration safeguards; fixed UTF-8 BOM preservation and lockfile handling.

## 0.1.2

- Removed an empty npm token configuration from the release workflow.
- Tagged `v0.1.2` after the failed `v0.1.1` release. npm still rejected the
  GitHub OIDC exchange for this repository's immutable identity; `0.1.2` was
  published manually with 2FA, without npm provenance.
- No CLI behavior changes.

## 0.1.1

- The `v0.1.1` Git tag was created, but this version was not published to npm.
- Updated the public npm quick start and linked the illustrative demo instead of
  embedding a clipped GIF on the npm package page.
- No CLI behavior changes.

## 0.1.0

- First npm release with a migration catalog for Firebase Admin and Stripe SDKs.
- Added local previews, manual findings, verification, and guarded writes to
  dedicated Git branches.
- Benchmarked migration behavior on public repositories and checked output
  against published SDK releases in CI.
