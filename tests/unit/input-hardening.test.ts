/// <reference types="bun-types" />
/**
 * Input hardening tests — static source-grep verification.
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSrc(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf-8')
}

test('widget-domains: limit >= 0 check (not count >= limit)', () => {
  const source = readSrc('src/app/api/widget-domains/route.ts')
  expect(source).toContain("limit >= 0")
  expect(source).not.toMatch(/^.*if\s*\(\s*count\s*>=\s*limit\s*\)/m)
})

test('self-host-request: has dedicated 5/15min rate limit', () => {
  const source = readSrc('src/app/api/self-host-request/route.ts')
  expect(source).toContain('checkSelfHostRateLimit')
  expect(source).toContain('SELF_HOST_LIMIT')
  expect(source).toContain('5')
  expect(source).toContain('15')
})

test('self-host-request: rejects non-string body fields', () => {
  const source = readSrc('src/app/api/self-host-request/route.ts')
  expect(source).toContain('typeof body.name')
  expect(source).toContain('typeof body.company')
  expect(source).toContain('typeof body.email')
  expect(source).toContain('typeof body.phone')
})

test('products: validates name non-empty + bounded', () => {
  const source = readSrc('src/app/api/products/route.ts')
  expect(source).toContain("name.length > 500")
  expect(source).toContain("invalid_name")
})

test('products: validates price is finite integer >= 0', () => {
  const source = readSrc('src/app/api/products/route.ts')
  expect(source).toContain('Number.isFinite')
  expect(source).toContain('Number.isInteger')
  expect(source).toContain('price < 0')
})

test('products: validates availability enum', () => {
  const source = readSrc('src/app/api/products/route.ts')
  expect(source).toContain('in_stock')
  expect(source).toContain('out_of_stock')
  expect(source).toContain('limited')
})

test('faqs: validates question non-empty + bounded', () => {
  const source = readSrc('src/app/api/faqs/route.ts')
  expect(source).toContain("question.length > 1000")
  expect(source).toContain("invalid_question")
})

test('faqs: validates answer non-empty + bounded', () => {
  const source = readSrc('src/app/api/faqs/route.ts')
  expect(source).toContain("answer.length > 5000")
  expect(source).toContain("invalid_answer")
})

test('conversations POST: validates contactId belongs to tenant', () => {
  const source = readSrc('src/app/api/conversations/route.ts')
  expect(source).toContain('contact_not_found')
  expect(source).toContain('db.contact.findUnique')
})

test('conversations PATCH: validates assignedUserId has active Membership', () => {
  const source = readSrc('src/app/api/conversations/[id]/route.ts')
  expect(source).toContain('invalid_assignee')
  expect(source).toContain("status: 'active'")
})

test('conversations PATCH: validates departmentId belongs to tenant', () => {
  const source = readSrc('src/app/api/conversations/[id]/route.ts')
  expect(source).toContain('invalid_department')
  expect(source).toContain('db.department.findUnique')
})

test('conversations PATCH: whitelists mutable fields', () => {
  const source = readSrc('src/app/api/conversations/[id]/route.ts')
  expect(source).toContain('VALID_STATUSES')
  expect(source).toContain('VALID_PRIORITIES')
})

test('routing-engine: revalidates department at execution time', () => {
  const source = readSrc('src/lib/routing-engine.ts')
  expect(source).toContain('db.department.findUnique')
  expect(source).toContain('stale departmentId')
})

test('routing-engine: revalidates user membership at execution time', () => {
  const source = readSrc('src/lib/routing-engine.ts')
  expect(source).toContain('db.membership.findFirst')
  expect(source).toContain('stale userId')
})

test('routing-engine: wrapped in withTenant', () => {
  const source = readSrc('src/lib/routing-engine.ts')
  expect(source).toContain('withTenant')
})

test('woocommerce: uses safeFetch (SSRF guard)', () => {
  const source = readSrc('src/lib/connectors/woocommerce.ts')
  expect(source).toContain('safeFetch')
})

test('woocommerce: validates Link header URLs', () => {
  const source = readSrc('src/lib/connectors/woocommerce.ts')
  expect(source).toContain('assertPublicUrl(match[1])')
})

test('woocommerce: revalidates store URL on every sync', () => {
  const source = readSrc('src/lib/connectors/woocommerce.ts')
  expect(source).toContain('validateOutboundUrl(storeUrl)')
})

test('woocommerce: wrapped in withTenant', () => {
  const source = readSrc('src/lib/connectors/woocommerce.ts')
  expect(source).toContain('withTenant')
})

test('db.ts: has TenantContextRequiredError', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('TenantContextRequiredError')
})

test('db.ts: DepartmentMember NOT in TENANT_SCOPED_MODELS', () => {
  const source = readSrc('src/lib/db.ts')
  // DepartmentMember should NOT be listed (it has no tenantId column)
  // Check that DepartmentMember is NOT in the actual array (only in comments)
  const arrayStart = source.indexOf('const TENANT_SCOPED_MODELS = [')
  const arrayEnd = source.indexOf('] as const', arrayStart)
  const arrayContent = source.slice(arrayStart, arrayEnd)
  expect(arrayContent).not.toContain("'DepartmentMember'")
})

test('db.ts: covers createMany operation', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('createMany')
})

test('db.ts: covers upsert operation', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('upsert')
})

test('db.ts: covers updateMany operation', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('updateMany')
})

test('db.ts: covers deleteMany operation', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('deleteMany')
})

test('db.ts: covers aggregate + groupBy', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('aggregate')
  expect(source).toContain('groupBy')
})

test('db.ts: forces tenantId from context on create (override)', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('$allModels')
  expect(source).toContain('args.data = { ...args.data, tenantId: tid }')
})

test('db.ts: stamps every row on createMany', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('createMany')
  expect(source).toContain('map((row')
})

test('db.ts: tenant-scoped where on upsert + force on create', () => {
  const source = readSrc('src/lib/db.ts')
  expect(source).toContain('upsert')
  expect(source).toContain('args.create')
  expect(source).toContain('tenantId: tid')
})

test('verify-membership: wrapped in withTenant', () => {
  const source = readSrc('src/app/api/realtime/verify-membership/route.ts')
  expect(source).toContain('withTenant')
})

test('verify-conversation: wrapped in withTenant', () => {
  const source = readSrc('src/app/api/realtime/verify-conversation/route.ts')
  expect(source).toContain('withTenant')
})






