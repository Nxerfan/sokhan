/**
 * Deployment mode detection.
 *
 * Three modes are supported:
 *   - `vercel`  : running on Vercel serverless (no persistent filesystem,
 *                 no long-lived Node process, must use external Postgres,
 *                 external Redis pub/sub, and object storage for attachments).
 *   - `docker`  : running inside the Sukhan Docker image (Next.js standalone
 *                 + realtime service + Caddy gateway, persistent local FS,
 *                 SQLite or Postgres, local Redis optional).
 *   - `dev`     : local development (`next dev` + mini-services/realtime).
 *
 * Mode is resolved as:
 *   1. `DEPLOYMENT_MODE` env var if set (explicit override — for tests).
 *   2. `VERCEL=1` (set automatically by Vercel) → `vercel`.
 *   3. `DOCKER=1` or `NODE_ENV=production` → `docker`.
 *   4. otherwise `dev`.
 *
 * The mode drives which adapters the storage/realtime/database factories
 * select. Each factory is independent — for example, you can run in `docker`
 * mode but still use Redis-backed realtime by setting `REDIS_URL`.
 */

export type DeploymentMode = 'vercel' | 'docker' | 'dev'

let override: DeploymentMode | null = null

/**
 * Override the detected mode. Intended for tests only — production code
 * should rely on environment variables, not runtime mutation.
 */
export function __setDeploymentModeOverride(mode: DeploymentMode | null): void {
  override = mode
}

export function getDeploymentMode(): DeploymentMode {
  if (override) return override
  const explicit = process.env.DEPLOYMENT_MODE as DeploymentMode | undefined
  if (explicit === 'vercel' || explicit === 'docker' || explicit === 'dev') {
    return explicit
  }
  if (process.env.VERCEL === '1') return 'vercel'
  if (process.env.DOCKER === '1' || process.env.NODE_ENV === 'production') {
    return 'docker'
  }
  return 'dev'
}

export const isVercel = (): boolean => getDeploymentMode() === 'vercel'
export const isDocker = (): boolean => getDeploymentMode() === 'docker'
export const isDev = (): boolean => getDeploymentMode() === 'dev'

/**
 * Whether the current deployment can rely on a long-lived Node process
 * reachable on localhost. True for docker and dev; false for vercel.
 *
 * Used by the realtime publisher to decide between the HTTP-internal
 * endpoint (docker/dev) and Redis pub/sub or an external HTTP endpoint
 * (vercel).
 */
export function hasLocalRealtimeService(): boolean {
  const mode = getDeploymentMode()
  return mode === 'docker' || mode === 'dev'
}

/**
 * Whether the current deployment has a writable persistent filesystem.
 * True for docker and dev; false for vercel (where only /tmp is writable
 * and is ephemeral per invocation).
 */
export function hasPersistentFilesystem(): boolean {
  const mode = getDeploymentMode()
  return mode === 'docker' || mode === 'dev'
}
