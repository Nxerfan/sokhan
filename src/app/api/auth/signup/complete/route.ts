import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { signToken, type AgentTokenPayload } from '@/lib/realtime-token'
import { getAuthSecret } from '@/lib/env-check'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const requestId = String(body?.requestId ?? '').trim()
  const password = String(body?.password ?? '')
  const workspaceName = String(body?.workspaceName ?? '').trim()
  const workspaceSlug = String(body?.workspaceSlug ?? '').trim()

  if (!email || !requestId || !password || !workspaceName) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Verify OTP was verified
  const otpReq = await db.otpRequest.findFirst({
    where: { requestId, email, purpose: 'signup', verified: true },
  })
  if (!otpReq) {
    return NextResponse.json({ error: 'otp_not_verified' }, { status: 403 })
  }

  // Check email not already registered
  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json({ error: 'email_already_registered' }, { status: 409 })
  }

  // Check slug availability
  const slug = workspaceSlug || workspaceName.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  const slugTaken = await db.tenant.findUnique({ where: { slug } })
  if (slugTaken) {
    return NextResponse.json({ error: 'slug_taken' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 10)

  // Create everything in a transaction
  const result = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { slug, name: workspaceName, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    })

    const user = await tx.user.create({
      data: {
        email, name: email.split('@')[0], passwordHash, locale: 'fa',
        hasUsedFreeTrial: true, emailVerified: true, emailVerifiedAt: new Date(),
      },
    })

    await tx.membership.create({
      data: { userId: user.id, tenantId: tenant.id, role: 'owner', status: 'active' },
    })

    await tx.widgetConfig.create({
      data: {
        tenantId: tenant.id, accentColor: '#E09A2B', launcherShape: 'tab', position: 'bottom-end',
        greetingTexts: { fa: 'سلام! چطور می‌تونم کمکتون کنم؟', en: 'Hi there! How can I help?' },
        defaultLocale: 'fa',
      },
    })

    // Clean up
    await tx.pendingSignup.deleteMany({ where: { email } })
    await tx.otpRequest.deleteMany({ where: { requestId } })

    return { tenant, user }
  })

  // Issue a NextAuth-compatible session by calling signIn internally
  // For simplicity, we return a success and the client does signIn('credentials')
  return NextResponse.json({ ok: true, tenantId: result.tenant.id })
}
