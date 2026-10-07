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
    // `enabled` defaults to true. When supplied, MUST be a boolean — never
    // silently coerce non-boolean values (e.g. "false" string, 0, null) to
    // true/false.
    let enabled = true
    if (body.enabled !== undefined && body.enabled !== null) {
      if (typeof body.enabled !== 'boolean') {
        return { error: 'invalid_enabled' as const }
      }
      enabled = body.enabled
    }
    const faq = await db.faqPair.create({
      data: {
        tenantId: session.user.workspaceId!,
        question,
        answer,
        enabled,
      },
    })
    return { faq } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ faq: result.result.faq })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    // id is required for PATCH — must be a non-empty string. Reject any other
    // type (number, object, array, empty string) before touching the DB.
    if (typeof body.id !== 'string' || body.id.trim() === '') {
      return { error: 'invalid_id' as const }
    }
    const id = body.id.trim()

    // Build the mutation payload, validating each field's type when supplied.
    // At least one mutable field must be present (PATCH with no fields is a
    // client bug).
    const data: { question?: string; answer?: string; enabled?: boolean } = {}
    let hasMutable = false

    if (body.question !== undefined && body.question !== null) {
      if (typeof body.question !== 'string') return { error: 'invalid_question' as const }
      const question = body.question.trim()
      if (!question || question.length > 1000) return { error: 'invalid_question' as const }
      data.question = question
      hasMutable = true
    }
    if (body.answer !== undefined && body.answer !== null) {
      if (typeof body.answer !== 'string') return { error: 'invalid_answer' as const }
      const answer = body.answer.trim()
      if (!answer || answer.length > 5000) return { error: 'invalid_answer' as const }
      data.answer = answer
      hasMutable = true
    }
    if (body.enabled !== undefined && body.enabled !== null) {
      if (typeof body.enabled !== 'boolean') return { error: 'invalid_enabled' as const }
      data.enabled = body.enabled
      hasMutable = true
    }

    if (!hasMutable) {
      return { error: 'no_fields' as const }
    }

    const updateResult = await db.faqPair.updateMany({
      where: { id },
      data,
    })
    // updateMany with a tenant-scoped where returns count=0 if the row
    // doesn't exist OR belongs to another tenant. Either way, the caller
    // has no business updating it — return 404 (not found / not in tenant).
    if (updateResult.count === 0) {
      return { error: 'not_found' as const }
    }
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) {
    const status = result.result.error === 'not_found' ? 404 : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
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
