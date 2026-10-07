import { NextResponse } from 'next/server'

/**
 * DEPRECATED — this route is intentionally non-functional.
 *
 * Account/workspace creation must go through the OTP-verified 3-step flow:
 *   1. POST /api/auth/signup/start   — send OTP to email
 *   2. POST /api/auth/signup/verify  — verify the OTP code
 *   3. POST /api/auth/signup/complete — create the user + tenant + membership
 *
 * The old implementation of this route created a fully email-verified user
 * and tenant WITHOUT any OTP check — a critical authentication bypass.
 * It has been removed. All callers (UI and tests) must use the 3-step flow.
 *
 * Returns 410 Gone so that any stale caller gets a clear non-success
 * response and cannot accidentally create an account.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'signup_deprecated', message: 'Use /api/auth/signup/start → /verify → /complete' },
    { status: 410 },
  )
}

export async function GET() {
  return NextResponse.json(
    { error: 'signup_deprecated', message: 'Use /api/auth/signup/start → /verify → /complete' },
    { status: 410 },
  )
}
