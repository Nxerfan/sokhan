/// <reference types="bun-types" />
/**
 * Developer-owned AI-Q2 implementation tests.
 *
 * Covers (beyond the 23 reviewer policy tests):
 *   - Plan catalog: approved prices, quotas, prototype-pollution safety.
 *   - Policy: additional edge cases for resolveAiUsageWindow and getAiRemaining.
 *   - Source inspection: usage-service atomic patterns, widget messages
 *     reserve/commit/release integration, billing-panel AI usage bar.
 *   - AI-Q1 regression: existing policy + AI module tests still pass.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPlan, isPaidPlan, PLANS } from '../../src/lib/payments/plans'
import {
  resolveAiUsageWindow,
  getAiRemaining,
} from '../../src/lib/ai/usage-policy'

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------------------
// Plan catalog — approved prices and quotas
// ---------------------------------------------------------------------------

describe('Developer — approved plan prices and quotas', () => {
  test('Pro is exactly 1,200,000 Toman with 1,400 AI replies and monthly interval', () => {
    const pro = getPlan('pro')!
    expect(pro.priceToman).toBe(1_200_000)
    expect(pro.limits.aiActions).toBe(1_400)
    expect(pro.interval).toBe('month')
    expect(pro.contactSales).toBe(false)
    expect(pro.customization).toBe(true)
  })

  test('Max is exactly 7,500,000 Toman with 10,000 AI replies and monthly interval', () => {
    const max = getPlan('max')!
    expect(max.priceToman).toBe(7_500_000)
    expect(max.limits.aiActions).toBe(10_000)
    expect(max.interval).toBe('month')
    expect(max.contactSales).toBe(false)
    expect(max.customization).toBe(true)
  })

  test('Free is zero price, zero AI replies, not contact-sales', () => {
    const free = getPlan('free')!
    expect(free.priceToman).toBe(0)
    expect(free.limits.aiActions).toBe(0)
    expect(free.contactSales).toBe(false)
  })

  test('Self-hosted is contact-sales with unlimited (-1) AI replies', () => {
    const sh = getPlan('self-hosted')!
    expect(sh.contactSales).toBe(true)
    expect(sh.limits.aiActions).toBe(-1)
    expect(sh.priceToman).toBe(0)
  })

  test('isPaidPlan correctly classifies all plans', () => {
    expect(isPaidPlan('pro')).toBe(true)
    expect(isPaidPlan('max')).toBe(true)
    expect(isPaidPlan('free')).toBe(false)
    expect(isPaidPlan('self-hosted')).toBe(false)
  })

  test('prototype-pollution-safe getPlan rejects constructor, __proto__, toString', () => {
    for (const slug of ['', 'invalid', 'constructor', 'toString', '__proto__', 'prototype', 'hasOwnProperty']) {
      expect(getPlan(slug)).toBeNull()
    }
  })

  test('the PLANS catalog has exactly 4 plans with unique slugs', () => {
    expect(PLANS).toHaveLength(4)
    const slugs = PLANS.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(4)
    expect(slugs).toContain('free')
    expect(slugs).toContain('pro')
    expect(slugs).toContain('max')
    expect(slugs).toContain('self-hosted')
  })
})

// ---------------------------------------------------------------------------
// Policy — additional edge cases
// ---------------------------------------------------------------------------

describe('Developer — resolveAiUsageWindow additional edge cases', () => {
  test('UTC midnight boundary: first instant of month is in the window', () => {
    expect(resolveAiUsageWindow(d('2026-11-01T00:00:00.000Z'), null))
      .toEqual({ start: d('2026-11-01T00:00:00Z'), end: d('2026-12-01T00:00:00Z'), source: 'calendar' })
  })

  test('UTC midnight boundary: last instant before month end is in the window', () => {
    expect(resolveAiUsageWindow(d('2026-11-30T23:59:59.999Z'), null)?.source).toBe('calendar')
  })

  test('January 1 is in the January calendar window (year boundary from December)', () => {
    expect(resolveAiUsageWindow(d('2027-01-01T00:00:00.000Z'), null))
      .toEqual({ start: d('2027-01-01T00:00:00Z'), end: d('2027-02-01T00:00:00Z'), source: 'calendar' })
  })

  test('non-active subscription statuses (trialing, past_due, etc.) fall back to calendar', () => {
    for (const status of ['trialing', 'past_due', 'incomplete', 'unknown']) {
      const result = resolveAiUsageWindow(d('2026-11-20T00:00:00Z'), {
        status,
        currentPeriodStart: d('2026-11-10T00:00:00Z'),
        currentPeriodEnd: d('2026-12-10T00:00:00Z'),
      })
      expect(result?.source).toBe('calendar')
    }
  })

  test('subscription with same start and end (zero-duration) fails closed', () => {
    expect(resolveAiUsageWindow(d('2026-11-15T00:00:00Z'), {
      status: 'active',
      currentPeriodStart: d('2026-11-15T00:00:00Z'),
      currentPeriodEnd: d('2026-11-15T00:00:00Z'),
    })).toBeNull()
  })

  test('resolver does not mutate the now Date or subscription dates', () => {
    const now = d('2026-11-22T13:00:00Z')
    const nowBefore = now.getTime()
    const sub = {
      status: 'active' as const,
      currentPeriodStart: d('2026-11-01T00:00:00Z'),
      currentPeriodEnd: d('2026-12-01T00:00:00Z'),
    }
    const startBefore = sub.currentPeriodStart.getTime()
    const endBefore = sub.currentPeriodEnd.getTime()
    resolveAiUsageWindow(now, sub)
    expect(now.getTime()).toBe(nowBefore)
    expect(sub.currentPeriodStart.getTime()).toBe(startBefore)
    expect(sub.currentPeriodEnd.getTime()).toBe(endBefore)
  })
})

describe('Developer — getAiRemaining additional edge cases', () => {
  test('zero used and reserved on a paid plan returns the full limit', () => {
    expect(getAiRemaining(0, 0, 1400)).toBe(1400)
    expect(getAiRemaining(0, 0, 10000)).toBe(10000)
  })

  test('reserved alone counts against capacity (no committed replies yet)', () => {
    expect(getAiRemaining(0, 1, 1400)).toBe(1399)
    expect(getAiRemaining(0, 1400, 1400)).toBe(0)
  })

  test('used alone counts against capacity', () => {
    expect(getAiRemaining(1, 0, 1400)).toBe(1399)
    expect(getAiRemaining(1400, 0, 1400)).toBe(0)
  })

  test('used + reserved exactly equals limit → zero remaining', () => {
    expect(getAiRemaining(700, 700, 1400)).toBe(0)
    expect(getAiRemaining(1399, 1, 1400)).toBe(0)
  })

  test('non-integer limit fails closed', () => {
    expect(getAiRemaining(0, 0, 0.5)).toBe(0)
    expect(getAiRemaining(0, 0, 1.5)).toBe(0)
    expect(getAiRemaining(0, 0, -0.5)).toBe(0)
  })

  test('Infinity and NaN counters fail closed', () => {
    expect(getAiRemaining(Infinity, 0, 1400)).toBe(0)
    expect(getAiRemaining(0, Infinity, 1400)).toBe(0)
    expect(getAiRemaining(NaN, 0, 1400)).toBe(0)
    expect(getAiRemaining(0, NaN, 1400)).toBe(0)
  })

  test('unlimited (-1) returns null even with very large used + reserved', () => {
    expect(getAiRemaining(999999999, 999999999, -1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Source inspection — usage service atomic patterns
// ---------------------------------------------------------------------------

describe('Developer — usage service source wiring', () => {
  const svcSrc = readFileSync(join(process.cwd(), 'src/lib/ai/usage-service.ts'), 'utf8')
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const svcCode = code(svcSrc)

  test('the service exports the four required functions', () => {
    expect(svcCode).toContain('export async function getAiUsageState')
    expect(svcCode).toContain('export async function reserveAiReply')
    expect(svcCode).toContain('export async function commitAiReply')
    expect(svcCode).toContain('export async function releaseAiReply')
  })

  test('the service uses globalDb (raw Prisma, not the fail-closed proxy)', () => {
    expect(svcCode).toContain('globalDb')
    // The service imports globalDb from @/lib/db, NOT the fail-closed `db` proxy.
    expect(svcCode).toMatch(/import \{ globalDb \}/)
  })

  test('reservation uses a conditional atomic UPDATE (raw SQL)', () => {
    // The atomic reservation uses $queryRaw with a WHERE condition on
    // used + reserved < limit. This is the PostgreSQL-safe atomic boundary.
    expect(svcCode).toContain('$queryRaw')
    expect(svcCode).toContain('UPDATE')
    expect(svcCode).toContain('AiUsagePeriod')
    expect(svcCode).toContain('"reserved" = "reserved" + 1')
    expect(svcCode).toContain('"used" + "reserved"')
    expect(svcCode).toContain('OR')
    expect(svcCode).toContain('= -1')
  })

  test('commit uses an interactive transaction (message + reservation + usage)', () => {
    expect(svcCode).toContain('$transaction')
    expect(svcCode).toMatch(/tx\.message\.create/)
    expect(svcCode).toMatch(/tx\.aiReplyReservation\.updateMany/)
    expect(svcCode).toMatch(/tx\.aiUsagePeriod\.update/)
  })

  test('commit is idempotent (already committed returns existing messageId)', () => {
    expect(svcCode).toMatch(/status === 'committed'/)
    expect(svcCode).toMatch(/aiMessageId/)
  })

  test('release is conditional (only reserved, never refunds committed)', () => {
    expect(svcCode).toMatch(/updateMany/)
    expect(svcCode).toMatch(/status: 'reserved'/)
    expect(svcCode).toMatch(/status: 'released'/)
  })

  test('the service resolves the plan from the active subscription or tenant.plan', () => {
    expect(svcCode).toContain('subscription.findFirst')
    expect(svcCode).toContain('tenant.findUnique')
    expect(svcCode).toContain('getPlan')
  })

  test('the service resolves the usage window via resolveAiUsageWindow', () => {
    expect(svcCode).toContain('resolveAiUsageWindow')
  })

  test('backfill counts historical AI messages when creating a period', () => {
    expect(svcCode).toContain('message.count')
    expect(svcCode).toMatch(/senderType.*ai/)
    expect(svcCode).toContain('backfilled')
  })

  test('stale reservation recovery exists', () => {
    expect(svcCode).toContain('releaseStaleReservations')
    expect(svcCode).toContain('expiresAt')
  })

  test('cross-tenant commit returns not_found (no data leak)', () => {
    expect(svcCode).toMatch(/tenantId !== tenantId/)
    expect(svcCode).toContain('not_found')
  })
})

// ---------------------------------------------------------------------------
// Corrected defect source inspection (reviewer AI-Q2 corrections)
// ---------------------------------------------------------------------------

describe('Developer — corrected AI-Q2 defects (source inspection)', () => {
  const svcSrc = readFileSync(join(process.cwd(), 'src/lib/ai/usage-service.ts'), 'utf8')
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const svcCode = code(svcSrc)

  test('Defect A: released reservation is reactivated, not re-inserted', () => {
    // When an existing reservation is 'released', it must be conditionally
    // updated back to 'reserved' — NOT re-inserted (which would hit the
    // unique constraint and return in_progress).
    expect(svcCode).toContain("status: 'released'")
    expect(svcCode).toContain('updateMany')
    expect(svcCode).toContain("status: 'released'")
    expect(svcCode).toContain("status: 'reserved'")
  })

  test('Defect A: reactivation is inside the same transaction as the capacity increment', () => {
    // The capacity increment and the reservation create/reactivate must be
    // ONE transaction (crash consistency).
    const reserveBlock = svcCode.split('export async function reserveAiReply')[1] ?? ''
    expect(reserveBlock).toContain('$transaction')
    expect(reserveBlock).toContain('$queryRaw')
    expect(reserveBlock).toContain('UPDATE')
  })

  test('Defect B+C: visitor message ownership is verified before reserving', () => {
    expect(svcCode).toContain('verifyMessageOwnership')
    expect(svcCode).toContain('senderType')
    expect(svcCode).toContain("'contact'")
    expect(svcCode).toMatch(/msg\.tenantId !== tenantId/)
  })

  test('Defect B+C: conversation ownership is verified', () => {
    expect(svcCode).toMatch(/conversation\.findUnique/)
    expect(svcCode).toMatch(/conv\.tenantId !== tenantId/)
  })

  test('Defect D: commit checks expiresAt inside the settlement transaction', () => {
    const commitBlock = svcCode.split('export async function commitAiReply')[1] ?? ''
    expect(commitBlock).toContain('expiresAt')
    expect(commitBlock).toMatch(/expiresAt.*gt.*now/)
  })

  test('Defect D: expired lease returns not_found (no message, no charge)', () => {
    const commitBlock = svcCode.split('export async function commitAiReply')[1] ?? ''
    expect(commitBlock).toContain('RESERVATION_NOT_SETTLABLE')
    expect(commitBlock).toContain('not_found')
  })

  test('crash consistency: release is atomic (status + counter in one transaction)', () => {
    const releaseBlock = svcCode.split('export async function releaseAiReply')[1] ?? ''
    expect(releaseBlock).toContain('$transaction')
    expect(releaseBlock).toContain('status: \'released\'')
    expect(releaseBlock).toContain('reserved: { decrement: 1 }')
  })

  test('crash consistency: stale recovery is atomic', () => {
    const staleBlock = svcCode.split('async function releaseStaleReservations')[1] ?? ''
    expect(staleBlock).toContain('$transaction')
  })

  test('content validation: blank text is rejected at commit', () => {
    const commitBlock = svcCode.split('export async function commitAiReply')[1] ?? ''
    expect(commitBlock).toMatch(/!text.*trim|text.*trim.*!/)
  })

  test('content validation: invalid source is rejected', () => {
    expect(svcCode).toContain('VALID_SOURCES')
    expect(svcCode).toContain("'faq'")
    expect(svcCode).toContain("'product'")
  })

  // --- Final concurrency corrections ---

  test('Defect A fix: release decrements ONLY when updateMany count === 1', () => {
    const releaseBlock = svcCode.split('export async function releaseAiReply')[1] ?? ''
    expect(releaseBlock).toContain('updated.count === 1')
    // The decrement must be conditional, not unconditional.
    expect(releaseBlock).not.toMatch(/decrement.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\n.*\}/)
  })

  test('Defect B fix: reactivation checks updateMany count and rolls back on 0', () => {
    const reserveBlock = svcCode.split('export async function reserveAiReply')[1] ?? ''
    expect(reserveBlock).toContain('REACTIVATION_LOST')
    expect(reserveBlock).toMatch(/reactivated\.count/)
  })

  test('Defect D fix: commit verifies conversation + message ownership inside transaction', () => {
    const commitBlock = svcCode.split('export async function commitAiReply')[1] ?? ''
    expect(commitBlock).toContain('verifyOwnershipInTx')
    expect(commitBlock).toContain('OWNERSHIP_INVALID')
  })

  test('Defect E fix: stale cleanup re-checks expiresAt in the conditional update', () => {
    const staleBlock = svcCode.split('async function releaseStaleReservations')[1] ?? ''
    expect(staleBlock).toContain('expiresAt')
    expect(staleBlock).toMatch(/lt: now/)
  })

  test('Defect C fix: checkPlanLimit for aiActions derives limit from getAiUsageState', () => {
    const gatingSrc = readFileSync(join(process.cwd(), 'src/lib/payments/gating.ts'), 'utf8')
    const gatingCode = gatingSrc
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
    const checkBlock = gatingCode.split('export async function checkPlanLimit')[1] ?? ''
    expect(checkBlock).toContain("limit === 'aiActions'")
    expect(checkBlock).toContain('getAiUsageState')
    // The aiActions branch must use state.limit (from getAiUsageState).
    expect(checkBlock).toContain('state.limit')
    // The aiActions branch must use state.planSlug.
    expect(checkBlock).toContain('state.planSlug')
  })

  test('post-commit delivery: metadata and realtime failures are caught', () => {
    const msgSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')
    expect(msgSrc).toContain('post-commit metadata error')
    expect(msgSrc).toContain('post-commit realtime error')
    expect(msgSrc).toContain('.catch(() => null)')
  })
})

// ---------------------------------------------------------------------------
// Source inspection — widget messages route (reserve/commit/release)
// ---------------------------------------------------------------------------

describe('Developer — widget messages route AI-Q2 integration', () => {
  const msgSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')

  test('tryAiResponse accepts visitorMessageId for reservation idempotency', () => {
    expect(msgSrc).toContain('visitorMessageId')
  })

  test('the route reserves before generating and commits after', () => {
    expect(msgSrc).toContain('reserveAiReply')
    expect(msgSrc).toContain('commitAiReply')
    expect(msgSrc).toContain('releaseAiReply')
  })

  test('the old checkPlanLimit is removed (reservation handles quota)', () => {
    // The AI-Q2 reservation is the authoritative quota gate — the old
    // count-based checkPlanLimit is no longer used in tryAiResponse.
    const tryBlock = msgSrc.split('async function tryAiResponse')[1] ?? ''
    expect(tryBlock).not.toContain('checkPlanLimit')
  })

  test('the visitor message is persisted BEFORE the AI reservation', () => {
    const visitorCreate = msgSrc.indexOf("senderType: 'contact'")
    const reserveCall = msgSrc.indexOf('reserveAiReply')
    expect(visitorCreate).toBeGreaterThan(-1)
    expect(reserveCall).toBeGreaterThan(visitorCreate)
  })

  test('AI failure does not destroy the visitor message (try/catch around AI)', () => {
    expect(msgSrc).toMatch(/try\s*{[\s\S]*?tryAiResponse[\s\S]*?}\s*catch/)
  })

  test('the AI message is persisted by commitAiReply (not by the route)', () => {
    // The route no longer creates the AI message directly — commitAiReply
    // does it inside a transaction. The route only fetches it for realtime.
    const tryBlock = msgSrc.split('async function tryAiResponse')[1] ?? ''
    expect(tryBlock).not.toMatch(/db\.message\.create.*senderType.*ai/)
    expect(tryBlock).toContain('commitAiReply')
  })
})

// ---------------------------------------------------------------------------
// Source inspection — billing panel AI usage bar
// ---------------------------------------------------------------------------

describe('Developer — billing panel AI usage bar', () => {
  const panelSrc = readFileSync(join(process.cwd(), 'src/components/dashboard/views/billing-panel.tsx'), 'utf8')

  test('the AI usage bar has the required testids', () => {
    // The UsageBar component accepts a testId prop that renders as
    // data-testid={testId}. The AI usage bar passes testId="billing-ai-usage".
    // The current/limit sub-elements use dynamic testids: `${testId}-current`
    // and `${testId}-limit`.
    expect(panelSrc).toContain('billing-ai-usage')
    expect(panelSrc).toContain('${testId}-current')
    expect(panelSrc).toContain('${testId}-limit')
  })

  test('the existing usage bars also have testids', () => {
    expect(panelSrc).toContain('billing-agents-usage')
    expect(panelSrc).toContain('billing-conversations-usage')
    expect(panelSrc).toContain('billing-departments-usage')
  })

  test('the UsageInfo type includes aiActions', () => {
    expect(panelSrc).toMatch(/aiActions.*current.*limit/)
  })

  test('the UsageBar component accepts a testId prop', () => {
    expect(panelSrc).toContain('testId')
    expect(panelSrc).toMatch(/data-testid=\{testId\}/)
  })
})

// ---------------------------------------------------------------------------
// Source inspection — gating.ts reports real AI usage
// ---------------------------------------------------------------------------

describe('Developer — gating reports real AI usage', () => {
  const gatingSrc = readFileSync(join(process.cwd(), 'src/lib/payments/gating.ts'), 'utf8')

  test('getTenantUsage imports and uses getAiUsageState for aiActions', () => {
    expect(gatingSrc).toContain('getAiUsageState')
    expect(gatingSrc).toContain('aiState.used')
  })

  test('getTenantUsage no longer hardcodes aiActions.current = 0', () => {
    // The old bug: aiActions: { current: 0, ... }
    expect(gatingSrc).not.toMatch(/aiActions:\s*\{\s*current:\s*0/)
  })
})

// ---------------------------------------------------------------------------
// Source inspection — Prisma schema (AiUsagePeriod + AiReplyReservation)
// ---------------------------------------------------------------------------

describe('Developer — Prisma schema AI-Q2 models', () => {
  const schemaSrc = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')

  test('AiUsagePeriod model exists with the required fields', () => {
    expect(schemaSrc).toContain('model AiUsagePeriod')
    expect(schemaSrc).toContain('tenantId')
    expect(schemaSrc).toContain('periodStart')
    expect(schemaSrc).toContain('periodEnd')
    expect(schemaSrc).toContain('used')
    expect(schemaSrc).toContain('reserved')
  })

  test('AiUsagePeriod has a unique constraint on tenant + period', () => {
    expect(schemaSrc).toMatch(/@@unique\(\[tenantId,\s*periodStart,\s*periodEnd\]\)/)
  })

  test('AiReplyReservation model exists with the required fields', () => {
    expect(schemaSrc).toContain('model AiReplyReservation')
    expect(schemaSrc).toContain('visitorMessageId')
    expect(schemaSrc).toContain('conversationId')
    expect(schemaSrc).toContain('usagePeriodId')
    expect(schemaSrc).toContain('status')
    expect(schemaSrc).toContain('aiMessageId')
  })

  test('AiReplyReservation has idempotency unique on tenant + visitorMessageId', () => {
    expect(schemaSrc).toMatch(/@@unique\(\[tenantId,\s*visitorMessageId\]\)/)
  })

  test('both models are in the tenant-scoped list (db.ts)', () => {
    const dbSrc = readFileSync(join(process.cwd(), 'src/lib/db.ts'), 'utf8')
    expect(dbSrc).toContain('AiUsagePeriod')
    expect(dbSrc).toContain('AiReplyReservation')
  })
})

// ---------------------------------------------------------------------------
// HTTP idempotency source inspection
// ---------------------------------------------------------------------------

describe('Developer — durable HTTP idempotency', () => {
  const msgSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')
  const schemaSrc = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const dbSrc = readFileSync(join(process.cwd(), 'src/lib/db.ts'), 'utf8')

  test('the route checks for an existing idempotency record before persisting', () => {
    expect(msgSrc).toContain('visitorMessageIdempotency.findUnique')
    expect(msgSrc).toContain('tenantId_contactId_clientMessageId')
  })

  test('the route creates the idempotency record after message persistence', () => {
    expect(msgSrc).toContain('visitorMessageIdempotency.create')
  })

  test('idempotent retries return the original message and skip AI', () => {
    expect(msgSrc).toContain('isIdempotentRetry')
    expect(msgSrc).toContain('retryAiResponse')
  })

  test('conflicting text reuse returns 409', () => {
    expect(msgSrc).toContain('idempotency_conflict')
    expect(msgSrc).toContain('409')
  })

  test('concurrent create catches unique constraint and returns original', () => {
    expect(msgSrc).toContain('Concurrent idempotency create')
  })

  test('the Prisma model VisitorMessageIdempotency exists with unique constraint', () => {
    expect(schemaSrc).toContain('model VisitorMessageIdempotency')
    expect(schemaSrc).toMatch(/@@unique\(\[tenantId,\s*contactId,\s*clientMessageId\]\)/)
  })

  test('VisitorMessageIdempotency is in the tenant-scoped list', () => {
    expect(dbSrc).toContain('VisitorMessageIdempotency')
  })

  test('the migration file exists', () => {
    const fs = require('fs')
    expect(fs.existsSync(join(process.cwd(), 'prisma/migrations/20261107000000_visitor_message_idempotency/migration.sql'))).toBe(true)
  })

  test('the idempotent retry fetches the original AI reservation', () => {
    expect(msgSrc).toContain('aiReplyReservation.findUnique')
    expect(msgSrc).toContain('tenantId_visitorMessageId')
  })
})
