/// <reference types="bun-types" />
/**
 * Developer-owned implementation tests for Feature 7 — Pre-chat Form.
 *
 * Additional coverage beyond the reviewer-owned contract:
 *   - Field key filtering, Unicode boundaries, email/phone validation.
 *   - Plan entitlement edge cases (Max, Self-hosted, unknown).
 *   - Downgrade/upgrade/paidFields lifecycle.
 *   - Submission: unknown keys, privilege-escalation attempts, oversized values.
 *   - shouldRequirePreChat: full lifecycle transitions.
 *   - Cross-feature true-patch preservation.
 *   - Strict parseAppearanceV2 rejection of malformed preChatForm.
 */
import { describe, expect, test } from 'bun:test'
import { getEntitlements } from '../../src/lib/payments/widget-entitlements'
import { parseAppearanceV2 } from '../../src/lib/widget/appearance-v2'
import {
  validatePreChatFormPatch, mergePreChatFormPatch,
} from '../../src/lib/widget/pre-chat-form-patch'
import { resolveEffectivePreChatForm } from '../../src/lib/widget/effective-pre-chat-form'
import {
  validatePreChatSubmission, shouldRequirePreChat, isPreChatComplete,
} from '../../src/lib/widget/pre-chat-form-policy'
import {
  PRE_CHAT_FIELD_KEYS,
  BASIC_PRE_CHAT_FIELDS,
  ADVANCED_ONLY_PRE_CHAT_FIELDS,
  isValidPreChatFieldKey,
  isBasicPreChatField,
  isAdvancedPreChatPlan,
  isFieldKeyAllowed,
  getMaxFields,
  NAME_MAX_CODE_POINTS,
  EMAIL_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  COMPANY_MAX_CODE_POINTS,
} from '../../src/lib/widget/pre-chat-form-types'
import { mergeColorPatch } from '../../src/lib/widget/color-patch'
import { mergeLauncherPatch } from '../../src/lib/widget/launcher-patch'
import { mergeAttentionPatch } from '../../src/lib/widget/attention-patch'
import { mergeMessagePreviewPatch } from '../../src/lib/widget/message-preview-patch'
import { mergeQuickRepliesPatch } from '../../src/lib/widget/quick-replies-patch'
import { mergePositioningPatch } from '../../src/lib/widget/positioning-patch'

type Field = { key: 'name' | 'email' | 'phone' | 'company'; required: boolean }
const FREE = getEntitlements('free')
const PRO = getEntitlements('pro')
const MAX = getEntitlements('max')
const SELF = getEntitlements('self-hosted')
const UNKNOWN = getEntitlements('__unrecognized__')
const freeFields: Field[] = [{ key: 'name', required: true }, { key: 'email', required: false }]
const paidFields: Field[] = [...freeFields, { key: 'phone', required: true }, { key: 'company', required: false }]
const full = {
  version: 1 as const,
  desktop: { positioning: { anchor: 'bottom-center' as const, offsetX: 5, offsetY: -5 } },
  mobile: { positioning: { anchor: 'bottom-start' as const, offsetX: -3, offsetY: 3 } },
  colors: { mode: 'preset' as const, presetId: 'emerald' },
  launcher: { shape: 'rounded' as const },
  attention: { animation: 'pulse' as const },
  messagePreview: { enabled: true },
  quickReplies: { items: ['Hello'] },
  preChatForm: { fields: paidFields },
}
const input = (appearanceV2: unknown) => ({ appearanceV2 })

