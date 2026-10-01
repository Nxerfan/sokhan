const DEV_SECRET = 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1'

if (!process.env.NEXTAUTH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n❌ FATAL: NEXTAUTH_SECRET is not set in production! Refusing to start.\n   Set NEXTAUTH_SECRET in the environment.\n   Generate one with: openssl rand -base64 32\n')
    process.exit(1)
  } else {
    process.env.NEXTAUTH_SECRET = DEV_SECRET
    console.warn('\n⚠️  NEXTAUTH_SECRET not set — using dev secret.\n')
  }
}

export function getAuthSecret(): string { return process.env.NEXTAUTH_SECRET! }
