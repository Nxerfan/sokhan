'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function LocaleSwitcher() {
  const t = useTranslations('locale')
  const locale = useLocale()
  const next = locale === 'fa' ? 'en' : 'fa'

  async function toggle() {
    await fetch('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    })
    // Reload to apply dir + lang at the <html> level
    window.location.reload()
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={t('switch')}
            className="h-8 w-8"
          >
            <Languages className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('switch')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
