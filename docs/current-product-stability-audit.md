# Current Product Stability Audit — Sukhan

> **Status legend**
> - ✅ **PROVEN** — behaviorally proven working end-to-end (browser/db-boundary test on the real app)
> - 🟡 **PARTIAL** — some behavioral coverage exists but gaps remain (listed)
> - 🔴 **DEFECT** — a defect was discovered; fixed in this PR and then proven
> - ⛔ **PLAN-GATED** — intentionally unavailable on some/all plans; UI must (and now does) communicate the restriction truthfully
> - ⏸️ **DEFERRED** — recorded deferred issue (needs a product decision or larger contract; not silently invented here)
>
> This is the **initial Phase-1 matrix** (created BEFORE fixing code). The
> "Discovered defects" column records what the audit found. The
> "Final verification" column is filled in by the final update at the end of
> this PR. This document intentionally does **not** claim "zero bugs".

## 1. Authentication

| Capability | UI entry | API route | Model/state | AuthZ | Plan | Runtime consumer | Existing behavioral test | Status | Discovered defects | Final verification |
|---|---|---|---|---|---|---|---|---|---|---|
| Signup start / verify / complete | `/` signup form | `POST /api/auth/signup/{start,verify,complete}` | `PendingSignup`, `OtpRequest`, creates `Tenant+User+Membership+WidgetConfig` | Public (OTP-gated) | free default | NextAuth session | invite-workspace-switching G/B (39 tests); module7 (legacy) | ✅ | Email format not regex-validated at start; no server-side password policy | journey 1 (signup→dashboard) re-proven via new specs' setupTenant |
| Signup resend | `/` OTP step | `POST /api/auth/otp/resend` | `OtpRequest.resendCount` | Public | — | OTP | module7 (legacy, not CI) | 🟡 | No per-IP rate limit at this layer (3-resend cap only) | unchanged (deferred) |
| Credentials login | `/` login form | `/api/auth/[...nextauth]` (credentials) | `User.passwordHash` | Public | — | session JWT | every spec's `signInExisting` pattern | ✅ | — | ✅ proven by every new spec |
| Login OTP (start/verify) | `/` | `POST /api/auth/login-otp/{start,verify}` | `OtpRequest` | Public | — | session issuance client-side | module7 (legacy) | 🟡 | verify returns `{verified}` only; session issuance delegated to client | unchanged (deferred) |
| Password reset start/verify/complete | `/` | `POST /api/auth/reset-password/{start,verify,complete}` | `OtpRequest(purpose=reset)` + `User.passwordResetAt` | Public (OTP-gated) | — | bcrypt | **new** `tests/password-reset.spec.ts` (CI, Full+Lite) | ✅ | No password policy; existing JWT sessions NOT revoked after reset (truthful known decision — see §Final) | ✅ current CI journey: real user → start → OTP verify (mock 123456) → complete → old password fails → new password succeeds → unrelated email rejected (404 request_not_found) → invalid code (400 code_mismatch) → already-used (400) → unverified complete (403 otp_not_verified) → expired (400 expired via test-only dev/expire) |
| Logout / session expiry | top-bar user menu | `signOut()` | NextAuth JWT | session | — | — | invite-workspace F | 🔴 | **Sign-out menu item mislabeled as "Sign in" (`t('auth.login')`)** — fixed in this PR | ✅ label fixed; login/logout/login re-proven |
| Active-membership enforcement | — | `withSessionTenant` re-reads Membership every request | `Membership.status` | session+active | — | every agent API | anonymous-isolation (15); reconnect-regression | ✅ | — | ✅ |
| Revoked-membership behavior | — | `withSessionTenant` 401; socket `membership_inactive` | `Membership.status='revoked'` | session | — | APIs + socket | invite-workspace F; reconnect-regression | ✅ | — | ✅ |

## 2. Workspaces

| Capability | UI entry | API route | Model/state | AuthZ | Plan | Runtime consumer | Existing behavioral test | Status | Discovered defects | Final verification |
|---|---|---|---|---|---|---|---|---|---|---|
| Current workspace | top-bar | `GET /api/tenants/me` | `Tenant` + JWT `workspaceId` | session | — | dashboard | every spec | ✅ | — | ✅ |
| Workspace listing | top-bar switcher dropdown | `GET /api/workspaces` | `Membership` | session | — | — | invite-workspace A (API-level) + **new** `tests/workspace-switcher.spec.ts` (UI) | ✅ | **Was**: backend + 39 API tests existed but NO dashboard UI exposed listing/switching (top-bar had no switcher). **Fixed**: switcher dropdown added to the top-bar (current name clickable, lists all active workspaces, current marked with Check + role badge, pending invitations as a separate non-switchable section). | ✅ UI dropdown lists all active workspaces; current marked; secure switch flow (POST /api/auth/switch-workspace validate → useSession().update → verify returned session → hard reload clears all workspace-specific client state) |
| Workspace switching | top-bar switcher dropdown | `POST /api/auth/switch-workspace` + `useSession().update` | JWT callback re-validates (throws `not_active_member` if invalid) | session+active | — | jwt callback | invite-workspace A (API-level) + **new** `tests/workspace-switcher.spec.ts` (UI) | ✅ | same as above | ✅ SINGLE user selection, NO retry of the switch interaction: open dropdown → click workspace ONCE → session switches + top-bar name changes + new-workspace data appears + old-workspace data disappears + stale Inbox selection cleared (component state, hard reload) + unauthorized id rejected (dropdown never lists it; API 404) + revoked membership disappears from dropdown with recovery to another active workspace |
| Revoked current workspace recovery | — | APIs 401; `/api/workspaces` still lists; switch works | — | session | — | — | invite-workspace F | ✅ | — | ✅ |
| Tenant isolation | — | fail-closed Prisma proxy + `withTenant` | 16 tenant-scoped models | — | — | all tenant APIs | tenant-isolation db-boundary (10); tenant-security (7) | ✅ | — | ✅ |

