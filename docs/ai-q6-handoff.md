# AI-Q6 — APPROVED feature contract: deterministic human handoff summary

Approval: the owner approved **deterministic, non-LLM, non-billable summary shown only to authorized human agents**. This document supersedes the earlier unapproved-scope note. Do not invent LLM output, modify Q2 accounting, or create a visitor-visible AI response.

Base: merged AI-Q5 PR #32; `main` merge SHA `6e391055833747c4155d58724fa165c67534b288`.
Existing branch: `feat/ai-q6-next`.

## Product behavior and eligibility

- **Trigger:** After an agent is assigned to a conversation, or upon the first real human agent reply, create a summary of the **pre-takeover** persisted visitor + AI conversation. Both trigger paths must work. The operation must be server-side and tenant-authoritative.
- **Precondition:** At least one actual persisted, text AI reply occurred before human takeover. If none exists, write no summary. No summary while still AI-owned/unassigned with no human reply.
- **Plans:** Pro, Max and Self-hosted are eligible; Free, unknown or malformed plans fail closed. Use the existing effective-plan entitlement source. The summary is not conditioned on today's AI quota, because it is not an AI answer.
- **Facts:** Render bounded deterministic extracts from `Message.content.text` for `senderType: 'contact' | 'ai'` only, with stable chronological `createdAt,id` order. Each included extract MUST reference its persisted source Message ID. Do not invent prices, stock, promises, recommendations or any LLM prose. Do not include agent, system, file or unsupported/malformed content.
- **Memory and text bounds:** At most 30 source message IDs and 3000 characters in the final summary; bounded per-message extract and predictable `truncated` marker. Do not read the entire tenant history unbounded. Malformed or contradictory duplicate IDs fail closed.
- **Idempotency:** Exactly **one first-handoff summary per tenant/conversation**, including parallel assignment/replies, reassignments, repeated notifications and reopening. Persist once atomically with a PostgreSQL uniqueness constraint; never rewrite its first snapshot based on later messages.
- **Security:** Only authenticated staff (agent role or above) in the owning tenant may read it. For foreign conversation IDs use 404; for unauthenticated users use 401/403. The widget public config/messages/history and visitor token NEVER reveal summary data. Render in the agent's **real Inbox** as React text (not `innerHTML`); sanitize untrusted markup.
- **Billing:** No calls to `reserveAiReply`, `commitAiReply`, `releaseAiReply` or paid model providers, and no `AiReplyReservation` or billable `Message(senderType='ai')` created. `AiUsagePeriod.used` and `.reserved` remain unchanged. A previously billed legitimate AI answer retains its earlier charge.
- **Q5 correctness:** AI auto-reply must remain prohibited after human takeover; summary must not pass through the visitor AI pipeline or bypass the `FOR UPDATE` settlement guard. Preserve Q1–Q5 test integrity and tenant isolation.

## Reviewer-selected implementation contracts

The reviewer-owned tests define the following interfaces. Implement these exact exports; don't edit the acceptance suite.

1. `src/lib/ai/handoff-summary-policy.ts`
   - `HandoffSourceMessage`: `{id:string,senderType:string,contentType:string,content:unknown,createdAt:Date}`.
   - `handoffSummaryEligible(planSlug:string,hasTakeover:boolean,aiCount:number):boolean`.
   - `summarizeHandoffMessages(messages:ReadonlyArray<HandoffSourceMessage>): {version:1,text:string,sourceMessageIds:string[],aiMessageCount:number,truncated:boolean}|null`.
   - Stable result regardless of input order; exact-grounded snippets; fail closed for ambiguity/malformed records.
2. `src/lib/ai/handoff-summary.ts`
   - `ensureConversationHandoffSummary(conversationId:string)`, called under `withTenant`, returning persisted summary or `null`.
   - Verify tenant, effective plan, current takeover and eligible pre-takeover AI messages. Concurrency-safe insert-only idempotency. Avoid any billed AI generation.
3. Additive Prisma `ConversationHandoffSummary` model with `id`, `tenantId`, `conversationId`, `summaryText`, `sourceMessageIds` (JSON list), `createdAt`, unique `[tenantId,conversationId]` and proper conversation/tenant relationships. Update the tenant-scoped model registry in `src/lib/db.ts`; the existing registry tests MUST stay green.
4. Authenticated **GET** `/api/conversations/[id]/handoff-summary` returns `{summary:null|{text:string,sourceMessageIds:string[],createdAt:string}}` (HTTP 200). Any unauthenticated access 401/403, other tenant 404, public POST 405 or denied. Do not accept client-supplied summary values.
5. Wire automatic one-time generation after successful **assignment PATCH** and **agent POST reply**, with failure isolated from original human interaction and no new billable AI message. Render stored summary in actual Inbox thread with `data-testid="ai-q6-handoff-summary"`, only after selection, only if a summary exists. Clear on conversation switch; protect against stale fetches.

