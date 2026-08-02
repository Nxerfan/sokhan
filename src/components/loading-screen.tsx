'use client'

import { MessageSquareText } from 'lucide-react'
import { useTranslations } from 'next-intl'

export function LoadingScreen() {
  const t = useTranslations('common')
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-ink text-ink-foreground">
        <MessageSquareText className="h-6 w-6 animate-pulse" />
      </div>
      <p className="text-sm text-muted-foreground">{t('loading')}</p>
    </div>
  )
}
