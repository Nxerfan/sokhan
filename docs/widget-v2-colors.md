# Widget V2 Colors — Architecture

A concise reference for the V2 color customization subsystem. Covers the palette
catalog, color-token schema, entitlement model, V1 compatibility, downgrade
preservation, strict parsing, public-config exposure, API contract, and the
runtime rendering applied by all three widget delivery surfaces.

This document is the colors-side companion to
[`docs/widget-v2-positioning.md`](./widget-v2-positioning.md). Both features
share the same additive `appearanceV2` JSON column on `WidgetConfig`, the same
strict parser (`parseAppearanceV2`), the same entitlement model
(`getEntitlements`), and the same dashboard PATCH chokepoint
(`/api/widget-config`).

---

## 1. Color palette catalog

Canonical source: [`src/lib/widget/color-palettes.ts`](../src/lib/widget/color-palettes.ts)
(`COLOR_PALETTES` — `readonly ColorPalette[]`).

10 predefined palettes, each with a **stable ID** that is persisted in
`appearanceV2.colors.presetId`. Palette IDs must never change once shipped —
new palettes can be appended, but existing IDs are immutable.

| # | ID         | Name     | accent     | headerBg   | panelBg    |
|---|------------|----------|------------|------------|------------|
| 1 | `sukhan`   | Sukhan   | `#E09A2B`  | `#E09A2B`  | `#FFFFFF`  |
| 2 | `midnight` | Midnight | `#6366F1`  | `#1E1B4B`  | `#F8FAFC`  |
| 3 | `emerald`  | Emerald  | `#10B981`  | `#064E3B`  | `#F0FDF4`  |
| 4 | `sunset`   | Sunset   | `#F97316`  | `#7C2D12`  | `#FFFBEB`  |
| 5 | `ocean`    | Ocean    | `#0EA5E9`  | `#0C4A6E`  | `#F0F9FF`  |
| 6 | `rose`     | Rose     | `#E11D48`  | `#881337`  | `#FFF1F2`  |
| 7 | `slate`    | Slate    | `#64748B`  | `#334155`  | `#F8FAFC`  |
| 8 | `violet`   | Violet   | `#8B5CF6`  | `#4C1D95`  | `#F5F3FF`  |
| 9 | `forest`   | Forest   | `#16A34A`  | `#14532D`  | `#F7Fee7`  |
| 10| `crimson`  | Crimson  | `#DC2626`  | `#7F1D1D`  | `#FEF2F2`  |

- **Default palette**: `DEFAULT_PALETTE_ID = 'sukhan'` — matches the historical
  Sukhan brand look (saffron accent, ink launcher, white panel).
- Lookup: `getPaletteById(id)` returns the `ColorPalette` or `null`.
- Validation: `isValidPaletteId(value)` narrows `unknown → string` against the
  catalog (used by both the strict parser and the PATCH validator).

Helper utilities exported from the same module:
- `isValidColor(value)` — strict `#RRGGBB` check (regex `/^#[0-9a-fA-F]{6}$/`).
  Rejects `#RGB` shorthand, named colors, `rgba()`, `hsl()`, non-strings.
- `isValidCustomColors(value)` — verifies all 11 tokens are present and each
  is a valid `#RRGGBB`.
- `relativeLuminance(hex)`, `contrastRatio(fg, bg)`, `meetsContrastAA(fg, bg,
  largeText)` — WCAG 2.1 contrast math used by the dashboard for inline
  contrast warnings.

---

## 2. Color token schema

11 tokens, all `#RRGGBB`. Defined by `ColorTokens` in
`color-palettes.ts` and enumerated in `COLOR_TOKEN_NAMES`:

| Token               | Surface                                               |
|---------------------|-------------------------------------------------------|
| `accent`            | Primary action color (send button, typing indicator) |
| `launcherBg`        | Launcher button background                            |
| `launcherFg`        | Launcher icon / foreground color                      |
| `headerBg`          | Chat panel header background                          |
| `headerText`        | Chat header text color                                |
| `panelBg`           | Chat panel body background                            |
| `panelText`         | Primary text color in the panel                       |
| `visitorBubbleBg`   | Visitor message bubble background                     |
| `visitorBubbleText` | Visitor message text color                            |
| `agentBubbleBg`     | Agent message bubble background                       |
| `agentBubbleText`   | Agent message text color                              |

