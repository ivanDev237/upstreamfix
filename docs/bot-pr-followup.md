# Dependency bot PR follow-up

The client repository workflow must subscribe to `repository_dispatch` type `bot-pr-followup` and call the reviewed UpstreamFix reusable workflow, as in `examples/action-test/.github/workflows/upstreamfix.yml`. Its token needs `contents: write`, `pull-requests: write`, `issues: write`, and `actions: read` for the publication job. The analysis job requests only `contents: read` and `pull-requests: read`.

The GitHub App must subscribe to `pull_request` (`opened`, `synchronize`, `reopened`) and have `pull_requests: read`. Existing installations must approve that new permission. Only public repositories and private repositories with an active paid entitlement can dispatch this follow-up. The App checks the live PR and manifest upgrade before dispatching. The client workflow checks them again before checkout and publication.

Currently the catalog contains one follow-up: `firebase-admin` 12 or 13 to 14. The dependency bot must have already updated the package manifest to major 14. The source-only `--source-major 12` or `--source-major 13` mode changes source files, leaving manifests and lockfiles as the bot left them. A target manifest without a Node.js 22 guarantee remains a manual review item. Verification compares the proposed code against the current bot PR head.

For a verified change, the publisher creates or updates `upstreamfix/firebase-admin-14-followup-<PR number>` from the current bot head and opens or updates a PR against the default branch. It never pushes to the dependency bot branch. A single marked comment on the bot PR points to the follow-up. Manual items produce a marked comment and no follow-up PR. On a new bot head, the same branch, PR and comment are updated. A stale dispatch cannot publish. The publisher refuses a branch without a managed bot PR or with an unexpected commit identity.

Review the combined follow-up PR instead of merging the dependency-only PR, because the combined PR contains both the bot's version upgrade and the verified source fix. The workflow does not merge or deploy either PR.
