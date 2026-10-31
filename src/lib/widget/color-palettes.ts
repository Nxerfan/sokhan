/**
 * Widget V2 Color Palettes — the canonical catalog of 10 predefined color themes.
 *
 * Each palette has a stable ID and a complete set of color tokens covering
 * all supported widget surfaces. The default palette (`sukhan`) matches the
 * existing Sukhan brand look.
 *
 * Color tokens (all #RRGGBB format):
 *   - accent:         Primary action color (buttons, links, highlights)
 *   - launcherBg:     Launcher button background
 *   - launcherFg:     Launcher icon/foreground color
 *   - headerBg:       Chat panel header background
 *   - headerText:     Chat header text color
 *   - panelBg:        Chat panel body background
 *   - panelText:      Primary text color in the panel
 *   - visitorBubbleBg:   Visitor message bubble background
 *   - visitorBubbleText: Visitor message text color
 *   - agentBubbleBg:     Agent message bubble background
 *   - agentBubbleText:   Agent message text color
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * NPM widget / browser bundle to import.
 */

/** A complete set of color tokens for one palette. */
export interface ColorTokens {
  accent: string
  launcherBg: string
  launcherFg: string
  headerBg: string
  headerText: string
  panelBg: string
  panelText: string
  visitorBubbleBg: string
  visitorBubbleText: string
  agentBubbleBg: string
  agentBubbleText: string
}

/** A predefined color palette with a stable ID. */
export interface ColorPalette {
  id: string
  name: string
  tokens: ColorTokens
}

/**
 * The canonical 10 predefined color palettes.
 *
 * Palette IDs are stable — they are stored in appearanceV2 and must never
 * change. New palettes can be added but existing IDs must remain.
 *
 * Palettes are chosen for visual distinction, accessibility (WCAG AA
 * contrast for text against backgrounds), and aesthetic variety.
 */
