# UpstreamFix Action test repository

This small Firebase Admin v13 project is intended to test the read-only migration job and the separate pull-request publication job. Dispatch **UpstreamFix API migrations** in GitHub Actions. The expected result is a new `upstreamfix/firebase-admin-14` branch and a PR to the default branch. Review and run **Client checks** on that branch before merging.

The client test fails if a workflow token or trap variable reaches its process. The source repository pins the reusable workflow and its implementation to one reviewed Git commit.
