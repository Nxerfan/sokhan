/**
 * Production secret validation.
 *
 * Centralised, dependency-free validator used by BOTH the Docker web
 * entrypoint (`docker-entrypoint.sh` shells out to a small node -e
 * helper that imports this module) and the standalone realtime
 * service (`mini-services/realtime/index.ts`).
 *
 * DESIGN:
 *   - Pure functions, no I/O. Callers pass the value; the validator
 *     decides accept/reject. This keeps the validator trivially
 *     unit-testable.
 *   - NEVER echoes the secret value. Failure messages mention the
 *     variable NAME only (e.g. "NEXTAUTH_SECRET is missing or
 *     placeholder"). The validator never receives the value back from
 *     a logger and never interpolates it into error text.
 *   - The list of known-bad placeholder values is intentionally small
 *     and explicit. We do NOT try to "detect weak secrets" by entropy
 *     heuristics — that produces false positives and is brittle. We
 *     only reject values that we, the project, have ourselves
 *     documented as placeholders OR that ship in committed example
 *     files. Real production secrets (any non-empty, non-placeholder
 *     value) are accepted.
 *
 * PRODUCTION VS DEV:
 *   - In production (NODE_ENV=production) the validator is strict —
 *     placeholders and known dev secrets are rejected.
 *   - In non-production (dev / test) the validator is permissive on
 *     the dev-secret path: the realtime service may fall back to its
 *     deterministic DEV_SECRET for local development. The validator
 *     still rejects the explicit `CHANGE_ME...` placeholders and
 *     empty values even in dev — operators running `bun dev` should
 *     set a real env var OR rely on the realtime DEV_SECRET fallback
 *     (which only kicks in when NEXTAUTH_SECRET is unset, NOT when it
 *     is set to a placeholder).
 */

/**
 * Known-bad NEXTAUTH_SECRET values that must NEVER be accepted in
 * production. These are values that:
 *   - ship in committed example/template files (`.env.docker.example`)
 *   - are documented as the deterministic dev-secret fallback used by
 *     the realtime service when NEXTAUTH_SECRET is unset in dev
 *
 * If you add a new placeholder to a committed template, add it here too.
 */
const KNOWN_BAD_NEXTAUTH_SECRETS: ReadonlySet<string> = new Set([
  // .env.docker.example historical placeholder
  'CHANGE_ME_generate_with_openssl_rand_base64_32',
  // mini-services/realtime/index.ts deterministic dev secret
  'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1',
])

/**
 * Prefix that marks an env value as an obvious placeholder. Anything
 * starting with this prefix is rejected in production. This is the
 * single most important defence — it catches any future
 * `CHANGE_ME_...`-style value shipped in a template without having to
 * enumerate each one explicitly.
 */
const PLACEHOLDER_PREFIX = 'CHANGE_ME'

/** True if `v` is a known-bad placeholder value. */
function isKnownPlaceholder(v: string): boolean {
  if (KNOWN_BAD_NEXTAUTH_SECRETS.has(v)) return true
  if (v.startsWith(PLACEHOLDER_PREFIX)) return true
  return false
}

export interface SecretValidationResult {
  ok: boolean
  /** Variable name (for logging). NEVER the value. */
  varName: string
  /** Human-readable reason (for logging). NEVER includes the value. */
  reason?: string
}

/**
 * Validate a NEXTAUTH_SECRET value for PRODUCTION use.
 *
 * Returns `{ ok: true }` if the value is acceptable in production,
 * or `{ ok: false, reason }` if it must be rejected.
 *
 * Rejected:
 *   - missing / undefined / null
 *   - empty after trim
 *   - any value starting with `CHANGE_ME`
 *   - any value in the explicit KNOWN_BAD_NEXTAUTH_SECRETS set
 *     (dev secret fallback, documented placeholders)
 *
 * Accepted:
 *   - any other non-empty string (the operator's real secret)
 *
 * The value is NEVER echoed. The returned `reason` mentions the
 * variable NAME only.
 */
export function validateNextAuthSecret(value: string | undefined | null): SecretValidationResult {
  const varName = 'NEXTAUTH_SECRET'
  if (value === undefined || value === null) {
    return { ok: false, varName, reason: `${varName} is missing. Set it to a strong random value (openssl rand -base64 32).` }
  }
  const trimmed = String(value).trim()
  if (trimmed === '') {
    return { ok: false, varName, reason: `${varName} is empty. Set it to a strong random value (openssl rand -base64 32).` }
  }
  if (isKnownPlaceholder(trimmed)) {
    return { ok: false, varName, reason: `${varName} is set to a known placeholder value. Generate a real secret (openssl rand -base64 32) and set it before starting in production.` }
  }
  return { ok: true, varName }
}

/**
 * Validate a POSTGRES_PASSWORD value for production use.
 *
 * Same shape as validateNextAuthSecret but with a separate list of
 * known-bad values. Currently the only known-bad value is the
 * historical `.env.docker.example` placeholder.
 *
 * Rejected:
 *   - missing / undefined / null
 *   - empty after trim
 *   - any value starting with `CHANGE_ME`
 *   - the explicit historical placeholder
 *
 * Accepted:
 *   - any other non-empty string
 *
 * The value is NEVER echoed.
 */
const KNOWN_BAD_POSTGRES_PASSWORDS: ReadonlySet<string> = new Set([
  'CHANGE_ME_strong_password_here',
])

export function validatePostgresPassword(value: string | undefined | null): SecretValidationResult {
  const varName = 'POSTGRES_PASSWORD'
  if (value === undefined || value === null) {
    return { ok: false, varName, reason: `${varName} is missing. Generate a strong password (openssl rand -hex 24) and set it before starting.` }
  }
  const trimmed = String(value).trim()
  if (trimmed === '') {
    return { ok: false, varName, reason: `${varName} is empty. Generate a strong password (openssl rand -hex 24) and set it before starting.` }
  }
  if (KNOWN_BAD_POSTGRES_PASSWORDS.has(trimmed) || trimmed.startsWith(PLACEHOLDER_PREFIX)) {
    return { ok: false, varName, reason: `${varName} is set to a known placeholder value. Generate a real password (openssl rand -hex 24) and set it before starting.` }
  }
  return { ok: true, varName }
}

/**
 * Format a failure for a shell exit message. Mentions the variable
 * name and reason only — never the value.
 *
 * Suitable for `console.error(...)` or `echo` in shell scripts.
 */
export function formatSecretFailure(result: SecretValidationResult): string {
  if (result.ok) return ''
  return `FATAL: ${result.reason ?? `${result.varName} is invalid.`}`
}

/**
 * Convenience: validate NEXTAUTH_SECRET for production and return
 * the failure message (or '' if ok). Useful for one-liner entrypoints.
 *
 * `isProduction` lets dev callers opt into the dev-fallback path
 * without dragging the validator's logic into the caller.
 */
export function nextAuthSecretProductionFailure(value: string | undefined | null): string {
  const r = validateNextAuthSecret(value)
  return r.ok ? '' : formatSecretFailure(r)
}

/**
 * Convenience: validate POSTGRES_PASSWORD for production and return
 * the failure message (or '' if ok).
 */
export function postgresPasswordProductionFailure(value: string | undefined | null): string {
  const r = validatePostgresPassword(value)
  return r.ok ? '' : formatSecretFailure(r)
}
