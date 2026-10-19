# Real Stripe v23 probe on signet

Reviewed commit: `6aae309def8500dae9f60efc6e682a6fef9b169b`.
Baseline and target diagnostics were measured in a temporary copy. TypeScript ran in Docker without network access.

Status: available
Current SDK: 22.4.0
Target SDK: 23.0.0

Candidate: src/lib/spend.ts:243 — Object literal may only specify known properties, but 'payment_method_types' does not exist in type 'PaymentIntentCreateParams'. Did you mean to write 'payment_method'?

A new diagnostic locates a possible incompatibility; it does not prove causality or justify an automatic rewrite.
