/// <reference types="bun-types" />
/**
 * Real-PostgreSQL boundary tests for the routing engine's BUSINESS-HOURS
 * condition (`src/lib/routing-engine.ts` + `src/lib/routing-hours.ts`).
 *
 * Executed against Docker PostgreSQL in the `docker-regression` CI job
 * (Full + Lite) via the existing `bun test tests/db-boundary/` step.
 *
 * WHY THIS FILE EXISTS (PR #13 stability audit):
 *   Business Hours is already exposed in the Routing Rules UI, so it cannot
 *   remain a deferred test gap. These tests prove the engine ACTUALLY
 *   EXECUTES the configured action deterministically — NOT via wall-clock
 *   luck. The engine accepts an optional `getHour` provider (default
 *   `new Date().getHours()`); these tests inject a fixed hour.
 *
 * DETERMINISM BARRIER:
 *   The hour is injected via the `getHour` argument — NO `waitFor`/sleeps,
 *   NO reliance on the server's wall-clock. Every assertion is against a
 *   fixed hour relative to a configured [start, end) window.
 *
 * CONTRACT under test (documented in `src/lib/routing-hours.ts`):
 *   - businessHours matches when  start <= hour < end
 *   - start INCLUSIVE, end EXCLUSIVE
 *
 * COVERAGE:
 *   1. assign_department INSIDE configured hours  → department lands on the conversation
 *   2. assign_department OUTSIDE (before start)   → no action
 *   3. boundary: hour === start (inclusive)       → action executes
 *   4. boundary: hour === end (exclusive)         → action does NOT execute
 *   5. send_message INSIDE configured hours       → system Message row created with the rule text
 *   6. send_message OUTSIDE                       → no system Message created
 *   7. tenant isolation: tenant B has NO rules     → engine does nothing for a B conversation
 *   8. tenant isolation at execution: a B rule referencing A's departmentId → revalidation rejects (fail-closed) → no cross-tenant assignment
 *   9. invalid businessHours rejected upstream    → `validateRuleTrigger` returns invalid_business_hours (so the rule can never be created via the API; the engine never sees an invalid window)
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import { evaluateRoutingRules } from '@/lib/routing-engine'
import { validateRuleTrigger } from '@/lib/routing-rules-validation'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let aDeptId: string
let aContactId: string
let bContactId: string

beforeAll(async () => {
  tenantA = await globalDb.tenant.create({
    data: {
      slug: `dbb-bh-a-${RUN_ID}`,
      name: `DB Boundary BH A ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })
  tenantB = await globalDb.tenant.create({
    data: {
      slug: `dbb-bh-b-${RUN_ID}`,
      name: `DB Boundary BH B ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })

  const aDept = await globalDb.department.create({
    data: { tenantId: tenantA.id, name: `Dept A ${RUN_ID}` },
    select: { id: true },
  })
  aDeptId = aDept.id

  // A contact in each tenant — conversations require a contactId.
  const aContact = await globalDb.contact.create({
    data: {
      tenantId: tenantA.id,
      identifier: `visitor-a-${RUN_ID}`,
      identifierType: 'visitorId',
      name: 'Visitor A',
      metadata: {},
    },
    select: { id: true },
  })
  aContactId = aContact.id
  const bContact = await globalDb.contact.create({
    data: {
      tenantId: tenantB.id,
      identifier: `visitor-b-${RUN_ID}`,
      identifierType: 'visitorId',
      name: 'Visitor B',
      metadata: {},
    },
    select: { id: true },
  })
  bContactId = bContact.id
})

afterAll(async () => {
  // Cascade deletes departments, contacts, conversations, routing rules,
  // messages (via conversation cascade). Tenants are the root.
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } })
})

/** Create a fresh open conversation in the given tenant (no routing triggered). */
async function freshConversation(tenantId: string, contactId: string, preview = 'hello') {
  return globalDb.conversation.create({
    data: { tenantId, contactId, status: 'open', lastMessagePreview: preview, tags: [] },
    select: { id: true, departmentId: true },
  })
}

/** Read a conversation's departmentId via the global (unscoped) client. */
async function deptOf(convId: string) {
  const c = await globalDb.conversation.findUnique({
    where: { id: convId },
    select: { departmentId: true },
  })
  return c?.departmentId ?? null
}

describe('business-hours routing — assign_department execution', () => {
  test('INSIDE configured hours → department lands on the conversation', async () => {
    // Rule: businessHours 9–17, action assign_department → A's department.
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-assign-inside-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    // hour=10 → inside [9, 17)
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 10)

    expect(await deptOf(conv.id)).toBe(aDeptId)

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })

  test('OUTSIDE (before start) → no action', async () => {
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-assign-outside-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    // hour=8 → before start (8 < 9) → NOT within → no match
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 8)

    expect(await deptOf(conv.id)).toBeNull()

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })

  test('boundary: hour === start (9) → INCLUSIVE → action executes', async () => {
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-assign-bstart-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 9)

    expect(await deptOf(conv.id)).toBe(aDeptId)

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })

  test('boundary: hour === end (17) → EXCLUSIVE → action does NOT execute', async () => {
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-assign-bend-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 17)

    expect(await deptOf(conv.id)).toBeNull()

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })
})

