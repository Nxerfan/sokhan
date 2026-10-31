# Widget V2 Positioning — Audit & Architecture

## 1. Baseline Audit

### 1.1 Entitlement model (`src/lib/payments/widget-entitlements.ts`)

Phase 1 established a **Map-based, prototype-free** entitlement catalog:
`getEntitlements(planSlug)` returns `Readonly<WidgetEntitlements> | null`.

Relevant entitlements for positioning:
- `presetPositioning: boolean` — 3 predefined positions (Free: true; paid: true).
- `precisePositioning: boolean` — arbitrary X/Y offsets + drag + slider (Free: false; paid: true).
- `legacyCustomizationUnlocked: boolean` — the old `customization: boolean` gate (Free: false; paid: true).

**Critical finding:** `getEntitlements()` is the server-authoritative capability source. The Phase 1 normalization module (`normalizeStoredAppearance`) does NOT enforce entitlements — it only parses/validates stored config. Entitlement enforcement is NOT implemented yet. This feature must introduce the effective resolver that enforces entitlements.

### 1.2 Free plan gate (`src/lib/payments/free-plan.ts`)

`getEffectiveWidgetConfig(tenantId)` uses the **legacy** `plan.customization: boolean` gate:
- Free (`customization: false`) → returns locked Sukhan-brand defaults (`position: 'bottom-end'`, `poweredBy: true`).
- Paid (`customization: true`) → returns stored WidgetConfig values.

This function is the **production effective config** consumed by:
- Dashboard GET `/api/widget-config` (`effective` field).
- Public widget config GET `/api/widget/[slug]/config`.

**Critical finding:** Free currently gets hardcoded `position: 'bottom-end'` regardless of stored config. To allow Free positioning presets, the effective resolver must be extended to consult stored V2 positioning + entitlements, not just the legacy boolean.

### 1.3 Appearance V2 parser (`src/lib/widget/appearance-v2.ts`)

Phase 1 established a strict parser with:
- `isPlainObject()` — prototype check (rejects Date/Map/Set/class instances); guards `Array.isArray()` for revoked Proxy.
- `safeOwnKeys()` — `Reflect.ownKeys` (catches non-enumerable + Symbol keys).
- `getOwnDataDescriptor()` — reads from `Object.getOwnPropertyDescriptor().value` (bypasses Proxy `get` traps).
- `parseAppearanceV2()` — never throws, returns canonical object or null.
- `DeviceAppearance` — **empty interface** (Phase 1 defines no device fields).

**Critical finding:** `DeviceAppearance` has no fields. This feature must add positioning fields (`anchor`, `offsetX`, `offsetY`) to `DeviceAppearance` and extend the parser to validate them strictly.

### 1.4 Stored normalization (`src/lib/widget/appearance-resolver.ts`)

`normalizeStoredAppearance()` parses stored V2 + returns V1 flat fields as-is. It does NOT enforce entitlements. The doc explicitly states: "Later phases will introduce a separate `resolveEffectiveAppearance` that enforces entitlements."

### 1.5 Dashboard PATCH (`src/app/api/widget-config/route.ts`)

Current PATCH:
- Role: admin+ (owner/admin). Manager/agent/viewer → 403.
- Plan gate: `if (!plan?.customization) return { planLocked: true }` → 402 `customization_locked`.
- Validates: accentColor (hex), launcherShape (enum), position (`bottom-start` | `bottom-end`), avatarUrl/logoUrl (http(s)), greetingTexts, defaultLocale.
- True-patch semantics: only present fields updated.
- `position` validation only accepts `bottom-start` / `bottom-end` (no `bottom-center`).

**Critical finding:** Free is rejected entirely. To allow Free positioning, the PATCH must be extended with an isolated positioning path that:
1. Allows Free to set anchor presets (bottom-start/end/center) per device.
2. Rejects Free offsetX/offsetY.
3. Rejects Free mixing positioning with other customization fields (no bypass).
4. Preserves 402 `customization_locked` for non-positioning Free edits.

### 1.6 Public widget config (`src/app/api/widget/[slug]/config/route.ts`)

GET returns: `slug, name, ...config (effective visual), ...publicPolicy, realtime`.
The `config` spread includes `position` (V1). No V2 positioning is exposed.

**Critical finding:** Public config must add effective V2 positioning (anchor + offsets for entitled plans only). Must NOT expose stored paid offsets to Free visitors.

### 1.7 Dashboard widget panel (`src/components/dashboard/views/widget-panel.tsx`)

Customization tab:
- No device toggle (single config).
- Position select: `bottom-start` / `bottom-end` only (no center).
- Preview: hardcoded CSS (`start-4` / `end-4`), not geometry-computed.
- All controls `disabled={isLocked}` when Free.
- Save: sends full config to PATCH (blocked by 402 for Free).

**Critical finding:** Need: Desktop/Mobile toggle, 3 presets, drag (paid), sliders (paid), numeric inputs (paid), geometry-computed preview, isolated positioning save for Free.

### 1.8 Widget runtime — 3 delivery surfaces

All three use **identical positioning logic** (duplicated):
1. `packages/widget-npm/src/widget.ts` (line 463-472): `pos = config.position || 'bottom-end'`, `side = left/right`, `root.style[side] = '20px'`, `bottom: '20px'`.
2. `src/app/api/widget/[slug]/script/route.ts` (line 408-410): same logic, baked into template string.
3. `src/app/api/widget/v1/sukhan.js/route.ts` (line 182-191): same logic, baked into template string.

**Critical finding:** No `bottom-center`. No custom offsets. No viewport clamping. No resize/orientation handling. No safe-area insets. Logic is triplicated (no shared module). Must introduce shared geometry + inject into all three surfaces.

