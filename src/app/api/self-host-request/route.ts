import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'

/**
 * Self-hosted deployment request form.
 * NO auth required — public form on the marketing site.
 * Stores the request for manual follow-up. No auto-provisioning.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  const name = String(body.name ?? '').trim()
  const company = String(body.company ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const phone = String(body.phone ?? '').trim()
  const message = body.message ? String(body.message).trim().slice(0, 2000) : null

  if (!name || !company || !email || !phone) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
  }

  const request = await db.selfHostRequest.create({
    data: { name, company, email, phone, message },
  })

  return NextResponse.json({ ok: true, id: request.id })
}