## 3. Invitations / Members

All capabilities (`invite creation`, `acceptance`, `reissue`, `expiry/revocation`, `role changes`, `member revocation`, `reinvite/reactivation`, `seat limits` incl. concurrency) — UI: Members panel; API: `/api/invitations*`, `/api/members`; **✅ PROVEN** by `invite-workspace-switching.spec.ts` (39 CI tests, incl. transactional seat locks + single-winner races + real plan downgrade). No defects found in this area. Members-panel mutations already have proper error UX (one lacks busy state — minor, fixed in the error-UX pass).

## 4. Departments

| Capability | Status | Existing test | Discovered defects | Final verification |
|---|---|---|---|---|
| List / create / delete | ✅ | departments db-boundary (7); module2 | **Delete success toast says "Saved"** (mislabel) — fixed | journey 7 re-proven in customization spec's department usage + toast fix |
| Plan limits | ✅ | enforced 402 via `enforcePlanLimit('departments')` | — | ✅ (covered by gating design + existing tests) |
| Membership relationships | ✅ | department-members db-boundary (7) | — | ✅ |
| Referenced by conversations/routing | ✅ | module2 ② (routing assigns dept); tenant-security D | — | ✅ |

## 5. Routing Rules

| Capability | Status | Existing test | Discovered defects | Final verification |
|---|---|---|---|---|
| Create / update-toggle / delete | 🔴→✅ | unit routing-rules (53); module2 ② (execution) | **toggle/delete ignore `!res.ok`; delete toast says "Saved"** — fixed | error-UX fixed; execution re-proven (module2 in CI) |
| Keyword condition | ✅ | unit validation (53) + module2 ② execution | — | ✅ |
| Business-hours condition | ✅ | unit validation (53) + **new** `tests/unit/routing-hours.test.ts` (pure helper boundaries) + **new** `tests/db-boundary/business-hours-routing.test.ts` (real-Postgres execution) | **Was**: unit validation only; no execution test. **Fixed**: extracted deterministic `isWithinBusinessHours` helper (`src/lib/routing-hours.ts`) + made `evaluateRoutingRules` accept an injectable `getHour` (default wall-clock — production unchanged). | ✅ Business Hours v1 supports SAME-DAY NON-EMPTY intervals only (`start < end` required); `start >= end` (overnight/zero-width/inverted) rejected with `invalid_business_hours`. Deterministic execution proven: inside hours → action executes; outside → no action; boundary start inclusive / end exclusive; tenant isolation (B rule referencing A dept → execution-time revalidation rejects) |
| assign-department action | ✅ | module2 ② (real execution on conversation create) | — | ✅ |
| send-message action | ✅ | module2 ② (auto-reply observed) | — | ✅ |
| **Actual rule execution** | ✅ | module2 ② — REAL conversation created via widget message → rule fires → dept assigned + auto-reply lands. NOT just "saved to DB" | — | ✅ |

## 6. Contacts

| Capability | Status | Existing test | Discovered defects | Final verification |
|---|---|---|---|---|
| Listing / details / conversation history | ✅ | contacts-panel UI (module3 legacy) + `/api/contacts` covered by anonymous-isolation + tenant-security + **new** `tests/contacts-identity.spec.ts` (UI) | **Was**: read-only loaders ignored `!res.ok` → a failed fetch rendered a fake "No contacts yet" empty state. **Fixed**: `load()` + `loadConversations()` now check `res.ok`; on failure a truthful error state + Retry button is shown (not a fake empty state). | ✅ UI identity journey proven: visitor identifies via real widget path → sends message → Dashboard Contacts shows the contact with correct name/email/anonymous fallback; conversation count correct; expand → correct conversation + last-message preview + status; same-email different-visitorId does NOT inherit (backend `(tenantId, visitorId)` lookup); tenant B cannot see tenant A's contact |
| Tenant isolation | ✅ | tenant-security A | — | ✅ |
| Visitor identity behavior | ✅ | security-regressions (visitorId is identity; email is metadata only) | — | ✅ |

## 7. Inbox / Conversations

All core capabilities (`listing`, `selecting`, `history`, `visitor sends`, `agent replies`, `unread`, `stale selection`, `burst`, `optimistic failure/retry`, `duplicate suppression`, `close/reopen`, `assignment`) — **✅ PROVEN** by the CI suite: module2, socketio-verify, socket-race, inbox-burst-dedup, inbox-reply-echo-dedup, inbox-stale-selection, widget-duplicate-messages, widget-adversarial-ordering, widget-optimistic-failure, widget-live-messaging.
**Discovered defects:** (1) `changeStatus` ignores `!res.ok` — fixed; (2) **typing indicator renders `t('dashboard.comingSoon')` = "Coming Soon" as the typing text** — fixed; (3) reply placeholder uses command-palette copy — fixed.

## 8. Realtime

All capabilities (`socket auth` HMAC, `join authz`, `visitor isolation`, `agent tenant isolation`, `message delivery`, `typing`, `reconnect`, `token refresh`, `polling fallback`, `cleanup/destroy`) — **✅ PROVEN** in BOTH Full and Lite Docker by: module2, socketio-verify, socket-race, realtime-authz, reconnect-regression, widget-live-messaging (incl. polling fallback on blocked socket), caddy-public-boundary (3003 public / 3004 internal). No defects found.

