import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  validateWooCommerceConfig,
  maskConsumerSecret,
  syncWooCommerceProducts,
  type WooCommerceConfig,
} from '@/lib/connectors/woocommerce'

/**
 * WooCommerce connector config + on-demand sync endpoint.
 *
 * GET    /api/connectors/woocommerce
 *   Returns the current WooCommerce connector config for the active tenant,
 *   with the consumer secret masked (last 4 chars only). 401 if unauthenticated,
 *   404 if no config saved yet.
 *
 * POST   /api/connectors/woocommerce
 *   Body: { storeUrl, consumerKey, consumerSecret, sync?: boolean }
 *   - Validates + upserts the ConnectorConfig row (one per tenant+type).
 *   - If `sync` is true (default), triggers a sync immediately and returns
 *     the result counts + errors. If false, just saves the config.
 *   - Requires admin role.
 */

const CONNECTOR_TYPE = 'woocommerce'

export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const row = await db.connectorConfig.findUnique({
      where: { tenantId_type: { tenantId: tid, type: CONNECTOR_TYPE } },
      select: { id: true, config: true, lastSyncAt: true, createdAt: true, updatedAt: true },
    })
    return row
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const row = result.result
  if (!row) {
    return NextResponse.json({ config: null, lastSyncAt: null })
  }

  const cfg = (row.config ?? {}) as Partial<WooCommerceConfig>
  return NextResponse.json({
    config: {
      storeUrl: cfg.storeUrl ?? '',
      consumerKey: cfg.consumerKey ?? '',
      consumerSecret: maskConsumerSecret(cfg.consumerSecret),
      secretMasked: true,
    },
    lastSyncAt: row.lastSyncAt,
    updatedAt: row.updatedAt,
  })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const tid = getCurrentTenantId()!

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return { error: 'invalid_body' as const }
    }

    const incoming: Partial<WooCommerceConfig> = {
      storeUrl: String(body.storeUrl ?? '').trim(),
      consumerKey: String(body.consumerKey ?? '').trim(),
      consumerSecret: String(body.consumerSecret ?? '').trim(),
    }

    // If the user sent a masked secret back (e.g. only updating storeUrl),
    // reject: we never want to persist a masked secret. The dashboard should
    // send the full secret on every save. (Future improvement: support a
    // "preserve existing secret" flag — but that requires a separate form
    // mode; for MVP we require the full secret each time.)
    if (incoming.consumerSecret && incoming.consumerSecret.includes('••••')) {
      return { error: 'secret_masked' as const }
    }

    const validationErrors = validateWooCommerceConfig(incoming)
    if (validationErrors.length > 0) {
      return { error: 'validation_failed' as const, details: validationErrors }
    }

    const config = incoming as WooCommerceConfig

    // Upsert by (tenantId, type). tenantId is passed explicitly per the
    // Module 2 convention; the Prisma extension would inject it on create,
    // but explicit is safer.
    const existing = await db.connectorConfig.findUnique({
      where: { tenantId_type: { tenantId: tid, type: CONNECTOR_TYPE } },
      select: { id: true },
    })

    let saved
    if (existing) {
      saved = await db.connectorConfig.update({
        where: { id: existing.id },
        data: { config: config as any },
        select: { id: true, updatedAt: true },
      })
    } else {
      saved = await db.connectorConfig.create({
        data: {
          tenantId: tid,
          type: CONNECTOR_TYPE,
          config: config as any,
        },
        select: { id: true, updatedAt: true },
      })
    }

    // If the caller asked to skip sync, return now.
    const wantSync = body.sync !== false
    if (!wantSync) {
      return { saved, synced: null as null }
    }

    // Run the sync inside the tenant context.
    const syncResult = await syncWooCommerceProducts(tid, config)

    // Stamp lastSyncAt (also stamped by runConnectorSync, but we called the
    // raw function here — so stamp explicitly).
    await db.connectorConfig.update({
      where: { id: saved.id },
      data: { lastSyncAt: new Date() },
    })

    return { saved, synced: syncResult } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('error' in result.result) {
    const r = result.result
    if (r.error === 'validation_failed') {
      return NextResponse.json({ error: r.error, details: r.details }, { status: 400 })
    }
    return NextResponse.json({ error: r.error }, { status: 400 })
  }

  const r = result.result
  return NextResponse.json({
    saved: r.saved,
    synced: r.synced,
  })
}
