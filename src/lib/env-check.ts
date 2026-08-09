/**
 * Startup safeguard for NEXTAUTH_SECRET.
 *
 * CRITICAL: Do NOT throw at module load time. If this module throws during
 * import, Next.js renders its default HTML error page (500) instead of JSON,
 * which breaks the NextAuth client's JSON contract (CLIENT_FETCH_ERROR).
 *
 * Strategy:
 *   1. If NEXTAUTH_SECRET env var is set → use it (production path).
 *   2. If NOT set in dev → set process.env.NEXTAUTH_SECRET to a DETERMINISTIC
 *      dev secret. This MUST happen at module load time (not lazily) because
 *      NextAuth v4 reads process.env.NEXTAUTH_SECRET directly during module
 *      initialization. If we don't set it, NextAuth falls back to its own
 *      internal default, which causes JWT encoding/decoding to fail silently.
 *   3. If NOT set in production → set it to the dev secret too, but log a
 *      loud warning. The NextAuth route will fail, but at least the error
 *      will be visible (not a crash at module load).
 *
 * The deterministic dev secret is NOT secure — it's a fixed string. Both
 * Next.js and the realtime service use this same string so Socket.IO auth
 * works correctly. In production, NEXTAUTH_SECRET is always set (Docker
 * fails fast without it).
 */

// A fixed, deterministic dev secret. Both Next.js and the realtime service
// use this exact string when NEXTAUTH_SECRET is not set in the environment.
const DEV_SECRET = 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1'

if (!process.env.NEXTAUTH_SECRET) {
  if (process.env.NODE_ENV !== 'production') {
    // Dev mode: set the deterministic dev secret in process.env.
    // This MUST happen at module load time because NextAuth v4 reads
    // process.env.NEXTAUTH_SECRET during its own module initialization.
    process.env.NEXTAUTH_SECRET = DEV_SECRET
    console.warn(
      '\n⚠️  NEXTAUTH_SECRET not set — using deterministic dev secret.\n' +
      '   This is NOT secure. Set NEXTAUTH_SECRET in production.\n' +
      '   Both Next.js and the realtime service use the same dev secret\n' +
      '   so Socket.IO auth works correctly.\n'
    )
  } else {
    // Production: set it anyway (NextAuth will use it), but log a FATAL warning.
    // The proper fix is to set NEXTAUTH_SECRET in the environment (Docker).
    process.env.NEXTAUTH_SECRET = DEV_SECRET
    console.error(
      '\n❌ FATAL: NEXTAUTH_SECRET is not set in production!\n' +
      '   Using an insecure dev secret. Set NEXTAUTH_SECRET in the environment.\n' +
      '   Generate one with: openssl rand -base64 32\n'
    )
  }
}

/**
 * Direct accessor — returns the secret. Since we set process.env at module
 * load time, this is just a convenience wrapper.
 */
export function getAuthSecret(): string {
  return process.env.NEXTAUTH_SECRET!
}