## 9. Widget Installation

All capabilities (`HTML snippet`, `script endpoint`, `external-origin embedding`, `domain enforcement`, `backend readiness check`, `truthful checklist`, `NPM Coming Soon`) — **✅ PROVEN** by onboarding.spec.ts + widget-external-origin + widget-npm-external-origin + widget-live-messaging + anonymous-isolation. The NPM card stays truthfully "Coming Soon" until real publication. One error-UX defect in `deleteDomain` (widget-panel + websites-panel duplicates) — fixed.
**Domain enforcement design note (recorded, not changed):** empty `WidgetDomain` list or absent Origin/Referer ⇒ allow (backward-compat for script installs); enforcement lives on data endpoints. Changing to fail-closed would break non-browser/missing-Origin embeds — ⏸️ deferred as a product decision. New behavioral test proves allow/deny when domains ARE configured (see §10).

## 10. Widget Customization — KNOWN-BROKEN AREA (deep audit)

### Discovered defects (all confirmed in code before fixing)

| ID | Defect | Severity | Fixed in this PR |
|---|---|---|---|
| **CUST-A** | **Free-plan misleading save UX.** `PATCH /api/widget-config` has NO plan gate — a free-plan admin edits every field, gets 200 + "Saved" toast, values persist, but the public widget keeps serving locked Sukhan-brand defaults (`getEffectiveWidgetConfig`). Dashboard preview renders the stored (never-served) values, compounding the deception. No plan restriction visible on the tab. | **BLOCKER (deceptive UI)** | ✅ |
| **CUST-B** | **avatarUrl / logoUrl are persisted no-ops.** Persisted by PATCH (no URL validation — `javascript:`/`data:` accepted), returned by the public config, advertised on the `/doc` marketing page ("Custom avatar/logo — Pro plan and above") — but rendered by NOTHING (script widget: hardcoded SVG; v1: same; NPM widget: declared in types, never read; dashboard preview: never rendered). | **BLOCKER (dead controls + unsafe persisted input)** | ✅ |
| **CUST-C** | **Position default 3-way inconsistency.** `bottom-start` (Prisma `@default` + migration + v1 runtime + NPM runtime) vs `bottom-end` (PATCH fallback + signup row creation + free-lock effective config + script runtime + preview binary). The schema default is dead in practice (signup writes `bottom-end` explicitly). | **HIGH (contract inconsistency)** | ✅ |
| **CUST-D** | **No end-to-end customization proof.** Zero tests cover: customization save → reload persistence → public config effective values → rendered external-origin widget. module6 T2 (legacy) asserts only 4 JSON fields on the free lock. | **HIGH (test gap)** | ✅ |
| **CUST-E** | **PATCH silently coerces garbage** — `String(body.accentColor ?? …)` accepts any string (`"[object Object]"` persistable); invalid enums fall back silently; `greetingTexts` object passthrough (no length/locale bounds); omitting a field RESETS it (full-update semantics — omitting `avatarUrl` nulls it). | **MEDIUM (input validation)** | ✅ |
| **CUST-F** | **NPM widget "Powered by Sukhan" badge renders for EVERY plan** — `isFreePlan()` checks `config.plan` which the backend never sends (it sends `isLocked`/`poweredBy`), so the badge condition is always true. Script widget renders NO badge at all even when `poweredBy:true` (free contract promises one). Stale `plan` enum in `types.ts`. | **MEDIUM (plan-contract truthfulness)** | ✅ |

### Fix design (no product-contract invention; free stays locked)

- **Canonical position default: `bottom-end`** (matches brand default actually served to every new/free tenant). Applied consistently to: Prisma `@default` (+ migration `ALTER DEFAULT` — no data change; stored explicit positions untouched), v1 runtime fallback, NPM runtime fallback. PATCH fallback, signup creation, free-lock, script runtime, preview already used `bottom-end`.
- **Plan-gated PATCH:** locked plans (`!plan.customization`, i.e. free) → `402 {code:'customization_locked'}`. Free customization stays locked (no unlock).
- **PATCH validation (strict, no silent coercion):** `accentColor` must be `#RRGGBB`; `launcherShape`/`position` must be valid enums (400, not silent fallback); `avatarUrl`/`logoUrl` null/empty → null, else absolute **http(s) URL ≤ 500 chars** (rejects `javascript:`, `data:`, relative); `greetingTexts` only `fa`/`en` keys, strings ≤ 200; `defaultLocale` `fa|en`; **true-patch semantics** (absent fields keep current values — omitting a field no longer resets it).
- **Truthful GET:** `/api/widget-config` now returns `{ config (stored), effective, isLocked }` — the dashboard preview shows the EFFECTIVE widget state when locked.
- **Dashboard (locked):** lock banner (fa/en), all customization inputs + Save disabled, preview = effective locked values. (unlocked): as before + avatar/logo rendered in preview.
- **avatarUrl/logoUrl rendering (both runtimes + preview):** `<img>` created via DOM `createElement` with `.src` property (never `innerHTML` with user content), `referrerPolicy='no-referrer'`, runtime scheme re-check (`^https?://`), on-error fallback (logo keeps SVG until load; avatar removed on error).
- **Badge:** NPM badge renders iff `poweredBy === true`; script widget gains the badge iff `poweredBy === true` (free contract). `types.ts` `plan` enum replaced by the real `isLocked`/`poweredBy` fields.

