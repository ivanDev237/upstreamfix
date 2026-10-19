# Firebase Admin declarations: v13.10.0 → v14.0.0

UpstreamFix compared the **published npm tarballs** for these exact versions in [CI run 39181606572](https://github.com/ivanDev237/upstreamfix/actions/runs/39181606572), on Node.js 22 and 24. The comparison verified each tarball's npm integrity value and read only declaration files. No package scripts ran.

The report identified removed declarations from the root entry, including `app`, `auth`, `credential`, `apps`, `firestore`, `database`, `messaging`, and `storage`. It also reported changed signatures such as `initializeApp`. The regression test now asserts the four representative removals `firestore`, `auth`, `credential`, and `apps`.

These are **type-level findings**. Some entries refer to declarations reachable through package export paths, and a text change can be formatting rather than a runtime break. A suggested rename is only a hypothesis; this report alone never authorizes a codemod or a dependency upgrade. Runtime behavior and compatibility still need the vendor guide, compilation, and project tests.
