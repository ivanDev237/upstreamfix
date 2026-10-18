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

## Supported migrations

| Migration | What it previews | Status |
|---|---|---|
| `firebase-admin@14` | Firebase Admin SDK v13 namespaced API to v14 modular API | Benchmarked on 12 valid public repositories; 316 of 340 detected change groups migrated automatically. Manual findings and runtime prerequisites still require review. |
| `stripe@22` | Stripe Node SDK v21 to v22 | Benchmarked on 6 installable public repositories; payment-sensitive cases remain manual. See [Stripe's v22 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22). |
| `stripe@23` | Stripe Node SDK v22 to v23 | Benchmarked on 4 public repositories; a removed payment parameter was identified for manual review. See [Stripe's v23 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v23). |

Run `upstreamfix list` for the catalog included in the installed version. Run `upstreamfix scan --cwd <project>` to select migrations from package versions declared in root or nested `package.json` files.

## What is not supported

- The GitHub Action exits without changing a repository; automatic pull requests are not available.
- UpstreamFix does not watch package registries, discover new API changes, or invent migrations. It only previews migration rules already included in the release.
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