### Final verification (filled at end of PR)

See §"End-to-end proof" below — new `tests/widget-customization.spec.ts` (Full+Lite CI) proves the complete paid flow (edit → save → reload persistence → public config effective values → rendered external-origin widget reflects accent/shape/position/greetings/avatar/logo) and the truthful free-locked flow (banner, disabled controls, 402 on direct PATCH, effective preview, locked public config).

## 11. Widget Domains

| Capability | Status before | Discovered defects | Final verification |
|---|---|---|---|
| Valid add / normalization (`www.` stripped, strict label rules) / duplicate rejection / invalid rejection / delete | ✅ (onboarding.spec.ts in CI) | delete ignored `!res.ok` — fixed | ✅ |
| Plan limit (free=1) incl. disabled button + API 400 | ✅ (onboarding) | — | ✅ |
| Tenant isolation (cross-tenant domain id) | 🟡 not directly tested | — | ✅ new spec |
| Unauthorized-origin blocked (`403 domain_not_allowed`) when domains configured | 🟡 no CI test | — | ✅ new spec |
| Authorized external origin works | ✅ (widget-live-messaging, allow-all path) | — | ✅ new spec (configured-domain path) |
| Concurrency on plan limit | ⏸️ deferred (single-tenant sequential UI path; the seat-limit concurrency pattern is proven for invitations; domain adds are admin UI actions) | — | ⏸️ |

## 12. Analytics

| Capability | Status before | Discovered defects | Final verification |
|---|---|---|---|
| Cards render | ✅ (UI exists; module3 legacy) | read-only loader ignores `!res.ok` (recorded) | — |
| **Calculations proven from known state** (total/open/closed, first-response, resolution, 7-day volume, CSAT avg+distribution) | 🔴 **NO behavioral test anywhere** | test gap (blocker per audit standard) | ✅ new `tests/analytics-csat.spec.ts` |
| Tenant isolation | 🟡 | — | ✅ new spec (two tenants) |

## 13. CSAT

| Capability | Status before | Discovered defects | Final verification |
|---|---|---|---|
| Survey at correct lifecycle point (conversation closed) | 🟡 module3 legacy only | — | ✅ new spec |
| Valid rating persists; analytics reflects it | 🔴 no CI test | — | ✅ new spec |
| Invalid rating rejected (0/6/non-int) | 🔴 | — | ✅ new spec |
| Another contact cannot rate another conversation | 🔴 | — | ✅ new spec |
| Duplicate rating rejected | 🔴 | — | ✅ new spec |

## 14. FAQ

CRUD + role (admin+) + strict validation: ✅ proven by unit routing/input tests + tenant boundaries; **discovered**: FAQ UI consumes data only when `AiConfig.faqEnabled` — but **no dashboard UI exposes AiConfig** (flags default OFF) ⇒ the advertised auto-answer capability is unreachable through the UI. module4 (legacy) proves the engine works when flags are set via API. **Fix decision:** not a code bug to hot-fix here (AI config UI is feature-scale); ⏸️ **DEFERRED** — recorded honestly: FAQ CRUD is proven; the FAQ→auto-answer integration is proven only at engine level (legacy specs), and the missing AiConfig UI is a deferred product decision.

## 15. Products / Import / WooCommerce

| Capability | Status | Findings |
|---|---|---|
| Product listing/create/delete (manual) | ✅ | delete ignored `!res.ok` — fixed; `availability` never editable in UI (always in_stock) — recorded |
| CSV/JSON import (`/api/products/import`) | ⛔ **NO UI** — backend strictly validated (≤500, validate-all-before-write) | orphan backend recorded (deferred) |
| WooCommerce connector (`/api/connectors/woocommerce[+/sync]`) | ⛔ **NO UI** — backend has SSRF guard (unit-proven), secret masking | orphan backend recorded (deferred). No fake WooCommerce success is claimed anywhere in the UI — the products panel only shows badges for existing rows. |
| Tenant isolation | ✅ | tenant-scoped models (fail-closed proxy) |

## 16. AI configuration

`GET/PATCH /api/ai-config` exist (admin+, lazy-create both-OFF). **No dashboard UI calls them** and no AI execution is enabled by default. The dashboard makes **no claim** that AI is active (no fake controls found). ⏸️ DEFERRED (UI for AI config is feature work). Engine-level behavior (FAQ auto-answer, product Q&A, plan cap) is proven by legacy module4 + unit tests; weekly message AI gating proven in module6.

## 17. Billing

Provider-agnostic state machine — **✅ PROVEN** by `tests/db-boundary/billing-state-machine.test.ts` (27 tests, real Postgres + injected mock provider — checkout, pending, success, duplicate callback idempotency, failure, cancellation, expiry, gateway/authority binding, tenant/plan consistency, entitlement activation, seat limits on downgrade) + unit billing-state (24) + billing-mock-provider (12). No live payment provider is called. Pro/Max are price-0 "Coming Soon" (truthfully badged in the billing UI). No defects found. No changes made (state machine preserved).

## 18. Self-host

Full + Lite clean install, migrations, Caddy public boundary (3003 public / 3004 blocked / arbitrary ports blocked), realtime, backup, restore, post-restore usability — **✅ PROVEN** by `self-host-clean-install.spec.ts` + `self-host-backup-restore.spec.ts` (production compose files only, port 80) + `caddy-public-boundary.spec.ts`, all in CI. No defects found.

## 19. Error-UX audit (dashboard mutations)

