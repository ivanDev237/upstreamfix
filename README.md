# UpstreamFix

**UpstreamFix previews code changes for supported breaking SDK upgrades, reports cases that need a developer, and can commit verified changes on a dedicated Git branch.**

> **Experimental (0.x).** Review every proposed change and test your application before using a migration in production. The source code is available in the [public GitHub repository](https://github.com/ivanDev237/upstreamfix).

## Demo

[View the illustrative terminal walkthrough](https://github.com/ivanDev237/upstreamfix/blob/main/docs/upstreamfix-demo.gif) of listing, scanning, and previewing a migration.

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

Copy the [client workflow example](examples/action-test/.github/workflows/upstreamfix.yml) into your repository and pin both references to the same reviewed UpstreamFix commit SHA. The reusable workflow runs on a schedule or by manual dispatch. Its first job checks out your code without stored credentials, uses only `contents: read`, prepares a verified migration in a temporary copy, and uploads a Git bundle and redacted report. Its second job downloads and validates that bundle, then opens or updates a pull request. It opens an issue when manual review is needed and never merges a PR.

An optional `.upstreamfix.yml` supports `frequency` (`daily`, `weekly`, `manual`), `ignore`, `exclude`, `verify`, `reviewers`, and `labels`. Each list uses one `  - value` line per item. Custom `verify` commands run only in the first job's isolated verification copy. The config cannot increase permissions or turn off verification. A repository with no configured checks will not receive an automatic migration PR.

Pull requests created with the default `GITHUB_TOKEN` do not trigger the repository's normal `pull_request` workflows. Run your CI manually on the proposed branch, or adapt the publication job to use a narrowly scoped GitHub App token or fine-grained PAT supplied by your organization. Review the report, the official migration guide, and the PR diff before merging.

## Supported migrations

| Migration | What it previews | Status |
|---|---|---|
| `firebase-admin@14` | Firebase Admin SDK v13 namespaced API to v14 modular API | Benchmarked on 12 valid public repositories; 316 of 340 detected change groups migrated automatically. Manual findings and runtime prerequisites still require review. |
| `stripe@22` | Stripe Node SDK v21 to v22 | Benchmarked on 6 installable public repositories; payment-sensitive cases remain manual. See [Stripe's v22 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22). |
| `stripe@23` | Stripe Node SDK v22 to v23 | Benchmarked on 4 public repositories; a removed payment parameter was identified for manual review. See [Stripe's v23 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v23). |
| `openai@5` | OpenAI Node SDK v4 to v5 | Conservative changes for renamed methods, beta chat paths, and moved imports. Review runtime requirements and semantic changes against the [official v5 guide](https://github.com/openai/openai-node/blob/v5.0.0/MIGRATION.md). |

Run `upstreamfix list` for the catalog included in the installed version. Run `upstreamfix scan --cwd <project>` to select migrations from package versions declared in root or nested `package.json` files.

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

After reviewing a preview, `--write` verifies the migration in an isolated Git worktree and commits it on a new `upstreamfix/<migration>` branch. It refuses non-Git projects, dirty trees (unless `--allow-dirty` is supplied), manual findings, missing or failed verification checks, and source changes whose containing manifest does not declare the target SDK major. It never switches or edits your current working tree. Verification still runs project scripts on your machine, so use it only with projects you trust. No branch is merged or pushed automatically.

Firebase Admin v14 requires Node.js 22 or newer. If your project omits `engines.node`, the preview explains why the dependency cannot yet be upgraded. Once you have confirmed your deployment runtime, add `"engines": { "node": ">=22" }` yourself or pass `--node-runtime 22` to `migrate firebase-admin@14` (including with `--write`). That option proposes the Node range alongside the SDK update. It never overrides an existing incompatible `engines.node` range.

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