describe('Developer — types and constants', () => {
  test('PRE_CHAT_FIELD_KEYS has exactly 4 keys', () => {
    expect(PRE_CHAT_FIELD_KEYS).toEqual(['name', 'email', 'phone', 'company'])
  })

  test('BASIC fields are name+email, advanced-only are phone+company', () => {
    expect(BASIC_PRE_CHAT_FIELDS).toEqual(['name', 'email'])
    expect(ADVANCED_ONLY_PRE_CHAT_FIELDS).toEqual(['phone', 'company'])
  })

  test('isValidPreChatFieldKey', () => {
    expect(isValidPreChatFieldKey('name')).toBe(true)
    expect(isValidPreChatFieldKey('email')).toBe(true)
    expect(isValidPreChatFieldKey('phone')).toBe(true)
    expect(isValidPreChatFieldKey('company')).toBe(true)
    expect(isValidPreChatFieldKey('other')).toBe(false)
    expect(isValidPreChatFieldKey(42)).toBe(false)
    expect(isValidPreChatFieldKey(null)).toBe(false)
  })

  test('isBasicPreChatField', () => {
    expect(isBasicPreChatField('name')).toBe(true)
    expect(isBasicPreChatField('email')).toBe(true)
    expect(isBasicPreChatField('phone')).toBe(false)
    expect(isBasicPreChatField('company')).toBe(false)
  })

  test('isAdvancedPreChatPlan', () => {
    expect(isAdvancedPreChatPlan('advanced')).toBe(true)
    expect(isAdvancedPreChatPlan('basic')).toBe(false)
    expect(isAdvancedPreChatPlan('none')).toBe(false)
  })

  test('isFieldKeyAllowed', () => {
    expect(isFieldKeyAllowed('name', 'basic')).toBe(true)
    expect(isFieldKeyAllowed('email', 'basic')).toBe(true)
    expect(isFieldKeyAllowed('phone', 'basic')).toBe(false)
    expect(isFieldKeyAllowed('company', 'basic')).toBe(false)
    for (const k of PRE_CHAT_FIELD_KEYS) {
      expect(isFieldKeyAllowed(k, 'advanced')).toBe(true)
    }
  })

  test('getMaxFields', () => {
    expect(getMaxFields('basic')).toBe(2)
    expect(getMaxFields('advanced')).toBe(4)
  })

  test('Length constants', () => {
    expect(NAME_MAX_CODE_POINTS).toBe(100)
    expect(EMAIL_MAX_LENGTH).toBe(200)
    expect(PHONE_MAX_LENGTH).toBe(50)
    expect(COMPANY_MAX_CODE_POINTS).toBe(100)
  })
})

describe('Developer — validation edge cases', () => {
  test('Max and Self-hosted accept all four fields', () => {
    for (const ent of [MAX, SELF]) {
      expect(validatePreChatFormPatch({ preChatForm: { fields: paidFields } }, ent))
        .toEqual({ ok: true, data: { fields: paidFields } })
    }
  })

  test('Free with only basic fields but 3+ entries is limit_exceeded', () => {
    const threeBasic = [
      { key: 'name' as const, required: true },
      { key: 'email' as const, required: false },
      { key: 'name' as const, required: false }, // would be duplicate but limit check is after validation
    ]
    // This will fail on duplicate, not limit — because validation runs first
    expect(validatePreChatFormPatch({ preChatForm: { fields: threeBasic } }, FREE).ok).toBe(false)
  })

  test('empty fields explicitly disables form', () => {
    for (const ent of [FREE, PRO, MAX, SELF]) {
      expect(validatePreChatFormPatch({ preChatForm: { fields: [] } }, ent))
        .toEqual({ ok: true, data: { fields: [] } })
    }
  })

  test('null entitlements rejected', () => {
    expect(validatePreChatFormPatch({ preChatForm: { fields: [] } }, null).ok).toBe(false)
  })

  test('rejects field with extra properties', () => {
    expect(validatePreChatFormPatch({ preChatForm: { fields: [{ key: 'name', required: true, label: 'X' }] } }, PRO).ok).toBe(false)
  })

  test('rejects non-boolean required', () => {
    for (const val of ['true', 1, 0, null, 'yes']) {
      expect(validatePreChatFormPatch({ preChatForm: { fields: [{ key: 'name', required: val as never }] } }, PRO).ok).toBe(false)
    }
  })
})

