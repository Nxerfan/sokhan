import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { z } from 'zod'

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1).max(80),
  workspaceName: z.string().min(1).max(80),
})

function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return base || 'workspace'
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = SignupSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  }
  const { email, password, name, workspaceName } = parsed.data

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json({ error: 'email_taken' }, { status: 409 })
  }

  const slug = slugify(workspaceName)
  const slugTaken = await db.tenant.findUnique({ where: { slug } })
  if (slugTaken) {
    return NextResponse.json({ error: 'slug_taken' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 10)

  // Create tenant + owner + widget config in one transaction.
  const result = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug,
        name: workspaceName,
        defaultLocale: 'fa',
        defaultDirection: 'rtl',
        plan: 'free',
      },
    })

    const user = await tx.user.create({
      data: { email, name, passwordHash, locale: 'fa', hasUsedFreeTrial: true, emailVerified: true, emailVerifiedAt: new Date() },
    })

    await tx.membership.create({
      data: { userId: user.id, tenantId: tenant.id, role: 'owner', status: 'active' },
    })

    await tx.widgetConfig.create({
      data: {
        tenantId: tenant.id,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        avatarUrl: null,
        logoUrl: null,
        greetingTexts: { fa: 'سلام! چطور می‌تونم کمکتون کنم؟', en: 'Hi there! How can I help?' },
        defaultLocale: 'fa',
      },
    })

    return { tenant, user }
  })

  return NextResponse.json({ ok: true, tenantId: result.tenant.id })
}
