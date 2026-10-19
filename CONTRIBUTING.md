# Contributing

UpstreamFix is experimental. Contributions should keep migrations conservative:
unsupported or ambiguous API usages must be reported for manual review rather
than guessed.

## Before opening a pull request

1. Explain the problem and the affected SDK/version in the pull request.
2. Add or update focused tests for every behavior change.
3. Run `npm run typecheck` and `npm run build`.
4. Run the relevant offline tests, for example `npx vitest run test/cli.test.ts test/runner.test.ts test/verify.test.ts test/write-branch.test.ts`.
5. Do not run real-repository benchmarks or tests that download SDKs unless you have network access and intend to do so.

The full `npm test` suite includes a lockfile regeneration test that may contact
the npm registry. Document any network-dependent checks that you could not run.

## Public repository benchmark

The benchmark supports every registered migration. It clones only reviewed,
public GitHub repositories pinned to full commit SHAs from a JSON manifest; it
installs dependencies and may use the network. Do not run it on a metered
connection. The existing Firebase corpus is the default:

```sh
npm run benchmark -- --estimate-only
npm run benchmark -- --yes
```

To run another migration, provide a reviewed repository manifest and choose an
output report path if needed. For example, for the reviewed Stripe corpus:

```sh
npm run benchmark -- --migration stripe@22 --repos benchmark/stripe-22-repos.json --report benchmark/stripe-22-results.md --yes
```

Use `--only <exact-repository-name>` to run one entry from the selected corpus.
Its report gets a distinct filename. For example, to start with the four-repository
Stripe v23 corpus:

```sh
npm run benchmark -- --migration stripe@23 --repos benchmark/stripe-23-repos.json --estimate-only
npm run benchmark -- --migration stripe@23 --repos benchmark/stripe-23-repos.json --only signet --memory-mb 2048 --yes
```

The benchmark prints a rough uncached transfer range before cloning. It exits
without network access unless you explicitly pass `--yes`; use `--estimate-only`
to print the estimate and exit successfully without creating a checkout or report.
Installs
reuse `benchmark/.cache/` across repositories and runs; this directory is ignored
by Git and can be deleted when disk space is needed. The install container alone
gets a writable cache mount. Test containers remain offline and cannot read it.
Package installation still uses the network when a package is missing from cache.
The benchmark checks free RAM before starting and caps container RAM and swap at
the same value. `--memory-mb` can lower the cap; the actual cap may be lower if
the machine has less free RAM. Installations require at least 1536 MiB after the
host reserve; a run below that limit refuses before cloning or downloading.
An installation container that runs out of memory is reported as `OOMKilled`.
If a local run refuses to start, free memory or use the manually triggered
`Public repository benchmark` workflow in GitHub Actions.
The post-migration npm install uses normal peer-dependency resolution. If it
fails because another package does not support the target SDK, the repository
is recorded as failed with the installation error; the benchmark does not
override peer-dependency conflicts.
The disposable post-migration checkout pins the target SDK to the exact first
release of the new major (for example, `stripe@22.0.0`) so a later minor release
cannot change the benchmark result. Source repositories and their lockfiles are
never edited.

Each entry must satisfy the review and pinning requirements in
`benchmark/repos.json`. A benchmark run is not evidence until it completes and
records results for the full selected corpus. A manifest may include an `env`
object for required test configuration; those values are passed only to the
network-disabled Docker checks. Use literal dummy values such as
`STRIPE_SECRET_KEY: "sk_test_fake"`; real credentials are rejected and must
never be added to a benchmark manifest.

### Run the benchmark on GitHub Actions

Changes to the OpenAI migration, benchmark runner, reviewed corpus, or benchmark
workflow also run the five-repository OpenAI corpus automatically on pull requests
to `main`. The probe and type-derived fixtures have their own path-filtered PR
workflows. Client Action changes run a separate read-only PR check; the reusable
client workflow that can publish PRs is never triggered by a pull request. PR
checks use no repository secrets and retain their reports as workflow artifacts.

After the workflow has reached `main`, open **Actions → Public repository benchmark
→ Run workflow**. Choose one reviewed migration corpus, optionally provide an
exact repository name for a pilot, and start the run. The workflow gives its
token read-only access, checks out without stored Git credentials, runs the
same Docker isolation with a 4096 MiB container cap, and uploads the Markdown
report as a run artifact, including partial results if the job fails. It does
not commit a report or publish a package. Each migration corpus is a separate
manual run. The report is an artifact in the Actions run, not a file written to
your local machine. The job exits unsuccessfully when one or more repositories
fail, while still uploading the report for diagnosis.

## Migration changes

Add migration behavior under `src/migrations/`, register it in the migration
catalog, and cover supported transformations, manual-review cases, package
manifest handling, and real SDK compatibility where available. Do not enable
file writes or the GitHub Action as part of a migration change unless every P1
safety prerequisite has been independently verified.

## Security

Do not commit credentials, `.env` files, downloaded customer repositories, or
benchmark artifacts containing private data. Report vulnerabilities using the
private process in `SECURITY.md`.
