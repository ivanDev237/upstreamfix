# Changelog

All notable changes to UpstreamFix are documented here. Versions in the 0.x
series are experimental; review proposed migrations before applying them.

## 0.1.2

- Fixed the npm release workflow's OIDC authentication setup.
- Retried publishing through a new version tag after `v0.1.1` failed.
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
