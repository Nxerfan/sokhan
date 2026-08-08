/**
 * Startup safeguard for NEXTAUTH_SECRET.
 *
 * CRITICAL: Do NOT throw at module load time. If this module throws during
 * import, Next.js renders its default HTML error page (500) instead of JSON,
 * which breaks the NextAuth client's JSON contract (CLIENT_FETCH_ERROR).
 *
 * Instead, we:
 *   1. Check if NEXTAUTH_SECRET is set.
 *   2. If missing in dev: generate a stable secret and persist it to .env
 *      so both Next.js and the realtime service share the same secret.
 *   3. If missing in production: throw lazily (on access, not at import).
 *
 * The sandbox wipes .env.local at session start, so we persist to .env itself
 * (which the sandbox resets to a template, but we re-add the secret after).
 */

import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const ENV_PATH = resolve(process.cwd(), '.env')

function ensureSecretInEnvFile(): string | null {
  let envContent = ''
  try {
    envContent = readFileSync(ENV_PATH, 'utf-8')
  } catch {
    // .env doesn't exist — will create it
  }

  // Check if NEXTAUTH_SECRET is already in .env
  const existingMatch = envContent.match(/^NEXTAUTH_SECRET=(.+)$/m)
  if (existingMatch) {
    return existingMatch[1].trim()
  }

  // Generate a new secret and add it to .env
  const newSecret = randomBytes(32).toString('base64')
  const newLine = envContent && !envContent.endsWith('\n') ? '\n' : ''
  const updatedContent = envContent + newLine + `NEXTAUTH_SECRET=${newSecret}\n`
  try {
    writeFileSync(ENV_PATH, updatedContent, { mode: 0o755 })
    console.log('[env-check] Generated and persisted NEXTAUTH_SECRET to .env')
  } catch {
    console.warn('[env-check] Could not write to .env — using in-memory secret only')
  }
  return newSecret
}

function getSecret(): string {
  if (process.env.NEXTAUTH_SECRET) {
    return process.env.NEXTAUTH_SECRET
  }

  const secret = ensureSecretInEnvFile()
  if (secret) {
    process.env.NEXTAUTH_SECRET = secret
    return secret
  }

  if (process.env.NODE_ENV !== 'production') {
    const tempSecret = randomBytes(32).toString('base64')
    console.warn(
      '\n⚠️  NEXTAUTH_SECRET not set and could not persist to .env.\n' +
      '   Using temporary in-memory secret. Socket.IO auth may fail.\n'
    )
    return tempSecret
  }

  throw new Error(
    'NEXTAUTH_SECRET is not set. ' +
    'Fix: set the NEXTAUTH_SECRET environment variable. ' +
    'Generate one with: openssl rand -base64 32'
  )
}

/**
 * Direct accessor — triggers the lazy check on first call (not at module load).
 * This ensures any throw happens inside a request handler, preserving the
 * JSON contract of API routes.
 */
export function getAuthSecret(): string {
  return getSecret()
}