The token set is **closed** — adding a token requires updating
`COLOR_TOKEN_NAMES`, every palette in `COLOR_PALETTES`, the dashboard editor,
and the three runtime `applyColors()` implementations. Removing or renaming a
token is a breaking change.

---

## 3. Global theme (not device-specific)

Unlike positioning (which is device-specific — desktop and mobile can have
independent anchors + offsets), **colors are a single global theme** applied
identically across both surfaces. The product requirement: a tenant's brand
colors are the same whether the visitor is on desktop or mobile.

Schema (in `appearance-v2.ts`):

```ts
interface AppearanceV2 {
  version: 1
  desktop?: DeviceAppearance        // positioning
  mobile?: DeviceAppearance         // positioning
  colors?: ColorTheme               // global — single theme for both devices
}

interface ColorTheme {
  mode: 'preset' | 'custom'
  presetId?: string                  // required when mode='preset'
  custom?: ColorTokens               // required when mode='custom' (paid only)
}
```

`colors` lives at the **top level** of `AppearanceV2`, not inside
`desktop`/`mobile`. The parser rejects `colors` if it appears inside a device
object (unexpected key).

---

## 4. Free vs paid entitlements

Entitlement source: [`src/lib/payments/widget-entitlements.ts`](../src/lib/payments/widget-entitlements.ts)
— `getEntitlements(planSlug)` returns `Readonly<WidgetEntitlements> | null`
from a Map-based, prototype-free catalog (so `'constructor'` / `'__proto__'`
return `null`, not a fake entitlement set).

Two capabilities govern colors:

| Entitlement    | Free | Pro / Max / Self-hosted |
|----------------|------|--------------------------|
| `presetColors` | true | true                     |
| `customColors` | false | true                    |

- **Free** can pick from the 10-palette catalog (`presetColors: true`).
- **Free** CANNOT save custom tokens (`customColors: false`). A PATCH with
  `colors: { mode: 'custom', custom: {...} }` is rejected with
  `403 colors_custom_not_allowed`.
- **Paid** plans can do both: pick a preset OR author a full custom token set.
- **Unknown / null entitlements** (e.g. tenant.plan set to a slug not in the
  catalog) → fail closed. ANY color PATCH is rejected with
  `403 colors_not_authorized`.

---

## 5. Legacy V1 `accentColor` compatibility

`WidgetConfig.accentColor` (V1 flat field, `#RRGGBB`) is preserved as the
backward-compat source of truth when a tenant has NOT migrated to V2 colors
(`appearanceV2.colors === null/absent`).

Resolution order in `resolveEffectiveColors(stored, entitlements)`
([`src/lib/widget/effective-colors.ts`](../src/lib/widget/effective-colors.ts)):

1. **Stored V2 colors** (if `appearanceV2.colors` present + valid):
   - `mode: 'preset'` → palette tokens (when `presetColors` entitled).
   - `mode: 'custom'` → custom tokens (only when `customColors` entitled;
     otherwise falls back to default Sukhan palette — stored custom tokens
     preserved for upgrade restore but NOT applied).
2. **V1 `accentColor` fallback** (no V2 colors): derive a minimal token set
   from the single accent color — accent / headerBg / agentBubbleBg are set
   to the V1 color; everything else uses default Sukhan tokens. This preserves
   the historical look for paid tenants who set `accentColor` before V2 shipped.
3. **DEFAULT_EFFECTIVE_COLORS** (no V2, no V1) → Sukhan palette.

The public config route also derives the legacy `accentColor` field from the
effective color tokens (`effectiveColors.tokens.accent`) so old widget
clients reading `config.accentColor` continue to render the right color.

---

