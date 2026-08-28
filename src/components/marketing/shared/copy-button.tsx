'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CopyButtonProps {
  text: string
  className?: string
}

/**
 * Copy-to-clipboard button. Shows a checkmark for 2s after a successful copy.
 */
export function CopyButton({ text, className }: CopyButtonProps) {
  const t = useTranslations('marketing.selfHosting')
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Older browsers / non-secure contexts: silently ignore.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
      aria-label={t('dockerCopy')}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-turquoise" />
          {t('dockerCopied')}
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {t('dockerCopy')}
        </>
      )}
    </button>
  )
}