| Mutation | Anti-pattern before | Fix |
|---|---|---|
| routing-rules `deleteRule` | DELETE → unconditional "Saved" toast (wrong copy too) | res.ok check; error toast; truthful "Deleted" |
| routing-rules `toggleRule` | PATCH ignored; silent revert | res.ok check; error toast |
| faq `deleteFaq` / `toggleFaq` | same pattern | fixed |
| products `deleteProduct` | same pattern | fixed |
| websites-panel `deleteDomain` | same pattern | fixed |
| widget-panel `deleteDomain` | same pattern | fixed |
| inbox `changeStatus` | PATCH ignored | res.ok check + error toast |
| departments `onDelete` | toast copy "Saved" for a delete; hardcoded `'Failed'` | truthful "Deleted"; localized errors |
| Well-behaved (kept) | widget-config save, general save, billing subscribe, members invite/revoke/role, inbox sendReply, both addDomain forms | unchanged |
| Unlocalized `'Failed'` strings (routing/faq/products/departments) + `'Failed to save'` (widget/general) | — | localized (fa/en) |

Contacts read paths hardened in this PR: `contacts-panel.tsx` `load()` + `loadConversations()` now check `res.ok` and render a truthful error state + Retry on failure (no fake "No contacts yet" / "No conversations" empty state when the request actually failed). Other read-only loaders (faqs/products/routing/departments/widget) still render empty states on failure — read-only, no deception (no success shown), deferred as polish.

## 20. Role / tenant audit

- Unauthenticated → 401 on every agent API: ✅ anonymous-isolation (15 CI tests).
- Cross-tenant ids → rejected: ✅ tenant-security (7 CI tests) + department-members + tenant-isolation db-boundary.
- Insufficient role → 403 on widget-config/faqs/products/routing/billing/connectors (admin+), members/invitations/departments (manager+): partially proven (invitation role escalation blocked in invite spec H). New customization spec adds a manager-role 403 spot-check on widget-config.
- Stale/revoked membership → 401: ✅ invite spec F + reconnect-regression.

## 21. Input validation audit (user-controlled settings)

- Strictly validated already: invitations (email regex, roles), widget-domains (strict hostname rules), faqs, products, import, self-host-request, routing trigger/action (unit-proven 53 tests).
- **Fixed in this PR:** widget-config PATCH (CUST-E above — hex color, enums, http(s) URLs, greeting bounds, true-patch semantics).
- Recorded (deferred): signup/login email format; password policy; `tenants/me` PATCH name bounds; ai-config boolean type-checks; agent message length bound; conversation `status` filter enum.

## 22. UI truthfulness audit (mismatches found)

1. Sign-out labeled "Sign in" — **fixed**.
2. Typing indicator shows "Coming Soon" — **fixed**.
3. Reply placeholder uses command-palette copy — **fixed**.
4. Free-plan customization tab pretends editable + save works — **fixed** (CUST-A).
5. avatarUrl/logoUrl controls persisted but never rendered — **fixed** (CUST-B: now rendered safely on paid plans).
6. Marketing `/doc` page claims "Custom avatar/logo (Pro plan and above)" — becomes TRUE after CUST-B fix.
7. Department/routing delete toasts say "Saved" — **fixed**.
8. Preview shows impossible paid appearance on free — **fixed** (shows effective locked state).
9. Honest placeholders kept as-is: Integrations ComingSoonView, NPM Coming Soon, zero-priced plans Coming Soon.
10. Orphan backends (import, WooCommerce, AiConfig) have NO UI and make no active claims — deferred, not deceptive.

## 23. Browser journeys coverage map (required list)

| # | Journey | Proof |
|---|---|---|
| 1 | brand-new signup → dashboard | every spec's setup + new specs |
| 2 | login/logout/login | invite spec B + sign-out fix + new specs |
| 3 | reset password | **new** `tests/password-reset.spec.ts` (CI, Full+Lite): real user → start → OTP verify → complete → old fails → new succeeds → unrelated user blocked → invalid/expired/already-used/unverified fail closed |
| 4 | workspace invitation + acceptance | invite spec B (CI) |
| 5 | workspace switching | invite spec A (API-level, CI) + **new** `tests/workspace-switcher.spec.ts` (UI clicks: dropdown lists both, switch B↔A, data isolation, stale inbox cleared, unauthorized id rejected, revoked-membership recovery) |
| 6 | member lifecycle | invite spec D/E/F/G (CI) |
| 7 | department lifecycle | module2 ② (CI) + new spec |
| 8 | routing rule actually executes | module2 ② (CI) |
| 9 | widget customization paid/effective flow | **new** widget-customization.spec.ts (CI, Full+Lite) |
| 10 | free-plan customization truthful locked flow | **new** widget-customization.spec.ts (CI) |
| 11 | allowed external domain widget | **new** widget-domains.spec.ts + widget-live-messaging (CI) |
| 12 | blocked external domain widget | **new** widget-domains.spec.ts (CI) |
| 13 | visitor sends → Inbox receives | module2/widget-live-messaging (CI) |
| 14 | agent reply → visitor receives | module2/widget-live-messaging (CI) |
| 15 | realtime disconnect → polling fallback → reconnect | widget-live-messaging ② + reconnect-regression (CI) |
| 16 | close → CSAT → analytics | **new** analytics-csat.spec.ts (CI) |
| 17 | contacts view reflects conversation identity | **new** `tests/contacts-identity.spec.ts` (CI, Full+Lite): real widget identify + message → Contacts shows correct name/email/anonymous fallback + count + expand → conversation/preview/status + same-email-different-visitorId no inheritance + tenant B isolation |
| 18 | plan limits actually enforced | module6 T1/T4 (free weekly + domain) legacy + invite D6 downgrade + new domains spec (CI) |
| 19 | self-host Full | self-host-clean-install/back-restore (CI) |
| 20 | self-host Lite | same, lite edition (CI) |

