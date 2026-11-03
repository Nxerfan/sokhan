/**
 * Widget Appearance V2 — versioned appearance model.
 *
 * A typed, versioned appearance configuration that supports independent
 * desktop/mobile configuration. Phase 1 established the version + structure.
 * Phase 2 / Feature 1 adds device-specific positioning (anchor + bounded
 * X/Y offsets) as the first concrete visual field.
 *
 * Design:
 *   - Explicit schema version (currently 1).
 *   - Strict parsing at trust boundaries (parseAppearanceV2).
 *   - Defined defaults (DEFAULT_APPEARANCE_V2).
 *   - Backward compat: if `appearanceV2` is null/absent on a WidgetConfig row,
 *     the existing flat fields (accentColor, launcherShape, position, etc.)
 *     remain the source of truth. The V2 model is ADDITIVE.
 *   - No accidental override of visitor access or identity configuration.
 *   - No unapproved arbitrary styles or CSS.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * NPM widget / browser bundle to import.
 */

import {
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
  type PositioningAnchor,
} from './positioning-geometry'
import {
  isValidPaletteId,
  isValidColor,
  isValidCustomColors,
  COLOR_TOKEN_NAMES,
  type ColorTokens,
} from './color-palettes'
import {
  LAUNCHER_SHAPES,
  isValidLauncherShape,
  isPaidOnlyLauncherShape,
  type LauncherShape,
} from './launcher-types'
import {
  isValidAttentionAnimation,
  isAdvancedOnlyAttentionAnimation,
  type AttentionAnimation,
} from './attention-types'

/** The appearance schema version. Currently 1. */
export const APPEARANCE_V2_VERSION = 1 as const

/**
 * Device-specific appearance.
 *
 * Phase 2 / Feature 1 adds `positioning` (anchor + bounded X/Y offsets).
 * Future phases add more visual fields (colors, launcherStyle, animations,
 * etc.). The structure is versioned — adding optional fields does NOT bump
 * the schema version (they are additive + nullable).
 */
export interface DeviceAppearance {
  /**
   * Widget positioning for this device. Anchor is always present when
   * positioning is configured; offsetX/offsetY are advanced-plan-only
   * (but may be stored for Free for future upgrade restore).
   */
  positioning?: DevicePositioning
}

/**
 * Per-device positioning config. `anchor` is the 3-preset base position;
 * `offsetX`/`offsetY` are bounded pixel adjustments (advanced plans only).
 *
 * Coordinate semantics (see positioning-geometry.ts for full details):
 *   - offsetX: positive = right (physical pixels)
 *   - offsetY: positive = up (physical pixels)
 */
export interface DevicePositioning {
  anchor: PositioningAnchor
  /** Horizontal offset in pixels (positive = right). Advanced plans only. */
  offsetX?: number
  /** Vertical offset in pixels (positive = up). Advanced plans only. */
  offsetY?: number
}

/**
 * Global color theme (not device-specific — colors are consistent across
 * desktop and mobile per product requirement).
 *
 * - `mode: 'preset'` — use a predefined palette (Free + paid).
 * - `mode: 'custom'` — use custom color tokens (paid only).
 */
export interface ColorTheme {
  mode: 'preset' | 'custom'
  /** Palette ID (required when mode='preset'). Must be a valid stable ID. */
  presetId?: string
  /** Custom color tokens (required when mode='custom'). Paid plans only. */
  custom?: ColorTokens
}

/**
 * Global launcher style selection (not device-specific).
 *
 * - `shape`: the active launcher shape ('tab', 'rounded', 'pill').
 * - `paidShape`: preserved paid-only shape for downgrade/upgrade restore.
 *   When a paid tenant selects 'pill' then downgrades to Free, the active
 *   shape becomes 'tab' (safe default), but 'pill' is stored in `paidShape`
 *   so it can be restored on upgrade.
 */
export interface LauncherConfig {
  shape: LauncherShape
  /** Preserved paid-only shape for upgrade restore. */
  paidShape?: LauncherShape
}

/**
 * Global attention animation selection (not device-specific).
 *
 * - `animation`: the active attention animation ('none', 'pulse', 'bounce',
 *   'shake', 'glow'). 'none' preserves the legacy unanimated launcher.
 * - `paidAnimation`: preserved advanced-only animation for downgrade/upgrade
 *   restore. When a paid tenant selects 'glow' then downgrades to Free, the
 *   active animation becomes a basic one (e.g. 'pulse' or 'none'), but
 *   'glow' is stored in `paidAnimation` so it can be restored on upgrade.
 *   Only advanced-only animations (bounce/shake/glow) are valid here —
 *   'none' and 'pulse' are basic and contradictory as a paid preference.
 */
export interface AttentionConfig {
  animation: AttentionAnimation
  /** Preserved advanced-only animation for upgrade restore. */
  paidAnimation?: AttentionAnimation
}

/**
 * Message Preview preference (Phase 2 / Feature 5). Additive — null =
 * default OFF. A plain `{ enabled: boolean }` — no paid-preservation
 * field is needed (the resolver enforces the entitlement, so a stored
 * `true` is simply ignored on Free and restored on upgrade).
 */
export interface MessagePreviewConfig {
  enabled: boolean
}

/**
 * Quick Replies configuration (Phase 2 / Feature 6). Additive — null = no
 * suggested replies (legacy behavior).
 * - `items`: the active quick-reply labels (1–80 Unicode code points each,
 *   no duplicates, within the plan's max).
 * - `paidItems`: preserved paid selection for downgrade/upgrade restore.
 *   When a paid tenant configures 10 items then downgrades to Free, the
 *   active `items` become the first 2, and the full 10 are stored in
 *   `paidItems` for restoration on upgrade. Must contain at least one item
 *   not in `items` (not a useless subset).
 */
export interface QuickRepliesConfig {
  items: string[]
  /** Preserved paid selection for upgrade restore. */
  paidItems?: string[]
}

/**
 * Pre-chat Form configuration (Phase 2 / Feature 7). Additive — null = no form.
 * - `fields`: the active field configuration.
 * - `paidFields`: preserved advanced selection for downgrade/upgrade restore.
 */
export interface PreChatFormConfig {
  fields: PreChatFormField[]
  paidFields?: PreChatFormField[]
}