## 6. Downgrade / upgrade preservation

When a Pro tenant downgrades to Free and then edits the palette (the only
color edit Free is allowed), their previously-saved **paid custom tokens are
preserved in storage** — they are NOT destroyed by the preset edit.

Implementation in `mergeColorPatch(existingAppearanceV2, patch)`
([`src/lib/widget/color-patch.ts`](../src/lib/widget/color-patch.ts)):

```ts
if (patch.theme.mode === 'preset' &&
    base.colors?.mode === 'custom' &&
    base.colors.custom) {
  mergedColors = {
    mode: 'preset',
    presetId: patch.theme.presetId,
    custom: base.colors.custom,   // ← preserved paid tokens
  }
}
```

The effective resolver (`resolveEffectiveColors`) then enforces entitlements at
read time: a Free visitor with stored `colors.custom` gets the default Sukhan
palette rendered (custom tokens NOT applied), but on upgrade to Pro the same
stored custom tokens immediately take effect again. This mirrors
`mergePositioningPatch`'s preservation of paid `offsetX`/`offsetY` when Free
edits only the anchor.

---

## 7. Strict parsing guarantees

`parseAppearanceV2(value)` in
[`src/lib/widget/appearance-v2.ts`](../src/lib/widget/appearance-v2.ts) is the
single trust boundary for the `appearanceV2` JSON column. It is used by:
- The dashboard GET (`getStoredColorTheme`).
- The PATCH merge (`mergeColorPatch` reads existing stored V2).
- The public config route (`resolveEffectiveColors`).
- The effective resolver (`resolveEffectiveColors`).

Guarantees:

- **Plain-object only**: rejects `Date`, `Map`, `Set`, class instances, arrays.
  `isPlainObject()` checks `Object.getPrototypeOf(value) === Object.prototype
  || === null`.
- **#RRGGBB only**: `isValidColor` rejects `#RGB`, named colors, `rgba()`,
  `hsl()`, non-strings, malformed hex.
- **Unknown keys rejected**: top-level allows only `version | desktop | mobile
  | colors`; inside `colors` only `mode | presetId | custom`; inside `custom`
  only the 11 token names. Any other key (including Symbol keys) → reject.
- **Mode-specific requirements**: `mode: 'preset'` requires a valid
  `presetId`; `mode: 'custom'` requires a complete `custom` token set.
- **Proxy-safe**: `safeOwnKeys()` (wraps `Reflect.ownKeys`) + 
  `getOwnDataDescriptor()` (reads from
  `Object.getOwnPropertyDescriptor().value`) bypass exotic-object `get` traps
  that could throw. All reflection is wrapped in `try/catch` — the parser
  **never throws**; malformed input returns `null` (fail closed → V1 fallback).
- **Canonical output**: the parser returns a fresh object built from
  validated values, never the raw input reference. Callers never hold an
  unvalidated object.

---

## 8. Public config exposes EFFECTIVE colors only

`GET /api/widget/[slug]/config`
([`src/app/api/widget/[slug]/config/route.ts`](../src/app/api/widget/[slug]/config/route.ts))
returns the **effective** color theme — what the widget actually renders. It
does NOT return raw stored config.

Response shape (additive — older clients ignore the new `colors` field):

```jsonc
{
  "slug": "acme",
  "name": "Acme",
  "accentColor": "#10B981",          // V1 derived from effective tokens.accent
  "position": "bottom-end",          // V1 derived from effective desktop anchor
  "positioning": { "desktop": {...}, "mobile": {...} },
  "colors": {
    "mode": "preset",                // or "custom"
    "presetId": "emerald",           // present when mode=preset
    "tokens": { /* 11 #RRGGBB strings */ }
  },
  // ...access policy, realtime, etc.
}
```

**Security contract:**

- Stored **paid custom tokens are NEVER exposed to Free visitors.** If a Pro
  tenant downgrades to Free and their stored `colors.custom` remains in the
  DB, the public resolver returns `DEFAULT_EFFECTIVE_COLORS` (Sukhan palette)
  — the custom tokens stay in storage but are invisible to the widget.