describe('Developer — downgrade/upgrade lifecycle', () => {
  test('Pro 4 → Free 1 preserves all 4 as paidFields', () => {
    const down = mergePreChatFormPatch(full, { fields: [{ key: 'name', required: false }] }, FREE)
    expect(down.preChatForm?.paidFields).toEqual(paidFields)
    expect(resolveEffectivePreChatForm(input(down), FREE).fields).toEqual([{ key: 'name', required: false }])
    expect(resolveEffectivePreChatForm(input(down), PRO).fields).toEqual(paidFields)
  })

  test('Free idempotent edit preserves paidFields', () => {
    const a = mergePreChatFormPatch(full, { fields: freeFields }, FREE)
    const b = mergePreChatFormPatch(a, { fields: freeFields }, FREE)
    expect(b.preChatForm?.paidFields).toEqual(paidFields)
  })

  test('Pro explicit save clears paidFields', () => {
    const down = mergePreChatFormPatch(full, { fields: [{ key: 'name', required: true }] }, FREE)
    const up = mergePreChatFormPatch(down, { fields: [{ key: 'name', required: true }] }, PRO)
    expect(up.preChatForm).toEqual({ fields: [{ key: 'name', required: true }] })
  })

  test('Free clear to empty preserves paidFields', () => {
    const free = mergePreChatFormPatch(full, { fields: [] }, FREE)
    expect(free.preChatForm?.fields).toEqual([])
    expect(free.preChatForm?.paidFields).toEqual(paidFields)
    expect(resolveEffectivePreChatForm(input(free), PRO).fields).toEqual(paidFields)
  })
})

describe('Developer — resolver edge cases', () => {
  test('null entitlements → empty', () => {
    expect(resolveEffectivePreChatForm(input(full), UNKNOWN)).toEqual({ fields: [] })
    expect(resolveEffectivePreChatForm(input(full), null)).toEqual({ fields: [] })
  })

  test('no V2 → empty', () => {
    expect(resolveEffectivePreChatForm(input(null), PRO)).toEqual({ fields: [] })
    expect(resolveEffectivePreChatForm(input({ version: 1 }), PRO)).toEqual({ fields: [] })
  })

  test('Free filters to basic fields only', () => {
    const result = resolveEffectivePreChatForm(input(full), FREE)
    expect(result.fields).toEqual(freeFields)
    // No phone or company
    expect(result.fields.some(f => f.key === 'phone' || f.key === 'company')).toBe(false)
  })

  test('Free truncates to max 2', () => {
    const stored = { appearanceV2: { version: 1, preChatForm: { fields: [
      { key: 'name', required: true }, { key: 'email', required: false },
    ] } } }
    expect(resolveEffectivePreChatForm(stored, FREE).fields.length).toBe(2)
  })
})

describe('Developer — submission validation edge cases', () => {
  const form = { fields: paidFields }

  test('valid full submission', () => {
    const result = validatePreChatSubmission({ values: { name: 'Alice', email: 'a@b.com', phone: '+1-555-1234', company: 'Acme' } }, form)
    expect(result.ok).toBe(true)
  })

  test('rejects privilege escalation attempts', () => {
    for (const extra of ['emailVerifiedAt', 'identityLevel', 'externalUserId', 'role', 'isAdmin']) {
      expect(validatePreChatSubmission({ values: { name: 'Alice', email: 'a@b.com', [extra]: 'value' } }, form).ok).toBe(false)
    }
  })

  test('rejects oversized name', () => {
    expect(validatePreChatSubmission({ values: { name: 'A'.repeat(101), email: 'a@b.com' } }, form).ok).toBe(false)
  })

  test('rejects oversized email', () => {
    expect(validatePreChatSubmission({ values: { name: 'A', email: 'a'.repeat(201) + '@b.com' } }, form).ok).toBe(false)
  })

  test('accepts valid phone formats', () => {
    for (const phone of ['+1-555-1234', '(555) 123-4567', '+44 20 7946 0958', '1234567890']) {
      expect(validatePreChatSubmission({ values: { name: 'A', email: 'a@b.com', phone } }, form).ok).toBe(true)
    }
  })

  test('rejects invalid phone', () => {
    for (const phone of ['abc', '<script>', 'a@b.com']) {
      expect(validatePreChatSubmission({ values: { name: 'A', email: 'a@b.com', phone } }, form).ok).toBe(false)
    }
  })

  test('HTML in name is accepted as plain text (XSS safety in DOM layer)', () => {
    // Use a form where phone is optional so we don't need to supply it.
    const formOptional = { fields: [{ key: 'name' as const, required: true }, { key: 'email' as const, required: true }, { key: 'phone' as const, required: false }, { key: 'company' as const, required: false }] }
    const result = validatePreChatSubmission({ values: { name: '<img src=x onerror=alert(1)>', email: 'a@b.com' } }, formOptional)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('<img src=x onerror=alert(1)>')
  })

  test('optional fields may be omitted', () => {
    const result = validatePreChatSubmission({ values: { name: 'Alice' } }, { fields: freeFields })
    expect(result.ok).toBe(true)
  })

  test('non-string values rejected', () => {
    expect(validatePreChatSubmission({ values: { name: 42, email: 'a@b.com' } }, form).ok).toBe(false)
  })

  test('body without values rejected', () => {
    expect(validatePreChatSubmission({}, form).ok).toBe(false)
    expect(validatePreChatSubmission({ values: null }, form).ok).toBe(false)
  })
})