/** A single pre-chat form field. */
export interface PreChatFormField {
  key: 'name' | 'email' | 'phone' | 'company'
  required: boolean
}

/**
 * Page Visibility configuration (Phase 2 / Feature 8). Additive — null = no rules.
 * - `rules`: the active visibility rules.
 * - `paidRules`: preserved advanced selection for downgrade/upgrade restore.
 */
export interface PageVisibilityConfig {
  rules: PageVisibilityRuleStored[]
  paidRules?: PageVisibilityRuleStored[]
}

/** A stored page visibility rule (same shape as the public type). */
export interface PageVisibilityRuleStored {
  pattern: string
  match: 'exact' | 'prefix'
  action: 'show' | 'hide'
  device?: 'desktop' | 'mobile'
}

/**
 * Alternative Contact Buttons configuration (Phase 2 / Feature 9). Additive.
 * - `items`: the active contact buttons.
 * - `paidItems`: preserved paid selection for downgrade/upgrade restore.
 */
export interface AlternativeContactButtonsConfig {
  items: AlternativeContactButtonStored[]
  paidItems?: AlternativeContactButtonStored[]
}

/** A stored alternative contact button. */
export interface AlternativeContactButtonStored {
  kind: 'phone' | 'email' | 'whatsapp' | 'telegram' | 'website'
  label: string
  value: string
}

/**
 * Smart Avoidance configuration (Phase 2 / Feature 10). Additive — null =
 * disabled (default).
 */
export interface SmartAvoidanceConfig {
  enabled: boolean
}

/**
 * Context Chat configuration (Phase 2 / Feature 11). Additive — null =
 * disabled (default for every existing tenant). Entitlement availability is
 * NOT automatic activation: the tenant owner must explicitly enable it.
 */
export interface ContextChatConfig {
  enabled: boolean
}

/** The versioned appearance configuration. */
export interface AppearanceV2 {
  version: typeof APPEARANCE_V2_VERSION
  desktop?: DeviceAppearance
  mobile?: DeviceAppearance
  /** Global color theme (Phase 2 / Feature 2). Additive — null = V1 behavior. */
  colors?: ColorTheme
  /** Global launcher style (Phase 2 / Feature 3). Additive — null = V1 behavior. */
  launcher?: LauncherConfig
  /** Global attention animation (Phase 2 / Feature 4). Additive — null = legacy (unanimated). */
  attention?: AttentionConfig
  /** Message Preview preference (Phase 2 / Feature 5). Additive — null = default OFF. */
  messagePreview?: MessagePreviewConfig
  /** Quick Replies (Phase 2 / Feature 6). Additive — null = no suggested replies. */
  quickReplies?: QuickRepliesConfig
  /** Pre-chat Form (Phase 2 / Feature 7). Additive — null = no form. */
  preChatForm?: PreChatFormConfig
  /** Page Visibility (Phase 2 / Feature 8). Additive — null = no rules (default visible). */
  pageVisibility?: PageVisibilityConfig
  /** Alternative Contact Buttons (Phase 2 / Feature 9). Additive — null = no buttons. */
  alternativeContactButtons?: AlternativeContactButtonsConfig
  /** Smart Avoidance (Phase 2 / Feature 10). Additive — null = disabled. */
  smartAvoidance?: SmartAvoidanceConfig
  /** Context Chat (Phase 2 / Feature 11). Additive — null = disabled. */
  contextChat?: ContextChatConfig
}

/** The canonical default appearance (V2). */
export const DEFAULT_APPEARANCE_V2: AppearanceV2 = {
  version: APPEARANCE_V2_VERSION,
  desktop: {},
  mobile: {},
}

/**
 * Strictly parse an unknown value as an AppearanceV2 config.
 *
 * Accepts ONLY:
 *   - null / undefined → null (no V2 config; fall back to V1 flat fields).
 *   - A PLAIN object (prototype === Object.prototype or null) with EXACTLY
 *     an own-property `version === 1` + optional desktop/mobile plain objects.
 *   - desktop/mobile may contain an optional `positioning` object with
 *     a valid `anchor` + optional bounded integer `offsetX`/`offsetY`.
 *
 * Rejects (returns null):
 *   - Non-object values (numbers, strings, booleans).
 *   - Arrays.
 *   - Non-plain objects (Date, Map, Set, class instances, etc.).
 *   - Objects with inherited `version` (must be an own property).
 *   - Missing or non-integer version.
 *   - Unknown version (version !== 1).
 *   - Fractional version.
 *   - desktop/mobile present but not plain objects.
 *   - Unexpected top-level keys (only version, desktop, mobile, colors, launcher are allowed).
 *   - Unexpected keys inside desktop/mobile (only `positioning` is allowed).
 *   - positioning present but not a plain object / malformed.
 *   - Invalid anchor (not one of the 3 presets).
 *   - offsetX/offsetY present but not finite integers / out of bounds.
 *   - Unexpected keys inside positioning (only anchor, offsetX, offsetY).
 *   - Getter-based exceptions (caught internally; never escapes).
 *
 * Returns a CANONICAL object (not the raw input reference) so callers never
 * hold an unvalidated object.
 *
 * Never throws. Returns null on any malformed shape so the caller fails closed
 * (falls back to V1 flat-field behavior).
 */

/** Allowed top-level keys in an AppearanceV2 object. */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['version', 'desktop', 'mobile', 'colors', 'launcher', 'attention', 'messagePreview', 'quickReplies', 'preChatForm', 'pageVisibility', 'alternativeContactButtons', 'smartAvoidance', 'contextChat'])

/**
 * Check if a value is a plain JSON-compatible object — prototype is exactly
 * `Object.prototype` or `null` (Object.create(null)). Rejects Date, Map, Set,
 * class instances, arrays, and primitives.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  try {
    // Array.isArray can throw for a revoked Proxy — guard inside try/catch.
    if (Array.isArray(value)) return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  } catch {
    return false // getPrototypeOf / isArray can throw for exotic objects
  }
}

/**
 * Safely get ALL own property keys (enumerable + non-enumerable, string +
 * Symbol) of a plain object. Uses Reflect.ownKeys which catches properties
 * that Object.keys misses (non-enumerable own properties, Symbol keys).
 * Wraps in try/catch to handle getter-based exceptions. Returns null if
 * the operation fails.
 */
