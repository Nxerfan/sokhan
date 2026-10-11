import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const requestId = String(body?.requestId ?? '').trim()
  const newPassword = String(body?.newPassword ?? '')

  if (!email || !requestId || !newPassword) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Verify OTP was verified
  const otpReq = await db.otpRequest.findFirst({
    where: { requestId, email, purpose: 'reset_password', verified: true },
  })
  if (!otpReq) return NextResponse.json({ error: 'otp_not_verified' }, { status: 403 })

  const passwordHash = await bcrypt.hash(newPassword, 10)

  await db.user.update({
    where: { email },
    data: { passwordHash, passwordResetAt: new Date() },
  })

  // Clean up
  await db.otpRequest.deleteMany({ where: { requestId } })

  return NextResponse.json({ ok: true })
}
