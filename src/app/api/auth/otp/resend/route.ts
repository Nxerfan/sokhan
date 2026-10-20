import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resendOtp, NixifyError, type OtpPurpose } from '@/lib/nixify/client'

const MAX_RESENDS = 3

const VALID_PURPOSES: OtpPurpose[] = ['signup', 'login', 'reset_password']

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const purposeStr = String(body?.purpose ?? '').trim()
  const originalRequestId = String(body?.originalRequestId ?? '').trim()

  if (!email || !purposeStr || !originalRequestId) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Validate purpose against our internal vocabulary
  if (!VALID_PURPOSES.includes(purposeStr as OtpPurpose)) {
    return NextResponse.json({ error: 'invalid_purpose' }, { status: 400 })
  }
  const purpose = purposeStr as OtpPurpose

  // Find original OtpRequest
  const otpReq = await db.otpRequest.findFirst({
    where: { requestId: originalRequestId, email, purpose },
  })
  if (!otpReq) return NextResponse.json({ error: 'request_not_found' }, { status: 404 })

  // Check resend count
  if (otpReq.resendCount >= MAX_RESENDS) {
    return NextResponse.json({ error: 'resend_limit_reached' }, { status: 400 })
  }

  try {
    const result = await resendOtp(email, purpose)

    // Update local OTP correlation state. For signup, both the OtpRequest
    // and PendingSignup must commit together (one logical resend operation).
    if (purpose === 'signup') {
      await db.$transaction([
        db.otpRequest.update({
          where: { id: otpReq.id },
          data: {
            requestId: result.otpRequestId,
            expiresAt: new Date(result.expiresAt),
            resendCount: { increment: 1 },
            verified: false,
          },
        }),
        db.pendingSignup.updateMany({
          where: { email },
          data: { nixifyRequestId: result.otpRequestId, expiresAt: new Date(result.expiresAt), otpVerified: false },
        }),
      ])
    } else {
      // login / reset: only OtpRequest needs updating
      await db.otpRequest.update({
        where: { id: otpReq.id },
        data: {
          requestId: result.otpRequestId,
          expiresAt: new Date(result.expiresAt),
          resendCount: { increment: 1 },
          verified: false,
        },
      })
    }

    return NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt })
  } catch (e) {
    if (e instanceof NixifyError) return NextResponse.json({ error: e.code }, { status: e.statusCode })
    console.error('[auth:otp/resend] internal error', { component: 'auth', route: '/api/auth/otp/resend', errorName: e instanceof Error ? e.name : 'unknown' })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
