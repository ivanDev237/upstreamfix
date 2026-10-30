# Changelog

All notable changes to UpstreamFix are documented here. Versions in the 0.x
series are experimental; review proposed migrations before applying them.

## Unreleased

- firebase-admin 14: CommonJS destructuring of a service's static exports is now migrated in place, for example `const { FieldValue, FieldPath: FP } = admin.firestore;` or `const { FieldPath } = require('firebase-admin').firestore;` become `require('firebase-admin/firestore')`, keeping scope, aliases and lazy loading. Rest elements, defaults, nested or computed names, members that are not static exports, ESM destructuring and assigned requires stay manual.

## 0.5.0

- **Dependency-bot follow-ups.** When Dependabot or Renovate opens a major-upgrade pull request for a catalog SDK, the client workflow can now prepare the matching code changes. The new `bot-pr-followup` dispatch revalidates the pull request through the GitHub API (bot author, same-repository head, current head commit, real major bump) before checking it out; no token reaches the step that runs client code. Fixes land on a separate `upstreamfix/*` branch with a single comment on the bot pull request; the bot branch itself is never modified. `migrate --source-major` migrates code on a head whose manifest and lockfile are already upgraded, without touching them.
- **Verification compares against the original project.** When a check fails, the same check runs on an unmigrated copy: type checks and builds pass only if the migration introduces no new TypeScript diagnostics; tests that fail before and after are reported as inconclusive and still block `--write`. The baseline copy never installs a package that the migration removes.
- **More projects can be verified.** JavaScript projects without type checks, builds or tests get a smoke check (syntax and resolution of the migrated imports). The `npm init` placeholder test script is ignored, a `tsconfig.json` without TypeScript installed counts as not configured, large non-source assets are excluded, and large unchanged files are copied within a 500 MiB budget.
- **firebase-admin 14 peer blockers.** The migration raises `firebase-functions` to `^7.3.0` when an older release would reject firebase-admin 14, and reports `firebase-functions-test` as a blocker (no published release accepts v14 yet) instead of failing with a raw `ERESOLVE`.
- **Prerelease versions.** Dependency specs with prerelease or build identifiers (for example `multer@^1.4.5-lts.1`) no longer prevent lockfile regeneration.
- **Experimental Brevo v6 migration.** `@getbrevo/brevo` v4 and v5 projects can be previewed with `migrate @getbrevo/brevo@6 --experimental`: direct, unambiguous rewrites only (`createBatchEvents`, balance parameters, `getAllCompanies` filters on `attributes.name`); other `filters` usages, removed parameters and changed response types are manual findings.
- GitHub App issues for manual findings now describe the steps to take in the repository instead of suggesting `--write`. YAML recipes gained `requiredPackage`, and an experimental Apollo Client 4 recipe is benchmarked publicly.

## 0.4.0

- The reusable client workflow now accepts `repository_dispatch` events from the UpstreamFix GitHub App. It runs only when the event names the receiving repository, its default branch and its current head commit; the event payload is never used to choose code, branches or migrations. Manual and scheduled runs are unchanged. The App itself is still in staging.
- OpenAI v4 to v5 remains **experimental**, but its rewrites are now far more conservative. A client is rewritten only when every use of it can be tracked: clients that are passed to other code, copied, mutated (including from another module, a subclass or a namespace import) or reached through an untracked receiver become manual findings instead of edits.
- OpenAI v5 coverage: `runTools` event and method renames, safe named path parameters (for example `runs.retrieve(threadId, runId)`), the removed `beta.chat` namespace, moved beta chat and message imports, removed polling and runner types, and `APIError.headers`.
- OpenAI v5 Node.js requirements: Node.js 20 is required. The missing `@types/node` and `"node"` tsconfig types are repaired together with the SDK upgrade, or not at all, and only when the runtime is guaranteed by `engines.node` or confirmed with `--node-runtime 20`.
- The Action's publish job now re-renders the expected `package.json` and `tsconfig.json` repair and requires an exact match, rejecting any other dependency, duplicated JSON key or unexpected configuration change.
- The public OpenAI benchmark now follows the CLI's all-or-nothing `--write` rule: 1 of 17 valid repositories migrates without a manual finding. See [benchmark/openai-5-results.md](benchmark/openai-5-results.md).

## 0.3.0

- Added experimental declarative YAML migration recipes for SDK publishers. Preview one with `upstreamfix migrate --recipe <file.yml> --experimental`.
- Published a strict [JSON schema](docs/recipe.schema.json) and an [English format guide](docs/recipe-format.md). Recipes are data only: they cannot execute code or provide arbitrary regular expressions.
- Made recipe migrations conservative: unsupported or ambiguous usages become manual review items; files with syntax errors, overlapping edits, or unsafe generated code are not rewritten. The ordinary verification and guarded Git branch workflow still applies.
- Fixed Stripe v22 request-option migration: only confirmed ID-first methods gain a missing parameters slot. ID-less calls and an `undefined` ID now require manual review, protecting Connect account selection.

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
