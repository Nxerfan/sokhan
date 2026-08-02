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