function safeOwnKeys(obj: object): (string | symbol)[] | null {
  try {
    return Reflect.ownKeys(obj)
  } catch {
    return null // reflection threw → fail closed
  }
}

/**
 * Get the own DATA property descriptor for a key. Returns the descriptor
 * (with `value`) if the property exists as a data property (not an
 * accessor). Returns null for accessor properties, inherited properties,
 * missing properties, or if reflection throws.
 *
 * By reading from the descriptor's `value` field instead of direct property
 * access, callers avoid triggering a Proxy `get` trap that could throw even
 * after getOwnPropertyDescriptor returns a valid data descriptor.
 */
function getOwnDataDescriptor(obj: object, key: string): { value: unknown } | null {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) return null // not an own property
    // Must be a data descriptor (has 'value'), not an accessor (has 'get'/'set').
    if (!('value' in desc)) return null
    // Return the descriptor so the caller reads desc.value (bypasses get trap).
    return desc as { value: unknown }
  } catch {
    return null // reflection threw → treat as not a data property
  }
}

export function parseAppearanceV2(value: unknown): AppearanceV2 | null {
  if (value === null || value === undefined) return null
  // Must be a plain object — reject Date, Map, Set, class instances, etc.
  if (!isPlainObject(value)) return null

  // Safely get ALL own keys (enumerable + non-enumerable, string + Symbol).
  const keys = safeOwnKeys(value)
  if (keys === null) return null // reflection threw → fail closed

  // Reject unexpected top-level keys — only version, desktop, mobile are
  // allowed. This includes Symbol keys + non-enumerable own properties.
  // Reflect.ownKeys returns (string | symbol)[] — Symbols are always
  // unexpected (our schema uses only string keys).
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_TOP_LEVEL_KEYS.has(key)) return null
  }

  // version must be an OWN DATA property (not an accessor/getter) + exactly 1.
  // getOwnDataDescriptor returns the descriptor with `value` so we read
  // desc.value instead of direct property access — this bypasses a Proxy
  // `get` trap that could throw even after getOwnPropertyDescriptor succeeds.
  const versionDesc = getOwnDataDescriptor(value, 'version')
  if (!versionDesc) return null // not an own data property → reject
  const versionValue = versionDesc.value
  if (typeof versionValue !== 'number' || !Number.isInteger(versionValue) || versionValue !== APPEARANCE_V2_VERSION) {
    return null
  }

  // desktop / mobile: if present, must be plain objects with NO unexpected
  // keys. Read values from descriptors to bypass Proxy get traps.
  let desktopValue: unknown = undefined
  let mobileValue: unknown = undefined
  const desktopDesc = getOwnDataDescriptor(value, 'desktop')
  if (desktopDesc !== null) {
    desktopValue = desktopDesc.value
  } else {
    // desktop is either absent (fine) or an accessor/non-own (reject).
    // Check if the key exists at all — if it does but isn't a data prop, reject.
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'desktop')) return null
    } catch {
      return null // hasOwnProperty threw on exotic object → fail closed
    }
  }
  const mobileDesc = getOwnDataDescriptor(value, 'mobile')
  if (mobileDesc !== null) {
    mobileValue = mobileDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'mobile')) return null
    } catch {
      return null // hasOwnProperty threw → fail closed
    }
  }
  const desktop = parseDeviceAppearance(desktopValue)
  if (desktop === undefined) return null // malformed → fail closed
  const mobile = parseDeviceAppearance(mobileValue)
  if (mobile === undefined) return null

  // Parse colors if present (read from descriptor to bypass Proxy get).
  const colorsDesc = getOwnDataDescriptor(value, 'colors')
  let colorsValue: unknown = undefined
  if (colorsDesc !== null) {
    colorsValue = colorsDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'colors')) return null
    } catch {
      return null
    }
  }
  let colors: ColorTheme | null | undefined = undefined
  if (colorsValue !== undefined) {
    colors = parseColorTheme(colorsValue)
    if (colors === undefined) return null // malformed → fail closed
  }

  // Parse launcher if present (read from descriptor to bypass Proxy get).
  const launcherDesc = getOwnDataDescriptor(value, 'launcher')
  let launcherValue: unknown = undefined
  if (launcherDesc !== null) {
    launcherValue = launcherDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'launcher')) return null
    } catch {
      return null
    }
  }
  let launcher: LauncherConfig | null | undefined = undefined
  if (launcherValue !== undefined) {
    launcher = parseLauncherConfig(launcherValue)
    if (launcher === undefined) return null // malformed → fail closed
  }

  // Parse attention if present (read from descriptor to bypass Proxy get).
  const attentionDesc = getOwnDataDescriptor(value, 'attention')
  let attentionValue: unknown = undefined
  if (attentionDesc !== null) {
    attentionValue = attentionDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'attention')) return null
    } catch {
      return null
    }
  }
  let attention: AttentionConfig | null | undefined = undefined
  if (attentionValue !== undefined) {
    attention = parseAttentionConfig(attentionValue)
    if (attention === undefined) return null // malformed → fail closed
  }

  // Parse messagePreview if present (read from descriptor to bypass Proxy get).
  const messagePreviewDesc = getOwnDataDescriptor(value, 'messagePreview')
  let messagePreviewValue: unknown = undefined
  if (messagePreviewDesc !== null) {
    messagePreviewValue = messagePreviewDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'messagePreview')) return null
    } catch {
      return null
    }
  }
  let messagePreview: MessagePreviewConfig | null | undefined = undefined
  if (messagePreviewValue !== undefined) {
    messagePreview = parseMessagePreviewConfig(messagePreviewValue)
    if (messagePreview === undefined) return null // malformed → fail closed
  }

  // Return a CANONICAL object (not the raw input reference) so callers
  // never hold an unvalidated object.
  const result: AppearanceV2 = {
    version: APPEARANCE_V2_VERSION,
    desktop: desktop ?? {},
    mobile: mobile ?? {},
  }
  if (colors !== null && colors !== undefined) {
    result.colors = colors
  }
  if (launcher !== null && launcher !== undefined) {
    result.launcher = launcher
  }
  if (attention !== null && attention !== undefined) {
    result.attention = attention
  }
  if (messagePreview !== null && messagePreview !== undefined) {
    result.messagePreview = messagePreview
  }

  // Parse quickReplies if present (read from descriptor to bypass Proxy get).
  const quickRepliesDesc = getOwnDataDescriptor(value, 'quickReplies')
  let quickRepliesValue: unknown = undefined
  if (quickRepliesDesc !== null) {
    quickRepliesValue = quickRepliesDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'quickReplies')) return null
    } catch {
      return null
    }
  }
  let quickReplies: QuickRepliesConfig | null | undefined = undefined
  if (quickRepliesValue !== undefined) {
    quickReplies = parseQuickRepliesConfig(quickRepliesValue)
    if (quickReplies === undefined) return null // malformed → fail closed
  }
  if (quickReplies !== null && quickReplies !== undefined) {
    result.quickReplies = quickReplies
  }

  // Parse preChatForm if present (read from descriptor to bypass Proxy get).
  const preChatFormDesc = getOwnDataDescriptor(value, 'preChatForm')
  let preChatFormValue: unknown = undefined
  if (preChatFormDesc !== null) {
    preChatFormValue = preChatFormDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'preChatForm')) return null
    } catch {
      return null
    }
  }
  let preChatForm: PreChatFormConfig | null | undefined = undefined
  if (preChatFormValue !== undefined) {
    preChatForm = parsePreChatFormConfig(preChatFormValue)
    if (preChatForm === undefined) return null
  }
  if (preChatForm !== null && preChatForm !== undefined) {
    result.preChatForm = preChatForm
  }

  // Parse pageVisibility if present.
  const pageVisibilityDesc = getOwnDataDescriptor(value, 'pageVisibility')
  let pageVisibilityValue: unknown = undefined
  if (pageVisibilityDesc !== null) {
    pageVisibilityValue = pageVisibilityDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'pageVisibility')) return null
    } catch {
      return null
    }
  }
  let pageVisibility: PageVisibilityConfig | null | undefined = undefined
  if (pageVisibilityValue !== undefined) {
    pageVisibility = parsePageVisibilityConfig(pageVisibilityValue)
    if (pageVisibility === undefined) return null
  }
  if (pageVisibility !== null && pageVisibility !== undefined) {
    result.pageVisibility = pageVisibility
  }

  // Parse alternativeContactButtons if present.
  const acbDesc = getOwnDataDescriptor(value, 'alternativeContactButtons')
  let acbValue: unknown = undefined
  if (acbDesc !== null) {
    acbValue = acbDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'alternativeContactButtons')) return null
    } catch {
      return null
    }
  }
  let alternativeContactButtons: AlternativeContactButtonsConfig | null | undefined = undefined
  if (acbValue !== undefined) {
    alternativeContactButtons = parseAlternativeContactButtonsConfig(acbValue)
    if (alternativeContactButtons === undefined) return null
  }
  if (alternativeContactButtons !== null && alternativeContactButtons !== undefined) {
    result.alternativeContactButtons = alternativeContactButtons
  }

  // Parse smartAvoidance if present.
  const saDesc = getOwnDataDescriptor(value, 'smartAvoidance')
  let saValue: unknown = undefined
  if (saDesc !== null) {
    saValue = saDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'smartAvoidance')) return null
    } catch {
      return null
    }
  }
  let smartAvoidance: SmartAvoidanceConfig | null | undefined = undefined
  if (saValue !== undefined) {
    smartAvoidance = parseSmartAvoidanceConfig(saValue)
    if (smartAvoidance === undefined) return null
  }
  if (smartAvoidance !== null && smartAvoidance !== undefined) {
    result.smartAvoidance = smartAvoidance
  }

  // Parse contextChat if present (Feature 11 — same strict shape contract
  // as smartAvoidance: exactly one own boolean `enabled` data property).
  const ccDesc = getOwnDataDescriptor(value, 'contextChat')
  let ccValue: unknown = undefined
  if (ccDesc !== null) {
    ccValue = ccDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'contextChat')) return null
    } catch {
      return null
    }
  }
  let contextChat: ContextChatConfig | null | undefined = undefined
  if (ccValue !== undefined) {
    contextChat = parseContextChatConfig(ccValue)
    if (contextChat === undefined) return null
  }
  if (contextChat !== null && contextChat !== undefined) {
    result.contextChat = contextChat
  }
  return result
}