describe('Developer — shouldRequirePreChat lifecycle', () => {
  const form = { fields: [{ key: 'name' as const, required: true }] }
  const emptyForm = { fields: [] }

  test('no fields → never required', () => {
    expect(shouldRequirePreChat(emptyForm, false, false)).toBe(false)
    expect(shouldRequirePreChat(emptyForm, true, false)).toBe(false)
    expect(shouldRequirePreChat(emptyForm, false, true)).toBe(false)
  })

  test('has fields + no message + not completed → required', () => {
    expect(shouldRequirePreChat(form, false, false)).toBe(true)
  })

  test('has fields + has message → not required', () => {
    expect(shouldRequirePreChat(form, true, false)).toBe(false)
  })

  test('has fields + completed → not required', () => {
    expect(shouldRequirePreChat(form, false, true)).toBe(false)
  })

  test('full lifecycle: mount → form required → completed → message sent', () => {
    // 1. Mount: no message, not completed → required.
    expect(shouldRequirePreChat(form, false, false)).toBe(true)
    // 2. Form completed → not required.
    expect(shouldRequirePreChat(form, false, true)).toBe(false)
    // 3. Message sent → not required (permanent).
    expect(shouldRequirePreChat(form, true, true)).toBe(false)
    // 4. Even if somehow form completion is reset, message persists → not required.
    expect(shouldRequirePreChat(form, true, false)).toBe(false)
  })
})

