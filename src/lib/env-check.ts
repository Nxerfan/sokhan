/**
 * Startup safeguard — fails loudly if critical env vars are missing.
 *
 * This module is imported by the auth options and the realtime token lib.
 * If NEXTAUTH_SECRET is missing, it throws immediately with a clear error
 * message, rather than silently falling back to 'dev-secret-change-me' and
 * causing mysterious JWEDecryptionFailed errors later.
 *
 * The .env file in this sandbox gets reset to a template (DATABASE_URL only)
 * at session start. The secret lives in .env.local (which persists). If
 * .env.local is also missing, this safeguard catches it loudly.
 */

const REQUIRED_ENV = ['NEXTAUTH_SECRET'] as const

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(
      `\n\n❌ FATAL: ${key} is not set.\n\n` +
      `This causes silent auth failures (JWEDecryptionFailed, 401s).\n\n` +
      `Fix: create a .env.local file in the project root with:\n` +
      `  ${key}=<random-32-byte-base64-string>\n\n` +
      `Generate one with: openssl rand -base64 32\n`
    )
  }
}

export const AUTH_SECRET = process.env.NEXTAUTH_SECRET!
