/**
 * Widget V2 Context Chat — effective resolution + entitlement enforcement
 * (Feature 11 — BETA).
 *
 *   - Free (contextChat: false) → always { enabled: false }, even when a
 *     paid-era stored preference is true (downgrade safety).
 *   - Paid (contextChat: true) → the stored preference (default false).
 *   - Unknown / null entitlements → { enabled: false } (fail closed).
 *
 * Entitlement availability is NOT automatic activation — the tenant owner
 * must have explicitly enabled the feature in their stored appearanceV2.
 *
 * Pure TS — no Prisma, no Next.js.
 */

import { parseAppearanceV2 } from './appearance-v2'
import type { WidgetEntitlements } from '../payments/widget-entitlements'

export interface EffectiveContextChat {
  enabled: boolean
}

export interface StoredContextChatInput {
  appearanceV2?: unknown
}

export function resolveEffectiveContextChat(
  stored: StoredContextChatInput,
  entitlements: Readonly<WidgetEntitlements> | null,
): EffectiveContextChat {
  if (!entitlements) return { enabled: false }
  if (!entitlements.contextChat) return { enabled: false }
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  const contextChat = appearanceV2?.contextChat
  return { enabled: contextChat?.enabled ?? false }
}

export function getStoredContextChat(
  stored: StoredContextChatInput,
): { enabled: boolean } | null {
  const appearanceV2 = parseAppearanceV2(stored.appearanceV2)
  return appearanceV2?.contextChat ?? null
}