export const COLOR_PALETTES: readonly ColorPalette[] = [
  {
    id: 'sukhan',
    name: 'Sukhan',
    tokens: {
      accent: '#E09A2B',
      launcherBg: '#0E1116',
      launcherFg: '#FAF7F2',
      headerBg: '#E09A2B',
      headerText: '#FFFFFF',
      panelBg: '#FFFFFF',
      panelText: '#1A1A2E',
      visitorBubbleBg: '#F0EEE9',
      visitorBubbleText: '#1A1A2E',
      agentBubbleBg: '#E09A2B',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    tokens: {
      accent: '#6366F1',
      launcherBg: '#1E1B4B',
      launcherFg: '#E0E7FF',
      headerBg: '#1E1B4B',
      headerText: '#E0E7FF',
      panelBg: '#F8FAFC',
      panelText: '#1E1B4B',
      visitorBubbleBg: '#E0E7FF',
      visitorBubbleText: '#1E1B4B',
      agentBubbleBg: '#6366F1',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    tokens: {
      accent: '#10B981',
      launcherBg: '#064E3B',
      launcherFg: '#D1FAE5',
      headerBg: '#064E3B',
      headerText: '#D1FAE5',
      panelBg: '#F0FDF4',
      panelText: '#064E3B',
      visitorBubbleBg: '#D1FAE5',
      visitorBubbleText: '#064E3B',
      agentBubbleBg: '#10B981',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    tokens: {
      accent: '#F97316',
      launcherBg: '#7C2D12',
      launcherFg: '#FFEDD5',
      headerBg: '#7C2D12',
      headerText: '#FFEDD5',
      panelBg: '#FFFBEB',
      panelText: '#7C2D12',
      visitorBubbleBg: '#FFEDD5',
      visitorBubbleText: '#7C2D12',
      agentBubbleBg: '#F97316',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    tokens: {
      accent: '#0EA5E9',
      launcherBg: '#0C4A6E',
      launcherFg: '#E0F2FE',
      headerBg: '#0C4A6E',
      headerText: '#E0F2FE',
      panelBg: '#F0F9FF',
      panelText: '#0C4A6E',
      visitorBubbleBg: '#E0F2FE',
      visitorBubbleText: '#0C4A6E',
      agentBubbleBg: '#0EA5E9',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    tokens: {
      accent: '#E11D48',
      launcherBg: '#881337',
      launcherFg: '#FFE4E6',
      headerBg: '#881337',
      headerText: '#FFE4E6',
      panelBg: '#FFF1F2',
      panelText: '#881337',
      visitorBubbleBg: '#FFE4E6',
      visitorBubbleText: '#881337',
      agentBubbleBg: '#E11D48',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    tokens: {
      accent: '#64748B',
      launcherBg: '#1E293B',
      launcherFg: '#F1F5F9',
      headerBg: '#334155',
      headerText: '#F1F5F9',
      panelBg: '#F8FAFC',
      panelText: '#1E293B',
      visitorBubbleBg: '#E2E8F0',
      visitorBubbleText: '#1E293B',
      agentBubbleBg: '#475569',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'violet',
    name: 'Violet',
    tokens: {
      accent: '#8B5CF6',
      launcherBg: '#4C1D95',
      launcherFg: '#EDE9FE',
      headerBg: '#4C1D95',
      headerText: '#EDE9FE',
      panelBg: '#F5F3FF',
      panelText: '#4C1D95',
      visitorBubbleBg: '#EDE9FE',
      visitorBubbleText: '#4C1D95',
      agentBubbleBg: '#8B5CF6',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    tokens: {
      accent: '#16A34A',
      launcherBg: '#14532D',
      launcherFg: '#DCFCE7',
      headerBg: '#14532D',
      headerText: '#DCFCE7',
      panelBg: '#F7Fee7',
      panelText: '#14532D',
      visitorBubbleBg: '#DCFCE7',
      visitorBubbleText: '#14532D',
      agentBubbleBg: '#16A34A',
      agentBubbleText: '#FFFFFF',
    },
  },
  {
    id: 'crimson',
    name: 'Crimson',
    tokens: {
      accent: '#DC2626',
      launcherBg: '#7F1D1D',
      launcherFg: '#FEE2E2',
      headerBg: '#7F1D1D',
      headerText: '#FEE2E2',
      panelBg: '#FEF2F2',
      panelText: '#7F1D1D',
      visitorBubbleBg: '#FEE2E2',
      visitorBubbleText: '#7F1D1D',
      agentBubbleBg: '#DC2626',
      agentBubbleText: '#FFFFFF',
    },
  },
] as const

/** The default palette ID (Sukhan brand look). */
export const DEFAULT_PALETTE_ID = 'sukhan'

/** The default color tokens (Sukhan brand). */
export const DEFAULT_COLOR_TOKENS: ColorTokens = COLOR_PALETTES[0].tokens

/** All valid palette IDs. */
export const PALETTE_IDS: readonly string[] = COLOR_PALETTES.map((p) => p.id)

/**
 * Get a palette by ID. Returns null if the ID is not found.
 */
export function getPaletteById(id: string): ColorPalette | null {
  for (const p of COLOR_PALETTES) {
    if (p.id === id) return p
  }
  return null
}

/**
 * Check if a value is a valid palette ID.
 */
export function isValidPaletteId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  return PALETTE_IDS.includes(id)
}

/**
 * All supported custom color token names.
 */
export const COLOR_TOKEN_NAMES = [
  'accent',
  'launcherBg',
  'launcherFg',
  'headerBg',
  'headerText',
  'panelBg',
  'panelText',
  'visitorBubbleBg',
  'visitorBubbleText',
  'agentBubbleBg',
  'agentBubbleText',
] as const

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number]

/**
 * Validate a single color value (#RRGGBB format).
 * Rejects: non-strings, wrong length, non-hex characters, #RGB shorthand,
 * named colors, rgba/hsl, etc.
 */
export function isValidColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * Validate a complete set of custom color tokens.
 * All 11 tokens must be present + valid #RRGGBB. Extra keys are rejected.
 */
export function isValidCustomColors(value: unknown): value is ColorTokens {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  const validNames = new Set(COLOR_TOKEN_NAMES as readonly string[])
  for (const key of Object.keys(obj)) {
    if (!validNames.has(key)) return false // extra key → reject
  }
  for (const name of COLOR_TOKEN_NAMES) {
    if (!isValidColor(obj[name])) return false
  }
  return true
}

/**
 * Compute the relative luminance of a #RRGGBB color (WCAG 2.1).
 * Returns a value between 0 (darkest) and 1 (lightest).
 */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/**
 * Compute the WCAG contrast ratio between two #RRGGBB colors.
 * Returns a value between 1 (no contrast) and 21 (max contrast).
 */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Check if a foreground/background pair meets WCAG AA contrast (≥ 4.5:1
 * for normal text, ≥ 3:1 for large text/UI). Uses 3:1 threshold for
 * UI elements (buttons, icons) and 4.5:1 for body text.
 */
export function meetsContrastAA(fg: string, bg: string, largeText = false): boolean {
  const ratio = contrastRatio(fg, bg)
  return largeText ? ratio >= 3 : ratio >= 4.5
}
