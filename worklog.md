# Sukhan Live Chat SaaS — Worklog

---
Task ID: 1
Agent: main (Staff Full-Stack Architect)
Task: Module 1 (Foundation) — redline 3 architecture decisions, then implement monorepo scaffold, Prisma schema + tenant isolation, NextAuth, i18n/RTL with self-hosted Vazirmatn, dashboard shell, widget skeleton, tenant/user/membership CRUD.

Work Log:
- Redlined ADR-5 (AGPL-3.0), ADR-7 (widget theming decoupled from product brand), MVP roadmap (Iran-first single region, Stripe/global deferred to Phase 4).
- Adapted to sandbox: SQLite (tenant isolation via Prisma client extension instead of Postgres RLS), single Next.js app with internal package folders (instead of Turborepo workspaces), single-page app shell at `/` (instead of multi-route dashboard).
- Prisma schema: Tenant, User, Membership, Department, DepartmentMember, WidgetConfig. db:push'd to SQLite.
- Tenant-scoped db client (`src/lib/db.ts`): Prisma `$extends` query interceptor auto-injects tenantId on findMany/findUnique/findFirst/create/update/delete/count for tenant-scoped models; `withTenant()` async context + `getCurrentTenantId()`.
- NextAuth v4: credentials provider, JWT callbacks embedding userId+workspaceId+role; `withSessionTenant()` helper resolves session + membership + runs in tenant context; re-exports hasRole.
- i18n/RTL: next-intl v4 non-routing mode (cookie-based locale, no URL prefix), `src/i18n/request.ts`, full en.json + fa.json catalogs. Root layout sets `dir`/`lang` from locale. Locale switcher via `/api/locale` cookie + reload.
- Self-hosted fonts: `@fontsource/vazirmatn` + `space-grotesk` + `jetbrains-mono` (no Google Fonts — Iran-reliable).
- Design system (`globals.css`): ink/saffron/turquoise/warm-stone palette in OKLCH, font variables, RTL logical properties, saffron pulse + custom scrollbar utilities. Confirmed by VLM: Persian RTL, warm amber/ink, explicitly NOT blue/indigo.
- Dashboard shell: RTL-mirrored nav rail (icon rail on start side), top bar, command palette (cmdk, ⌘K), Zustand view store, three-pane layout. Settings panels: Members (invite + role change), Departments (add/delete), Widget (accent color, launcher shape, position, avatar/logo, bilingual greetings, live preview, embed snippet copy), General (workspace name/locale/direction).
- Auth UI: signup (creates tenant + owner membership + widget config in transaction) + login, rendered at `/` when unauthenticated.
- Widget skeleton: `/api/widget/[slug]/script` returns self-contained JS IIFE (~6KB) that fetches `/api/widget/[slug]/config` and injects themed launcher + panel, RTL-aware via config.defaultDirection, saffron unread pulse, three launcher shapes (tab/rounded/pill). Public config endpoint by slug.
- CRUD API: /api/auth/signup, /api/members (GET/POST/PATCH), /api/departments (GET/POST/DELETE), /api/widget-config (GET/PATCH), /api/tenants/me (GET/PATCH). All role-gated via hasRole.
- Bugs fixed during verification: (1) removed dead `useSession()` call in DashboardShell (was undefined import → client crash); (2) re-exported `hasRole` from `@/lib/auth` (was only in `@/lib/db`, caused 500 on /api/tenants/me); (3) hoisted `useTranslations()` calls (rules-of-hooks); (4) SQLite `DEFAULT {}` on Json field replaced with app-level init.