/** Allowed keys inside a color theme object. */
const ALLOWED_COLOR_KEYS = new Set(['mode', 'presetId', 'custom'])

/** Allowed keys inside a custom colors object. */
const ALLOWED_CUSTOM_COLOR_KEYS = new Set(COLOR_TOKEN_NAMES as readonly string[])

/**
 * Parse a color theme object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (colors is null/undefined).
 *   - ColorTheme → valid (canonical object).
 *
 * Validates: mode is 'preset' or 'custom'; presetId is valid when mode='preset';
 * custom tokens are valid #RRGGBB when mode='custom'; no unexpected keys.
 */
function parseColorTheme(value: unknown): ColorTheme | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_COLOR_KEYS.has(key)) return undefined
  }

  // mode — required, must be 'preset' or 'custom'.
  const modeDesc = getOwnDataDescriptor(value, 'mode')
  if (!modeDesc) return undefined
  const modeValue = modeDesc.value
  if (modeValue !== 'preset' && modeValue !== 'custom') return undefined

  // presetId — required when mode='preset'.
  const presetIdDesc = getOwnDataDescriptor(value, 'presetId')
  let presetId: string | undefined
  if (presetIdDesc !== null) {
    const v = presetIdDesc.value
    if (v !== undefined && v !== null) {
      if (!isValidPaletteId(v)) return undefined
      presetId = v
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'presetId')) return undefined
    } catch {
      return undefined
    }
  }

  // custom — required when mode='custom'.
  const customDesc = getOwnDataDescriptor(value, 'custom')
  let custom: ColorTokens | undefined
  if (customDesc !== null) {
    const v = customDesc.value
    if (v !== undefined && v !== null) {
      if (!isPlainObject(v)) return undefined
      const customKeys = safeOwnKeys(v)
      if (customKeys === null) return undefined
      // Check for unexpected keys.
      for (const key of customKeys) {
        if (typeof key !== 'string' || !ALLOWED_CUSTOM_COLOR_KEYS.has(key)) return undefined
      }
      // Validate all tokens are valid colors.
      if (!isValidCustomColors(v)) return undefined
      // Return canonical copy.
      const tokens: Record<string, string> = {}
      for (const name of COLOR_TOKEN_NAMES) {
        tokens[name] = (v as unknown as Record<string, unknown>)[name] as string
      }
      custom = tokens as unknown as ColorTokens
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'custom')) return undefined
    } catch {
      return undefined
    }
  }

  // Validate mode-specific requirements.
  if (modeValue === 'preset' && !presetId) return undefined
  if (modeValue === 'custom' && !custom) return undefined

  const result: ColorTheme = { mode: modeValue }
  if (presetId) result.presetId = presetId
  if (custom) result.custom = custom
  return result
}

