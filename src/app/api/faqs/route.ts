import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.faqPair.findMany({
      where: { tenantId: getCurrentTenantId()! },
      orderBy: { createdAt: 'desc' },
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ faqs: result.result })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    if (typeof body.question !== 'string') return { error: 'invalid_question' as const }
    const question = body.question.trim()
    if (typeof body.answer !== 'string') return { error: 'invalid_answer' as const }
    const answer = body.answer.trim()
    if (!question || question.length > 1000) return { error: 'invalid_question' as const }
    if (!answer || answer.length > 5000) return { error: 'invalid_answer' as const }
    const faq = await db.faqPair.create({
      data: {
        tenantId: session.user.workspaceId!,
        question,
        answer,
        enabled: body.enabled !== false,
      },
    })
    return { faq } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ faq: result.result.faq })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const data: any = {}
    if (body.question !== undefined) data.question = body.question
    if (body.answer !== undefined) data.answer = body.answer
    if (body.enabled !== undefined) data.enabled = body.enabled
    await db.faqPair.updateMany({
      where: { id: body.id, tenantId: getCurrentTenantId()! },
      data,
    })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return { error: 'invalid_id' as const }
    await db.faqPair.deleteMany({ where: { id, tenantId: getCurrentTenantId()! } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
