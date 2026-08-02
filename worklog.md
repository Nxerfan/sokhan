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