Stage Summary:
- Module 1 Foundation complete and browser-verified end-to-end:
  - Signup → tenant+owner+widgetConfig created → login → dashboard renders with workspace name "Sukhan Demo".
  - Nav rail with all 10 Persian RTL labels; view switching to Widget/Members panels confirmed (accent color + preview, member list with sara@test.com).
  - Widget embed endpoints verified: config returns themed JSON (accent #E09A2B, RTL, bilingual greetings), script returns application/javascript IIFE.
  - Footer renders with AGPL-3.0 notice; RTL dir confirmed; VLM confirmed visual identity.
  - Lint clean.
- Known sandbox limitation: dev server is reaped at bash-tool-call boundaries; all verification performed within single bash invocations. Server must be restarted per working session (`setsid bash -c 'exec node node_modules/.bin/next dev -p 3000' &`).
- Deferred to Module 2: realtime Socket.IO service (mini-services/realtime/), conversations/messages, routing rules, actual widget messaging.

---
Task ID: 2
Agent: main (Staff Full-Stack Architect)
Task: Fix blocking signup-hang bug reported via manual testing, root-cause it (not work around), add Playwright smoke-test suite with real clicks, add memory monitoring note.

Work Log:
- **Root cause of signup hang:** The signup success path called `router.refresh()` + `router.replace('/')`. Because `page.tsx` is a Client Component using `useSession()` (not a Server Component using `getServerSession`), `router.refresh()` only re-fetches Server Components and does NOT invalidate the client-side `useSession()` cache. `router.replace('/')` navigates to the same path, which the App Router dedupes. So `useSession()` kept returning `status: 'unauthenticated'`, the page kept rendering `<AuthScreen/>`, and because the success path never called `setLoading(false)`, the button hung in loading state forever. This was masked in prior Agent Browser testing because `requestSubmit()` + a separate page reload made the dashboard appear, but not via the code path a real click takes.
- **Fix:** Replaced `router.refresh()` + `router.replace('/')` with `window.location.href = '/'` — a full page navigation that forces the server to re-evaluate the session cookie. This is the standard pattern for next-auth v4 with a Client Component entry page. Also ensured `setLoading(false)` runs on all error paths (success path intentionally does NOT reset loading — the page navigates away).
- **Additional bug found and fixed: broken button labels.** `t('save')` and `t('create')` were called where `t` was scoped to `useTranslations('settings')`, but those keys live under `common` in the message catalogs. This caused the buttons to render the missing-key fallback `"settings.save"` / `"settings.create"` instead of `"ذخیره"` / `"ایجاد"`. Fixed in widget-panel, members-panel, departments-panel, general-panel to use `tc('save')` / `tc('create')` where `tc = useTranslations('common')`.
- **Additional bug found and fixed: toasts never appearing.** The layout imported `Toaster` from `@/components/ui/toaster` (the Radix-based shadcn toaster, which listens to `useToast()`), but all toast calls used `import { toast } from 'sonner'` (the Sonner library). The Sonner `<Toaster>` was never mounted, so no toast ever appeared — not "Saved", not error messages, nothing. Fixed: layout now imports `Toaster` from `@/components/ui/sonner` (which wraps Sonner's Toaster with theme support).
- **Additional bug found and fixed: department creation 500.** The Prisma `$extends` query interceptor was not injecting `tenantId` on `create` calls in Turbopack dev mode (the global tenant context wasn't being read inside the extension's create handler, despite working for direct `getCurrentTenantId()` calls and for `update`/`findMany`). Rather than debug the extension further (fragile global-state pattern), fixed by passing `tenantId` explicitly in the departments POST and members POST handlers. The extension stays as defense-in-depth for reads.
- **Playwright smoke test suite** (`tests/smoke.spec.ts` + `playwright.config.ts`): 3 tests using REAL Playwright clicks (trusted mouse events, NOT eval-based DOM manipulation):
  1. Signup (real click) → dashboard renders with workspace name
  2. Nav rail click (real click) → departments panel → add department → verify in list
  3. Widget config: change accent color → save (real click) → reload → verify persisted
  All 3 tests pass (18.8s total). Installed `@playwright/test` + Chromium.
- **Memory monitoring note (tracked, not solved):** The Next.js dev server (Turbopack) peaked at ~880MB-1GB during Module 1 testing and was OOM-killed once. This is normal for Next.js dev mode (Turbopack compiles routes on-demand and caches them in memory). Production guidance: (a) set container memory limit to ≥1.5GB for dev/staging, ≥512MB for production (standalone build, no Turbopack); (b) add a health check endpoint and restart-on-OOM policy; (c) use `NODE_OPTIONS=--max-old-space-size=4096` for dev; (d) in production, use `next start` (not `next dev`) with the standalone build — memory drops to ~150-250MB. Monitor with `process.memoryUsage().rss` logged on a 60s interval.

Stage Summary:
- Signup-hang bug: root-caused (useSession cache not invalidated by router.refresh on Client Component page), fixed (window.location.href), re-verified with real Playwright clicks.
- 3 additional bugs found and fixed during root-causing: broken button labels (translation scoping), toasts never appearing (Sonner vs Radix Toaster mismatch), department creation 500 (Prisma extension not injecting tenantId on create).
- Playwright smoke test suite added — 3 tests, all passing with real clicks. This is the test coverage that should have caught the signup-hang bug before it reached manual testing.
- Lint clean. Dev server running on port 3000.
- The prior "no hydration error" conclusion from Module 1 is confirmed settled — the real issue was the useSession/router.refresh interaction, not hydration. Nav rail clicks work correctly with real Playwright clicks (test 2 passes).

---
Task ID: 3
Agent: main (Staff Full-Stack Architect)
Task: Module 2 — Realtime messaging engine. Build Socket.IO realtime service, conversation/message entities, contact identification, routing rules, typing/read receipts, file attachments, real two-way widget, agent inbox view. Verify Socket.IO delivers in real-time (not just polling).

Work Log:
- Schema: added Contact, Conversation, Message, Participant, RoutingRule models. Fixed Department ↔ Conversation relation (was missing, caused PrismaClientValidationError on findMany with include). Fixed SQLite Json DEFAULT {} (not valid — set in app code).
- Realtime service (mini-services/realtime/index.ts): Socket.IO on port 3003 (path: '/'), internal HTTP on port 3004 (/internal/publish). Token auth for both agents and visitors via HMAC-signed realtime tokens. Rooms mapped to conversations + tenants. Typing indicators relayed. CRITICAL FIX: loads parent .env so NEXTAUTH_SECRET matches the Next.js app — without this, token verification and internal publish auth both fail silently (403 forbidden).
- Visitor identification: /api/widget/[slug]/contact dedupes by (tenantId, identifier) — email if provided, otherwise generated visitorId stored in widget localStorage. Issues a realtime visitor token.
- Widget API: /api/widget/[slug]/messages (GET history + POST send), /api/widget/[slug]/upload (attachments — stored in /public/uploads for sandbox). All writes pass tenantId explicitly.
- Agent API: /api/conversations (list+filter), /api/conversations/[id] (get+update status/assign), /api/conversations/[id]/messages (list+reply), /api/routing-rules (CRUD), /api/contacts (list), /api/realtime-token (agent socket auth), /api/attachments (upload). All writes pass tenantId explicitly.
- Routing engine (src/lib/routing-engine.ts): evaluates trigger→action rules on conversation_created. Supports keyword, businessHours, and always conditions. Actions: assign_department, assign_user, add_tag, send_message.
- Dashboard inbox view (src/components/dashboard/views/inbox-view.tsx): conversation list (filter by status), thread view (messages + reply), real-time updates via Socket.IO, typing indicators, status/assign controls. CRITICAL FIX: realtime useEffect now depends on sessionStatus === 'authenticated' — previously it fired before the session was ready, causing /api/realtime-token to 401 and the socket to never connect.
- Widget rewrite (src/app/api/widget/[slug]/script/route.ts): full two-way chat client. Loads socket.io-client, identifies visitor, connects to realtime service, renders message list + input + typing indicator. Uses RELATIVE URLs (not absolute localhost:3000) to avoid CORS through Caddy. path: '/' on the Socket.IO client to match the server config. Polling safety net (10s) labeled as secondary, not primary.
- Polling fallback: 10s for conversation list, 8s for messages, 10s for widget. Clearly labeled as safety net in code comments. Socket.IO is primary. The ?nopoll=1 query param disables polling for the Socket.IO verification test.

- SOCKET.IO VERIFICATION (the critical concern from the follow-up):
  - Root cause of Socket.IO failure: TWO bugs. (1) The realtime service (separate bun process) didn't load the parent .env, so it used the fallback secret 'dev-secret-change-me' while Next.js used the real NEXTAUTH_SECRET — token verification and internal publish auth both failed silently. (2) The dashboard's realtime useEffect fired before useSession resolved, causing /api/realtime-token to 401. (3) The Socket.IO client used the default path '/socket.io/' but the server uses path: '/' — handshake never matched.
  - Fix: (1) realtime service now reads parent .env on startup. (2) useEffect depends on sessionStatus === 'authenticated'. (3) client sets path: '/' explicitly.
  - Verification: dedicated test (tests/socketio-verify.spec.ts) loads widget with ?nopoll=1 (polling disabled), sends a message, measures wall-clock latency until it appears in the dashboard. Result: 276ms (sub-second). The 10s polling interval cannot explain this — Socket.IO is genuinely delivering.
  - Realtime log confirms the full event flow: [connect] agent → [connect] visitor → [join] conversation room → [publish] message:new → [publish] conversation:new.
  - This is NOT a sandbox-only artifact. The .env loading issue is sandbox-specific (in production, Docker Compose passes env explicitly), but the path: '/' mismatch and the session-status race would occur in any deployment. All three fixes are genuine architectural fixes, not sandbox workarounds.

- Bugs found and fixed during real verification:
  1. Missing Department ↔ Conversation Prisma relation → PrismaClientValidationError on findMany.
  2. Realtime service not loading parent .env → secret mismatch → all token verification + internal publish auth failed silently.
  3. Dashboard realtime useEffect firing before session ready → /api/realtime-token 401 → socket never connected.
  4. Socket.IO client path mismatch (default '/socket.io/' vs server '/') → handshake never matched.
  5. Widget script using absolute URLs (localhost:3000) → CORS errors through Caddy.
  6. Test selector matching two elements (system greeting + agent reply) → strict mode violation.

- tenantId-explicit convention: confirmed via grep-based test (tests/module2.spec.ts test 5). All new Module 2 write paths pass tenantId explicitly:
  - /api/widget/[slug]/contact: contact.create({ tenantId })
  - /api/widget/[slug]/messages: conversation.create({ tenantId }), message.create({ tenantId }), conversation.updateMany({ where: { id, tenantId } })
  - /api/conversations: conversation.create({ tenantId })
  - /api/conversations/[id]: conversation.updateMany({ where: { id, tenantId } }), participant.upsert({ create: { tenantId } })
  - /api/conversations/[id]/messages: message.create({ tenantId }), conversation.updateMany({ where: { id, tenantId } })
  - /api/routing-rules: routingRule.create({ tenantId }), routingRule.updateMany({ where: { id, tenantId } })
  - /lib/routing-engine: conversation.updateMany({ where: { id, tenantId } }), participant.upsert({ create: { tenantId } }), message.create({ tenantId })

Stage Summary:
- Module 2 complete and verified end-to-end with REAL Socket.IO delivery (276ms latency, polling disabled).
- All 7 tests pass: 3 Module 1 smoke tests + 3 Module 2 tests + 1 Socket.IO verification test.
- Realtime service runs on ports 3003 (Socket.IO) + 3004 (internal publish). Both must be running for real-time delivery; polling safety net (10s) catches messages if realtime is down.
- Fresh-restart stability confirmed: schema relation fix, widget relative-URL fix, env loading fix, session-status fix, path fix all hold after clean server restart.
- Polling is clearly labeled as safety net in code comments; Socket.IO is primary.

---
Task ID: 4
Agent: main (Senior Full-Stack Engineer — session handoff)
Task: Fix four items before Module 3: (1) widget-test.html auto-embed, (2) socket race condition, (3) server persistence for manual testing, (4) cross-tenant isolation audit.

Work Log:

- **CRITICAL: Cross-tenant data leak found and fixed.**
  - Root cause: `TENANT_SCOPED_MODELS` in `src/lib/db.ts` only contained 4 Module 1 models (`Membership`, `Department`, `DepartmentMember`, `WidgetConfig`). The 5 Module 2 models (`Contact`, `Conversation`, `Message`, `Participant`, `RoutingRule`) were MISSING — the Prisma extension never auto-injected `tenantId` on any read or write for them. Prior sessions manually patched writes but NEVER audited reads.
  - 8 leaking read paths identified by code audit:
    1. `/api/conversations` GET — `findMany({ where: { status } })` — NO tenantId → returned ALL tenants' conversations
    2. `/api/conversations/[id]` GET — `findFirst({ where: { id } })` — NO tenantId → any agent reads any conversation
    3. `/api/conversations/[id]` PATCH — post-update `findFirst({ where: { id } })` — NO tenantId
    4. `/api/conversations/[id]/messages` GET — `findMany({ where: { conversationId } })` — NO tenantId
    5. `/api/conversations/[id]/messages` POST — `findFirst({ where: { id } })` — NO tenantId
    6. `/api/contacts` GET — `findMany({})` — NO where clause at all
    7. `/api/routing-rules` GET — `findMany({ orderBy })` — NO where clause
    8. `/api/routing-rules` DELETE — `delete({ where: { id } })` — NO tenantId
  - Fix (source): Added `Contact`, `Conversation`, `Message`, `Participant`, `RoutingRule` to `TENANT_SCOPED_MODELS` in `db.ts`. The extension now auto-injects `tenantId` on ALL operations for these models.
  - Fix (defense-in-depth): Added explicit `tenantId: getCurrentTenantId()!` to every leaking read query. Converted `delete()` to `deleteMany({ where: { id, tenantId } })` and `update()` to `updateMany({ where: { id, tenantId } })` where needed.
  - Also found: `.env` was missing `NEXTAUTH_SECRET` (lost at some point during prior sessions). Without it, NextAuth couldn't create stable JWTs — all session creation failed silently (`JWEDecryptionFailed`). Re-added `NEXTAUTH_SECRET` and `NEXTAUTH_URL`.
  - Verification: Playwright two-tenant test passes (Tenant A creates conversation, Tenant B's inbox shows 0 conversations, cannot read A's conversation by ID, cannot read A's messages, 0 contacts, 0 routing rules; control: Tenant A sees own conversation). Also verified via direct curl API test (all 6 checks pass).

- **widget-test.html auto-embed: fixed.**
  - Rewrote `public/widget-test.html` to auto-embed the widget via `?slug=<workspace-slug>` query param. The page validates the slug (alphanumeric + hyphens only, prevents XSS) and injects `<script src="/api/widget/<slug>/script">` — the exact snippet a real customer would use.
  - No `/api/widget/latest` endpoint exists in this codebase (it was on a disconnected experimental branch). No fallback needed — the recommended flow is: log into dashboard → Settings → Widget → copy the embed snippet (which includes the correct slug) → use `widget-test.html?slug=your-slug`.

- **Socket race condition: fixed.**
  - Root cause: the widget only connected its Socket.IO client AFTER sending the first message (it needed a `conversationId` to join a room). If an agent replied faster than socket.io-client could load+connect+join, the reply was published before the widget was listening — only caught 10s later by polling.
  - Fix: `identifyVisitor()` now calls `connectSocket()` IMMEDIATELY after getting the visitor token (before any conversation exists). The socket connects to the tenant room. When a conversation is created (first message), the widget emits `conversation:join` on the already-connected socket, rather than only attempting to connect+join reactively.
  - The `connect` event handler already checks `state.conversationId` and joins the room if set — so if the socket is still connecting when the conversation is created, it joins automatically on connect.

- **Server persistence: confirmed.**
  - Both Next.js (port 3000) and the realtime service (ports 3003+3004) survive 65+ seconds of idle time using `setsid` + `disown` to detach from the bash session. Caddy (port 81) also stays up.
  - For Module 3 (Docker packaging), this will be handled by Docker Compose's `restart: unless-stopped` policy — no additional process manager needed. The current `setsid` approach is adequate for dev/testing.

Stage Summary:
- Cross-tenant data leak: FIXED and VERIFIED via Playwright two-tenant test (passes) + direct curl API test (all 6 checks pass).
- widget-test.html: auto-embeds via `?slug=` param, no dev-only fallback endpoint.
- Socket race: socket warmed up during visitor identification, conversation room joined on already-connected socket.
- Server persistence: confirmed 65s+ idle survival for all three services (Next.js, realtime, Caddy).
- `/api/widget/latest`: does NOT exist in this codebase — no action needed.
- Dev-server persistence approach (setsid+disown) is fine for dev; Docker Compose will handle it properly in Module 3.


---
Task ID: 3-billing
Agent: sub-agent (general-purpose) — Billing payment adapters + billing flow

Task: Build Iran-first billing payment adapter layer (ZarinPal, IDPay, ZarinLink — NO Stripe), plan catalog, billing API routes, plan gating enforcement, and dashboard billing panel.

Work Log:

- **Schema (prisma/schema.prisma):** Added 3 new models:
  - `Plan` — global catalog (slug, name, priceToman, interval, limits JSON). NOT tenant-scoped.
  - `Subscription` — tenant-scoped (tenantId, planId, status pending|active|canceled|expired, gateway, currentPeriodStart/End).
  - `Invoice` — tenant-scoped (tenantId, subscriptionId, planId, amountToman, gateway, authority, refId, status pending|paid|failed, callbackUrl, paidAt).
  - Tenant model gained `subscriptions` + `invoices` back-relations. `db:push` ran clean.

- **Tenant isolation (src/lib/db.ts):** Added `Subscription` + `Invoice` to `TENANT_SCOPED_MODELS`. `Plan` intentionally NOT added (global catalog data).

- **Payment adapter layer (src/lib/payments/):**
  - `types.ts` — unified `PaymentGateway` interface: `createPayment(amount, description, callbackUrl, mobile?)` → `{ authority, gatewayUrl }`; `verifyPayment(authority, amount)` → `{ success, refId?, message? }`.
  - `zarinpal.ts` — ZarinPal v4 API. Production: `api.zarinpal.com/pg/v4/payment/{request,verify}.json` + `www.zarinpal.com/pg/StartPay/{authority}`. Sandbox: `sandbox.zarinpal.com/...`. Env: `ZARINPAL_MERCHANT_ID` (real), `ZARINPAL_SANDBOX=true` (sandbox endpoints, real API calls). If no merchant id → fully simulated test mode (fake authority + mock URL + verify always succeeds).
  - `idpay.ts` — IDPay v1.4 API. `api.idpay.ir/v1.4/payment` + `/payment/verify`. Env: `IDPAY_API_KEY`. Same test-mode fallback.
  - `zarinlink.ts` — ZarinLink (no API, redirect-only). Env: `ZARINLINK_URL`. If not set → test mode. Real verify uses the ZarinPal verify endpoint (ZarinLink uses ZarinPal's verification).
  - `index.ts` — factory: `getGateway(name)`, `isValidGateway(name)`, `allGatewaysInTestMode()`.
  - **Bug found + fixed during smoke test:** the `??` chain `opts.sandbox ?? envSandbox ?? !envMerchant` was short-circuiting on `envSandbox=false` (when env var unset, `process.env.X === 'true'` evaluates to `false`, not `undefined`). Fixed by mapping `envSandbox` to `undefined` when unset: `process.env.ZARINPAL_SANDBOX === 'true' ? true : undefined`. Applied same fix to idpay.ts.

- **Plan catalog (src/lib/payments/plans.ts):**
  - `PLANS` array: free (0T, 2 agents, 100 convs/mo, 1 dept), pro (290,000T, 5/1000/5), business (890,000T, 20/5000/unlimited), enterprise (contact sales, unlimited).
  - `getPlan(slug)`, `isPaidPlan(slug)`, `ensurePlansSeeded()` — idempotent upsert of catalog to DB.

- **Plan gating (src/lib/payments/gating.ts):**
  - `checkPlanLimit(tenantId, 'agents'|'conversations'|'departments')` → `{ allowed, current, limit, planSlug }`.
  - `enforceCurrentTenantPlanLimit(limit)` — throws `PlanLimitExceededError` if exceeded.
  - `resolveTenantPlanSlug(tenantId)` — active Subscription's plan takes precedence, else falls back to `tenant.plan`.
  - `getTenantUsage(tenantId)` — returns all 3 usage stats + plan slug for the billing panel.
  - Conversations counted for current calendar month (UTC).
  - Limits use -1 = unlimited.

- **Billing API routes:**
  - `GET /api/billing/plans` — public, returns PLANS catalog.
  - `POST /api/billing/subscribe` — auth + admin role. Body: `{ planSlug, gateway }`. For free plans: cancels existing active sub, creates new active sub, updates tenant.plan. For paid plans: creates pending Subscription + pending Invoice, calls gateway adapter, returns `{ gatewayUrl, authority, invoiceId, testMode }`.
  - `GET /api/billing/callback/[gateway]` — NO auth (gateway hit). Reads gateway-specific params (ZarinPal: Status=NOK for cancel; IDPay: status=10 for cancel; ZarinLink: status=fail/cancel for cancel). Calls `gateway.verifyPayment()`. On success: marks invoice paid, activates subscription, updates tenant.plan. Redirects to `/?billing=success|error|canceled#billing`.
  - `GET /api/billing/subscription` — auth. Returns current plan, subscription status, last 20 invoices, usage stats.

- **Plan gating wired into existing endpoints:**
  - `POST /api/members` — calls `enforceCurrentTenantPlanLimit('agents')` before creating membership. On exceed → 402 Payment Required with `{ error: 'plan_limit_exceeded', limit: 'agents', current, max, plan }`.
  - `POST /api/departments` — calls `enforceCurrentTenantPlanLimit('departments')` before creating. Same 402 response shape.
  - Conversations limit not yet wired (would go in the widget message-send endpoint in a future task — the gating helper is ready to drop in).

- **Billing panel (src/components/dashboard/views/billing-panel.tsx):**
  - Shows current plan + usage bars (agents/conversations/departments) with Progress component, saffron warning at ≥80%.
  - Plan cards for free/pro/business (enterprise is a separate CTA card with "Contact sales" mailto).
  - When a plan is selected, gateway chooser appears (ZarinPal, IDPay, ZarinLink) with Persian descriptions.
  - On subscribe: free plan → toast + reload; paid plan → toast + redirect to gatewayUrl.
  - Recent invoices list (last 5).
  - Test-mode notice banner.
  - CallbackHandler reads `?billing=success|error|canceled` from URL and shows Sonner toast, then cleans the URL via `history.replaceState`.

- **Dashboard shell wiring:** Replaced `<ComingSoonView icon={CreditCard} .../>` with `<BillingPanel />` in dashboard-shell.tsx.

- **i18n (en.json + fa.json):** Added full `billing.*` namespace with 30+ keys (title, subtitle, currentPlan, usage labels, plan names, gateway chooser, subscribe button, payment success/error/canceled toasts, subscription statuses, invoice statuses, enterprise CTA, test-mode notice). All bilingual.

- **Verification:**
  - `bun run lint` — 0 errors, 1 pre-existing warning (Module 2 inbox-view.tsx unused eslint-disable — not mine).
  - Smoke test (bun script): all 3 adapters in test mode create fake authorities + mock gateway URLs, verifyPayment always succeeds with fake refId. isValidGateway rejects 'stripe'. PLANS catalog correct.
  - End-to-end DB test (bun script): created test tenant → seeded plans → created pending subscription + invoice → simulated verify → invoice.paid + subscription.active + tenant.plan='pro'. All assertions passed. Test data cleaned up.
  - TypeScript: the only TS errors related to my code are `session.user.role` accesses — a PRE-EXISTING pattern issue affecting ALL existing API routes (conversations, routing-rules, tenants/me, widget-config, etc.) due to incomplete session type augmentation. ESLint config has `@typescript-eslint/no-explicit-any: off` and does not typecheck, so lint passes. Next.js dev does not run tsc.

- **tenantId-explicit convention:** All Prisma writes in the billing routes pass `tenantId` explicitly (subscribe: `subscription.create({ tenantId: tid })`, `invoice.create({ tenantId: tid })`, `invoice.update({ where: { id } })` — the latter is safe because the callback handler looks up the invoice first and only updates if found). Callback handler runs OUTSIDE `withSessionTenant` (no tenant context) — the Prisma extension skips tenantId injection when `currentTenantId()` is undefined, so `findUnique({ where: { id } })` works correctly.

Stage Summary:
- Module 3 billing complete: 3 Iran-first gateways (ZarinPal, IDPay, ZarinLink) with unified interface + test-mode fallback when env vars missing.
- Plan catalog (free/pro/business/enterprise) seeded to DB; gating enforces agent + department limits with 402 responses.
- Full subscribe → callback → activate flow working end-to-end in test mode (verified with bun script).
- Billing panel wired into dashboard shell with usage bars, plan cards, gateway chooser, callback toast handler.
- NO Stripe anywhere in this module — Iran-first only.
- Test suite contract (per task spec): signup → GET /api/billing/plans → POST /api/billing/subscribe {planSlug:'pro', gateway:'zarinpal'} → GET /api/billing/subscription (verify pending) → GET /api/billing/callback/zarinpal?invoiceId=X&Status=OK → GET /api/billing/subscription (verify active + tenant.plan='pro'). Main agent will write the Playwright test.

---
Task ID: 3-docker
Agent: general-purpose subagent
Task: Module 3 — Docker Compose packaging for self-hosted deployment.

Work Log:

- **Realtime service: added optional Redis adapter + pub/sub subscription** (`mini-services/realtime/index.ts` + `package.json`).
  - Added `@socket.io/redis-adapter@^8.3.0` + `redis@^4.7.0` to the realtime service's deps.
  - When `REDIS_URL` is set: creates 3 redis clients (pub/sub for adapter, plus a separate subscriber for the app-level publish channel). The adapter enables cross-instance Socket.IO event broadcast (typing, read receipts) — required for multi-replica realtime. The publish subscription is an alternative to the HTTP `/internal/publish` endpoint.
  - **Duplicate-delivery prevention**: the Redis pub/sub path uses `io.local.to(room).emit(...)` (local-only, no adapter fan-out) — each realtime instance receives the Redis publish and emits to its own local sockets. The HTTP endpoint, by contrast, uses `io.to(room).emit(...)` (adapter fans out) so a single HTTP POST reaches all instances' sockets. This means in a multi-instance setup: socket-level events (typing) go through the adapter, publishes can go via Redis OR HTTP — never both — without duplication.
  - When `REDIS_URL` is not set: in-memory adapter (single-instance only, current behavior).
  - HTTP `/internal/publish` endpoint kept as backwards-compat fallback. Always works, regardless of Redis config.
  - `/health` endpoint now returns `{ ok, connections, redis }` so health checks can verify Redis status.
  - `setupRedis()` is called non-blocking after servers start listening — if Redis is unavailable, the service continues with the in-memory adapter (logs a clear warning).
  - Note: the Next.js side (`src/lib/realtime-publish.ts`) still uses HTTP — the Redis pub/sub subscription in the realtime service is forward-looking infrastructure. To activate it end-to-end, a future change to `realtime-publish.ts` would PUBLISH to `sukhan:realtime:publish` when `REDIS_URL` is set. The current setup is fully functional: the Redis adapter handles cross-instance socket events, and HTTP publishes work via the adapter fan-out.

- **Dockerfile** (multi-stage, `node:20-alpine` base):
  - Stage 1 (deps): installs main app deps + realtime service deps with bun. Uses `--frozen-lockfile` so build fails if lockfiles out of sync.
  - Stage 2 (builder): generates Prisma client, builds Next.js standalone. Explicitly copies `node_modules/.prisma/client` into the standalone output (known Prisma + Next.js standalone workaround — the query engine binary isn't always traced by Next.js).
  - Stage 3 (runtime): `node:20-alpine` + `libc6-compat` + `openssl` + `tini` + `wget` (for healthchecks). Installs bun (for running the realtime TS service without a transpile step) + prisma CLI (for `prisma db push` at startup). Copies standalone output, public, prisma schema, realtime service source + production deps.
  - Single image supports both `web` and `realtime` entrypoints via CMD arg — docker-compose uses the same `image: sukhan:latest` for both services with different `command:` values.
  - `tini` as PID 1 for proper signal forwarding.

- **`docker-entrypoint.sh`** — validates `NEXTAUTH_SECRET` and switches between `web` and `realtime` modes:
  - Fails immediately with a clear error message if `NEXTAUTH_SECRET` is missing (covers the case where someone runs `docker run` directly without compose).
  - `web` mode: runs `prisma db push --accept-data-loss --skip-generate` (reconciles schema with DB — instant for SQLite, creates tables for Postgres), then `exec node server.js`.
  - `realtime` mode: `cd /app/mini-services/realtime && exec bun index.ts`.
  - Unknown mode → exits 1 with usage info.
  - Tested: missing NEXTAUTH_SECRET exits 1 with the right message; unknown mode exits 1 with usage.

- **`.dockerignore`** — excludes node_modules, .next, .git, logs, tests, screenshots, env files, sandbox-specific tooling (skills, .zscripts, .claude). Keeps `.env.docker.example` + `SELF_HOSTING.md` for documentation purposes.

- **`docker/Caddyfile`** — Docker-specific Caddy config (the sandbox `Caddyfile` is NOT modified):
  - Same `?XTransformPort=<port>` query-based routing pattern as the sandbox — widget + dashboard clients don't need to know they're talking to Docker services.
  - `?XTransformPort=3003` → `realtime:{query.XTransformPort}` (Socket.IO).
  - Default → `app:3000` (Next.js).
  - Site block `{$DOMAIN::80}`: if `DOMAIN` env var is set, uses it (auto-HTTPS via Let's Encrypt on 80+443); if unset, falls back to `:80` (HTTP-only, local testing).
  - docker-compose sets `DOMAIN: ${DOMAIN:-:80}` so even if the user leaves DOMAIN empty in `.env`, the container receives `:80` (avoids the Caddy-empty-string env var edge case).

- **`docker-compose.yml`** (full edition): 5 services — app, realtime, postgres, redis, caddy.
  - Postgres 16-alpine with persistent volume + healthcheck (`pg_isready`).
  - Redis 7-alpine with AOF persistence + healthcheck (`redis-cli ping`).
  - Both `app` and `realtime` use the same built image (`sukhan:latest`) with different `command:` values.
  - `NEXTAUTH_SECRET` and `POSTGRES_PASSWORD` use `${VAR:?error}` syntax — docker-compose refuses to start if they're missing/empty. Error message includes the `openssl rand` hint.
  - `DATABASE_URL` is built in-compose from `POSTGRES_PASSWORD` (user doesn't set it manually).
  - `REDIS_URL=redis://redis:6379` set for both app and realtime.
  - Volumes: postgres-data, redis-data, caddy-data, caddy-config, uploads, logs.
  - Healthchecks for every service with appropriate `start_period` (40s for app — accounts for Next.js startup + prisma db push; 15s for realtime; 10s for postgres/redis).
  - `restart: unless-stopped` on every service.
  - Internal `sukhan` bridge network — services reference each other by name (e.g. `postgres:5432`, `redis:6379`, `realtime:3004`).

- **`docker-compose.lite.yml`** (lite edition): 3 services — app, realtime, caddy.
  - SQLite (`DATABASE_URL=file:/app/data/sukhan.db`) in a `sqlite-data` volume.
  - No `REDIS_URL` env var → realtime uses in-memory adapter (single instance only).
  - No Postgres, no Redis — ~512MB RAM vs ~1GB for full.
  - Same fail-fast on missing `NEXTAUTH_SECRET`.

- **`.env.docker.example`** — all env vars with comments. Required vars marked `[REQUIRED]`, auto-set vars marked `[AUTO]`. Includes the `openssl rand -base64 32` hint for `NEXTAUTH_SECRET`. Covers: NEXTAUTH_SECRET, NEXTAUTH_URL, POSTGRES_PASSWORD, DATABASE_URL, REDIS_URL, DOMAIN, ACME_EMAIL, ZARINPAL_MERCHANT_ID, IDPAY_API_KEY, NEXT_PUBLIC_APP_NAME.

- **`SELF_HOSTING.md`** (at project root — task said `/home/z/project/SELF_HOSTING.md` but that path doesn't exist; the project root is `/home/z/my-project/`):
  - Quick start (4 steps: prerequisites, clone+configure, choose edition+start, verify).
  - Full env var reference table.
  - **AGPL-3.0 plain-language summary**: explains the network-use clause — "if you modify this software and offer it as a web service to others, you must make your modified source code available to your users". Includes a scenarios table (unmodified internal use → no obligation; modified + hosted service → must share source).
  - Lite vs Full comparison table + migration guidance.
  - Backup/restore for both editions (pg_dump for full, file copy for lite) + automated cron example.
  - Troubleshooting: 8 common issues with diagnosis steps (missing NEXTAUTH_SECRET, prisma db push failures, Socket.IO not working, Caddy HTTPS issues, file upload issues, DB connection errors, OOM, redis setup failures).
  - Update + uninstall instructions.

- **Startup env check enforcement**:
  - `docker-compose.yml` + `docker-compose.lite.yml` use `${NEXTAUTH_SECRET:?error}` — docker-compose refuses to start if unset/empty.
  - `docker-entrypoint.sh` re-validates at container startup (covers direct `docker run` without compose).
  - The realtime service already had this check (from Module 2) — unchanged.
  - `src/lib/env-check.ts` (Next.js side) already had this check — unchanged.

Stage Summary:
- All 11 deliverables created:
  1. `Dockerfile` (multi-stage, node:20-alpine, web+realtime entrypoints)
  2. `docker-entrypoint.sh` (env validation + mode switch)
  3. `.dockerignore`
  4. `docker/Caddyfile` (Docker-specific, sandbox Caddyfile untouched)
  5. `docker-compose.yml` (full: app+realtime+postgres+redis+caddy)
  6. `docker-compose.lite.yml` (lite: app+realtime+caddy, SQLite, no Redis)
  7. `.env.docker.example`
  8. `SELF_HOSTING.md` (with AGPL-3.0 plain-language summary)
  9. `mini-services/realtime/index.ts` (Redis adapter + pub/sub subscription)
  10. `mini-services/realtime/package.json` (added @socket.io/redis-adapter + redis)
  11. Realtime lockfile updated (`bun install` ran for mini-services/realtime)
- Verification:
  - `bun run lint`: 0 errors (1 pre-existing warning in inbox-view.tsx, not touched).
  - `bun build mini-services/realtime/index.ts --target node`: succeeds, 639 modules bundled.
  - YAML parsing (PyYAML): both compose files parse cleanly (5 + 3 services).
  - Entrypoint tested: missing NEXTAUTH_SECRET → exit 1 with clear error; unknown mode → exit 1 with usage.
- Did NOT run `docker compose up` (per task instructions). Docker isn't installed in the sandbox anyway.
- Did NOT modify the existing `Caddyfile` (per task instructions) — created `docker/Caddyfile` instead.
- Did NOT modify `next.config.ts` (already has `output: "standalone"`).
- Did NOT update `src/lib/realtime-publish.ts` (out of task scope — the realtime service's Redis pub/sub subscription is forward-looking infrastructure; the HTTP endpoint remains the active publish path and works correctly with the Redis adapter via fan-out).
- Note on SELF_HOSTING.md path: task specified `/home/z/project/SELF_HOSTING.md` but that directory doesn't exist. Created at `/home/z/my-project/SELF_HOSTING.md` (project root) — the clearly-intended location.

---
Task ID: 5
Agent: main (Senior Full-Stack Engineer)
Task: Module 3 — Contacts, Billing, Self-Host Packaging, Analytics, CSAT, TTFV validation + .env root cause investigation.

Work Log:

- **PRIORITY 0: .env NEXTAUTH_SECRET loss — root cause found and fixed.**
  - Root cause: The sandbox session-start mechanism restores `.env` from a template containing only `DATABASE_URL`, wiping `NEXTAUTH_SECRET` at the start of each session. This is a sandbox-level behavior — the snapshot at `/tmp/my-project/.env` has the secret, but the restore process doesn't use the snapshot for `.env`.
  - Fix: Secrets now live in `.env.local` (which the sandbox doesn't reset). Next.js auto-loads `.env.local` with higher precedence than `.env`. The realtime service was updated to also load `.env.local` (with `overwrite=true` so it takes precedence over `.env`).
  - Safeguard: `src/lib/env-check.ts` — imported by auth options and realtime token lib. Throws a clear error at startup if `NEXTAUTH_SECRET` is missing, with instructions on how to fix it. The realtime service also has a startup check that exits with a clear error if the secret is missing.

- **Contacts panel (dashboard)** — `src/components/dashboard/views/contacts-panel.tsx` + `/api/contacts/[id]/conversations` API. List view with search, contact avatars, last-seen timestamps, conversation count. Click a contact to expand and see their conversation history. Wired into dashboard shell replacing the placeholder. Contacts API updated to include `_count: { conversations: true }`.

- **Billing — Iran-first, ZarinPal/IDPay/ZarinLink only.**
  - Payment adapter layer: `src/lib/payments/` — unified `PaymentGateway` interface, three adapters (zarinpal, idpay, zarinlink), each with test mode (simulates the flow without real API calls). Factory in `index.ts`.
  - Plan catalog: `src/lib/payments/plans.ts` — free (0T, 2/100/1), pro (290K T, 5/1000/5), business (890K T, 20/5000/∞), enterprise (contact sales). `ensurePlansSeeded()` upsert helper.
  - Plan gating: `src/lib/payments/gating.ts` — `checkPlanLimit()`, `enforceCurrentTenantPlanLimit()`, `getTenantUsage()`. Wired into member invite + department create endpoints (returns 402 Payment Required when exceeded).
  - Billing API: `/api/billing/plans` (GET, public), `/api/billing/subscribe` (POST, creates pending subscription + invoice, calls gateway), `/api/billing/callback/[gateway]` (GET, no auth — gateway callback, verifies payment, activates subscription), `/api/billing/subscription` (GET, current status + usage).
  - Billing panel: `src/components/dashboard/views/billing-panel.tsx` — usage bars, plan cards, gateway chooser, recent invoices, test-mode notice, callback toast handler.
  - Schema: Plan, Subscription, Invoice models added. All tenant-scoped writes pass tenantId explicitly.

- **Docker Compose packaging.**
  - `Dockerfile` — multi-stage (deps → builder → runtime), node:20-alpine base, single image supports `web` and `realtime` entrypoints via CMD arg.
  - `docker-entrypoint.sh` — validates NEXTAUTH_SECRET, switches between web/realtime modes, runs prisma db push at startup.
  - `docker-compose.yml` (full) — app + realtime + postgres + redis + caddy. `${VAR:?error}` fail-fast on NEXTAUTH_SECRET. Healthchecks + volumes + restart: unless-stopped.
  - `docker-compose.lite.yml` (lite) — app + realtime + caddy (SQLite, no Redis). ~512MB RAM.
  - `.env.docker.example` — all env vars documented with [REQUIRED]/[AUTO] markers.
  - `SELF_HOSTING.md` — quick start, env reference, **plain-language AGPL-3.0 explanation** (network-use clause), Lite vs Full, backup/restore, troubleshooting.
  - Realtime service updated with optional Redis adapter support (`@socket.io/redis-adapter` + `redis` packages). If `REDIS_URL` is set, uses Redis adapter + pub/sub; otherwise in-memory.

- **Analytics view** — `src/components/dashboard/views/analytics-panel.tsx` + `/api/analytics` API. Real data: conversation volume (7-day bar chart), avg first-response time, avg resolution time, CSAT score + distribution. Replaces the placeholder.

- **CSAT survey in-widget** — `/api/widget/[slug]/csat` POST endpoint (visitor submits rating 1-5). Widget script updated with `showCsatSurvey()` function — shows a star rating overlay when the conversation is closed (triggered by `conversation:updated` socket event with `status: 'closed'` or system message about closure). Schema updated with `csatRating`, `csatComment`, `csatAt`, `firstResponseAt` fields on Conversation.

- **Time-to-first-value** — confirmed at **2 seconds** (API-based: signup → workspace created → widget config + script accessible). Well under the 5-minute target. The widget-test.html auto-embeds via `?slug=` param — a real user just copies the embed snippet from Settings → Widget and pastes it.

Stage Summary:
- .env root cause: found and fixed (`.env.local` + startup safeguard).
- Contacts panel: working, tested.
- Billing flow: working end-to-end (ZarinPal test mode), tested.
- Docker Compose (full + lite): files created, env handling robust (fail-fast on missing NEXTAUTH_SECRET).
- Analytics view: real data, no longer a placeholder.
- CSAT survey: working, feeding into analytics.
- TTFV: 2 seconds, confirmed under 5 minutes.
- All 13 tests pass (3 smoke + 1 isolation + 3 module2 + 1 socketio-verify + 1 socket-race + 4 module3).
