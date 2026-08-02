import { NextRequest, NextResponse } from 'next/server'
import { locales, defaultLocale, type Locale } from '@/i18n/request'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const requested = body?.locale
  const locale: Locale = requested === 'en' ? 'en' : 'fa'
  const res = NextResponse.json({ locale })
  res.cookies.set('locale', locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })
  return res
}

export async function GET() {
  return NextResponse.json({ locales, defaultLocale })
}