/** Allowed keys inside a device appearance object. */
const ALLOWED_DEVICE_KEYS = new Set(['positioning'])

/** Allowed keys inside a positioning object. */
const ALLOWED_POSITIONING_KEYS = new Set(['anchor', 'offsetX', 'offsetY'])

/**
 * Parse a device-specific appearance. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (no device config).
 *   - DeviceAppearance → valid (canonical object with parsed positioning).
 *
 * Phase 2: DeviceAppearance may contain an optional `positioning` object.
 * Any other key is UNEXPECTED and causes rejection (returns undefined).
 * Non-plain objects (Date, Map, Set, class instances) are rejected.
 * Getter-based exceptions are caught (never escape).
 */
function parseDeviceAppearance(value: unknown): DeviceAppearance | null | undefined {
  if (value === null || value === undefined) return null
  // Must be a plain object — reject Date, Map, Set, class instances, etc.
  if (!isPlainObject(value)) return undefined // malformed
  // Safely get ALL own keys (enumerable + non-enumerable, string + Symbol).
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined // reflection threw → fail closed
  // Only `positioning` is allowed inside a device object.
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_DEVICE_KEYS.has(key)) return undefined
  }

  const result: DeviceAppearance = {}

  // Parse positioning if present (read from descriptor to bypass Proxy get).
  const positioningDesc = getOwnDataDescriptor(value, 'positioning')
  let positioningValue: unknown = undefined
  if (positioningDesc !== null) {
    positioningValue = positioningDesc.value
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'positioning')) return undefined
    } catch {
      return undefined
    }
  }

  if (positioningValue !== undefined) {
    const positioning = parsePositioning(positioningValue)
    if (positioning === undefined) return undefined // malformed → fail closed
    if (positioning !== null) {
      result.positioning = positioning
    }
  }

  return result
}

/**
 * Parse a positioning object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (positioning is null/undefined).
 *   - DevicePositioning → valid (canonical object).
 *
 * Validates: anchor is one of the 3 presets; offsetX/offsetY are optional
 * finite integers within [-2000, 2000]; no unexpected keys.
 */
function parsePositioning(value: unknown): DevicePositioning | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  // Only anchor, offsetX, offsetY are allowed.
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_POSITIONING_KEYS.has(key)) return undefined
  }

  // anchor — required, must be a valid preset. Read from descriptor.
  const anchorDesc = getOwnDataDescriptor(value, 'anchor')
  if (!anchorDesc) return undefined // anchor must be an own data property
  const anchorValue = anchorDesc.value
  if (typeof anchorValue !== 'string' || !(POSITIONING_ANCHORS as readonly string[]).includes(anchorValue)) {
    return undefined
  }

  const result: DevicePositioning = { anchor: anchorValue as PositioningAnchor }

  // offsetX — optional, must be a finite integer within bounds.
  const offsetXDesc = getOwnDataDescriptor(value, 'offsetX')
  if (offsetXDesc !== null) {
    const v = offsetXDesc.value
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined
    if (v < OFFSET_MIN || v > OFFSET_MAX) return undefined
    result.offsetX = v
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'offsetX')) return undefined
    } catch {
      return undefined
    }
  }

  // offsetY — optional, must be a finite integer within bounds.
  const offsetYDesc = getOwnDataDescriptor(value, 'offsetY')
  if (offsetYDesc !== null) {
    const v = offsetYDesc.value
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined
    if (v < OFFSET_MIN || v > OFFSET_MAX) return undefined
    result.offsetY = v
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'offsetY')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

/** Allowed keys inside a launcher config object. */
const ALLOWED_LAUNCHER_KEYS = new Set(['shape', 'paidShape'])

/**
 * Parse a launcher config object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (launcher is null/undefined).
 *   - LauncherConfig → valid (canonical object).
 *
 * Validates: shape is a valid launcher shape; paidShape (optional) is
 * a valid launcher shape; no unexpected keys.
 */