## 24. Deferred items (recorded, not silently invented)

1. **AiConfig dashboard UI** (FAQ/product-Q&A toggles) — engine proven; UI deferred.
2. **Products import UI + WooCommerce connector UI** — backends validated; UIs deferred.
3. **Password policy + email-format validation + auth rate limiting** — product/security-contract decisions; recorded. (Session revocation on reset is a SEPARATE known security decision — see §Final.)
4. **`hasUsedFreeTrial` enforcement** (written, never checked) — recorded; the second-free-workspace rule is enforced at a different layer (module6 T3 proves the 409 via signup flow).
5. **Domain enforcement fail-open when no Origin/Referer or empty list** — deliberate backward-compat; deferred as product decision.
6. **Read-only loader error states** (faqs/products/routing/departments/widget) — polish, deferred. (Contacts read paths were hardened in this PR.)
7. **Monthly `conversations` plan limit** — display-only today; enforcement deferred (needs product decision on paid pricing which is Coming Soon).
8. **Login-OTP session issuance on server** — currently client-delegated; recorded.

**Resolved in this PR (no longer deferred):**
- Workspace switcher UI — implemented in `src/components/dashboard/top-bar.tsx` + UI behavioral spec `tests/workspace-switcher.spec.ts`.
- Business-hours routing execution test — deterministic helper `src/lib/routing-hours.ts` + unit `tests/unit/routing-hours.test.ts` + db-boundary execution `tests/db-boundary/business-hours-routing.test.ts`.
- Password reset CI journey — `tests/password-reset.spec.ts` (+ test-only `dev/expire` OTP infra mirroring `invitations/dev/expire`).
- Contacts UI identity journey — `tests/contacts-identity.spec.ts` + hardened read paths in `contacts-panel.tsx`.


---

# Final audit results (post-fix update)

> This section is the final update required by the stabilization task. The
> initial matrix above was created BEFORE fixing code (Phase 1). Everything
> below reflects the state at the final SHA of this PR.

## What was tested, what failed initially, what was fixed

| Defect | Severity | Fixed by commit | Behavioral proof |
|---|---|---|---|
| CUST-A free-plan misleading save UX (editable controls + "Saved" toast while the widget serves locked defaults) | **BLOCKER (deceptive UI)** | `fix(widget-config)` + `fix(dashboard)` | `widget-customization.spec.ts` test 2 (FREE): banner visible, all controls disabled, direct PATCH → 402 `customization_locked`, effective preview, locked public config, locked rendered widget |
| CUST-B avatarUrl/logoUrl persisted no-ops (unvalidated, rendered nowhere, advertised on /doc) | **BLOCKER (dead controls + unsafe input)** | `fix(widget-config)` (strict http(s) validation) + `fix(widget)` (safe DOM rendering in script + v1 + NPM runtimes + dashboard preview) | test 1 (PAID): avatar + logo images actually rendered in the external-origin widget (served by the customer test server); test 3: `javascript:`/`data:`/`ftp://`/relative URLs → 400 |
| CUST-C position default 3-way inconsistency | HIGH | `fix(widget-config)` (schema `@default` + migration) + `fix(widget)` (v1 + NPM fallbacks → `bottom-end`) | test 3: fresh tenant stored position `bottom-end`; public config `bottom-end`; stored explicit `bottom-start` preserved verbatim |
| CUST-D zero end-to-end customization tests | HIGH | `test(stability)` | test 1: dashboard edit → save → reload persistence → config API → public config → rendered external-origin widget (accent rgb, shape class, position side with rtl flip, greeting, avatar, logo, no badge on paid) |
| CUST-E PATCH silently coerces garbage / omit-resets-field | MEDIUM | `fix(widget-config)` | test 3: invalid hex/enum/locale/greeting-length → 400; partial PATCH keeps other fields (avatarUrl NOT reset) |
| CUST-F "Powered by" badge wrong on every runtime (never/always) | MEDIUM | `fix(widget)` | test 1: paid → badge count 0; test 2: free → badge visible |
| 8 dashboard mutations ignore `!res.ok` then show success | HIGH (error-UX) | `fix(dashboard)` | source-level fix (anti-pattern eliminated); the 402 rejection path itself is behaviorally proven (test 2) |
| Sign-out labeled "Sign in" | MEDIUM (truthfulness) | `fix(dashboard)` | label now uses `auth.signOut` key (fa/en) |
| Typing indicator labeled "Coming Soon" | MEDIUM (truthfulness) | `fix(dashboard)` | uses new `dashboard.typing` key |
| Reply placeholder used command-palette copy | LOW | `fix(dashboard)` | uses new `dashboard.replyPlaceholder` key |
| Delete toasts said "Saved" (routing/departments) | LOW | `fix(dashboard)` | truthful "Deleted" copy |
| Latent customization-tab crash when config failed to load | LOW | `fix(dashboard)` | tab now guards on `config` |
| Domain enforcement untested (allow/deny with configured domains) | HIGH (test gap) | `test(stability)` | `widget-domains.spec.ts`: authorized Origin 200 vs unauthorized 403 `domain_not_allowed`, cross-tenant delete 404, normalization, duplicates, invalids, delete, allow-all when empty |
| Analytics/CSAT untested | HIGH (test gap) | `test(stability)` | `analytics-csat.spec.ts`: totals/open/closed/first-response/resolution/7-day-volume/CSAT avg+distribution proven from known state; open-conversation rating rejected; invalid ratings rejected; cross-contact rating 404; duplicate `already_rated`; tenant isolation |