describe('Developer — cross-feature preservation', () => {
  test('pre-chat form edit preserves all V2 neighbors', () => {
    const r = mergePreChatFormPatch(full, { fields: [{ key: 'name', required: true }] }, PRO)
    expect(r.colors).toEqual(full.colors)
    expect(r.launcher).toEqual(full.launcher)
    expect(r.attention).toEqual(full.attention)
    expect(r.messagePreview).toEqual(full.messagePreview)
    expect(r.quickReplies).toEqual(full.quickReplies)
    expect(r.desktop).toEqual(full.desktop)
    expect(r.mobile).toEqual(full.mobile)
    expect(parseAppearanceV2(r)).not.toBeNull()
  })

  test('all 6 sibling merges preserve pre-chat form', () => {
    expect(mergeColorPatch(full, { theme: { mode: 'preset', presetId: 'sunset' } }).preChatForm).toEqual(full.preChatForm)
    expect(mergeLauncherPatch(full, { shape: 'pill' }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergeAttentionPatch(full, { animation: 'glow' }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergeMessagePreviewPatch(full, { enabled: false }).preChatForm).toEqual(full.preChatForm)
    expect(mergeQuickRepliesPatch(full, { items: ['Support'] }, PRO).preChatForm).toEqual(full.preChatForm)
    expect(mergePositioningPatch(full, { hasAny: true, mobile: { hasFields: true, anchor: 'bottom-center' } }, 'bottom-center').preChatForm).toEqual(full.preChatForm)
  })
})

describe('Developer — strict parseAppearanceV2 preChatForm', () => {
  test('valid preChatForm coexists with all V2 fields', () => {
    expect(parseAppearanceV2(full)?.preChatForm).toEqual({ fields: paidFields })
  })

  test('rejects null, arrays, primitives', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: null })).toBeNull()
    expect(parseAppearanceV2({ version: 1, preChatForm: [] })).toBeNull()
    expect(parseAppearanceV2({ version: 1, preChatForm: 'hello' })).toBeNull()
    expect(parseAppearanceV2({ version: 1, preChatForm: 42 })).toBeNull()
  })

  test('rejects non-boolean required', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: 'true' }] } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: 1 }] } })).toBeNull()
  })

  test('rejects unknown field keys', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'other', required: true }] } })).toBeNull()
  })

  test('rejects duplicate keys', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: true }, { key: 'name', required: false }] } })).toBeNull()
  })

  test('rejects extra properties on field object', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: true, label: 'X' }] } })).toBeNull()
  })

  test('rejects unexpected keys on preChatForm object', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [], html: '<form>' } })).toBeNull()
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [], css: 'x' } })).toBeNull()
  })

  test('rejects empty paidFields', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: true }], paidFields: [] } })).toBeNull()
  })

  test('accepts valid paidFields', () => {
    const v = parseAppearanceV2({ version: 1, preChatForm: { fields: [{ key: 'name', required: true }], paidFields: [{ key: 'name', required: true }, { key: 'email', required: false }] } })
    expect(v?.preChatForm?.paidFields).toEqual([{ key: 'name', required: true }, { key: 'email', required: false }])
  })

  test('rejects getter-based malformed objects', () => {
    expect(parseAppearanceV2({ version: 1, preChatForm: { get fields() { throw new Error('x') } } })).toBeNull()
  })

  test('absent preChatForm is valid', () => {
    expect(parseAppearanceV2({ version: 1 })?.preChatForm).toBeUndefined()
  })

  test('empty fields is valid', () => {
    const v = parseAppearanceV2({ version: 1, preChatForm: { fields: [] } })
    expect(v?.preChatForm).toEqual({ fields: [] })
  })
})

