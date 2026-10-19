# Declarative migration recipes (experimental)

An SDK publisher can describe a safe subset of an upgrade in YAML. The recipe is data: UpstreamFix never evaluates JavaScript from it. Run a preview first:

```sh
upstreamfix migrate --recipe ./upgrade.yml --cwd ./customer-project
```

Use `--verify` to check the proposed changes in an isolated copy. `--write` retains the ordinary clean Git tree, manual review, verification, and new branch safeguards. A recipe is an explicit experimental opt-in; it is not discovered by `scan` or the GitHub Action.

The [JSON schema](recipe.schema.json) defines the closed set of fields. Unknown fields, duplicate keys, bad package paths, and YAML tags or anchors are rejected. The file limit is 64 KiB. Recipe rules match parsed JavaScript or TypeScript nodes; authors cannot supply regular expressions or executable code. Files with syntax errors are left unchanged. Ambiguous references and overlapping edits become manual review items.

## Fields

`id` must equal `package@toMajor`. `fromMajor` and `toMajor` describe the package transition. `nodeMajor` is the minimum runtime: the project must declare a compatible `engines.node`, or the developer must explicitly pass `--node-runtime <major>` after checking production. The manifest dependency changes only when source edits are safe and the Node requirement is met. `releasedAt`, `title`, and `guideUrl` appear in reports.

Each rule has a lowercase `id` for reporting, a `kind`, and a source `name`. Several patterns can share an `id`; the combination of kind and name must be unique:

| Kind | Other fields | Meaning |
| --- | --- | --- |
| `export-rename` | `to` | Change a named import from the root package, preserving its local name. |
| `import-move` | `from` | Move a single named import to a package subpath. |
| `namespace-call` | `to`, `from` | Replace `sdk.name()` with `to()` and import `to` from the subpath. |
| `chained-namespace-call` | `via`, `to`, `from` | Replace `sdk.via().name()` when both calls have no arguments; calls with arguments stay manual. |
| `namespace-property` | `to`, `from` | Replace `sdk.name`; `to` may be a zero-argument call. |
| `method-rename` | `to`, `receiver` | Rename a call on an imported SDK value named `receiver`. |
| `manual-namespace-call` | `message` | Report `sdk.name()` for human review, without rewriting the file. |

`from` must be the recipe package or one of its subpaths. Complex imports, app-scoped calls, unsupported namespace references, and name collisions require manual work. A green typecheck and the customer's tests remain necessary; a recipe cannot prove semantic equivalence.

## Complete example

```yaml
schemaVersion: 1
id: firebase-admin@14
package: firebase-admin
fromMajor: 13
toMajor: 14
releasedAt: 2026-06-08
title: Firebase Admin 13 to 14
guideUrl: https://firebase.google.com/docs/admin/migrate-node-v10
nodeMajor: 22
rules:
  - kind: namespace-call
    id: service-getter
    name: firestore
    to: getFirestore
    from: firebase-admin/firestore
  - kind: namespace-call
    id: app-lifecycle
    name: initializeApp
    to: initializeApp
    from: firebase-admin/app
  - kind: manual-namespace-call
    id: removed-instance-id
    name: instanceId
    message: 'Instance ID was removed; review the equivalent Installations API.'
```

The repository also includes a [larger Firebase recipe](recipes/firebase-admin-v14.yml). It demonstrates service getters and app lifecycle rules. The built-in migration covers additional Firebase-specific patterns and remains the recommended migration for Firebase customers.
