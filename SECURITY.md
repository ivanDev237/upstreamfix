# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's
private vulnerability reporting for this repository (Security → Advisories →
Report a vulnerability). Include the affected version, reproduction steps, and
impact. Do not include live credentials or customer data.

If private vulnerability reporting is unavailable, contact the repository
owner privately through GitHub before disclosing the issue publicly.

## Data and execution

UpstreamFix currently runs locally. Preview and migration analysis read source
files, `package.json` manifests, and supported lockfiles in the selected
project. It does not upload project source or environment files to an
UpstreamFix service. Regenerating a supported lockfile may invoke npm, pnpm,
or Yarn and contact the package registry. That subprocess receives a fresh
per-run home/config/cache and a restricted environment without the caller's
tokens; project-specific package-manager config and non-registry dependency
specs are rejected for automatic regeneration.

The optional `--verify` operation requires a Git working tree and copies only
tracked or non-ignored files into a temporary directory. It excludes common
credential files and directories, package-manager configuration, symlinks,
and projects exceeding its copy-size limits. Dependencies are installed with
scripts disabled and a per-run npm cache.

Configured typecheck and test scripts still execute on the local machine. They
are project code and can run arbitrary commands and access the network. The
restricted environment and omitted credentials reduce exposure but do not
sandbox those commands. Only use `--verify` with projects and scripts you trust;
do not run it when the scripts could access production services or perform
external side effects. Dependency installation may contact the package
registry; a cache miss may use the network.

The current GitHub Action is disabled. No hosted service or automatic PR
creation is currently provided. Do not re-enable it until it pushes only the
verified migration branch, keeps reports outside the workspace, prevents
checkout credentials from reaching migration scripts, and documents that it
must never run against untrusted pull request code.
