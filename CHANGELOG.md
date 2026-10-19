# Changelog

All notable changes to UpstreamFix are documented here. Versions in the 0.x
series are experimental; review proposed migrations before applying them.

## Unreleased

- Added `watch`, `diff-api`, `impact`, and `probe` for version monitoring, TypeScript API comparison, impact estimates, and isolated diagnostic probes.
- Hardened previews and verification: bounded lockfile reports, explicit Yarn downloads, isolated package caches, package-manager detection, capped timeouts, and retained error tails.
- Escaped untrusted benchmark output and withheld ambiguous Stripe rewrites.

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