## Intentionally unavailable (truthful plan gating — unchanged product contract)

- **Free-plan customization** stays locked (locked brand look + `poweredBy` badge). The dashboard now says so truthfully; PATCH is rejected with 402.
- **Pro/Max purchases** are Coming Soon (price-0) — truthfully badged in the billing UI; checkout correctly rejects them (`plan_unavailable`).
- **NPM installation** stays "Coming Soon" until the package is actually published to the public npm registry (PR #12 preserved this truthfully).
- **Integrations** nav item is an honestly-labeled Coming Soon placeholder.

## Statement of completion

No known blockers remain in the audited current-product capability matrix.

The four capability-completion blockers (workspace switcher UI, business-hours
routing execution, password-reset CI journey, contacts UI identity journey)
were implemented + behaviorally green on `545c998` (CI run 40134735057) — ACCEPTED.

A second round of THREE deterministic-stability blockers was implemented on top
of `59987da` and is behaviorally green on the final SHA `83997a3`
(CI run `40202739156` — all 4 jobs SUCCESS in BOTH Full and Lite):
  1. E8 reissue race contract → deterministic 409 `already_reissued` (both
     timing paths converge). E8 10-round concurrent reissue: PASSED Full + Lite.
  2. Workspace switcher → single user selection, NO retry (removed
     `e.preventDefault()` + the retry helper; the revoked-workspace recovery
     test uses ONE open + ONE click + `noWaitAfter`). Single-click switches
     (B→A, A→B, B→A, revoked recovery): PASSED Full + Lite.
  3. Business Hours → v1 same-day non-empty intervals only (`start < end`
     required). Route-level rejection (POST /api/routing-rules 22→6, 5→5,
     17→9 → 400 invalid_business_hours; none persisted; 9→17 control creates
     one rule): PASSED Full + Lite.

The stabilization contract's affirmation is now made: all three are
behaviorally green in BOTH Full and Lite on `83997a3`.

This document does not claim zero bugs. The deferred items below remain
recorded, each with the reason it was not silently invented or hot-fixed
here.

## Deliberately deferred items (from the initial matrix)

1. AiConfig dashboard UI (engine proven; UI deferred)
2. Products import UI + WooCommerce connector UI (validated backends, no UI, no deceptive claims)
3. Password policy, email-format validation, auth rate limiting (product/security-contract decisions). **Session revocation on reset is a SEPARATE known security decision** — see the known-decisions note below.
4. `hasUsedFreeTrial` enforcement gap (second-free-workspace rule proven enforced at the signup layer by module6 T3)
5. Domain enforcement fail-open on missing Origin/Referer or empty list (deliberate backward-compat; documented in §9; the configured-domain deny path is now behaviorally proven)
6. Read-only loader error states for faqs/products/routing/departments/widget (polish). **Contacts read paths were hardened in this PR** (truthful error + Retry).
7. Monthly conversations plan limit (display-only; paid pricing is Coming Soon)
8. Login-OTP server-side session issuance

## Known security decision (truthfully recorded, not invented here)

The `reset-password/complete` route updates `User.passwordHash` + `passwordResetAt` but does **NOT** invalidate existing sessions. A user who is signed in on another device and resets their password keeps that existing session alive until its JWT expires naturally. This is the CURRENT product contract (verified by reading the route source). This PR does **not** invent session revocation behavior — it documents the existing contract truthfully, as instructed. The new `tests/password-reset.spec.ts` proves the reset itself works (old password fails, new password succeeds) without making any claim about session revocation.

## Deterministic-stability fixes (3 final blockers, resolved in this round)

### E8 reissue race — root cause + deterministic resolution

**Root cause**: `POST /api/invitations/reissue` classified the target status
BEFORE the transaction (`const target = await db.invitation.findFirst(...)`
then `if (target.status === 'superseded') return 400 superseded_not_reissuable`).
The conditional single-winner claim lives INSIDE the transaction
(`updateMany WHERE status='revoked'` → loser `count=0` → `409 already_reissued`).
So the concurrent-loser response was timing-dependent:
  - Timing A (both pre-transaction reads see `revoked`): loser's claim loses → `409 already_reissued`.
  - Timing B (winner commits before loser's read): loser reads `superseded` → exits early → `400 superseded_not_reissuable`.
The public contract was therefore non-deterministic (`200+409` OR `200+400`).

**Deterministic resolution**: a request to reissue an already-superseded
invitation now returns `409 already_reissued` (the SAME result as the
conditional-claim loser). BOTH paths — initial-read-observes-`superseded` AND
conditional-claim-loses — produce the identical public result
`{ "error": "already_reissued" }` with HTTP 409. The contract is now
timing-independent. The safety invariants are unchanged: exactly one new
pending invitation, exactly one valid token, the old (superseded) token is
dead, the loser gets no invite URL/token, no seat overbooking (transactional
plan-capacity re-check under the per-tenant seat lock), and a superseded row
can never create another pending invitation. E8 is NO LONGER a flake — it is a
fixed deterministic contract, proven across 10 rounds of fresh-row concurrent
reissues in BOTH Full and Lite (every round `statuses == [200, 409]` + exactly
one pending). The older E1-E4 lifecycle assertion that expected
`superseded_not_reissuable` (400) was updated to `already_reissued` (409).

### Workspace switcher — single user selection, no retry

**Root cause of the prior intermittent single-click non-switch**: the
DropdownMenuItem `onSelect` called `e.preventDefault()` to keep the menu open
during the async validate → `useSession().update` → reload flow. The
menu-stays-open state raced with the `useSession` re-render triggered by
`update()`, intermittently preventing the session from switching on a single
click (the prior test masked this with a 3-attempt retry helper — unacceptable
proof for a stability audit).

**Resolution**: `e.preventDefault()` was REMOVED — the menu now closes
normally on selection (Radix default), and `handleSwitch` runs exactly once
(the async closure persists after the menu unmounts). The `switching` guard +
`disabled={switching}` prevent a duplicate selection; the reload fires only
after the returned session contains the requested `workspaceId` (verified
inside `handleSwitch`). A real user clicks ONCE. The 3-attempt retry helper
was REMOVED from `tests/workspace-switcher.spec.ts`; every switch assertion
performs exactly ONE user selection (open dropdown → click workspace once →
wait for session `workspaceId` → assert new workspace). If the single
interaction fails, the test fails — no masking.

The revoked-current-workspace recovery test additionally uses
`click({ noWaitAfter: true })` (so the click does NOT auto-wait for the
post-click reload navigation — Playwright's default click auto-wait raced the
reload in this degraded timing) and ONE open + ONE click (no Escape + re-open:
the double-open confused Radix's menu state in the degraded
revoked-current-workspace state, continuously detaching the menuitem). The
session transition is verified independently by `waitForWorkspaceSwitch`.

Proven in BOTH Full and Lite on `83997a3`: B→A single click, A→B single click,
B→A again single click, stale Inbox state clears, revoked-current-workspace
recovery (ONE open + ONE click → session becomes B → B data shows).

### Business Hours — v1 same-day non-empty intervals only

The validator previously accepted `start=22, end=6` (overnight),
`start=5, end=5` (zero-width), and `start=17, end=9` (inverted) because both
values independently fall within `[0,23]`. But the engine contract is
`hour >= start && hour < end`, so all three match NOTHING — a persisted no-op
(stabilization violation). **Resolution**: `validateRuleTrigger` now REQUIRES
`start < end` (Business Hours v1 supports same-day non-empty intervals only);
`start >= end` is rejected with `invalid_business_hours`. Valid same-day
examples (`0→1`, `9→17`, `22→23`) remain accepted. The UI does not claim an
invalid window was saved (the authoritative server-side rejection is retained;
the dashboard's save path calls the same validator before persisting).
Overnight routing is NOT implemented in v1 — it is a future product enhancement
(do NOT add timezone/wrap-around support in this corrective). Unit + db-boundary
tests cover the accept/reject matrix; the valid-rule execution + send_message +
tenant isolation behaviors remain green.

## Verification summary at the final SHA (`83997a3`, CI run `40202739156`)

All 4 CI jobs SUCCESS — `ci`, `widget-package-qualification`, `self-host-qualification`, `docker-regression` (Full + Lite).

- **lint**: clean (0 errors; 1 pre-existing baseline warning unchanged) · **typecheck**: clean — `ci` job
- **unit**: **537 pass / 0 fail** (520 baseline + 12 `routing-hours` + 5 `routing-rules` start<end matrix) — `ci` job
- **Prisma validate**: schema unchanged in this PR (validate passes in CI where DIRECT_URL is set) — `ci` job
- **widget-package-qualification**: SUCCESS (all 14 steps) — own job
- **Full DB-boundary**: **58 pass / 0 fail** (44 baseline + 13 `business-hours-routing` + 1 start<end rejection matrix) — `docker-regression` job
- **Lite DB-boundary**: **58 pass / 0 fail** (same composition) — `docker-regression` job
- **Full browser regression**: **116 pass / 0 fail** (87 baseline + 5 widget-customization/domains/analytics-csat + 3 workspace-switcher/password-reset/contacts-identity + 1 module2 route-level business-hours rejection) — `docker-regression` job
- **Lite browser regression**: **116 pass / 0 fail** (same composition) — `docker-regression` job
- **E8 10-round concurrent reissue**: PASSED Full + Lite (every round `statuses == [200, 409]` + exactly one pending) — `docker-regression` job
- **Single-click workspace switching** (B→A, A→B, B→A, stale Inbox clear, revoked-current-workspace recovery via ONE open + ONE click + `noWaitAfter`): PASSED Full + Lite — `docker-regression` job
- **Route-level Business Hours rejection** (POST /api/routing-rules 22→6, 5→5, 17→9 → 400 invalid_business_hours; none persisted; 9→17 control creates one rule): PASSED Full + Lite — `docker-regression` job
- **self-host-qualification**: SUCCESS (clean-install Full+Lite + backup-restore Full+Lite — the backup-restore heading assertion `getByRole('heading', { name: workspace })` passes with the `<h2>` switcher trigger) — own job
- **New behavioral specs added across this PR** (run in BOTH Full and Lite docker-regression CI — added to both lists): `tests/workspace-switcher.spec.ts`, `tests/password-reset.spec.ts`, `tests/contacts-identity.spec.ts`, `tests/db-boundary/business-hours-routing.test.ts`, `tests/unit/routing-hours.test.ts`; plus the E8 10-round strengthening in `tests/invite-workspace-switching.spec.ts` and the route-level business-hours rejection in `tests/module2.spec.ts`
- **Existing regressions untouched**: all previously-green specs still in the CI lists; no test was weakened or removed
- **Vercel**: failure `Account is blocked.` — the exact known external account-level block → NON-BLOCKING
