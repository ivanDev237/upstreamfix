# UpstreamFix Action test repository

This small Firebase Admin v13 project is intended to test the read-only migration job and the separate pull-request publication job. Dispatch **UpstreamFix API migrations** in GitHub Actions. The expected result is a new `upstreamfix/firebase-admin-14` branch and a PR to the default branch. Review and run **Client checks** on that branch before merging.

The client test fails if a workflow token or trap variable reaches its process. The source repository pins the reusable workflow and its implementation to one reviewed Git commit.

## Real validation after merging the reviewed PR to `main`

1. Obtain the exact 40-character merge commit from `ivanDev237/upstreamfix` `main`.
2. In this private test repository's `.github/workflows/upstreamfix.yml`, replace **both** `REPLACE_WITH_REVIEWED_MAIN_SHA` values with that same commit. Keep `ci_workflow: ci.yml` and `actions: write` permission; the workflow on `main` must contain these fields before dispatch.
3. Push that workflow to the test repository's `main`, then dispatch **UpstreamFix API migrations** there. The reviewed source reference must pass the `main` ancestry check.
4. Inspect the run: `migrate` has no write token; its client test prints `Client isolation canary absent.` The migration verification deadline and the separate Docker timeout smoke job must pass. `publish` opens or updates `upstreamfix/firebase-admin-14` and dispatches `ci.yml` on that branch only after a new push.
5. Check the PR diff and the dispatched **Client checks** run. Keep the PR open for human review. Do not publish npm or tag a release as part of this validation.
