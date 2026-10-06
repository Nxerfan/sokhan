import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendOtp, NixifyError, type OtpPurpose } from '@/lib/nixify/client'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()

  if (!email) {
    return NextResponse.json({ error: 'email_required' }, { status: 400 })
  }

  // Check if email already registered
  const existingUser = await db.user.findUnique({ where: { email } })
  if (existingUser) {
    return NextResponse.json({ error: 'email_already_registered' }, { status: 409 })
  }

  // Check existing pending signup (not expired)
  const existingPending = await db.pendingSignup.findUnique({ where: { email } })
  if (existingPending && existingPending.expiresAt > new Date()) {
    return NextResponse.json({ error: 'otp_already_sent', requestId: existingPending.nixifyRequestId }, { status: 409 })
  }

  try {
    const purpose: OtpPurpose = 'signup'
    const result = await sendOtp(email, purpose)

    // Create PendingSignup — store otp_request_id (NOT api request_id)
    await db.pendingSignup.upsert({
      where: { email },
      create: {
        email,
        nixifyRequestId: result.otpRequestId,
        expiresAt: new Date(result.expiresAt),
      },
      update: {
        nixifyRequestId: result.otpRequestId,
        expiresAt: new Date(result.expiresAt),
        otpVerified: false,
      },
    })

    // Create OtpRequest
    await db.otpRequest.create({
      data: {
        email,
        purpose,
        requestId: result.otpRequestId,
        expiresAt: new Date(result.expiresAt),
        ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0] || null,
      },
    })

    return NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt })
  } catch (e) {
    if (e instanceof NixifyError) {
      return NextResponse.json({ error: e.code }, { status: e.statusCode })
    }
    return NextResponse.json({ error: 'unknown_error' }, { status: 500 })
  }
}
