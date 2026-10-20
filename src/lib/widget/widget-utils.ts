/**
 * Shared utilities for the widget package + script-tag endpoint.
 *
 * These helpers live outside the NPM package so they can be imported by
 * both:
 *   - The Next.js route handlers (`/api/widget/v1/sukhan.js`, etc.)
 *   - The dashboard's widget-panel preview
 *
 * The package itself (under `packages/widget-npm/`) has its own copy of
 * `normalizeApiKey` and `resolveApiUrl` to stay self-contained.
 */

/**
 * Strip the optional `sk_` prefix from an API key.
 *
 * Today the API key IS the tenant slug. The `sk_` prefix is cosmetic — it
 * makes the key look like a "real" API key. When true randomized API keys
 * land (via a future schema migration adding `apiKey` to WidgetConfig),
 * this helper will still work as the entry point: it will look up the
 * tenant by the (now randomized) key instead of stripping a prefix.
 */
export function normalizeApiKey(key: string): string {
  if (!key) return ''
  return key.startsWith('sk_') ? key.slice(3) : key
}
