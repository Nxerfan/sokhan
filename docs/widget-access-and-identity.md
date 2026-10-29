# Widget Access & Identity

> **Status:** This document describes the **actual implementation** on branch `feat/widget-visitor-access-modes` at head `1e4bb64f1a84f1be1c0ebde35f89ffe1f2b06675`. It is the source-of-truth reference for the visitor access-policy feature (PR #14). The NPM package exists in the repository but **public npm publication is still pending** — the dashboard continues to present NPM as `Coming Soon`. Do **not** run a public `npm install sukhan-widget` until external publication actually happens.

---

## 1. Purpose and scope

Sukhan's widget lets a website embed a real-time chat. **Widget Access & Identity** controls *who* a visitor is, *how strongly* that identity is proven, and *what policy* governs message-sending + realtime joins for that tenant.

The feature introduces three **access modes** — `anonymous`, `verified_visitor`, `site_user_only` — enforced on the **current** tenant policy at REST send time + at realtime connect/join time. Identity is resolved per-tenant against tenant-scoped **Contacts** (not dashboard Users), with a `policyVersion` that immediately invalidates weaker credentials when the policy tightens.

**In scope:**
- The three access modes + their identity flows (OTP/resume, customer identity endpoint, anonymous).
- The `policyVersion` immediate-invalidation mechanism.
- The integration-secret lifecycle (generate/rotate/revoke).
- The public widget config, contact bootstrap, OTP, identity mint, message-send, realtime visitor authorization, NPM widget, both script-tag runtimes, + the dashboard Access & Identity UI.

**Intentionally out of scope for this feature:**
- Dashboard User authentication (NextAuth) — separate from visitor identity.
- Agent/realtime internal credentials — visitors are scoped to their Contact/conversation, not tenant-wide subscriptions.
- OTP provider configuration / provider dashboard controls.
- Billing/plan changes beyond the plan-independence of access policy from visual customization.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **workspace / tenant** | A single Sukhan tenant (`Tenant` row). One tenant has one `WidgetConfig`, many `Contact`s, many conversations. The widget is embedded per-tenant via the tenant slug. |
| **Contact** | A tenant-scoped visitor identity row (`Contact`). Identified by `identifier` (a `visitorId` or an opaque `ext_…` external id) + `identifierType` (`visitorId` / `externalUser`). A Contact is **not** a dashboard User. |
| **visitorId** | A browser-generated, tenant-scoped opaque id stored in `localStorage` under `sukhan_visitor_<slug>`. Used in anonymous + verified_visitor flows. |
| **externalUserId** | A stable, **server-authenticated** customer user id, provided by the customer's backend during the server-to-server identity mint. The stable identity key for `site_user_only`. **Never** browser-supplied. |
| **accessMode** | The tenant's current visitor access policy: `anonymous` / `verified_visitor` / `site_user_only`. |
| **identityLevel** | A claim in a signed visitor token: `anonymous` / `verified_contact` / `external_user`. Indicates how strongly the visitor's identity was proven. |
| **policyVersion** | A monotonic integer on `WidgetConfig`. Incremented on accessMode change + on integration-secret generate/rotate/revoke. Stale tokens (`policyVersion` mismatch) are immediately rejected for protected actions. Starts at `1` for new workspaces. |
| **resume credential** | An opaque, HMAC-signed, tenant/Contact/policyVersion-bound credential issued after successful OTP verification. Lets a verified visitor resume without re-OTP. Audience `sukhan-resume`. TTL 30 days. |
| **external identity token** | A short-lived, HMAC-signed token minted server-to-server by the customer backend. Carries `externalUserId` + `identityLevel=external_user` + `policyVersion`. Audience `sukhan-external`. TTL 5 minutes. Memory-only in the browser. |
| **realtime token** | A signed visitor token (separate from resume/external) issued by `/contact` bootstrap, used as the Socket.IO `auth.token`. Carries `identityLevel` + `policyVersion`. |
| **integration secret** | A dedicated Sukhan credential (48 random bytes, base64url) used **only** by the customer backend to mint external identity tokens via `POST /api/widget/identity/token`. SHA-256 hash stored; raw value shown once. **Not** a Widget Key, not NEXTAUTH_SECRET, not a DB/provider credential. |

---

## 3. Access modes overview

| Mode | Identity proof | Who can send / join realtime | Typical use |
|---|---|---|---|
| `anonymous` | None (visitorId only) | Anyone with the widget | Lowest assurance; legacy/compatibility; identity intentionally unnecessary. |
| `verified_visitor` | Email OTP | A visitor who completed OTP (or has a valid resume credential) | **Recommended** for most public websites. |
| `site_user_only` | Customer website login (external identity token) | Only authenticated customer-site users | SaaS/app dashboards, private portals. |

A stronger identity is always acceptable under a weaker mode; a weaker identity is never acceptable under a stricter mode. Mode is the **tenant's current policy** — enforced at send/join time, not just at bootstrap.

---

## 4. Defaults and migration behavior

The frozen contract distinguishes **new** vs **existing** rows:

```
existing migrated WidgetConfig rows -> anonymous
new WidgetConfig rows               -> verified_visitor
```

- The `WidgetConfig.accessMode` column DB default is `verified_visitor` (`prisma/schema.prisma`).
- The production signup (`src/app/api/auth/signup/complete/route.ts`) creates a new `WidgetConfig` **without** an explicit `accessMode`, so the DB default `verified_visitor` applies. `policyVersion` starts at `1`.
- The visitor-access migration backfills **existing** rows to `anonymous` (`DEFAULT_ACCESS_MODE_EXISTING = 'anonymous'`).
- Old workspaces were **not** automatically upgraded to `verified_visitor`. A tenant admin can change the mode via the dashboard.

Migration/creation-path proof: [`tests/db-boundary/widget-migration.test.ts`](../tests/db-boundary/widget-migration.test.ts) (existing→anonymous backfill + new-row→verified_visitor default) + [`tests/db-boundary/widget-access-foundation.test.ts`](../tests/db-boundary/widget-access-foundation.test.ts).

---

## 5. Identity levels and Contact model

Three identity levels (`src/lib/widget-access-evaluator.ts`):

| identityLevel | Contact `identifierType` | Required Contact fields | Meaning |
|---|---|---|---|
| `anonymous` | `visitorId` | `externalUserId = null` | visitorId-based; no email/site-login proof. |
| `verified_contact` | `visitorId` | `externalUserId = null`, `emailVerifiedAt != null` | visitorId-based + email OTP verified. |
| `external_user` | `externalUser` | `externalUserId != null` | customer-authenticated user, bound to `externalUserId`. |

Visitors/site users map to **tenant-scoped Contacts**, never dashboard Users. The evaluator **revalidates the Contact's persisted identity class** against the token's claim (a `verified_contact` token for a Contact missing `emailVerifiedAt` fails with `identity_token_invalid`; an `external_user` token for a `visitorId` Contact fails likewise).

---

## 6. Request origins and trust boundaries

| Origin | Who | What runs there |
|---|---|---|
| **CUSTOMER page origin** | The customer's website (`window.location.origin`) | The widget (NPM/script) renders here; the browser GETs the customer identity endpoint **same-origin** here. |
| **CUSTOMER backend** | The customer's server | The customer's own auth/session; the server-to-server Sukhan identity mint (`POST <SUKHAN_ORIGIN>/api/widget/identity/token`) runs here with the integration secret. |
| **SUKHAN REST origin** | The Sukhan backend (`apiUrl`) | Public config, `/contact`, OTP, `/messages`, identity mint. |
| **SUKHAN realtime origin** | The Sukhan realtime service | Socket.IO connect/join (visitor sockets scoped to their Contact/conversation). |

**Critical:** the `identityEndpoint` is a **customer-origin** relative path (e.g. `/api/sukhan-identity`). It resolves against `window.location.origin` — **never** the Sukhan origin. The dashboard readiness check does **not** probe it.

---

## 7. Anonymous mode

Historical behavior, preserved exactly:
- Browser generates/loads a slug-scoped `visitorId` (`localStorage` key `sukhan_visitor_<slug>`).
- `POST /api/widget/<slug>/contact` with `{ visitorId, email?, name? }` — **no** `Authorization` header.
- Backend creates/reuses a `visitorId` Contact, returns `{ contactId, conversationId, realtimeToken, locale, direction }`.
- Realtime token carries `identityLevel: 'anonymous'` + `policyVersion`.
- No OTP UI, no customer identity endpoint call.
- Subject to normal domain/rate restrictions.
- **Weakest identity assurance.**

---

## 8. Verified Visitor flow

End-user sequence:

```
config (accessMode=verified_visitor)
  -> visitor enters name/email in the widget's verification form
  -> OTP START  (POST /api/widget/<slug>/verify-identity/start)
  -> visitor enters the emailed code
  -> OTP VERIFY (POST /api/widget/<slug>/verify-identity/verify)
  -> resume credential issued (opaque, 30-day TTL)
  -> authenticated /contact bootstrap (Authorization: Bearer <resume>)
  -> realtime connect + conversation/history restore
```

**Email is not the primary identity key.** The Contact is visitorId-scoped; email is verified to prove ownership, but the resume credential + Contact id are the identity. A returning visitor resumes via the stored resume credential without re-OTP.

---

## 9. OTP START API

`POST /api/widget/<slug>/verify-identity/start`

**Request body:**
```json
{ "visitorId": "vis_…", "email": "user@example.com", "name": "Optional Name" }
```

**Success (200):**
```json
{ "requestId": "…", "expiresAt": "2025-01-01T00:00:00.000Z" }
```

Behavior (from [`src/app/api/widget/[slug]/verify-identity/start/route.ts`](../src/app/api/widget/%5Bslug%5D/verify-identity/start/route.ts)):
- Rate-limited per IP + slug.
- Tenant-bound; mode must be `verified_visitor` (else `409 mode_mismatch`).
- Pending `name`/`email` stored on `WidgetOtpRequest` — the Contact's `email`/`name`/`emailVerifiedAt` are **not** mutated at START.
- Resolving an existing Contact by `(tenant, visitorId)` requires `identifierType='visitorId'` + `externalUserId=null`; a collision with an external-user Contact → `403 identity_conflict`.
- Starting a new flow **supersedes** any previous active `WidgetOtpRequest` for the same Contact (atomically expires the old ones).
- Bounded P2002 retry on concurrent Contact creation.

Stable failure codes: `rate_limited` (429), `not_found` (404), `mode_mismatch` (409), `policy_unavailable` (503), `invalid_body` (400), `visitorId_required` (400), `invalid_email` (400), `identity_conflict` (403), `verification_conflict` (409), provider codes, `internal_error` (500).

---

## 10. OTP VERIFY API

`POST /api/widget/<slug>/verify-identity/verify`

**Request body:**
```json
{ "visitorId": "vis_…", "email": "user@example.com", "requestId": "…", "code": "123456" }
```

**Success (200):**
```json
{ "verified": true, "contactId": "…", "resumeCredential": "…", "realtimeToken": "…" }
```

Behavior ([`…/verify/route.ts`](../src/app/api/widget/%5Bslug%5D/verify-identity/verify/route.ts)):
- `MAX_VERIFY_ATTEMPTS = 5` — atomic attempt reservation before calling the OTP provider; over the limit → `429 attempt_limit_reached`.
- Contact revalidated (tenant, visitorId, `identifierType`, `externalUserId=null`, email match) **before** the provider call. Mismatch → `403 identity_mismatch`-class, no provider call, no attempt consumed.
- Expiry: `expiresAt < now` → `400 expired`.
- One-time: a verified/superseded request cannot be reused (`already_used` / `request_superseded`).
- Success finalization in **one** tenant-bound transaction: conditional claim (`verified=false AND expiresAt>now`) + Contact revalidation + `emailVerifiedAt` set. Credentials issued only after commit.
- Resume credential + realtime token issued on success.

Stable failure codes: `code_mismatch` (400), `expired` (400), `request_superseded` (400), `already_used` (400), `attempt_limit_reached` (429), `request_not_found` (404), `missing_fields` (400), `mode_mismatch` (409), `policy_unavailable` (503), `rate_limited` (429).

---

## 11. OTP RESEND API

`POST /api/widget/<slug>/verify-identity/resend`

**Request body:**
```json
{ "visitorId": "vis_…", "email": "user@example.com", "requestId": "…" }
```

**Success (200):**
```json
{ "requestId": "<rotated>", "expiresAt": "<rotated>" }
```

Behavior ([`…/resend/route.ts`](../src/app/api/widget/%5Bslug%5D/verify-identity/resend/route.ts)):
- `MAX_RESENDS = 3` — enforced via PostgreSQL `SELECT … FOR UPDATE` inside a transaction (row-lock serialization). Provider call happens **inside** the lock; failure rolls back (no resend consumed).
- On success, `requestId` + `expiresAt` are **rotated** — the old `requestId` is no longer usable for verify.
- The frontend `email` is **not** trusted to change identity (used only for optional correlation; mismatch → `409 wrong_correlation`).
- Old/superseded requests → `request_superseded` / `expired`.

Stable failure codes: `resend_limit` (429), `expired` (400), `wrong_correlation` (409), `rate_limited` (429), `mode_mismatch` (409), `policy_unavailable` (503), `visitorId_required` (400), `invalid_email` (400).

---

## 12. Resume credential

[`src/lib/widget-identity-tokens.ts`](../src/lib/widget-identity-tokens.ts):

- HMAC-signed opaque envelope. Audience `sukhan-resume`. Type `resume`.
- Claims: `contactId`, `tenantId`, `identityLevel: 'verified_contact'`, `policyVersion`.
- TTL: `RESUME_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60` (30 days).
- Tenant-bound, Contact-bound, policyVersion-bound. Audience/purpose-protected (a resume credential is **not** accepted as an external identity token + vice-versa).
- Stored in the browser in `localStorage` under `sukhan_verified_resume_<slug>` (separate key from `visitorId`). Treated as **opaque** — browsers must not parse it.
- On stale/invalid resume, `/contact` returns `403 verification_required`; the widget clears the resume + shows the verification UI (no anonymous downgrade).

---

## 13. Site User Only architecture

Trust chain:

```
host browser
  -> customer identity endpoint (e.g. /api/sukhan-identity, same-origin)
       -> customer backend's authenticated session/user
       -> server-to-server Sukhan identity mint:
            POST <SUKHAN_ORIGIN>/api/widget/identity/token
            Authorization: Bearer <integration secret>
            body: { externalUserId, name?, username?, email?, avatarUrl? }
       <- { token }   (short-lived external identity token)
  <- { authenticated: true, token }
  -> Sukhan POST /api/widget/<slug>/contact
       Authorization: Bearer <external identity token>
  <- { contactId, conversationId, realtimeToken, … }
```

**The browser must never choose a trusted `externalUserId`.** The `externalUserId` comes from the customer's server-side authenticated user. Browser-supplied user id/email is never trusted.

---

## 14. Integration secret lifecycle

[`src/lib/widget-integration-credential.ts`](../src/lib/widget-integration-credential.ts) + [`src/app/api/widget-config/integration-secret/route.ts`](../src/app/api/widget-config/integration-secret/route.ts):

- Generated by Sukhan: `RAW_LENGTH_BYTES = 48` (384 bits) random bytes, `base64url`-encoded.
- Stored: **SHA-256 hex hash** (`integrationSecretHash`); the raw value is returned **exactly once** on POST (generate/rotate).
- Tenant-bound. Dashboard shows only `hasSecret` + `rotatedAt` (never the raw value on GET).
- **Generate / Rotate / Revoke** each increment `policyVersion` (so previously-minted external identity tokens become stale for protected actions under the new policyVersion).
- Rotate: the previous secret stops working **immediately** — no dual-secret grace period. The customer backend must update its stored secret right away.
- Revoke: `integrationSecretHash` cleared; the customer backend can no longer mint tokens. Mode stays `site_user_only` (runtime fails closed until a new secret is generated; **not** auto-downgraded to anonymous).
- Never browser-visible. **Not** a Widget Key, not NEXTAUTH_SECRET, not a DB/provider key.

---

## 15. External identity mint API

`POST /api/widget/identity/token`

**Authentication:**
```
Authorization: Bearer <integration secret>
```

**Required body field:** `externalUserId` (string, ≤200 chars, no control chars).

**Optional profile fields (server-side trusted only):** `name`, `username`, `email`, `avatarUrl`. If present but not a string → `400 invalid_profile` (`{ error: 'invalid_profile', field }`). `email` validated; `avatarUrl` must be http(s).

**Success (200):** `{ "token": "<external identity token>" }` — no PII in the token.

Behavior ([`src/app/api/widget/identity/token/route.ts`](../src/app/api/widget/identity/token/route.ts)):
- Mode must be `site_user_only` (else `409 mode_mismatch`).
- Concurrency-safe Prisma upsert on `(tenantId, externalUserId)` → stable mapping: **same `tenantId + externalUserId` → same Contact**.
- Token carries `identityLevel: 'external_user'` + `policyVersion`.

**Display fallback** (Contact name shown in dashboard/inbox): `name -> username -> email -> "Authenticated user"`.

Stable failure codes: `unauthorized` (401), `policy_unavailable` (503), `mode_mismatch` (409), `invalid_body` (400), `externalUserId_required` (400), `invalid_profile` (400), `invalid_email` (400), `invalid_avatar_url` (400).

---

## 16. External identity token

- HMAC-signed envelope. Audience `sukhan-external`. Type `external_identity`.
- Claims: `tenantId`, `externalUserId`, `contactId` (bound where present), `identityLevel: 'external_user'`, `policyVersion`, `iat`, `exp`.
- TTL: `EXTERNAL_IDENTITY_TOKEN_TTL_SECONDS = 5 * 60` (5 minutes).
- Short-lived + **memory-only** in the browser (never localStorage/sessionStorage/cookies/IndexedDB/URL/DOM attributes).
- Audience/purpose-protected (not accepted as a resume credential).

---

## 17. Customer identity endpoint contract

Preferred path: `/api/sukhan-identity` (customer-configurable via `identityEndpointPath`).

**Browser request:** `GET`, same-origin, `credentials: 'same-origin'`, `Accept: application/json`. Sends **no** Sukhan secret / externalUserId / visitorId / Contact id / realtime token.

**Logged-out response:**
```json
{ "authenticated": false }
```

**Logged-in response:**
```json
{ "authenticated": true, "token": "<short-lived Sukhan external identity token>" }
```

Strict parsing (in the NPM/script runtime): only the two shapes above are accepted. Arrays, missing `authenticated`, non-boolean `authenticated`, `authenticated:true` without a non-empty string `token`, non-string `token`, oversized token → **fail closed** (`integration_unavailable`).

Bounded timeout: **5 seconds** (`AbortController`). Timeout / network failure / non-2xx / malformed JSON → fail closed. **Logged-out (`authenticated:false`) is a valid auth result** (→ login-required UI), **not** an integration failure. **Never** downgraded to anonymous.

The endpoint resolves against the **customer page origin** (`window.location.origin`), never the Sukhan origin. Cross-origin absolute endpoints are rejected.

---

## 18. NPM widget integration

The NPM package lives at [`packages/widget-npm`](../packages/widget-npm). **Public npm publication is still pending** — the dashboard shows NPM as `Coming Soon`. Consume from the repository source until publication.

```ts
import { initSukhan } from 'sukhan-widget' // after package availability

const widget = initSukhan({
  apiKey: 'YOUR_WIDGET_KEY',
  identityEndpoint: '/api/sukhan-identity',
})
```

Instance surface:
```ts
widget.setIdentity(token)        // bootstrap/re-bootstrap with an external identity token
widget.setIdentity(null)         // logout: clear identity, disconnect, enter login-required
widget.refreshIdentity()         // re-query the customer identityEndpoint (SPA post-login, no reload)
widget.send(text)
widget.open() / widget.close() / widget.toggle()
widget.destroy()
```

- `setIdentity(tokenB)` after User A is active: disconnects A's socket, clears A's messages/contactId/conversationId, bumps a **generation counter** (stale async from A cannot mutate B's state), bootstraps B. Live A→B user switch with no cross-account history leakage.
- `setIdentity(null)` (logout): immediately disconnects, clears state, enters login-required.
- `refreshIdentity()`: re-fetches the customer endpoint; if authenticated, bootstraps; if logged-out, login-required. No page reload.
- The external identity token is **memory-only**.

`onLoginRequired` callback option + the `sukhan:login-required` window CustomEvent (see §20).

---

## 19. Script-tag widget integration

Two endpoints, both identity-parity with the NPM widget:

**Slug script:** `GET /api/widget/<slug>/script`
```html
<script async defer src="https://YOUR_SUKHAN_ORIGIN/api/widget/YOUR_SLUG/script"></script>
```

**v1 stable script:** `GET /api/widget/v1/sukhan.js`
```html
<script
  async
  defer
  src="https://YOUR_SUKHAN_ORIGIN/api/widget/v1/sukhan.js"
  data-api-key="YOUR_WIDGET_KEY"
  data-identity-endpoint="/api/sukhan-identity">
</script>
```

The v1 script supports a `data-identity-endpoint` override (resolved same-origin against the customer page origin). The slug script uses the public config `identityEndpointPath`.

Public SPA control surface (both runtimes):
```js
window.SukhanWidget.setIdentity(token)   // site_user_only bootstrap
window.SukhanWidget.setIdentity(null)    // logout
window.SukhanWidget.refreshIdentity()    // SPA post-login
```

Both runtimes share the same identity runtime ([`src/lib/widget-script-identity.ts`](../src/lib/widget-script-identity.ts)) — the security-critical contract (endpoint resolution, response parsing, login-required event, OTP API) is identical across the two generated scripts. No internal state/Contact id/realtime token/resume credential is exposed via `window.SukhanWidget`.

---

## 20. Login-required behavior

When the widget enters the site-user login-required state (logged-out host user under `site_user_only`):

- A `sukhan:login-required` **CustomEvent** is dispatched on `window`.
- For NPM, the `onLoginRequired` callback is also invoked.
- **Safe detail only:** `{ accessMode: 'site_user_only', loginUrl, loginButtonLabel, loginReturnUrlParam }`. Never includes the integration secret, identity token, realtime token, or (preferably) the Contact id.
- **Transition-based:** emitted once on entering login-required, not on every render/reconnect tick (no event storms).

---

## 21. Login URL and SPA/modal login

Configured via the dashboard / `PATCH /api/widget-config/access`:
- `loginUrl` — relative (`/login`) or absolute http(s).
- `loginButtonLabel` — the button text.
- `loginReturnUrlParam` — query-param name.

**Relative `loginUrl` resolves against the customer page origin** (`window.location.origin`), never the Sukhan origin. If `loginReturnUrlParam` is set, the widget appends `<param>=window.location.href` via the `URL` API (no manual concatenation, no open redirect).

**No `loginUrl` is required** for SPA/modal integrations — the host listens for `sukhan:login-required`, opens its own login UI, then calls `refreshIdentity()` (no page reload). After a successful SPA/modal login, the widget re-queries the customer endpoint, bootstraps the authenticated Contact, connects realtime, + enables sending.

---

## 22. Public Widget Access configuration

`GET /api/widget/<slug>/config` returns the visual config **spread with** the safe public access-policy fields:
- `accessMode`
- `policyVersion`
- `loginUrl`
- `loginButtonLabel`
- `loginReturnUrlParam`
- `identityEndpointPath`
- `realtime` (endpoint config)

A malformed persisted policy (e.g. corrupt `accessMode`) **fails closed** (`503 policy_unavailable`) — it is never silently coerced to anonymous. **No** integration secret / hash is ever public.

---

## 23. Dashboard Access & Identity configuration

[`src/components/dashboard/views/widget-access-identity.tsx`](../src/components/dashboard/views/widget-access-identity.tsx) (the "Access & Identity" tab in the Widget panel):

- Three mode cards (keyboard-accessible radio semantics): **Verified visitor** (Recommended badge), **Site user only**, **Anonymous** (amber warning).
- **Access policy is independent from the customization plan-lock** — never disabled on Free, never forces anonymous.
- **Explicit Save** with a local draft: selecting a card does not change production. Changing the mode shows an immediate-policy-change warning + a confirmation dialog. One intentional `PATCH` per save (mode + site-user fields together); empty optional fields sent as `null`.
- `policyVersion` is **read-only** display; the post-save value comes from the authoritative `GET /api/widget-config/access` (the PATCH response returns only `{accessMode, policyVersion,accessModeChanged}` — the dashboard re-fetches GET for the full config, no client-side synthesis).
- Site-user fields: `identityEndpointPath`, `loginUrl`, `loginButtonLabel`, `loginReturnUrlParam` + a setup-status checklist.
- Integration secret **Generate / Rotate / Revoke** via the dedicated `/api/widget-config/integration-secret` API (each with a confirmation dialog). Raw secret shown **once** in a memory-only reveal card (Copy + Dismiss); after reload only "Secret configured".
- **Readiness check:** re-reads `GET /api/widget-config/access` + verifies mode/secret/endpoint. It is **Sukhan-side only** — it does **not** probe the customer endpoint (no SSRF), sends no secret anywhere. The success copy explicitly states it does not prove the customer endpoint/auth works.

---

## 24. policyVersion and policy transitions

`policyVersion` is the **immediate invalidation** mechanism. An accessMode change increments it exactly once; a same-mode or non-mode PATCH does not. Secret generate/rotate/revoke also increment it.

A visitor with a token whose `policyVersion` is stale (≠ current) is **immediately** rejected for protected actions (send / realtime join) — this is **not** expiry-only enforcement. Covered transitions include:
```
anonymous -> verified_visitor
anonymous -> site_user_only
verified_visitor -> site_user_only
```

Weaker credentials (e.g. an anonymous token after a transition to `verified_visitor`) lose permission immediately. Secret rotation/revocation increments `policyVersion`, so external identity tokens minted under the previous policy become stale for protected operations.

---

## 25. REST authorization

`POST /api/widget/<slug>/messages` enforces **CURRENT-policy** send authorization ([`src/lib/widget-access-evaluator.ts`](../src/lib/widget-access-evaluator.ts) `evaluateSendAuthorization`):

Checks: current tenant policy (accessMode + policyVersion), token `identityLevel`, presented `policyVersion`, persisted Contact identity class. The Contact row is revalidated against the token's claim.

Stable failure semantics (safe error codes, no raw internals):
- `verification_required` — verified_visitor mode, insufficient identity.
- `website_login_required` — site_user_only mode, insufficient identity.
- `policy_changed` — stale `policyVersion`.
- `identity_token_invalid` — partial/malformed token claims or Contact identity-class mismatch.
- `policy_unavailable` — missing/corrupt `WidgetConfig`.
- Plus: `no_token` (401), `invalid_token` (401), `token_slug_mismatch` (403), `token_tenant_mismatch` (403), `rate_limited` (429), `empty_message` (400), `domain_not_allowed` (403).

On a policy denial, the optimistic message stays failed/retryable — the dashboard/widget triggers identity recovery but does **not** auto-resend (explicit retry required).

---

## 26. Realtime authorization

Two deployment paths share the **same pure evaluator** (`evaluateVisitorCurrentPolicyAccess`):

- **Vercel realtime** (`api/realtime.ts`): in-process adapter (`src/lib/realtime-visitor-auth.ts`) loads tenant + WidgetConfig + Contact + calls the evaluator directly.
- **Docker mini realtime service** (`mini-services/realtime/index.ts`): calls the internal verifier `GET /api/realtime/verify-visitor-access` (timing-safe `X-Internal-Secret` header), which runs the same evaluator.

Checks occur on:
- **Visitor socket connect** (`io.use` middleware).
- **`conversation:join`** — revalidated against the CURRENT policy (a policy may change mid-connection).

An already-connected weaker visitor **cannot join a new conversation** after a stricter policy transition. Agent realtime behavior is separate (not covered by visitor authorization).

Docker error-reason allowlist: `{policy_unavailable, identity_token_invalid, policy_changed, verification_required, website_login_only}` — anything else maps to `visitor_access_check_failed`. Visitors are scoped to their authorized Contact/conversation (not tenant-wide subscriptions).

---

## 27. Legacy token compatibility

A historical visitor realtime token is considered **legacy** ONLY when **BOTH**:
- `identityLevel` absent (undefined)
- `policyVersion` absent (undefined)

It is accepted **ONLY while the CURRENT mode is `anonymous`**. In `verified_visitor` / `site_user_only`, a legacy token is rejected.

**Partial modern claims or malformed claims are NOT legacy and fail closed.** A correctly-signed modern token with partial claims (one present, one missing) or malformed values must **not** silently degrade to anonymous.

---

## 28. Browser credential storage rules

| Value | Storage |
|---|---|
| `visitorId` | `localStorage` (`sukhan_visitor_<slug>`) — anonymous/verified_visitor flow |
| Verified resume credential | `localStorage` (`sukhan_verified_resume_<slug>`) — slug-scoped, opaque |
| OTP code | **never persisted** |
| External identity token | **memory only** |
| Realtime token | **memory only** |
| Integration secret | **server only** (customer backend env) |
| Raw integration secret (dashboard reveal) | **component memory only** — shown once, dismissed |

---

## 29. Security and threat model

Implemented controls (not absolute security):

- **Cross-tenant credential misuse:** tokens are tenant-bound + verified; cross-tenant join/send rejected (`token_tenant_mismatch`).
- **Cross-contact misuse:** a visitor cannot join another Contact's conversation (cross-contact isolation in realtime).
- **Token tampering:** HMAC-signed envelopes; tampering → `identity_token_invalid`.
- **Stale policy:** `policyVersion` immediate invalidation (not expiry-only).
- **Identity-class drift:** the evaluator revalidates the persisted Contact against the token's claim.
- **Browser-supplied `externalUserId`:** never trusted; `externalUserId` comes from the customer's server-side auth only.
- **Email collision / email-as-identity:** email is profile data, not the identity key; `externalUserId` is the stable key. Same email in another tenant does not imply shared identity.
- **Cross-origin customer identity endpoint:** rejected (same-origin only).
- **Open redirect:** `loginUrl` built via the `URL` API with `loginReturnUrlParam`; relative resolves against the customer origin.
- **Integration secret exposure:** server-only; raw shown once; never in browser artifacts.
- **Secret rotation/revocation:** increments `policyVersion`; no dual-secret grace period.
- **OTP replay/supersession/attempt limits:** `MAX_VERIFY_ATTEMPTS=5`, `MAX_RESENDS=3`, supersession, one-time semantics.
- **Concurrent Contact creation:** bounded P2002 retry; concurrency-safe upsert on `(tenantId, externalUserId)`.
- **Malformed modern claims:** fail closed (not legacy).
- **SSRF avoidance:** the dashboard readiness check reads only Sukhan-side state — no customer-URL probing.
- **Stale SPA async / cross-account history leakage:** generation counter in the NPM widget + `clearIdentityState` re-render prevents stale async from a previous identity mutating the new identity's state.

---

## 30. Errors, failure modes, and troubleshooting

| Code | HTTP | Meaning |
|---|---|---|
| `mode_mismatch` | 409 | OTP/mint called under the wrong accessMode. |
| `policy_unavailable` | 503 | Missing/corrupt `WidgetConfig` (bad `accessMode`/`policyVersion`). |
| `policy_changed` | 403 | Stale `policyVersion` (visitor token ≠ current). |
| `verification_required` | 403 | `verified_visitor` mode, insufficient identity (no/stale resume). |
| `website_login_required` | 403 | `site_user_only` mode, missing/invalid external token. |
| `identity_token_invalid` | 403 | Partial/malformed token claims or Contact identity-class mismatch. |
| `identity_conflict` | 403 | visitorId collides with an external-user Contact. |
| `rate_limited` | 429 | Rate limit (per IP + slug). `Retry-After` header. |
| `expired` | 400 | OTP request expired. |
| `request_superseded` | 400 | A newer OTP flow superseded this one. |
| `already_used` | 400 | OTP request already verified. |
| `attempt_limit_reached` | 429 | `MAX_VERIFY_ATTEMPTS=5` exceeded. |
| `resend_limit` | 429 | `MAX_RESENDS=3` exceeded. |
| `code_mismatch` | 400 | Wrong OTP code. |
| `wrong_correlation` | 409 | Resend: email/requestId mismatch. |
| `verification_conflict` | 409 | START: concurrent/active-flow conflict. |
| `unauthorized` | 401 | Identity mint: missing/invalid integration secret. |
| `invalid_profile` | 400 | Mint: a profile field present but not a string. |
| `invalid_email` / `invalid_avatar_url` | 400 | Mint: malformed optional field. |
| `externalUserId_required` | 400 | Mint: missing `externalUserId`. |
| `invalid_body` | 400 | Malformed JSON body. |
| `no_token` / `invalid_token` | 401 | Messages: missing/invalid bearer. |
| `token_slug_mismatch` / `token_tenant_mismatch` | 403 | Token doesn't match the route slug/tenant. |
| `empty_message` | 400 | Empty send text. |
| `domain_not_allowed` | 403 | Embedding domain not allow-listed. |
| `not_found` | 404 | Tenant not found. |
| `forbidden` | 403 | Dashboard mutation: non-admin role. |
| **integration unavailable** | — | Customer identity endpoint timeout/network/non-2xx/malformed → fail closed (no anonymous fallback). |

---

## 31. Verification and qualification evidence

**Accepted head before docs:** `1e4bb64f1a84f1be1c0ebde35f89ffe1f2b06675`
**Accepted run:** `40800843935`

| Gate | Result |
|---|---|
| `ci` | SUCCESS |
| `docker-regression` | SUCCESS |
| `self-host-qualification` | SUCCESS |
| `widget-package-qualification` | SUCCESS |

**Verified counts (Full + Lite):**
- Full DB-boundary: 271 pass / 0 fail
- Lite DB-boundary: 271 pass / 0 fail
- Full browser: 151 passed
- Lite browser: 151 passed

**Tested categories:**
- Migration / defaults (existing→anonymous, new→verified_visitor)
- OTP START/VERIFY/RESEND (concurrency, attempt/resend limits, supersession, expiry)
- Credential misuse (cross-tenant, cross-contact, tampered tokens)
- Policy transitions (anonymous↔verified_visitor↔site_user_only, immediate invalidation)
- Stable `externalUserId` mapping (same user → same Contact)
- Secret generate/rotate/revoke (policyVersion increment, one-time reveal, no-persistence)
- REST send authorization (CURRENT-policy, stable error codes)
- Realtime authorization (Vercel + Docker parity, connect + conversation:join)
- NPM widget identity (anonymous/verified/site_user + SPA refreshIdentity/user-switch/logout)
- Script widget identity parity (both endpoints)
- Dashboard Access & Identity (mode save, post-Save full-config regression, secret lifecycle, no-SSRF)
- External-origin embedding (customer origin vs Sukhan origin)
- Credential leaks (integration secret not in browser artifacts)
- Full + Lite PostgreSQL

These are qualification results for the exact implementation SHA **before** this docs commit.

---

## 32. Customer-repository coding CLI prompt

> Paste the following prompt into a coding CLI **while inside the customer's application repository**. The prompt is framework-neutral. The agent must inspect the repository first + use its actual server-side auth primitives.

```text
You are integrating the customer's application with the Sukhan widget visitor-access
contract (site_user_only mode). Do NOT modify Sukhan itself — you are integrating the
customer's repository with the existing Sukhan contract.

STEP 0 — Inspect the repository FIRST. Do not invent framework/auth APIs.
  1. Inspect the package manager / lockfiles (package.json, bun.lockb, yarn.lock,
     pnpm-lock.yaml, Gemfile, requirements.txt, go.mod, Cargo.toml, etc.).
  2. Inspect the framework / runtime (Next.js, Express, Fastify, NestJS, Rails,
     Django, Laravel, ASP.NET, Phoenix, etc.). Determine frontend vs server
     execution boundaries.
  3. Inspect the EXISTING authentication implementation. Find the authoritative
     server-side current-user accessor (e.g. a session middleware, a req.user,
     a getUser(ctx) helper, a controller base class).
  4. Identify the STABLE IMMUTABLE customer user ID (the primary key the customer's
     auth uses — NOT an email, NOT a username, NOT a browser cookie). This is the
     `externalUserId`.
  5. Inspect login / logout flows. Inspect SPA/modal vs redirect login behavior.
  6. Inspect environment-variable conventions. Find the SERVER-only env prefix
     (e.g. a non-public secret store). Identify the PUBLIC-client env prefix
     convention (e.g. NEXT_PUBLIC_*, VITE_*, PUBLIC_*) — the integration secret
     MUST NOT be in any public-client env.
  7. Inspect existing route/API conventions (where do API endpoints live?).
  8. Inspect existing tests + lint/typecheck/build commands.

STEP 1 — Configure the integration secret.
  - Obtain SUKHAN_INTEGRATION_SECRET from the Sukhan dashboard (Access & Identity
    → Generate integration secret). It is shown ONCE — copy it immediately.
  - Add it to the SERVER environment configuration (a server-only secret store /
    a non-public .env variable / your platform's secret manager).
  - NEVER expose it in: client bundles, HTML, logs, URLs, localStorage, cookies,
    NEXT_PUBLIC_*, VITE_*, PUBLIC_*, window.*, or data-* attributes. Inspect the
    repository's public-client env conventions and avoid them.

STEP 2 — Implement the customer identity endpoint (preferably /api/sukhan-identity).
  - GET, same-origin, Accept: application/json.
  - On the SERVER, read the current authenticated user via the repository's actual
    server-side auth primitive (from STEP 0.3). NEVER trust browser-supplied
    user id / email as externalUserId.
  - If the user is NOT authenticated, respond exactly:
      { "authenticated": false }
  - If authenticated, mint a Sukhan external identity token SERVER-TO-SERVER:
      POST <SUKHAN_ORIGIN>/api/widget/identity/token
      Authorization: Bearer ${process.env.SUKHAN_INTEGRATION_SECRET}  (or the repo's server env accessor)
      Content-Type: application/json
      body: {
        externalUserId: currentUser.id,   // the stable server-authenticated user id
        name: currentUser.name,           // optional, trusted server-side
        username: currentUser.username,   // optional
        email: currentUser.email,         // optional
        avatarUrl: currentUser.avatarUrl, // optional, must be http(s)
      }
    The mint returns { token }. Respond to the browser exactly:
      { "authenticated": true, "token": "<token>" }
  - NEVER return the integration secret to the browser.
  - On mint failure (non-2xx), respond { "authenticated": false } (the widget will
    fail closed to login-required; do NOT fabricate a token).

STEP 3 — Integrate the widget.
  - If the NPM package is available (after public publication), use:
      initSukhan({ apiKey: 'YOUR_WIDGET_KEY', identityEndpoint: '/api/sukhan-identity' })
    (Until publication, consume from the repository source.)
  - OR use the script tag:
      <script async defer
        src="https://YOUR_SUKHAN_ORIGIN/api/widget/v1/sukhan.js"
        data-api-key="YOUR_WIDGET_KEY"
        data-identity-endpoint="/api/sukhan-identity"></script>
  - Handle the `sukhan:login-required` window event (or onLoginRequired for NPM):
      window.addEventListener('sukhan:login-required', () => { /* open host login UI */ })
  - Support the application's real login route/modal. After a successful SPA/modal
    login (no page reload), call:
      window.SukhanWidget.refreshIdentity()   // script
      // or widget.refreshIdentity()          // NPM
  - On logout, call:
      window.SukhanWidget.setIdentity(null)   // script
      // or widget.setIdentity(null)          // NPM
  - Support account switching (user A → user B): call setIdentity(tokenForB) — the
    widget disconnects A, clears A's history, and bootstraps B. Do not leak A's
    conversation history to B.

STEP 4 — Fail-closed behavior.
  - The customer identity endpoint MUST fail closed on timeout / network failure /
    non-2xx / malformed response. Logged-out ({authenticated:false}) is a valid
    auth result (→ login-required), NOT an integration failure.
  - NEVER downgrade to anonymous.

STEP 5 — Tests (use the repository's test framework).
  - Test logged-out behavior (login-required UI + sukhan:login-required event).
  - Test logged-in behavior (bootstrap + send + realtime).
  - Test identity-endpoint failure (timeout/500/malformed → fail closed).
  - Test stable same-user mapping (same externalUserId across page loads → same Contact).
  - Test logout (setIdentity(null) → cleared, login-required).
  - Test user A → user B switch (A history absent after switch).
  - Test that the integration secret is ABSENT from browser artifacts (HTML, globals,
    localStorage, sessionStorage, network responses to the browser).

STEP 6 — Run the repository's real gates.
  - Run the repository's real lint.
  - Run the repository's real typecheck.
  - Run the repository's real tests.
  - Run the repository's real production build.

STEP 7 — Report.
  - Report every changed file + the exact commands + their results.

Do not invent framework/auth APIs. Inspect the repository first and use its actual
server-side auth primitives. Do not modify Sukhan itself. You are integrating the
customer's repository with the existing Sukhan contract.
```

---

### Cross-links

- NPM package README: [`packages/widget-npm/README.md`](../packages/widget-npm/README.md)
- Evaluator: [`src/lib/widget-access-evaluator.ts`](../src/lib/widget-access-evaluator.ts)
- Identity tokens: [`src/lib/widget-identity-tokens.ts`](../src/lib/widget-identity-tokens.ts)
- Integration credential: [`src/lib/widget-integration-credential.ts`](../src/lib/widget-integration-credential.ts)
- Public config: [`src/app/api/widget/[slug]/config/route.ts`](../src/app/api/widget/%5Bslug%5D/config/route.ts)
- Contact bootstrap: [`src/app/api/widget/[slug]/contact/route.ts`](../src/app/api/widget/%5Bslug%5D/contact/route.ts)
- OTP routes: [`src/app/api/widget/[slug]/verify-identity/`](../src/app/api/widget/%5Bslug%5D/verify-identity/)
- Identity mint: [`src/app/api/widget/identity/token/route.ts`](../src/app/api/widget/identity/token/route.ts)
- Messages: [`src/app/api/widget/[slug]/messages/route.ts`](../src/app/api/widget/%5Bslug%5D/messages/route.ts)
- Realtime verifier: [`src/app/api/realtime/verify-visitor-access/route.ts`](../src/app/api/realtime/verify-visitor-access/route.ts)
- Dashboard component: [`src/components/dashboard/views/widget-access-identity.tsx`](../src/components/dashboard/views/widget-access-identity.tsx)
- Script identity runtime: [`src/lib/widget-script-identity.ts`](../src/lib/widget-script-identity.ts)
- DB-boundary tests: [`tests/db-boundary/`](../tests/db-boundary/)
- Dashboard tests: [`tests/widget-access-identity-dashboard.spec.ts`](../tests/widget-access-identity-dashboard.spec.ts)
