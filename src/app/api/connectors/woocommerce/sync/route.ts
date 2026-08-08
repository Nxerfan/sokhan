import { NextResponse } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { runConnectorSync, isKnownConnector } from '@/lib/connectors'

/**
 * Trigger a WooCommerce product sync using the previously-saved config.
 *
 * POST /api/connectors/woocommerce/sync
 *   - Requires admin role.
 *   - Loads the saved ConnectorConfig row for type='woocommerce' and dispatches
 *     to the connector. Stamps lastSyncAt on completion (even on partial
 *     failure).
 *   - Returns { synced, created, updated, errors, lastSyncAt }.
 *
 * This endpoint is separate from POST /api/connectors/woocommerce (which saves
 * config + optionally syncs) so that a tenant can re-sync at any time without
 * re-submitting credentials.
 */

const CONNECTOR_TYPE = 'woocommerce'

export async function POST() {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const tid = getCurrentTenantId()!

    if (!isKnownConnector(CONNECTOR_TYPE)) {
      return { error: 'unknown_connector' as const }
    }

    const syncResult = await runConnectorSync(tid, CONNECTOR_TYPE)
    return { syncResult } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if ('error' in result.result) {
    return NextResponse.json({ error: result.result.error }, { status: 400 })
  }

  const r = result.result.syncResult
  if (!r.configFound) {
    return NextResponse.json(
      { error: 'no_config', message: 'No WooCommerce config saved for this tenant' },
      { status: 404 },
    )
  }

  return NextResponse.json({
    synced: r.synced,
    created: r.created,
    updated: r.updated,
    errors: r.errors,
    lastSyncAt: r.lastSyncAt,
  })
}