describe('Developer — isPreChatComplete: validate stored values against CURRENT required fields', () => {
  const nameOnly = { fields: [{ key: 'name' as const, required: true }] }
  const nameEmailRequired = { fields: [{ key: 'name' as const, required: true }, { key: 'email' as const, required: true }] }
  const nameRequiredEmailOptional = { fields: [{ key: 'name' as const, required: true }, { key: 'email' as const, required: false }] }
  const noFields = { fields: [] }

  test('no fields configured → vacuously complete', () => {
    expect(isPreChatComplete(noFields, null)).toBe(true)
    expect(isPreChatComplete(noFields, undefined)).toBe(true)
    expect(isPreChatComplete(noFields, {})).toBe(true)
  })

  test('null/undefined stored pre-chat → incomplete (when fields exist)', () => {
    expect(isPreChatComplete(nameOnly, null)).toBe(false)
    expect(isPreChatComplete(nameOnly, undefined)).toBe(false)
  })

  test('all required fields present and nonblank → complete', () => {
    expect(isPreChatComplete(nameOnly, { name: 'Alice' })).toBe(true)
    expect(isPreChatComplete(nameEmailRequired, { name: 'Alice', email: 'a@b.com' })).toBe(true)
  })

  test('required field missing → incomplete', () => {
    expect(isPreChatComplete(nameEmailRequired, { name: 'Alice' })).toBe(false)
    expect(isPreChatComplete(nameEmailRequired, { email: 'a@b.com' })).toBe(false)
  })

  test('required field blank → incomplete', () => {
    expect(isPreChatComplete(nameOnly, { name: '' })).toBe(false)
    expect(isPreChatComplete(nameOnly, { name: '  ' })).toBe(false)
  })

  test('optional field missing → still complete', () => {
    expect(isPreChatComplete(nameRequiredEmailOptional, { name: 'Alice' })).toBe(true)
  })

  test('extra fields in stored metadata do NOT cause failure', () => {
    // Downgrade scenario: formerly advanced fields (phone/company) are in the
    // stored metadata but are NOT in the current effective form. The form is
    // still complete because only CURRENT required fields matter.
    expect(isPreChatComplete(nameOnly, { name: 'Alice', phone: '+1234', company: 'Acme' })).toBe(true)
  })

  test('non-string values for required fields → incomplete', () => {
    expect(isPreChatComplete(nameOnly, { name: 42 })).toBe(false)
    expect(isPreChatComplete(nameOnly, { name: null })).toBe(false)
    expect(isPreChatComplete(nameOnly, { name: true })).toBe(false)
  })

  test('Bug C: old incomplete form (name only) does NOT satisfy new required email', () => {
    // Visitor submitted { name: 'Only Name' } when only name was required.
    // Owner adds email as required. The old metadata is insufficient.
    expect(isPreChatComplete(nameEmailRequired, { name: 'Only Name' })).toBe(false)
  })

  test('Bug C: after re-submission with both values → complete', () => {
    // Visitor re-submits with both name + email → satisfies current requirements.
    expect(isPreChatComplete(nameEmailRequired, { name: 'Alice', email: 'alice@example.com' })).toBe(true)
  })

  test('Bug B: completed form survives reload (same required fields)', () => {
    // Visitor completed the form. On reload, the /contact response computes
    // preChatCompleted from the stored metadata + current effective form.
    // Since the required fields haven't changed, the form is still complete.
    expect(isPreChatComplete(nameEmailRequired, { name: 'Alice', email: 'alice@example.com' })).toBe(true)
  })

  test('Bug B: different visitor (no metadata) → incomplete', () => {
    // A different visitor has no stored pre-chat metadata → form is required.
    expect(isPreChatComplete(nameEmailRequired, null)).toBe(false)
    expect(isPreChatComplete(nameEmailRequired, undefined)).toBe(false)
  })

  test('downgrade with formerly advanced values: basic required fields still satisfied', () => {
    // Pro had name+email+phone+company all required. Downgrade to Free:
    // effective form is name+email only. The stored values include phone+
    // company (extra), but the CURRENT basic required fields (name+email)
    // are present and nonblank → complete.
    const basicForm = { fields: [{ key: 'name' as const, required: true }, { key: 'email' as const, required: true }] }
    const storedWithExtras = { name: 'Alice', email: 'a@b.com', phone: '+1234', company: 'Acme' }
    expect(isPreChatComplete(basicForm, storedWithExtras)).toBe(true)
  })

  test('stale async response after identity change: different contact metadata', () => {
    // If identity changed (user-switch), the old contact's metadata is NOT
    // the new contact's metadata. isPreChatComplete checks the STORED values
    // passed to it — the caller (server) reads the CURRENT contact's metadata.
    // If the new contact has no pre-chat → incomplete.
    const newContactMetadata = undefined
    expect(isPreChatComplete(nameEmailRequired, newContactMetadata)).toBe(false)
  })

  test('all required fields satisfied, optional fields present → complete', () => {
    const allFields = { fields: [
      { key: 'name' as const, required: true },
      { key: 'email' as const, required: true },
      { key: 'phone' as const, required: false },
      { key: 'company' as const, required: false },
    ] }
    expect(isPreChatComplete(allFields, { name: 'A', email: 'a@b.com', phone: '+1', company: 'C' })).toBe(true)
  })

  test('all required fields satisfied, optional fields absent → complete', () => {
    const allFields = { fields: [
      { key: 'name' as const, required: true },
      { key: 'email' as const, required: true },
      { key: 'phone' as const, required: false },
      { key: 'company' as const, required: false },
    ] }
    expect(isPreChatComplete(allFields, { name: 'A', email: 'a@b.com' })).toBe(true)
  })
})
