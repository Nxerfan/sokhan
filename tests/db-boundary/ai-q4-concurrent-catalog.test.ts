/// <reference types="bun-types" />
/**
 * Developer-owned AI-Q4 concurrent catalog modification tests.
 *
 * Real PostgreSQL tests that verify the REPEATABLE READ transaction
 * strategy provides a consistent point-in-time snapshot across
 * multi-batch catalog scans, even when products are modified,
 * inserted, or deleted concurrently.
 *
 * These tests use the real database (globalDb for setup, db for
 * tenant-scoped reads) — no mocks.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, globalDb } from '../../src/lib/db'

const TEST_TENANT = 'test-q4-concurrent-' + Date.now()
let tenantId = ''

beforeAll(async () => {
  const tenant = await globalDb.tenant.create({
    data: { slug: TEST_TENANT, name: TEST_TENANT, plan: 'pro', defaultLocale: 'fa', defaultDirection: 'rtl' },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await globalDb.product.deleteMany({ where: { tenantId } })
  await globalDb.tenant.delete({ where: { id: tenantId } })
})

async function addProduct(name: string, price: number, description = '') {
  return globalDb.product.create({
    data: { tenantId, name, description, price, currency: 'IRT', availability: 'in_stock', metadata: {} },
  })
}

describe('Developer — REPEATABLE READ snapshot consistency', () => {
  test('product price update during scan is invisible to the transaction', async () => {
    const product = await addProduct('لامپ تست اسنپشات', 100000)

    // Start a REPEATABLE READ transaction and read the product.
    const txResult = await db.$transaction(async (tx) => {
      // Read the product inside the transaction.
      const before = await tx.product.findUnique({ where: { id: product.id } })
      expect(before?.price).toBe(100000)

      // OUTSIDE the transaction (using globalDb), modify the product.
      await globalDb.product.update({
        where: { id: product.id },
        data: { price: 999999 },
      })

      // Read again INSIDE the transaction — should still see 100000
      // (REPEATABLE READ snapshot).
      const after = await tx.product.findUnique({ where: { id: product.id } })
      return { beforePrice: before?.price, afterPrice: after?.price }
    }, { isolationLevel: 'RepeatableRead' as const, timeout: 5000 })

    // The transaction saw the OLD price both times — consistent snapshot.
    expect(txResult.beforePrice).toBe(100000)
    expect(txResult.afterPrice).toBe(100000)

    // Clean up.
    await globalDb.product.delete({ where: { id: product.id } })
  })

  test('product deletion during scan is invisible to the transaction', async () => {
    const product = await addProduct('کیبورد حذف اسنپشات', 50000)

    const txResult = await db.$transaction(async (tx) => {
      // Read inside transaction — product exists.
      const before = await tx.product.findUnique({ where: { id: product.id } })
      expect(before).not.toBeNull()

      // Delete outside the transaction.
      await globalDb.product.delete({ where: { id: product.id } })

      // Read again inside transaction — should still exist (snapshot).
      const after = await tx.product.findUnique({ where: { id: product.id } })
      return { beforeExists: before !== null, afterExists: after !== null }
    }, { isolationLevel: 'RepeatableRead' as const, timeout: 5000 })

    expect(txResult.beforeExists).toBe(true)
    expect(txResult.afterExists).toBe(true)

    // Clean up (product was deleted outside the transaction).
  })

  test('product description change during scan is invisible to the transaction', async () => {
    const product = await addProduct('ماوس توضیح اسنپشات', 30000, 'توضیح اصلی')

    const txResult = await db.$transaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id: product.id } })
      expect(before?.description).toBe('توضیح اصلی')

      // Change description outside the transaction.
      await globalDb.product.update({
        where: { id: product.id },
        data: { description: 'توضیح تغییر یافته' },
      })

      const after = await tx.product.findUnique({ where: { id: product.id } })
      return { beforeDesc: before?.description, afterDesc: after?.description }
    }, { isolationLevel: 'RepeatableRead' as const, timeout: 5000 })

    // Both reads inside the transaction saw the original description.
    expect(txResult.beforeDesc).toBe('توضیح اصلی')
    expect(txResult.afterDesc).toBe('توضیح اصلی')

    await globalDb.product.delete({ where: { id: product.id } })
  })

  test('new product insertion during scan is invisible to the transaction', async () => {
    // Count products before the transaction.
    const countBefore = await globalDb.product.count({ where: { tenantId } })

    const txResult = await db.$transaction(async (tx) => {
      const beforeCount = await tx.product.count({ where: { tenantId } })

      // Insert a new product outside the transaction.
      await addProduct('محصول جدید اسنپشات', 75000)

      const afterCount = await tx.product.count({ where: { tenantId } })
      return { beforeCount, afterCount }
    }, { isolationLevel: 'RepeatableRead' as const, timeout: 5000 })

    // The transaction saw the SAME count both times.
    expect(txResult.beforeCount).toBe(txResult.afterCount)
    expect(txResult.beforeCount).toBe(countBefore)

    // Clean up the inserted product.
    await globalDb.product.deleteMany({ where: { tenantId, name: 'محصول جدید اسنپشات' } })
  })

  test('transaction timeout fails closed without producing an answer', async () => {
    // This test verifies that a transaction timeout is caught and
    // handled as a fail-closed scenario (no answer, no charge).
    // We simulate this by using a very short timeout (1ms).
    let caught = false
    try {
      await db.$transaction(async (tx) => {
        // Perform a slow operation that exceeds the 1ms timeout.
        await tx.product.findMany({ where: { tenantId }, take: 1 })
        // Sleep to ensure timeout.
        await new Promise((r) => setTimeout(r, 50))
        await tx.product.findMany({ where: { tenantId }, take: 1 })
      }, { isolationLevel: 'RepeatableRead' as const, timeout: 1 })
    } catch (e) {
      caught = true
    }
    expect(caught, 'Transaction timeout must be caught as an error').toBe(true)
  })
})
