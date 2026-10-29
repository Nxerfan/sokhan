# Widget Customization V2 — Foundation Audit

> **Phase 1, Part A.** Evidence-based audit of the current customization architecture, conducted BEFORE writing any production code. All findings reference actual file paths + line numbers at branch head `ccc70b7440f35204494c89de197fd82922eb238c`.

---

## 1. Current architecture trace

### 1.1 Database schema (`prisma/schema.prisma`)

`WidgetConfig` model (lines 180–204):
- **Visual fields:** `accentColor` (String, default `#E09A2B`), `launcherShape` (String, default `tab`), `position` (String, default `bottom-end`), `avatarUrl` (String?), `logoUrl` (String?), `greetingTexts` (Json), `defaultLocale` (String, default `fa`).
- **Access/identity fields (PR #14):** `accessMode`, `policyVersion`, `integrationSecretHash`, `integrationSecretRotatedAt`, `loginUrl`, `loginButtonLabel`, `loginReturnUrlParam`, `identityEndpointPath`.
- **No appearance version field.** No desktop/mobile distinction. No structured appearance model — the visual config is a flat set of columns.

`Tenant` model has `plan` (String, default `free`) + `defaultLocale` / `defaultDirection`.

### 1.2 Plan catalog (`src/lib/payments/plans.ts`)

- `Plan.customization: boolean` — the ONLY customization entitlement signal.
  - `free`: `customization: false`
  - `pro` / `max` / `self-hosted`: `customization: true`
- This is a **coarse boolean** — Free is fully locked; paid plans have unrestricted customization. No per-capability distinction.

### 1.3 Effective config resolution (`src/lib/payments/free-plan.ts`, `getEffectiveWidgetConfig`, lines 92–139)

- Reads `Tenant` + `WidgetConfig`.
- `isLocked = !plan?.customization`.
- **Free (locked):** returns **hardcoded** Sukhan brand defaults (accent `#E09A2B`, shape `tab`, position `bottom-end`, fixed greetings, `avatarUrl: null`, `logoUrl: null`) + `isLocked: true, poweredBy: true`. The tenant's stored WidgetConfig values are **ignored**.
- **Paid:** returns the stored WidgetConfig values + `isLocked: false, poweredBy: false`.

**Defect D1 (coarse entitlement):** Free tenants cannot customize ANYTHING — the approved V2 contract gives Free limited customization (3 preset positions, 10 color palettes, limited launcher selection, etc.). The current model is incompatible.

### 1.4 Dashboard config API (`src/app/api/widget-config/route.ts`)

**GET (lines 20–32):** returns `{ stored, effective, isLocked }` — `stored` is the raw WidgetConfig, `effective` is `getEffectiveWidgetConfig()`, `isLocked` from `!plan.customization`.

**PATCH (lines 77+):**
- **Plan gate (CUST-A):** `if (!plan?.customization) return 402 customization_locked` — Free cannot PATCH at all.
- **Strict validation (CUST-E):** `accentColor` (hex `#rrggbb`), `launcherShape` (`tab|rounded|pill`), `position` (`bottom-start|bottom-end`), `avatarUrl`/`logoUrl` (http(s) URL or null), `greetingTexts` (object, fa/en strings ≤200 chars), `defaultLocale`.
- **True-patch semantics:** absent fields keep their values; `null` clears avatar/logo.

**Defect D2 (no capability enforcement):** The PATCH doesn't enforce per-capability limits (e.g., Free should only accept preset colors, not arbitrary hex). A plan bypass isn't possible today (Free is fully blocked), but the V2 model needs per-field capability checks.

### 1.5 Public widget config (`src/app/api/widget/[slug]/config/route.ts`)

- Calls `getEffectiveWidgetConfig(tenant.id)` → spreads the effective visual config.
- Separately reads the access policy (`accessMode`, `policyVersion`, login fields) from `WidgetConfig` via `publicAccessConfig`.
- Returns `{ slug, name, ...effective, ...publicPolicy, realtime }`.

**No regression risk for V2 Phase 1** if the effective config resolution is backward-compatible.

### 1.6 Dashboard UI (`src/components/dashboard/views/widget-panel.tsx`)

- Fetches `GET /api/widget-config` → `{ stored, effective, isLocked }`.
- Customization tab: gates all controls on `isLocked` (disabled when locked). Shows a lock banner. Previews the EFFECTIVE state.
- Saves via `PATCH /api/widget-config` with the `stored` config.
- **667 lines.** Three tabs: Installation, Customization, Access & Identity.

### 1.7 NPM widget (`packages/widget-npm/src/types.ts`)

`WidgetConfig` type (lines 24–45):
- `accentColor`, `launcherShape` (`tab|rounded|pill`), `position` (`bottom-start|bottom-end`), `avatarUrl?`, `logoUrl?`, `greetingTexts`, `isLocked?`, `poweredBy?`, `realtime?`, `accessMode?`, `policyVersion?`.

The widget reads these flat fields directly in `widget.ts` (mount, render). No appearance version, no desktop/mobile distinction.

### 1.8 Script widget (`src/app/api/widget/[slug]/script/route.ts` + `v1/sukhan.js/route.ts`)

- The generated JS reads `config.accentColor`, `config.launcherShape`, `config.position`, etc. directly.
- Shared identity runtime in `src/lib/widget-script-identity.ts`.

### 1.9 Signup defaults (`src/app/api/auth/signup/complete/route.ts`)

- Creates `WidgetConfig` with `accentColor: #E09A2B`, `launcherShape: tab`, `position: bottom-end`, `greetingTexts: {fa, en}`, `defaultLocale: fa`, `policyVersion: 1`. No explicit `accessMode` (DB default `verified_visitor` applies).
- **No appearanceV2 field** (doesn't exist yet).

### 1.10 Existing tests

- `tests/widget-customization.spec.ts` — browser: PAID flow (edit/save/persist/render) + FREE locked flow (lock banner, disabled controls, 402 on PATCH, effective defaults, Powered by badge).
- `tests/unit/widget-config.test.ts` — unit: source-shape assertions (tabs, Widget Key, HTML snippet, NPM Coming Soon).
- `tests/db-boundary/widget-access-foundation.test.ts` — DB: WidgetConfig defaults (accessMode, policyVersion).

---

## 2. Defects + inconsistencies

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| D1 | **High** | Coarse `customization: boolean` entitlement — incompatible with V2 capability-based contract. Free is fully locked; V2 needs per-capability limits. | `plans.ts` `customization: boolean`; `free-plan.ts:104` `isLocked = !plan?.customization` |
| D2 | Medium | No per-capability enforcement in PATCH. Today Free is fully blocked (402), but V2 needs per-field capability checks (e.g., Free accepts only preset colors). | `widget-config/route.ts:88` `if (!plan?.customization)` |
| D3 | Low | No appearance version field — no way to evolve the appearance schema without breaking existing configs. | `schema.prisma:183-189` (flat columns, no version) |
| D4 | Low | No desktop/mobile distinction — V2 requires independent desktop/mobile positioning. | `schema.prisma:185` single `position` column |
| D5 | Low | Duplicated appearance logic across NPM widget + script runtime + dashboard preview. V2 long-term needs a shared renderer. | `widget-npm/src/widget.ts` mount + `script/route.ts` generated JS |
| D6 | Info | `getEffectiveWidgetConfig` hardcodes Free defaults inline (not driven by a capability resolver). | `free-plan.ts:107-121` |

---

## 3. Missing validation / security checks (for V2)

- Per-capability plan enforcement (Free can't use arbitrary colors / precise positioning / all launcher styles).
- Versioned appearance parsing (reject unknown versions, malformed structures).
- Safe URL validation for any new URL-bearing appearance fields.
- No script injection / arbitrary CSS / unsafe URL in appearance config.

---

## 4. Existing test coverage + gaps

**Covered:**
- Free locked flow (402, disabled UI, effective defaults, Powered by badge).
- Paid customization flow (edit/save/persist/public config/rendered widget).
- Strict PATCH validation (hex, enum, URL, greeting bounds).
- True-patch semantics.
- Access policy independence from customization plan-lock.

**Gaps for V2:**
- No entitlement capability tests (Free vs Pro per-capability).
- No appearance-version compat tests.
- No migration/preservation tests for an appearanceV2 field.
- No desktop/mobile config tests.

---

## 5. Required V2 Phase 1 changes

### 5.1 Typed capability-based entitlement model

**File:** `src/lib/payments/widget-entitlements.ts` (NEW)

A typed entitlement definition per plan:
```ts
interface WidgetEntitlements {
  presetPositioning: boolean
  precisePositioning: boolean
  presetColors: boolean
  customColors: boolean
  launcherSelection: 'limited' | 'all'
  messagePreview: boolean
  attentionAnimations: 'basic' | 'advanced'
  quickReplies: number  // max buttons (0 = disabled)
  preChatForm: 'basic' | 'advanced' | 'none'
  pageVisibility: 'basic' | 'advanced' | 'none'
  alternativeContactButtons: number
  smartAvoidance: boolean
  contextChat: boolean
  playground: boolean
  brandingRemoval: boolean
}
```
- One canonical definition per plan slug.
- `getEntitlements(planSlug): WidgetEntitlements | null` — null for unknown plans (fail closed).
- Server-authoritative; no client-supplied plan info.
- Does NOT activate unimplemented features — entitlements describe what a plan ALLOWS, not what's implemented.

### 5.2 Versioned appearance V2 model

**File:** `src/lib/widget/appearance-v2.ts` (NEW)

A minimal versioned appearance config:
```ts
interface AppearanceV2 {
  version: 1
  desktop?: { position?: string; … }
  mobile?: { position?: string; … }
  // Future fields added in later phases. Phase 1 keeps this minimal.
}
```
- Strict parsing: `parseAppearanceV2(unknown): AppearanceV2 | null`.
- Defined defaults.
- Backward compat: if `appearanceV2` is null/absent, the existing flat fields (accentColor, launcherShape, position, etc.) remain the source of truth.
- No accidental override of access/identity config.

### 5.3 Additive migration

**Prisma migration:** add `appearanceV2 Json?` to `WidgetConfig`. Existing rows get `null` (V1 behavior preserved). No destructive rewrite. No identity/access changes.

### 5.4 Shared resolution

**File:** `src/lib/widget/appearance-resolver.ts` (NEW)

A resolver that takes the stored config (flat fields + appearanceV2) + the plan entitlements → produces the effective appearance. Used by `getEffectiveWidgetConfig` (adapter) + the public config + eventually the widget runtime.

Phase 1: the resolver is a thin adapter — if `appearanceV2` is null, it returns the existing flat-field behavior (backward compat). If `appearanceV2` is present, it parses + validates it. The resolver does NOT change visible behavior in Phase 1 (no new visual features).

### 5.5 Backward-compat adapter

`getEffectiveWidgetConfig` continues to work as-is for V1 behavior. The entitlement model + appearance V2 are additive — they don't change the current Free-locked / paid-unlocked behavior until later phases implement the actual V2 features.

---

## 6. Regression risks

| Risk | Mitigation |
|---|---|
| Changing `getEffectiveWidgetConfig` breaks the public config / widget rendering | The resolver is a thin adapter; V1 behavior unchanged when `appearanceV2` is null. |
| Migration corrupts existing configs | Additive `Json?` field; existing rows get null; no data rewrite. |
| Entitlement model changes Free behavior prematurely | Phase 1 does NOT change the `customization: boolean` gating. The entitlement model is additive + not wired into the PATCH gate yet. |
| NPM package depends on server-only modules | The appearance V2 model + resolver are pure TS (no Prisma/Next.js imports). |
| Test regressions | All existing tests preserved; new tests are additive. |

---

## 7. Acceptance criteria for Phase 1

1. Entitlement model defined for Free/Pro/Max/Self-hosted; unknown plans fail closed.
2. Appearance V2 model with strict parsing + defaults + backward compat.
3. Additive migration (`appearanceV2 Json?`); existing rows preserved.
4. Shared resolver (thin adapter, V1 behavior unchanged).
5. Focused tests: entitlement differences, invalid plans, existing compat, new-workspace defaults, migration preservation, malformed input, no plan bypass, effective vs stored, no regression.
6. No user-facing customization features implemented.
7. No regression of existing public widget config, widget rendering, access policy, or NPM/script behavior.
8. Local gate: typecheck, lint, prisma validate/generate, unit tests.
9. CI: all 4 jobs green on the exact SHA.

---

## 8. Unrelated defects (recorded, not fixed in this phase)

- `contacts-panel.tsx:60` — unused eslint-disable directive (pre-existing warning). Not related to customization V2.
- No other unrelated defects discovered in the customization paths.

---

## 9. Shared runtime approach (for subsequent phases)

The long-term goal: the production widget + Playground use the SAME rendering implementation. Phase 1 establishes the appearance V2 model + resolver as the shared contract. Subsequent phases will:
1. Move the appearance-reading logic from the NPM widget / script runtime into a shared resolver that consumes the V2 model.
2. The dashboard preview will use the same resolver.
3. The Playground will use the same resolver + renderer.

**Browser/server packaging boundary:** the appearance V2 model + resolver are pure TS (no server-only imports). The NPM package can import them safely.

---

## 10. Plan downgrade handling (for future phases)

When a tenant downgrades (e.g., Pro → Free):
- The stored advanced settings are NOT destroyed (preserved in `appearanceV2`).
- The effective config is resolved against the NEW plan's entitlements (advanced settings are hidden/not applied).
- When the tenant upgrades again, the stored advanced settings are restored.
- Phase 1 documents this strategy but does NOT implement downgrade enforcement (the entitlement model is additive + not wired into the PATCH gate yet).
