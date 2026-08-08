/**
 * External store connector registry + factory.
 *
 * Each connector implements the `ProductConnector` interface:
 *   - `sync(tenantId, config)` — pull the external catalog into the internal
 *     Product table. Returns a unified `ProductSyncResult` (synced/created/
 *     updated counts + errors[]).
 *
 * The factory `getConnector(source)` returns the connector for a given source
 * name. Today only 'woocommerce' is implemented; 'shopify' and 'basalam' are
 * stubbed (their public APIs exist — see worklog — but the connectors are not
 * yet implemented). Unknown sources throw.
 *
 * Design constraint: connectors NEVER make live API calls per chat message.
 * They run on demand (dashboard button / scheduled job) and write into the
 * internal Product table; chat / AI code reads only from Product.
 */

import { db } from '@/lib/db'
import {
  syncWooCommerceProducts,
  validateWooCommerceConfig,
  maskConsumerSecret,
  type WooCommerceConfig,
  type ProductSyncResult,
} from './woocommerce'

export type { WooCommerceConfig, ProductSyncResult } from './woocommerce'

export interface ProductConnector<TConfig = Record<string, unknown>> {
  /** Source identifier — matches Product.externalSource. */
  source: string
  /** Human-readable name for display. */
  label: string
  /** Sync the external catalog into the internal Product table. */
  sync(tenantId: string, config: TConfig): Promise<ProductSyncResult>
  /** Validate a config object before persisting. Returns [] when valid. */
  validateConfig(config: unknown): string[]
}

/** Connector registry — keyed by source name. */
const CONNECTORS: Record<string, ProductConnector<any>> = {
  woocommerce: {
    source: 'woocommerce',
    label: 'WooCommerce',
    async sync(tenantId: string, config: WooCommerceConfig) {
      return syncWooCommerceProducts(tenantId, config)
    },
    validateConfig(config: unknown) {
      return validateWooCommerceConfig(config as Partial<WooCommerceConfig>)
    },
  },
  // Shopify — API confirmed (Admin REST: /admin/api/2024-10/products.json +
  // GraphQL Admin API). Connector not yet implemented; the public API is
  // viable (OAuth, X-Shopify-Access-Token header). Stubbed here so the
  // factory has a known source list and the dashboard can list it as
  // "coming soon" without 500-ing the connector chooser.
  shopify: {
    source: 'shopify',
    label: 'Shopify',
    async sync() {
      return {
        synced: 0,
        created: 0,
        updated: 0,
        errors: ['Shopify connector is not yet implemented'],
      }
    },
    validateConfig() {
      return ['Shopify connector is not yet implemented']
    },
  },
  // Basalam — SalamAPI (https://developers.basalam.com) is a public OAuth2
  // seller API. Connector not yet implemented. Stubbed for the same reason.
  basalam: {
    source: 'basalam',
    label: 'Basalam',
    async sync() {
      return {
        synced: 0,
        created: 0,
        updated: 0,
        errors: ['Basalam connector is not yet implemented'],
      }
    },
    validateConfig() {
      return ['Basalam connector is not yet implemented']
    },
  },
}

/** Known connector source names (for UI / iteration). */
export const CONNECTOR_SOURCES = Object.keys(CONNECTORS) as string[]

/** Returns true if a connector is registered for the given source name. */
export function isKnownConnector(source: string): boolean {
  return source in CONNECTORS
}

/**
 * Return the connector for a given source name. Throws if unknown — callers
 * should validate with `isKnownConnector` first or wrap in try/catch.
 */
export function getConnector<T = Record<string, unknown>>(
  source: string,
): ProductConnector<T> {
  const connector = CONNECTORS[source]
  if (!connector) {
    throw new Error(`Unknown connector source: ${source}`)
  }
  return connector as ProductConnector<T>
}

/**
 * Convenience: run a sync using the connector matching `source`. Loads the
 * ConnectorConfig row from the DB, dispatches to the connector, and stamps
 * `lastSyncAt` on success (even partial success — we still record that a sync
 * attempt was made).
 *
 * Runs INSIDE the caller's tenant context — `getCurrentTenantId()` must be set.
 */
export async function runConnectorSync(
  tenantId: string,
  source: string,
): Promise<ProductSyncResult & { configFound: boolean; lastSyncAt: Date | null }> {
  const connector = getConnector(source)

  const cfg = await db.connectorConfig.findUnique({
    where: { tenantId_type: { tenantId, type: source } },
  })
  if (!cfg) {
    return {
      synced: 0,
      created: 0,
      updated: 0,
      errors: [`No ${source} connector config saved for this tenant`],
      configFound: false,
      lastSyncAt: null,
    }
  }

  const result = await connector.sync(tenantId, cfg.config as any)

  // Stamp lastSyncAt — even on partial failure, the attempt is informative.
  const now = new Date()
  await db.connectorConfig.update({
    where: { id: cfg.id },
    data: { lastSyncAt: now },
  })

  return { ...result, configFound: true, lastSyncAt: now }
}

export { maskConsumerSecret, validateWooCommerceConfig } from './woocommerce'
