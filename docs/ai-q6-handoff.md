# AI-Q6 — reviewer handoff and CI isolation contract

Base: PR #32 merge commit `6e391055833747c4155d58724fa165c67534b288`.

Branch: `feat/ai-q6-next`.

## Scope and sequencing

AI-Q5 (human takeover + atomic settlement) is merged. There is **no source-of-truth AI-Q6 product specification yet** in this repository. Do not infer a new production feature from the stage number, nor ship a speculative implementation.

Before coding, establish one explicit AI-Q6 feature contract: observable behavior, tenant/privacy/plan boundaries, failure and no-charge semantics, and the owner-approved acceptance criteria. Preserve all Q1–Q5 behavior and Git blob hashes of independent reviewer tests.

## One-pass CI plan: no redundant Q1–Q5 suites on the Q6 PR

When the AI-Q6 feature contract is approved and tests are authored, wire these exact Q6-specific files in the existing CI:
- `tests/unit/ai-q6-acceptance.test.ts`: pure policy, input validation and adversarial boundaries.
- `tests/db-boundary/ai-q6-acceptance.test.ts`: actual PostgreSQL, tenant isolation, authorization, atomic failure and concurrency.
- `tests/ai-q6-acceptance.spec.ts`: real widget HTTP browser acceptance on **both** Full and Lite.
- Any extra reviewer-owned Q6 adversarial files explicitly selected by the reviewer.

For `pull_request` when `github.head_ref == 'feat/ai-q6-next'`, run only the Q6 unit, Q6 DB (Full and Lite), and Q6 HTTP browser (Full and Lite) suites, plus lint, TypeScript, Prisma, build, widget and self-host qualifications. Do not redundantly rerun full Q1–Q5 Unit/DB/browser suites. Relevant earlier behavior must instead be asserted through focused Q6 cross-feature cases.

For pushes to `main` and for unrelated PRs, continue the full existing regression and add the Q6 suites there **after those tests exist**. Never weaken or delete previous tests. Preflight must verify exact commands and immutable reviewer blobs.

## Acceptance integrity

Q1–Q5 independent reviewer tests are immutable; the following 21 Git blob hashes are the approved baseline, copied from merged Q5 preflight:

```
tests/unit/ai-q1-contract.test.ts c4ebfd333c3a87b9b8568306e7136b5f63ab9ffe
tests/ai-q1-config.spec.ts da4085c92f5db1f9c447c2d96a065ab25fbf2cd0
tests/unit/ai-q2-policy.test.ts 4ea2e9b52dc6e3e657ccc090dc5c14a092d7fa5a
tests/db-boundary/ai-q2-usage.test.ts aa8959f7337fcf66e0c04decb0af9f765e92733b
tests/ai-q2-usage.spec.ts 9769f4ca8d2779e829e783b0d9c03401935c22ff
tests/unit/ai-q3-faq-contract.test.ts 5038fb8036b8699bb9c048c58a82007ddf6938ba
tests/db-boundary/ai-q3-faq.test.ts fbe9032979f62d3546438725c446aabd2d28f28f
tests/ai-q3-faq.spec.ts 4b73548ba4dab02b551993ae46e3c3d5f8bf2355
tests/unit/ai-q3-faq-adversarial-review.test.ts 83b4441bfb6997db5f79c5762f18c5f9ff00de2f
tests/unit/ai-q4-product-contract.test.ts 219096d2d1dea3535bf33af72859cd3258fcefce
tests/unit/ai-q4-adversarial-review.test.ts 0915c1f18a0e3fb52efbc3356f8801906d3565d8
tests/unit/ai-q4-streaming-adversarial-review.test.ts deb132de5322cffde6fde3cf3ecbda1d9492c3d0
tests/db-boundary/ai-q4-products.test.ts 2b4d03c379910676488e8a796e67a69cd1e0e1ec
tests/db-boundary/ai-q4-snapshot-review.test.ts 22fe6be77853c13f3a2fa007075cb6eec583be18
tests/ai-q4-products.spec.ts 6dbc072903fd00fcacea1f4644a0cd0c4e7fd61f
tests/ai-q4-large-catalog-review.spec.ts 42d8f364fa3f4df656afb9e61eb52563a34efc9f
tests/unit/ai-q5-human-takeover-contract.test.ts 0c907672b31dc896488a3fcab62e0b0c50789634
tests/db-boundary/ai-q5-human-takeover.test.ts 69fe3c6b8aaee6dea744e1d9f6e258848a5405a7
tests/db-boundary/ai-q5-commit-race-review.test.ts 14deb3e698f460a3a4d19392d71cbfff0c3290d4
tests/db-boundary/ai-q5-concurrent-settlement-review.test.ts c9ad1d2c0ddfc006bd1dd15067c478cd6987f2d2
tests/ai-q5-human-takeover.spec.ts ecd0271c38abe39a9ccbaf51ca09a2d1f2620f41
```

No Q6 PR or merge before a real agreed acceptance suite has passed on its exact HEAD.
