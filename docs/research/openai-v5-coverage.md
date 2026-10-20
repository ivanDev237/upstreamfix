# openai-node v4 → v5 migration coverage

Source of truth: [official `MIGRATION.md` at the v5.0.0 release commit](https://github.com/openai/openai-node/blob/524080c001a22998cf12b91025187f6993fc66dc/MIGRATION.md) (`524080c001a22998cf12b91025187f6993fc66dc`). This document concerns **v5.0.0**, not the current SDK guide, which can change. “Manual” means an explicit finding that blocks an automatic package upgrade; it is not a claim that the tool can fix the behavior. The guide's migration CLI is an upstream tool, not an SDK breaking change.

| Official guide section | UpstreamFix handling | Evidence |
|---|---|---|
| Environment requirements | Node >=20 must be declared or explicitly confirmed; TypeScript <4.9 and Jest <28 are manual findings. | `test/openai-v5.test.ts` — runtime and tooling tests |
| Web types for `withResponse`, `asResponse`, and `APIError.headers` | `.asResponse().body.pipe(...)` is manual; environment with no DOM or Node Web types is manual. Other Web response uses and `APIError.headers` require additional detection. | `test/openai-v5.test.ts` — Web response and type environment |
| Named path parameters | Listed multi-argument methods are manual; no argument order is guessed. | `test/openai-v5.test.ts` — changed path calls |
| URI encoded path parameters | Direct `encodeURIComponent` in a client call is manual. Indirect pre-encoding remains a gap. | `test/openai-v5.test.ts` — URI encoding |
| Removed request options overloads | Literal request-options objects passed as the sole argument to a listed method are manual. Variables holding options remain a gap. | `test/openai-v5.test.ts` — request options |
| HTTP method naming | Bound `del` calls are renamed to `delete`; multi-path argument calls remain manual. | `test/openai-v5.test.ts` — del-to-delete; `test/openai-real-sdk.test.ts` |
| Removed `httpAgent` in favor of `fetchOptions` | An `httpAgent` option on a direct OpenAI constructor is manual because transport semantics change. Aliased options remain a gap. | `test/openai-v5.test.ts` — semantic changes |
| Changed exports | Known moved subpaths are rewritten; imports from private `openai/core` must be reviewed. | `test/openai-v5.test.ts` — moved re-exports |
| Resource classes | Runtime imports of resource-specific `*Page` classes are manual. Root CommonJS destructuring is manual. | `test/openai-v5.test.ts` — resource classes and unsupported forms |
| uploads exports | Removed `fileFromPath` references are manual before moving the import; other removed uploads exports remain a gap. | `test/openai-v5.test.ts` — all fileFromPath forms |
| APIClient | Imports of the removed `APIClient` base class are manual. | `test/openai-v5.test.ts` — removed APIClient |
| File handling | Every detected `fileFromPath` form is manual; replacement with a stream is a runtime decision. | `test/openai-v5.test.ts` — fileFromPath forms |
| Shims removal | `openai/shims/*` imports are manual pending environment configuration. | `test/openai-v5.test.ts` — unsupported v4 usage |
| Zod helpers optionality error | `.optional()` in a file using `zodResponseFormat` is manual; nullability is a semantic decision. | `test/openai-v5.test.ts` — Zod optionality |
| Pagination changes | `nextPageParams()` and `nextPageInfo()` are manual; asynchronous page iteration is unchanged. | `test/openai-v5.test.ts` — pagination |
| Removed unnecessary classes | Value imports of resource-specific `*Page` classes are manual; type-only imports are left intact. | `test/openai-v5.test.ts` — runtime page classes |
| Beta chat namespace removed | Bound `beta.chat.completions` becomes `chat.completions`, including `parse`, `stream`, and `runTools`; moved type module is rewritten. Unknown receivers are manual. | `test/openai-v5.test.ts` — beta chat, typed/NestJS clients; `test/openai-real-sdk.test.ts` |
| Removed deprecated `.runFunctions` methods | Bound calls are manual because definitions and handling can change. | `test/openai-v5.test.ts` — semantic changes |
| `.runTools()` event / method names | Known event and final-method uses on a tracked runner are manual; listener contracts need review. | `test/openai-v5.test.ts` — runTools event and final names |
| `openai/src` directory removed | `openai/src` and `openai/src/*` imports are manual pending public-export review. | `test/openai-v5.test.ts` — root openai/src |
| TypeScript troubleshooting | Explicitly excluded DOM with no Node types, and undeclared `@types/node` when `process` is used, produce precise manual findings. Browser, Cloudflare Worker, and Bun configurations still need dedicated coverage. | `test/openai-v5.test.ts` — missing Node/Web type environment |

## Promotion status

**Experimental.** The matrix records the official guide and identifies unresolved detection gaps. Promotion additionally requires the 15-repository benchmark, at least 10 repositories with relevant usages, each rule represented, >=80% automatic migration, zero corrupt files, no unexplained typecheck regression, real v5 SDK tests for each rule, and a report from the PR head. The committed benchmark report still covers seven repositories and must not be presented as promotion evidence.
