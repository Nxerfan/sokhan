import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendOtp, NixifyError } from '@/lib/nixify/client'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  if (!email) return NextResponse.json({ error: 'email_required' }, { status: 400 })

  const user = await db.user.findUnique({ where: { email } })
  if (!user) return NextResponse.json({ error: 'email_not_found' }, { status: 404 })

  try {
    const result = await sendOtp(email, 'login')
    await db.otpRequest.create({
      data: {
        userId: user.id, email, purpose: 'login',
        requestId: result.otpRequestId, expiresAt: new Date(result.expiresAt),
        ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0] || null,
      },
    })
    return NextResponse.json({ requestId: result.otpRequestId, expiresAt: result.expiresAt })
  } catch (e) {
    if (e instanceof NixifyError) return NextResponse.json({ error: e.code }, { status: e.statusCode })
    console.error('[auth:login-otp/start] internal error', { component: 'auth', route: '/api/auth/login-otp/start', errorName: e instanceof Error ? e.name : 'unknown' })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
