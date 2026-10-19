# Type-derived compatibility fixtures

Compiled against exact published SDK releases inside network-disabled Docker containers. The generated TypeScript was never executed.

| SDK | Removed symbol | Baseline diagnostics | Target diagnostics | Migrated diagnostics | Result |
|---|---|---|---|---|---|
| stripe 22.4.0 → 23.0.0 | `esm/stripe.esm.node.d.ts:Stripe.PaymentIntentCreateParams.payment_method_types` | [] | [{"line":2,"code":2339}] | manual — no approved rewrite | pass |
| firebase-admin 13.10.0 → 14.0.0 | `lib/index.d.ts:firestore` | [] | [{"line":2,"code":2339}] | [] | pass |

Type errors prove a declaration incompatibility. A passing migrated fixture proves type compatibility only; it does not prove equivalent business behavior.