function parseLauncherConfig(value: unknown): LauncherConfig | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_LAUNCHER_KEYS.has(key)) return undefined
  }

  // shape — required, must be a valid launcher shape.
  const shapeDesc = getOwnDataDescriptor(value, 'shape')
  if (!shapeDesc) return undefined
  const shapeValue = shapeDesc.value
  if (!isValidLauncherShape(shapeValue)) return undefined

  const result: LauncherConfig = { shape: shapeValue as LauncherShape }

  // paidShape — optional, must be a valid PAID-ONLY launcher shape.
  // BLOCKER 4: Reject Free shapes (tab/rounded) as paidShape — only
  // paid-only shapes (pill) are semantically valid as preserved paid
  // preferences. A Free shape stored as paidShape is contradictory.
  const paidShapeDesc = getOwnDataDescriptor(value, 'paidShape')
  if (paidShapeDesc !== null) {
    const v = paidShapeDesc.value
    if (v !== undefined && v !== null) {
      if (!isValidLauncherShape(v)) return undefined
      if (!isPaidOnlyLauncherShape(v as LauncherShape)) return undefined
      result.paidShape = v as LauncherShape
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidShape')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

/** Allowed keys inside an attention config object. */
const ALLOWED_ATTENTION_KEYS = new Set(['animation', 'paidAnimation'])

/**
 * Parse an attention config object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (attention is null/undefined).
 *   - AttentionConfig → valid (canonical object).
 *
 * Validates: animation is a valid attention animation; paidAnimation
 * (optional) is a valid ADVANCED-ONLY animation (bounce/shake/glow) —
 * 'none' and 'pulse' are basic and contradictory as a paid preference,
 * so they are rejected; no unexpected keys; no arbitrary CSS or
 * executable text (animation is an enum, never a free string).
 *
 * Getter-based malformed objects are caught (never escape).
 */
function parseAttentionConfig(value: unknown): AttentionConfig | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_ATTENTION_KEYS.has(key)) return undefined
  }

  // animation — required, must be a valid attention animation.
  const animationDesc = getOwnDataDescriptor(value, 'animation')
  if (!animationDesc) return undefined
  const animationValue = animationDesc.value
  if (!isValidAttentionAnimation(animationValue)) return undefined

  const result: AttentionConfig = { animation: animationValue as AttentionAnimation }

  // paidAnimation — optional, must be a valid ADVANCED-ONLY animation.
  // Only bounce/shake/glow are semantically valid as preserved paid
  // preferences. 'none' and 'pulse' are basic (available to Free) and
  // contradictory as a paid preference — rejected.
  const paidAnimationDesc = getOwnDataDescriptor(value, 'paidAnimation')
  if (paidAnimationDesc !== null) {
    const v = paidAnimationDesc.value
    if (v !== undefined && v !== null) {
      if (!isValidAttentionAnimation(v)) return undefined
      if (!isAdvancedOnlyAttentionAnimation(v as AttentionAnimation)) return undefined
      result.paidAnimation = v as AttentionAnimation
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidAnimation')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

/** Allowed keys inside a message preview config object. */
const ALLOWED_MESSAGE_PREVIEW_KEYS = new Set(['enabled'])

/**
 * Parse a message-preview config object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (messagePreview is null/undefined).
 *   - MessagePreviewConfig → valid (canonical object).
 *
 * Validates: `enabled` is a strict boolean; no unexpected keys; no arrays,
 * inherited properties, or getter-based malformed objects.
 */
function parseMessagePreviewConfig(value: unknown): MessagePreviewConfig | null | undefined {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_MESSAGE_PREVIEW_KEYS.has(key)) return undefined
  }

  // enabled — required, must be a strict boolean (reject 'true', 1, etc.).
  const enabledDesc = getOwnDataDescriptor(value, 'enabled')
  if (!enabledDesc) return undefined
  const enabledValue = enabledDesc.value
  if (typeof enabledValue !== 'boolean') return undefined

  return { enabled: enabledValue }
}

/** Allowed keys inside a quick-replies config object. */
const ALLOWED_QUICK_REPLIES_KEYS = new Set(['items', 'paidItems'])

/** Maximum items in a stored quick-replies config (defensive cap). */
const QUICK_REPLIES_MAX_STORED = 50

/**
 * Parse a quick-replies config object. Returns:
 *   - undefined → malformed (caller fails closed).
 *   - null → absent (quickReplies is null/undefined).
 *   - QuickRepliesConfig → valid (canonical object).
 *
 * Validates:
 *   - `items` is a non-empty array of valid strings (1–80 code points,
 *     non-blank, single-line, no case-insensitive duplicates).
 *   - `paidItems` (optional): if present, must be a non-empty array of valid
 *     strings with no duplicates, AND must contain at least one item not in
 *     `items` (not a useless subset). An empty paidItems or one identical to
 *     items is rejected as contradictory.
 *   - No unexpected keys.
 *   - No arrays, inherited properties, or getter-based malformed objects.
 */
function parseQuickRepliesConfig(value: unknown): QuickRepliesConfig | null | undefined {
  if (value === undefined) return null // absent (key not present)
  if (value === null) return undefined // malformed (explicit null is not valid)
  if (!isPlainObject(value)) return undefined // malformed
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_QUICK_REPLIES_KEYS.has(key)) return undefined
  }

  // items — required, must be an array of valid strings.
  const itemsDesc = getOwnDataDescriptor(value, 'items')
  if (!itemsDesc) return undefined
  const itemsValue = itemsDesc.value
  if (!Array.isArray(itemsValue)) return undefined
  if (itemsValue.length > QUICK_REPLIES_MAX_STORED) return undefined
  // Note: empty items is accepted (the merge can produce { items: [], paidItems: [...] }
  // when Free clears suggestions while preserving paid selection). The resolver
  // returns [] for empty items.

  const items: string[] = []
  const itemsLower = new Set<string>()
  for (const raw of itemsValue) {
    if (typeof raw !== 'string') return undefined
    // Reject blank (whitespace-only).
    if (raw.trim() === '') return undefined
    // Reject whitespace-padded (leading or trailing whitespace).
    if (raw !== raw.trim()) return undefined
    // Reject multiline.
    if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) return undefined
    const codePoints = Array.from(raw).length
    if (codePoints < 1 || codePoints > 80) return undefined
    const lower = raw.toLowerCase()
    if (itemsLower.has(lower)) return undefined // duplicate
    itemsLower.add(lower)
    items.push(raw)
  }

  const result: QuickRepliesConfig = { items }

  // paidItems — optional. If present, must be non-empty, valid, no duplicates,
  // and contain at least one item NOT in items (not a useless subset).
  const paidItemsDesc = getOwnDataDescriptor(value, 'paidItems')
  if (paidItemsDesc !== null) {
    const v = paidItemsDesc.value
    if (v !== undefined && v !== null) {
      if (!Array.isArray(v)) return undefined
      if (v.length === 0) return undefined // useless empty paidItems
      if (v.length > QUICK_REPLIES_MAX_STORED) return undefined
      const paidItems: string[] = []
      const paidLower = new Set<string>()
      let hasNewItem = false
      for (const raw of v) {
        if (typeof raw !== 'string') return undefined
        if (raw.trim() === '') return undefined
        if (raw !== raw.trim()) return undefined
        if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) return undefined
        const codePoints = Array.from(raw).length
        if (codePoints < 1 || codePoints > 80) return undefined
        const lower = raw.toLowerCase()
        if (paidLower.has(lower)) return undefined // duplicate within paidItems
        paidLower.add(lower)
        if (!itemsLower.has(lower)) hasNewItem = true
        paidItems.push(raw)
      }
      // paidItems must provide at least one item not in items (not a subset).
      if (!hasNewItem) return undefined
      result.paidItems = paidItems
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidItems')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

/**
 * Whether a WidgetConfig row has a usable V2 appearance.
 * Returns false if the stored value is null/absent/malformed.
 */
export function hasAppearanceV2(value: unknown): boolean {
  return parseAppearanceV2(value) !== null
}

const ALLOWED_PAGE_VISIBILITY_KEYS = new Set(['rules', 'paidRules'])
const ALLOWED_PAGE_RULE_KEYS_SET = new Set(['pattern', 'match', 'action', 'device'])
const ALLOWED_PAGE_MATCH_VALUES = new Set(['exact', 'prefix'])
const ALLOWED_PAGE_ACTION_VALUES = new Set(['show', 'hide'])
const ALLOWED_PAGE_DEVICE_VALUES = new Set(['desktop', 'mobile'])

function parsePageVisibilityRule(raw: unknown): PageVisibilityRuleStored | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const keys = safeOwnKeys(raw)
  if (keys === null) return undefined
  for (const k of keys) {
    if (typeof k !== 'string' || !ALLOWED_PAGE_RULE_KEYS_SET.has(k)) return undefined
  }
  const patternDesc = getOwnDataDescriptor(raw, 'pattern')
  if (!patternDesc) return undefined
  const pattern = patternDesc.value
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 500) return undefined
  if (pattern[0] !== '/') return undefined
  if (pattern.includes('*') || pattern.includes('?') || pattern.includes('\\')) return undefined
  if (pattern.includes('(') || pattern.includes(')')) return undefined
  if (/[\r\n\t\0]/.test(pattern)) return undefined

  const matchDesc = getOwnDataDescriptor(raw, 'match')
  if (!matchDesc) return undefined
  const matchValue = matchDesc.value
  if (typeof matchValue !== 'string' || !ALLOWED_PAGE_MATCH_VALUES.has(matchValue)) return undefined

  const actionDesc = getOwnDataDescriptor(raw, 'action')
  if (!actionDesc) return undefined
  const actionValue = actionDesc.value
  if (typeof actionValue !== 'string' || !ALLOWED_PAGE_ACTION_VALUES.has(actionValue)) return undefined

  const result: PageVisibilityRuleStored = {
    pattern,
    match: matchValue as 'exact' | 'prefix',
    action: actionValue as 'show' | 'hide',
  }

  const deviceDesc = getOwnDataDescriptor(raw, 'device')
  if (deviceDesc !== null) {
    const dv = deviceDesc.value
    if (dv !== undefined && dv !== null) {
      if (typeof dv !== 'string' || !ALLOWED_PAGE_DEVICE_VALUES.has(dv)) return undefined
      result.device = dv as 'desktop' | 'mobile'
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(raw, 'device')) return undefined
    } catch {
      return undefined
    }
  }

  return result
}