## Immutable acceptance: Q6 reviewer-owned

- `tests/unit/ai-q6-acceptance.test.ts` — 14 deterministic/safety checks.
- `tests/db-boundary/ai-q6-acceptance.test.ts` — 10 real PG/tenant/quota/concurrency checks in Full + Lite.
- `tests/unit/ai-q6-adversarial-review.test.ts` — 4 identity/provenance/chronology adversarial checks.
- `tests/db-boundary/ai-q6-adversarial-review.test.ts` — 2 real PostgreSQL tests for the 501st AI message and earliest human cutoff in Full + Lite.
- `tests/ai-q6-acceptance.spec.ts` — 8 real HTTP/browser/security/no-charge scenarios in Full + Lite.

Unit test policy and data contract, DB tests assert real uniqueness and no billing, browser tests verify actual dashboard/visitor boundaries. Do **not** create placeholders or change expected hashes. Developer tests may supplement reviewer tests.

## CI — no duplicate Q1–Q5 tests

For PR `feat/ai-q6-next`: ONLY the three Q6 suites above (Unit once, DB Full + Lite, browser Full + Lite) plus lint/TypeScript/Prisma/build/widget qualification/self-host qualification/Q6 preflight. No full Q1/Q2/Q3/Q4/Q5 suite repetition.

For pushes to `main` and unrelated PRs: retain complete existing regression, including Q6. The reviewer preflight pins the **21 previous reviewer-owned files** and the **5 Q6 reviewer files** by their Git blob hashes (27 total).

## Delivery requirements

After implementation, open **one PR** against current `main`. Supply HEAD, changed files, exact Full+Lite counts and CI URLs. Require all four CI jobs and reviewer Q6 preflight on the exact same HEAD. **DO NOT MERGE. DO NOT START Q7.**

## Independent reviewer correction / red acceptance (post-implementation)

- The first Q6 browser acceptance fixture created a *current-period* artificial sent AI row on a Free tenant, then incorrectly asserted AI-Q2 `used = 0`. Q2 correctly backfills all persisted sent AI messages in the current billing window. The reviewer corrected only this synthetic fixture to be **genuinely historical** (`createdAt: 2025-01-01`), preserving the Free-plan denial and zero-current-period-usage assertion. Do not change Q2 accounting to satisfy a mistaken fixture.
- New red reviewer tests reject source IDs unsupported by visible excerpts, contradictory same-ID sender or timestamp, out-of-order older AI facts, an AI answer at message #501 hidden by the first-500-row scan, and post-human messages included because `firstResponseAt` was recorded later than the first agent reply.
- All six Q6 reviewer-owned files are immutable from this handoff onward; never weaken, rename, skip or rehash them in the implementation agent's changes. The Q6 PR must pass 18 focused Unit tests, 16 real PG tests **per edition**, and 8 browser tests **per edition**, without duplicating Q1–Q5 suites.

## Latest independent reviewer invariants — additional unresolved blockers

Reviewer-owned `tests/db-boundary/ai-q6-handoff-invariants-review.test.ts` (4 real PostgreSQL cases) validates:
1. The first valid AI reply at **message 5001** cannot be silently hidden by a 5000-record scan cutoff.
2. A delayed summary retry must exclude messages persisted after the **first assignment**. The production pipeline must retain an immutable authoritative first-assignment timestamp or equivalent transactionally persisted cut-off, not approximate it using the time of the later summary invocation.
3. An **active Free subscription** overrides stale `Tenant.plan='pro'`: no summary.
4. An **active Pro subscription** overrides stale `Tenant.plan='free'`: summary allowed, without new AI charges.

Effective entitlement must match the active-subscription-first logic used in Q2. Do not change Q2 accounting. The reviewer preflight pins all **27** reviewer-owned test blobs. Q6 scoped CI runs **18 Unit**, **16 PostgreSQL per Full/Lite edition**, and **8 browser tests per edition**. No legacy Q1-Q5 suite reruns on this PR.
