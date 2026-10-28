# UpstreamFix

**UpstreamFix previews code changes for supported breaking SDK upgrades, reports cases that need a developer, and can commit verified changes on a dedicated Git branch.**

> **Experimental (0.x).** Review every proposed change and test your application before using a migration in production. The source code is available in the [public GitHub repository](https://github.com/ivanDev237/upstreamfix).

## Demo

[View the Firebase Admin migration walkthrough](https://github.com/ivanDev237/upstreamfix/blob/main/docs/upstreamfix-demo.gif), composed from real CLI preview output on a local example project. It shows the proposed diff; no project files are written.

The frames show the intended command flow. Output varies with the project and migration findings.

## Quick start

Start with `npx upstreamfix@latest list`. To inspect a project without changing its files, run:

```sh
npx --yes upstreamfix@latest list
npx --yes upstreamfix@latest scan --cwd /path/to/your/project
npx --yes upstreamfix@latest migrate firebase-admin@14 --cwd /path/to/your/project --report /tmp/firebase-admin-v14.md
```

The report path is explicit; preview commands do not create report files unless `--report` is supplied. The Firebase Admin migration currently targets projects using the namespaced API and proposes modular API changes. Review the diff and manual findings against the [official migration guide](https://firebase.google.com/docs/admin/migrate-node-v10).

## GitHub Action

### Install in under five minutes

1. In your repository, open **Settings → Actions → General**. Allow GitHub Actions and reusable workflows, then enable **Allow GitHub Actions to create and approve pull requests**. GitHub combines creation and approval in one repository setting; UpstreamFix creates PRs but does not approve or merge them. Keep the default `GITHUB_TOKEN` setting at read access if you prefer: the workflow requests its own permissions below. [GitHub settings guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).
2. Copy [this workflow](examples/action-test/.github/workflows/upstreamfix.yml) to `.github/workflows/upstreamfix.yml` in your repository. It grants exactly `contents: write`, `pull-requests: write`, `issues: write`, and `actions: write` to the reusable workflow. The migration job reduces its own token to `contents: read`; only the separate publication job receives write access. No secret or personal token is needed.
3. Replace both `REPLACE_WITH_REVIEWED_MAIN_SHA` values with the **same reviewed 40-character commit SHA** already on UpstreamFix `main`. For a version tag, you may use `@v0.2.0` in the `uses:` line after that tag exists, but keep `upstreamfix_sha:` set to the exact SHA to which the tag points. A release tag and a main commit are accepted; a `develop` commit is refused. A full SHA is the safer pin. [GitHub reusable-workflow guide](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
4. If your repository has `.github/workflows/ci.yml` on its default branch, keep `ci_workflow: ci.yml` in the copied example and add `workflow_dispatch:` to that CI workflow's `on:` triggers. Otherwise remove the `ci_workflow:` line. Commit the workflow, then open **Actions → UpstreamFix API migrations → Run workflow**. The example also runs weekly; change its `schedule` if needed.
5. Read the result. UpstreamFix opens or updates a PR only when the migration and configured checks pass. It opens an issue for manual work. Review the diff, report, and official SDK guide before merging.

The first job checks out your code without stored credentials, installs dependencies without lifecycle scripts, verifies project checks in an isolated Docker container, and uploads a redacted report and Git bundle. The second job validates the bundle and publishes a PR or issue. Both jobs have time limits. A repository without a usable typecheck or test will not receive an automatic PR.

An optional `.upstreamfix.yml` supports `frequency` (`daily`, `weekly`, `manual`), `ignore`, `exclude`, `verify`, `reviewers`, `labels`, and `experimental`. Each list uses one `  - value` line per item. For example:

```yaml
frequency: weekly
verify:
  - npm run typecheck
ignore:
  - stripe@23
```

Custom checks run only in the isolated verification job. This file cannot increase permissions or disable verification. OpenAI v5 is experimental and excluded by default; add `experimental:` followed by `  - openai@5` only after reviewing its limits.

The repository's `GITHUB_TOKEN` may leave `pull_request` checks for a bot-created PR awaiting **Approve workflows to run**. When `ci_workflow` names a CI workflow that supports `workflow_dispatch`, UpstreamFix dispatches it on the verified migration branch after opening or updating the PR. If the dispatch fails, the PR remains open with a warning. This avoids relying on a new `pull_request` event to start CI. [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token). UpstreamFix does not merge automatically.

## Supported migrations

| Migration | What it previews | Status |
|---|---|---|
| `firebase-admin@14` | Firebase Admin SDK v13 namespaced API to v14 modular API | Benchmarked on 12 valid public repositories; 316 of 340 detected change groups migrated automatically. Manual findings and runtime prerequisites still require review. |
| `stripe@22` | Stripe Node SDK v21 to v22 | Benchmarked on 6 installable public repositories; payment-sensitive cases remain manual. See [Stripe's v22 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22). |
| `stripe@23` | Stripe Node SDK v22 to v23 | Benchmarked on 4 public repositories; a removed payment parameter was identified for manual review. See [Stripe's v23 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v23). |
| `openai@5` | OpenAI Node SDK v4 to v5 | **Experimental.** On the 17 valid repositories of the [public benchmark](benchmark/openai-5-results.md), only 1 is migrated without any manual item. `--write` is all-or-nothing, and the others keep at least one finding that needs a developer: missing Node or Web types, lockfiles that cannot be regenerated safely, OpenAI clients that are passed to other code or mutated, optional Zod response fields, or a Node.js range below 20. Rewrites are withheld whenever the client cannot be tracked with certainty. Explicit opt-in and review are required; see the [official v5 guide](https://github.com/openai/openai-node/blob/v5.0.0/MIGRATION.md). |

Run `upstreamfix list` for the catalog included in the installed version. Run `upstreamfix scan --cwd <project>` to select stable migrations from package versions declared in root or nested `package.json` files. Use `--include-experimental` on `scan` or `--experimental` on `migrate openai@5` only after reviewing the current limits.

SDK publishers can also describe supported changes in an experimental declarative YAML recipe. Preview one with `upstreamfix migrate --recipe ./upgrade.yml --experimental --cwd ./project`. Recipes are not discovered by `scan` or the GitHub Action. See the [recipe format and safety rules](docs/recipe-format.md).

## Detecting SDK changes

These commands report evidence for review. They do not create migration rules or pull requests.

```sh
upstreamfix watch --state /path/to/upstreamfix-watch.json
upstreamfix diff-api firebase-admin 13.10.0 14.0.0
upstreamfix impact --cwd /path/to/project
upstreamfix probe stripe@23.0.0 --cwd /path/to/project
```

`watch` checks the npm `latest` tags of catalog packages. The first run records a baseline; later runs record newly observed **major** versions in the chosen JSON file. It makes small registry requests and updates the file atomically. `diff-api` downloads two exact npm tarballs, verifies their published integrity values, and compares public TypeScript declarations. Removed or changed declarations are clues; apparent renames are explicitly hypotheses. The archive size is capped and no package scripts run.

`impact` reads declared versions in root and nested manifests, looks up each catalog package's latest npm version, and estimates automatic versus manual source findings using the catalog's current rules. It does not install dependencies or modify the project. Its counts are estimates, not a compatibility guarantee.

`probe` needs a Git project with a root npm lockfile and TypeScript. It shows an estimated cold download first and exits without downloading. Add `--yes` after reviewing that estimate. It copies the project, installs the locked baseline and an exact target SDK version with lifecycle scripts disabled, and runs both compiler checks in a pinned Docker image with no network and a read-only project mount. Existing compiler errors are separated from new candidates. A new error is **not proof** that the SDK caused it. The original files and lockfile remain untouched. pnpm/Yarn projects and projects without a readable TypeScript check currently return "measurement unavailable". Docker and registry access are required only for the confirmed probe.

## What is not supported

- Automatic PRs require a clean, verified migration with no manual findings and a repository that permits GitHub Actions to create pull requests. The Action never merges changes.
- `watch`, `diff-api`, and `probe` can identify new version and type-change candidates. They do not generate or approve safe migration rules automatically.
- Only migrations shown by `upstreamfix list` are supported. Unsupported, ambiguous, or semantic API changes require manual work.
- Lockfile previews cover standalone root projects using npm v3, pnpm, or Yarn Classic lockfiles. Regenerating a lockfile may contact the package registry; pnpm or Yarn must already be installed and match any `packageManager` pin. Workspaces, Yarn Berry, shrinkwrap, project package-manager configuration files, and local or non-registry dependencies are left for manual review.

## Safety and data

UpstreamFix runs locally. It reads source files, package manifests, and supported lockfiles in the selected project. It does not upload project source to an UpstreamFix service. A preview can invoke npm, pnpm, or Yarn to regenerate a supported lockfile; this may contact the package registry, but the updater uses a fresh temporary home and does not pass your environment tokens or package-manager config. Preview does not write project files unless you explicitly request a report with `--report`.

Optional `--verify` requires a Git working tree and copies tracked or non-ignored files into a size-limited temporary directory. It excludes common credential files, package-manager configuration, and symlinks, then installs dependencies with scripts disabled. Configured typecheck and test scripts still execute on your machine with a restricted environment; they are project code, can run arbitrary commands, and can access the network. Only verify projects and scripts you trust, and avoid projects whose tests can access production services or perform external side effects. Dependency installation can contact the package registry. The original project directory is left unchanged.

The isolated copy normally has a 100 MiB limit after excluding non-code assets. Unchanged files larger than 20 MiB are copied when needed, with a 500 MiB total-copy ceiling, and listed in the verification report. Files changed by the migration, `package.json`, and lockfiles retain the 20 MiB per-file limit.

After reviewing a preview, `--write` verifies the migration in an isolated Git worktree and commits it on a new `upstreamfix/<migration>` branch. It refuses non-Git projects, dirty trees (unless `--allow-dirty` is supplied), manual findings, missing or failed verification checks, and source changes whose containing manifest does not declare the target SDK major. It never switches or edits your current working tree. Verification still runs project scripts on your machine, so use it only with projects you trust. No branch is merged or pushed automatically.

Firebase Admin v14 requires Node.js 22 or newer. If your project omits `engines.node`, the preview explains why the dependency cannot yet be upgraded. Once you have confirmed your deployment runtime, add `"engines": { "node": ">=22" }` yourself or pass `--node-runtime 22` to `migrate firebase-admin@14` (including with `--write`). That option proposes the Node range alongside the SDK update. It never overrides an existing incompatible `engines.node` range.

OpenAI SDK v5 requires Node.js 20 or newer. This migration remains experimental because a real-project upgrade exposed missing Node and Web types, even when a source rewrite was mechanical. After confirming your deployment runtime, pass `--experimental --node-runtime 20` to `migrate openai@5` to propose `"engines": { "node": ">=20" }` when the range is absent. An existing incompatible range must be reviewed and changed by you; the option does not override it. `scan --include-experimental` accepts the same runtime option and applies it only to `openai@5`. A failed verification blocks `--write`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, test guidance, and how to add a migration. Security reports belong in the private reporting process described in [SECURITY.md](SECURITY.md). UpstreamFix is licensed under the [MIT License](LICENSE).

## Development

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run typecheck
npm test
```

To build and run the CLI from this checkout:

```sh
npm run build
node dist/cli.js list
node dist/cli.js migrate firebase-admin@14 --cwd /path/to/fixture
```

Add a migration scaffold with `npm run new-migration -- <npm-package> <target-major>`. Its real-SDK compatibility test is opt-in because it downloads SDK versions: set `UPSTREAMFIX_RUN_REAL_SDK_TESTS=1` when running that generated test.