function parsePageVisibilityRulesArray(arr: unknown): PageVisibilityRuleStored[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const rules: PageVisibilityRuleStored[] = []
  const seen = new Set<string>()
  for (const raw of arr) {
    const rule = parsePageVisibilityRule(raw)
    if (rule === undefined) return undefined
    const key = `${rule.pattern}|${rule.match}|${rule.action}|${rule.device ?? 'any'}`
    if (seen.has(key)) return undefined
    seen.add(key)
    rules.push(rule)
  }
  return rules
}

function parsePageVisibilityConfig(value: unknown): PageVisibilityConfig | null | undefined {
  if (value === undefined) return null
  if (value === null) return undefined
  if (!isPlainObject(value)) return undefined
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_PAGE_VISIBILITY_KEYS.has(key)) return undefined
  }
  const rulesDesc = getOwnDataDescriptor(value, 'rules')
  if (!rulesDesc) return undefined
  const rules = parsePageVisibilityRulesArray(rulesDesc.value)
  if (rules === undefined) return undefined
  const result: PageVisibilityConfig = { rules }
  const paidRulesDesc = getOwnDataDescriptor(value, 'paidRules')
  if (paidRulesDesc !== null) {
    const v = paidRulesDesc.value
    if (v !== undefined && v !== null) {
      const paidRules = parsePageVisibilityRulesArray(v)
      if (paidRules === undefined) return undefined
      if (paidRules.length === 0) return undefined
      result.paidRules = paidRules
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidRules')) return undefined
    } catch {
      return undefined
    }
  }
  return result
}

const ALLOWED_PRE_CHAT_KEYS = new Set(['fields', 'paidFields'])
const ALLOWED_PRE_CHAT_FIELD_KEYS_SET = new Set(['name', 'email', 'phone', 'company'])

function parsePreChatFormField(raw: unknown): PreChatFormField | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const keys = safeOwnKeys(raw)
  if (keys === null) return undefined
  if (keys.length !== 2) return undefined
  let hasKey = false, hasRequired = false
  for (const k of keys) {
    if (k === 'key') hasKey = true
    else if (k === 'required') hasRequired = true
    else return undefined
  }
  if (!hasKey || !hasRequired) return undefined
  const keyDesc = getOwnDataDescriptor(raw, 'key')
  if (!keyDesc) return undefined
  const keyValue = keyDesc.value
  if (typeof keyValue !== 'string' || !ALLOWED_PRE_CHAT_FIELD_KEYS_SET.has(keyValue)) return undefined
  const reqDesc = getOwnDataDescriptor(raw, 'required')
  if (!reqDesc) return undefined
  const reqValue = reqDesc.value
  if (typeof reqValue !== 'boolean') return undefined
  return { key: keyValue as PreChatFormField['key'], required: reqValue }
}

function parsePreChatFormFieldsArray(arr: unknown): PreChatFormField[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const fields: PreChatFormField[] = []
  const seenKeys = new Set<string>()
  for (const raw of arr) {
    const field = parsePreChatFormField(raw)
    if (field === undefined) return undefined
    if (seenKeys.has(field.key)) return undefined
    seenKeys.add(field.key)
    fields.push(field)
  }
  return fields
}

function parsePreChatFormConfig(value: unknown): PreChatFormConfig | null | undefined {
  if (value === undefined) return null
  if (value === null) return undefined
  if (!isPlainObject(value)) return undefined
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_PRE_CHAT_KEYS.has(key)) return undefined
  }
  const fieldsDesc = getOwnDataDescriptor(value, 'fields')
  if (!fieldsDesc) return undefined
  const fields = parsePreChatFormFieldsArray(fieldsDesc.value)
  if (fields === undefined) return undefined
  const result: PreChatFormConfig = { fields }
  const paidFieldsDesc = getOwnDataDescriptor(value, 'paidFields')
  if (paidFieldsDesc !== null) {
    const v = paidFieldsDesc.value
    if (v !== undefined && v !== null) {
      const paidFields = parsePreChatFormFieldsArray(v)
      if (paidFields === undefined) return undefined
      if (paidFields.length === 0) return undefined
      result.paidFields = paidFields
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidFields')) return undefined
    } catch {
      return undefined
    }
  }
  return result
}

