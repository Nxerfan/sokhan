import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'

export const locales = ['fa', 'en'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'fa'

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const raw = cookieStore.get('locale')?.value
  const locale: Locale = raw === 'en' ? 'en' : 'fa'
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
