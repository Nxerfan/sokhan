import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyOtp, NixifyError } from '@/lib/nixify/client'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/options'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const code = String(body?.code ?? '').trim()
  const requestId = String(body?.requestId ?? '').trim()

  if (!email || !code || !requestId) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  const otpReq = await db.otpRequest.findFirst({
    where: { requestId, email, purpose: 'login' },
  })
  if (!otpReq) return NextResponse.json({ error: 'request_not_found' }, { status: 404 })
  if (otpReq.verified) return NextResponse.json({ error: 'already_used' }, { status: 400 })
  if (otpReq.expiresAt < new Date()) return NextResponse.json({ error: 'expired' }, { status: 400 })

  await db.otpRequest.update({
    where: { id: otpReq.id },
    data: { attempts: { increment: 1 } },
  })

  try {
    const result = await verifyOtp(email, code, 'login', requestId)
    if (!result.verified) return NextResponse.json({ error: 'code_mismatch' }, { status: 400 })

    await db.otpRequest.update({
      where: { id: otpReq.id },
      data: { verified: true, verifiedAt: new Date() },
    })

    // Return success — the client calls signIn('credentials') with email+password
    // But since this is OTP login, we need to issue a session differently.
    // The simplest approach: return the user's email and let the client call
    // signIn('credentials') with a special otp-login flag. For now, just return success.
    return NextResponse.json({ verified: true, email })
  } catch (e) {
    if (e instanceof NixifyError) return NextResponse.json({ error: e.code }, { status: e.statusCode })
    return NextResponse.json({ error: 'unknown_error' }, { status: 500 })
  }
}