const ALLOWED_ACB_KEYS = new Set(['items', 'paidItems'])
const ALLOWED_ACB_KINDS = new Set(['phone', 'email', 'whatsapp', 'telegram', 'website'])

function validateAcbValue(kind: string, value: string): boolean {
  switch (kind) {
    case 'phone':
      if (value.startsWith('tel:')) return false
      if (value.includes('<') || value.includes('>')) return false
      return /^\+[\d\s\-()]+$/.test(value) && value.replace(/[\s\-()]/g, '').length >= 8
    case 'email':
      if (value.startsWith('mailto:')) return false
      if (value.includes(' ') || value.includes('<') || value.includes('>')) return false
      if (value.includes('?') || value.includes('#')) return false
      if (value.includes('%')) return false
      if (/[\r\n\0]/.test(value)) return false
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200
    case 'whatsapp':
      if (value.startsWith('http') || value.includes('wa.me')) return false
      if (value.includes('<') || value.includes('>')) return false
      const waClean = value.replace(/[\s\-()]/g, '')
      return /^\+?\d{8,}$/.test(waClean)
    case 'telegram':
      if (value.startsWith('http') || value.includes('t.me')) return false
      if (value.startsWith('@')) return false
      if (value.includes('/') || value.includes('\\') || value.includes(' ')) return false
      if (value.includes('<') || value.includes('>')) return false
      return /^[a-zA-Z0-9_]{3,}$/.test(value)
    case 'website':
      if (!value.startsWith('https://')) return false
      if (!/^https:\/\/[^\s\n\r\t\\]+$/.test(value)) return false
      try {
        const url = new URL(value)
        if (url.username || url.password) return false
        if (url.protocol !== 'https:') return false
      } catch { return false }
      return true
    default: return false
  }
}

function parseAcbButton(raw: unknown): AlternativeContactButtonStored | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const keys = safeOwnKeys(raw)
  if (keys === null) return undefined
  if (keys.length !== 3) return undefined
  let hasKind = false, hasLabel = false, hasValue = false
  for (const k of keys) {
    if (k === 'kind') hasKind = true
    else if (k === 'label') hasLabel = true
    else if (k === 'value') hasValue = true
    else return undefined
  }
  if (!hasKind || !hasLabel || !hasValue) return undefined
  const kindDesc = getOwnDataDescriptor(raw, 'kind')
  if (!kindDesc) return undefined
  const kind = kindDesc.value
  if (typeof kind !== 'string' || !ALLOWED_ACB_KINDS.has(kind)) return undefined
  const labelDesc = getOwnDataDescriptor(raw, 'label')
  if (!labelDesc) return undefined
  const label = labelDesc.value
  if (typeof label !== 'string') return undefined
  if (label.trim() === '') return undefined
  if (label !== label.trim()) return undefined
  if (label.includes('\n') || label.includes('\r')) return undefined
  if (Array.from(label).length > 40) return undefined
  const valueDesc = getOwnDataDescriptor(raw, 'value')
  if (!valueDesc) return undefined
  const value = valueDesc.value
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return undefined
  if (!validateAcbValue(kind, value)) return undefined
  return { kind: kind as AlternativeContactButtonStored['kind'], label, value }
}

function parseAcbItemsArray(arr: unknown): AlternativeContactButtonStored[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const items: AlternativeContactButtonStored[] = []
  const seenKinds = new Set<string>()
  for (const raw of arr) {
    const btn = parseAcbButton(raw)
    if (btn === undefined) return undefined
    if (seenKinds.has(btn.kind)) return undefined
    seenKinds.add(btn.kind)
    items.push(btn)
  }
  return items
}

function parseAlternativeContactButtonsConfig(value: unknown): AlternativeContactButtonsConfig | null | undefined {
  if (value === undefined) return null
  if (value === null) return undefined
  if (!isPlainObject(value)) return undefined
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_ACB_KEYS.has(key)) return undefined
  }
  const itemsDesc = getOwnDataDescriptor(value, 'items')
  if (!itemsDesc) return undefined
  const items = parseAcbItemsArray(itemsDesc.value)
  if (items === undefined) return undefined
  const result: AlternativeContactButtonsConfig = { items }
  const paidItemsDesc = getOwnDataDescriptor(value, 'paidItems')
  if (paidItemsDesc !== null) {
    const v = paidItemsDesc.value
    if (v !== undefined && v !== null) {
      const paidItems = parseAcbItemsArray(v)
      if (paidItems === undefined) return undefined
      if (paidItems.length === 0) return undefined
      result.paidItems = paidItems
    }
  } else {
    try {
      if (Object.prototype.hasOwnProperty.call(value, 'paidItems')) return undefined
    } catch { return undefined }
  }
  return result
}

const ALLOWED_SMART_AVOIDANCE_KEYS = new Set(['enabled'])

function parseSmartAvoidanceConfig(value: unknown): SmartAvoidanceConfig | null | undefined {
  if (value === undefined) return null
  if (value === null) return undefined
  if (!isPlainObject(value)) return undefined
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_SMART_AVOIDANCE_KEYS.has(key)) return undefined
  }
  const enabledDesc = getOwnDataDescriptor(value, 'enabled')
  if (!enabledDesc) return undefined
  const enabledValue = enabledDesc.value
  if (typeof enabledValue !== 'boolean') return undefined
  return { enabled: enabledValue }
}

const ALLOWED_CONTEXT_CHAT_KEYS = new Set(['enabled'])

function parseContextChatConfig(value: unknown): ContextChatConfig | null | undefined {
  if (value === undefined) return null
  if (value === null) return undefined
  if (!isPlainObject(value)) return undefined
  const keys = safeOwnKeys(value)
  if (keys === null) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_CONTEXT_CHAT_KEYS.has(key)) return undefined
  }
  const enabledDesc = getOwnDataDescriptor(value, 'enabled')
  if (!enabledDesc) return undefined
  const enabledValue = enabledDesc.value
  if (typeof enabledValue !== 'boolean') return undefined
  return { enabled: enabledValue }
}