- Stored custom tokens are also NEVER exposed via the dashboard GET to Free
  tenants in a form that would let them read+copy raw hexes: the dashboard GET
  returns `stored` for the colors panel to populate controls, but the panel's
  custom-mode editor is locked (`canCustom === false`) — the user can SEE the
  saved custom theme exists but cannot edit it. (Free sees `stored.custom` so
  the panel can render a "Upgrade to edit your custom colors" affordance.)
- The `accentColor` V1 field is derived from the **effective** accent token —
  never from the stored raw V1 value when V2 colors are present.

---

## 9. API contract

### `GET /api/widget-config` (dashboard, authenticated)

Returns (alongside existing fields):

```jsonc
{
  "colors": {
    "entitlements": {
      "presetColors": true,
      "customColors": false      // Free
    },
    "effective": {               // what the widget renders
      "mode": "preset",
      "presetId": "sukhan",
      "tokens": { /* 11 #RRGGBB */ }
    },
    "stored": {                  // raw stored V2 theme (or null)
      "mode": "preset",
      "presetId": "emerald"
      // "custom": { ... } present when stored mode=custom
    }
  }
}
```

### `PATCH /api/widget-config` (dashboard, authenticated, admin+)

Body — only the `colors` field is read for color updates (mixed bodies with
positioning + colors are allowed; mixed with non-V2 customization fields is
rejected for Free with `402 customization_locked`):

```jsonc
// Preset save (Free + paid)
{ "colors": { "mode": "preset", "presetId": "emerald" } }

// Custom save (paid only)
{ "colors": { "mode": "custom", "custom": { /* 11 #RRGGBB */ } } }
```

### Error codes