describe('business-hours routing — send_message execution', () => {
  const RULE_TEXT = 'Auto: business-hours routing test message'

  test('INSIDE configured hours → system Message created with the rule text', async () => {
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-send-inside-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'send_message', text: RULE_TEXT },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 12)

    const sysMsg = await globalDb.message.findFirst({
      where: { conversationId: conv.id, senderType: 'system' },
    })
    expect(sysMsg).not.toBeNull()
    expect((sysMsg!.content as any)?.text).toBe(RULE_TEXT)

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })

  test('OUTSIDE configured hours → no system Message created', async () => {
    const rule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-send-outside-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'send_message', text: RULE_TEXT },
      },
      select: { id: true },
    })

    const conv = await freshConversation(tenantA.id, aContactId)
    await evaluateRoutingRules(conv.id, tenantA.id, 'help', () => 3)

    const sysMsg = await globalDb.message.findFirst({
      where: { conversationId: conv.id, senderType: 'system' },
    })
    expect(sysMsg).toBeNull()

    await globalDb.routingRule.delete({ where: { id: rule.id } })
    await globalDb.conversation.deleteMany({ where: { id: conv.id } })
  })
})

describe('business-hours routing — tenant isolation', () => {
  test('tenant B (no rules) → engine does nothing for a B conversation', async () => {
    // A has a rule; B has none. The engine runs inside withTenant(B), so
    // db.routingRule.findMany auto-scopes to B → empty → early return.
    const aRule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantA.id,
        name: `bh-iso-a-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId },
      },
      select: { id: true },
    })

    const convB = await freshConversation(tenantB.id, bContactId)
    // hour=10 is inside A's window, but the rule belongs to A — B has no rules.
    await evaluateRoutingRules(convB.id, tenantB.id, 'help', () => 10)

    expect(await deptOf(convB.id)).toBeNull()

    await globalDb.routingRule.delete({ where: { id: aRule.id } })
    await globalDb.conversation.deleteMany({ where: { id: convB.id } })
  })

  test('B rule referencing A departmentId → execution-time revalidation rejects (fail-closed)', async () => {
    // A misconfigured B rule that points at A's department. The engine's
    // executeAction does db.department.findUnique({where:{id:aDeptId}}) inside
    // withTenant(B) → the fail-closed extension injects tenantId=B → A's
    // department is invisible → null → skip → no cross-tenant assignment.
    const bRule = await globalDb.routingRule.create({
      data: {
        tenantId: tenantB.id,
        name: `bh-iso-b-${RUN_ID}`,
        enabled: true,
        priority: 1,
        trigger: { event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } },
        action: { type: 'assign_department', departmentId: aDeptId }, // A's dept!
      },
      select: { id: true },
    })

    const convB = await freshConversation(tenantB.id, bContactId)
    await evaluateRoutingRules(convB.id, tenantB.id, 'help', () => 10)

    // The rule matched (businessHours), but assign_department revalidated the
    // department against tenant B and found nothing → conversation stays
    // unassigned. Cross-tenant assignment is impossible.
    expect(await deptOf(convB.id)).toBeNull()

    await globalDb.routingRule.delete({ where: { id: bRule.id } })
    await globalDb.conversation.deleteMany({ where: { id: convB.id } })
  })
})

describe('business-hours routing — invalid windows rejected upstream', () => {
  // The engine never sees an invalid businessHours window because
  // `validateRuleTrigger` (called by POST + PATCH /api/routing-rules before
  // any db.routingRule.create/updateMany) rejects them. These tests pin that
  // contract so an invalid window can NEVER reach the engine.
  test('non-integer start → invalid_business_hours', () => {
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 9.5, end: 17 } } }).ok,
    ).toBe(false)
  })

  test('start out of [0,23] → invalid_business_hours', () => {
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 24, end: 17 } } }).ok,
    ).toBe(false)
  })

  test('missing end → invalid_business_hours', () => {
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 9 } } }).ok,
    ).toBe(false)
  })

  test('businessHours as array → invalid_business_hours', () => {
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: [9, 17] } }).ok,
    ).toBe(false)
  })

  test('valid same-day businessHours windows accepted', () => {
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 9, end: 17 } } }).ok,
    ).toBe(true)
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 0, end: 1 } } }).ok,
    ).toBe(true)
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 22, end: 23 } } }).ok,
    ).toBe(true)
  })

  test('overnight/zero-width/inverted windows rejected (start must be < end)', () => {
    // Business Hours v1 supports same-day non-empty intervals only.
    // The engine contract is hour >= start && hour < end, so these match
    // NOTHING → persisting them would be a no-op (stabilization violation).
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 22, end: 6 } } }).ok,
      'overnight 22->6 rejected',
    ).toBe(false)
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 5, end: 5 } } }).ok,
      'zero-width 5->5 rejected',
    ).toBe(false)
    expect(
      validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 17, end: 9 } } }).ok,
      'inverted 17->9 rejected',
    ).toBe(false)
    // The error code must be invalid_business_hours (not a different error).
    const r = validateRuleTrigger({ event: 'conversation_created', conditions: { businessHours: { start: 22, end: 6 } } })
    if (r.ok === false) expect(r.error).toBe('invalid_business_hours')
  })
})