### 1.9 WidgetConfig types (`packages/widget-npm/src/types.ts`)

`WidgetConfig.position: 'bottom-start' | 'bottom-end'` — no center, no V2 positioning.

### 1.10 Prisma schema

`WidgetConfig.position String @default("bottom-end")` (V1). `appearanceV2 Json?` (additive V2, nullable).

No schema change needed for positioning — it extends `appearanceV2` (already nullable/additive).

## 2. Architecture Decisions

### 2.1 Positioning data contract

Extends `DeviceAppearance` (inside `appearanceV2`) with:

```typescript
interface DeviceAppearance {
  positioning?: DevicePositioning
}

interface DevicePositioning {
  anchor: 'bottom-start' | 'bottom-end' | 'bottom-center'
  offsetX?: number   // pixels, positive = right (physical). Default 0.
  offsetY?: number   // pixels, positive = up (physical). Default 0.
}
```

**Coordinate semantics:**
- `anchor` — the base position (logical: start/end/center). RTL/LTR flips start↔end.
- `offsetX` — horizontal adjustment in physical pixels. Positive = right. Negative = left. Always physical (not logical) so slider/drag/input are direction-consistent.
- `offsetY` — vertical adjustment in physical pixels. Positive = up. Negative = down.

**Bounds:** offsetX/offsetY are finite integers in [-2000, 2000]. NaN, Infinity, fractions, strings → reject.

**Free:** only `anchor` allowed. offsetX/offsetY rejected (and not applied even if stored).

**Schema version:** stays at 1 (the structure is extended, not replaced — existing rows with `appearanceV2 = null` are unaffected).

### 2.2 Shared geometry

Canonical geometry function `computeLauncherPosition(opts)` computes `{ left, bottom }` in pixels from anchor + offsets + viewport + safe-area + RTL. Implemented in:
- `src/lib/widget/positioning-geometry.ts` — TS function (server/dashboard) + `POSITIONING_FN_SOURCE` string (for script injection).
- `packages/widget-npm/src/positioning.ts` — TS function (NPM widget, self-contained copy).

**Parity test** verifies both produce identical output for the same inputs.

### 2.3 Effective positioning resolver

`resolveEffectivePositioning(stored, entitlements, device, dir)`:
1. Parse stored `appearanceV2` (strict).
2. If V2 positioning present for the device → use anchor (always) + offsets (only if `precisePositioning` entitled).
3. If no V2 → fall back to V1 `position` (mapped to anchor: `bottom-start`/`bottom-end`; center not in V1).
4. Unknown plan / null entitlements → fail closed (default `bottom-end`, no offsets).
5. Free with stored paid offsets → offsets NOT applied (preserved in storage, not in effective output).

### 2.4 API contract

**GET `/api/widget-config`** (dashboard, authenticated):
- Existing fields unchanged.
- Add `positioning`: `{ entitlements: { presetPositioning, precisePositioning }, effective: { desktop, mobile }, stored: { desktop, mobile } }`.

**PATCH `/api/widget-config`** (dashboard, authenticated):
- If body contains non-positioning customization fields AND Free → 402 `customization_locked` (existing behavior preserved).
- If body contains `positioning`:
  - Free: only `anchor` per device allowed. offsetX/offsetY → 400 `positioning_offset_not_allowed`.
  - Paid: anchor + bounded offsetX/offsetY.
  - True-patch: editing desktop doesn't reset mobile.
  - Merges with existing `appearanceV2` (preserves the other device + paid offsets).

**GET `/api/widget/[slug]/config`** (public):
- Add `positioning`: `{ desktop: { anchor, offsetX?, offsetY? }, mobile: { anchor, offsetX?, offsetY? } }`.
- Offsets only included for entitled plans. Free gets anchor-only.
- V1 `position` preserved for legacy consumers (derived from desktop V2 anchor or stored V1).

### 2.5 Dashboard UI

Customization tab extended:
- Desktop/Mobile toggle.
- Positioning card: 3 preset buttons + (paid) drag in preview + X/Y sliders + numeric inputs + reset.
- Preview uses `computeLauncherPosition` (same as production).
- Isolated positioning save (separate from customization save for Free).
- Dirty-state indication.
- Persian/English i18n + RTL.

### 2.6 Widget runtime

All three surfaces:
1. Read `config.positioning` (V2) with `config.position` (V1) fallback.
2. Detect device (desktop/mobile) via `matchMedia('(max-width: 768px)')`.
3. Call `computeLauncherPosition` with anchor + offsets + viewport + safe-area.
4. Apply computed `left`/`bottom` CSS.
5. Resize/orientation listener recomputes (no jumps).
6. Clamp to viewport (launcher stays visible/tappable).
7. Panel direction: if launcher near right edge, panel opens left; near left, opens right. Center: opens centered.

### 2.7 Downgrade/upgrade preservation

- Free edits anchor → stored V2 anchor updated; paid offsets preserved in storage.
- Effective resolver for Free ignores offsets → renders anchor-only.
- Upgrade to paid → effective resolver applies stored offsets → restores advanced positioning.
- No destructive overwrite of paid offsets when Free edits anchor.

## 3. Compatibility invariants preserved

- `verified_visitor` access mode unchanged.
- Anonymous migration behavior unchanged.
- `policyVersion` + access checks unchanged.
- Integration secrets server-only.
- No cross-tenant exposure.
- Free trial + billing restrictions unchanged.
- Powered by Sukhan branding unchanged.
- Realtime/polling + dedup unchanged.
- NPM publication state unchanged.
- Full/Lite compatibility.
- V1 `position` field preserved for legacy consumers.
- `appearanceV2 = null` rows render exactly as before.