| Code                              | HTTP | When                                                          |
|-----------------------------------|------|---------------------------------------------------------------|
| `colors_not_authorized`           | 403  | Unknown plan / null entitlements / `presetColors=false`.      |
| `colors_no_fields`                | 400  | `body.colors === undefined/null`.                             |
| `colors_not_object`               | 400  | `colors` is not a plain object (or is an array).              |
| `colors_unexpected_key`           | 400  | Top-level key inside `colors` not in `{mode, presetId, custom}`. |
| `colors_mode_missing`             | 400  | `mode` absent.                                                |
| `colors_mode_invalid`             | 400  | `mode` not `'preset'` or `'custom'`.                          |
| `colors_preset_id_missing`        | 400  | `mode='preset'` but no `presetId`.                            |
| `colors_preset_id_invalid`        | 400  | `presetId` not in the 10-palette catalog.                     |
| `colors_custom_not_allowed`       | 403  | Free plan sent `mode='custom'` (`customColors=false`).        |
| `colors_custom_missing`           | 400  | `mode='custom'` but no `custom` tokens.                       |
| `colors_custom_invalid`           | 400  | Custom tokens missing/invalid (#RGB, named, etc.).            |
| `colors_custom_unexpected_key`    | 400  | Custom tokens object has a key not in the 11-token set.       |
| `customization_locked`            | 402  | Free mixed colors with non-V2 customization fields.           |
| `unrecognized_field`              | 400  | Body has top-level key outside the allowed set.               |

Status-code mapping lives in `COLOR_ERROR_STATUS` inside the route handler.

True-patch semantics: editing `colors` does NOT reset `desktop`/`mobile`
positioning, V1 `accentColor`, or any other field. When both positioning and
color patches arrive in the same PATCH, the color merge reads the
already-merged `appearanceV2` (so positioning is preserved), then writes the
combined result in a single `widgetConfig.update`.

---

## 10. Runtime rendering — all 3 surfaces

All three widget delivery surfaces apply V2 colors via **inline styles** (so
customer-website stylesheets cannot accidentally override them) and tag the
root with a `data-sk-color-mode` diagnostic attribute for tests + analytics.

### 10.1 Slug-script — `src/app/api/widget/[slug]/script/route.ts`

The `applyColors(config)` function (around line 252 of the built script):

```js
function applyColors(config) {
  if (!state.rootEl) return;
  var colors = config.colors;
  if (!colors || !colors.tokens) {
    state.rootEl.setAttribute('data-sk-color-mode', 'legacy');
    return;
  }
  var t = colors.tokens;
  state.rootEl.setAttribute('data-sk-color-mode', colors.mode || 'preset');
  if (colors.presetId) state.rootEl.setAttribute('data-sk-color-preset', colors.presetId);
  if (launcher) { launcher.style.background = t.launcherBg; launcher.style.color = t.launcherFg; }
  if (panel) { panel.style.background = t.panelBg; }
  var headerEl = panel ? panel.querySelector('.sk-header') : null;
  if (headerEl) { headerEl.style.background = t.headerBg; headerEl.style.color = t.headerText; }
  if (bodyEl) { bodyEl.style.color = t.panelText; }
  if (sendBtn) { sendBtn.style.background = t.accent; }
  if (typingEl) { typingEl.style.background = t.accent; }
  if (typeof renderMessages === 'function') renderMessages();
}
```

### 10.2 v1-script — `src/app/api/widget/v1/sukhan.js/route.ts`

Identical `applyColors()` implementation baked into the v1 script bundle.

### 10.3 NPM widget — `packages/widget-npm/src/widget.ts`

`SukhanWidget.applyColors(config)` (private method, around line 787) — same
inline-style application + same diagnostic attributes. The NPM widget reuses
the same `WidgetConfig.colors` shape from `packages/widget-npm/src/types.ts`.

### Rendered surfaces (per token)

| Token              | Element                                           | CSS property           |
|--------------------|---------------------------------------------------|------------------------|
| `launcherBg`       | `.sk-launcher`                                    | `background`           |
| `launcherFg`       | `.sk-launcher`                                    | `color`                |
| `panelBg`          | `.sk-panel`                                       | `background`           |
| `headerBg`         | `.sk-header`                                      | `background`           |
| `headerText`       | `.sk-header`                                      | `color`                |
| `panelText`        | `.sk-body`                                        | `color`                |
| `accent`           | `.sk-send-btn`, `.sk-typing`                      | `background`           |
| `visitorBubbleBg`  | visitor bubble `<div>`                            | `background` (inline)  |
| `visitorBubbleText`| visitor bubble `<div>`                            | `color` (inline)       |
| `agentBubbleBg`    | agent bubble `<div>`                              | `background` (inline)  |
| `agentBubbleText`  | agent bubble `<div>`                              | `color` (inline)       |

`renderMessages()` is re-invoked after `applyColors()` so existing bubbles
pick up the new token values.

### Diagnostic attributes (test surface)

- `data-sk-color-mode` — `'preset'`, `'custom'`, or `'legacy'` (when V2
  colors absent — backward-compat with V1-only tenants).
- `data-sk-color-preset` — the palette ID, present only when `mode='preset'`.

These attributes let tests verify the widget received + applied V2 colors
without inspecting inline styles directly. For pixel-exact verification,
tests read `getComputedStyle(element).backgroundColor` on `.sk-header` (or
`.sk-launcher`, `.sk-panel`) and compare against the expected `#RRGGBB`
converted to `rgb(r, g, b)` form.

---

## 11. Compatibility invariants preserved

- `appearanceV2 = null` rows render exactly as before (V1 accentColor fallback
  → Sukhan-default-derived token set).
- V1 `accentColor` flat field is preserved + derived from effective tokens for
  legacy consumers.
- `verified_visitor` access mode, anonymous migration, `policyVersion`, and
  all access-policy checks unchanged.
- Integration secrets remain server-only.
- No cross-tenant exposure.
- Free trial + billing restrictions unchanged.
- Realtime / polling + dedup unchanged.
- NPM publication state unchanged.
- Full / Lite Docker compatibility unchanged.
- Positioning panel + colors panel coexist (they write to different subfields
  of the same `appearanceV2` JSON column; the PATCH merge is field-level).
