'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageSquareText, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

type BubbleType = 'visitor' | 'agent' | 'ai'

interface Bubble {
  id: number
  type: BubbleType
  text: string
}

/**
 * Animated CSS-only chat-widget mockup for the marketing hero.
 *
 * Reveals a short scripted conversation in a loop: greeting → visitor Q →
 * agent reply → visitor Q → AI product answer. Each message appears with a
 * subtle slide+fade. After the loop completes, it pauses and restarts.
 *
 * Purely decorative — no real chat, no socket. The bubble texts come from
 * i18n so the conversation is bilingual.
 */
export function ChatWidgetMockup() {
  const t = useTranslations('marketing.home.widget')
  const [visibleCount, setVisibleCount] = useState(0)
  const [isTyping, setIsTyping] = useState(false)

  const bubbles: Bubble[] = [
    { id: 0, type: 'agent', text: t('greeting') },
    { id: 1, type: 'visitor', text: t('visitor1') },
    { id: 2, type: 'agent', text: t('agent1') },
    { id: 3, type: 'visitor', text: t('visitor2') },
    { id: 4, type: 'ai', text: t('aiAnswer') },
  ]

  // The conversation loop.
  useEffect(() => {
    let cancelled = false
    let timeouts: ReturnType<typeof setTimeout>[] = []

    function run() {
      if (cancelled) return
      setVisibleCount(0)
      setIsTyping(false)

      // Step 1: show greeting after a brief beat.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(true)
        }, 600),
      )

      // Step 2: agent typing for greeting.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(false)
          setVisibleCount(1)
        }, 1400),
      )

      // Step 3: visitor1 — appears after greeting.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setVisibleCount(2)
        }, 2800),
      )

      // Step 4: agent typing.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(true)
        }, 3600),
      )

      // Step 5: agent1 reply.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(false)
          setVisibleCount(3)
        }, 4400),
      )

      // Step 6: visitor2.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setVisibleCount(4)
        }, 5800),
      )

      // Step 7: AI typing (slightly different label).
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(true)
        }, 6600),
      )

      // Step 8: AI answer.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          setIsTyping(false)
          setVisibleCount(5)
        }, 7400),
      )

      // Step 9: pause + restart.
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return
          run()
        }, 11000),
      )
    }

    run()

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
    }
  }, [t])

  const visibleBubbles = bubbles.slice(0, visibleCount)

  return (
    <div className="relative mx-auto w-full max-w-md">
      {/* Ambient glow behind the widget — matches the saffron/turquoise brand wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10"
      >
        <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-tr from-saffron/10 via-transparent to-turquoise/10 blur-2xl" />
      </div>

      {/* The widget card — shaped like the real Sukhan widget */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-ink/5">
        {/* Header — tab-shaped (recurrent visual motif) */}
        <div className="relative flex items-center gap-3 bg-ink px-4 py-3 text-ink-foreground">
          {/* Saffron tab "tail" at top-start — the launcher shape motif */}
          <div
            aria-hidden
            className="absolute -top-px start-4 h-2 w-12 rounded-b-md bg-saffron"
          />
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-saffron/20 ring-2 ring-saffron/30">
            <MessageSquareText className="h-4 w-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight">Sukhan</span>
            <span className="flex items-center gap-1 text-[11px] text-ink-foreground/70">
              <span className="h-1.5 w-1.5 rounded-full bg-turquoise animate-saffron-pulse" />
              {t('poweredBy')}
            </span>
          </div>
        </div>

        {/* Message stream */}
        <div className="flex h-[360px] flex-col gap-3 overflow-y-auto bg-background p-4 scroll-thin">
          <AnimatePresence initial={false}>
            {visibleBubbles.map((b) => (
              <Bubble key={b.id} bubble={b} />
            ))}
          </AnimatePresence>

          {/* Typing indicator */}
          <AnimatePresence>
            {isTyping && <TypingBubble />}
          </AnimatePresence>
        </div>

        {/* Input row */}
        <div className="flex items-center gap-2 border-t border-border bg-card px-3 py-2.5">
          <div className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-xs text-muted-foreground">
            {t('inputPlaceholder')}
          </div>
          <button
            type="button"
            aria-label="Send"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-saffron text-saffron-foreground transition-transform hover:scale-105"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function Bubble({ bubble }: { bubble: Bubble }) {
  const isVisitor = bubble.type === 'visitor'
  const isAI = bubble.type === 'ai'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={cn(
        'flex flex-col gap-1',
        isVisitor ? 'items-end' : 'items-start',
      )}
    >
      {isAI && (
        <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-turquoise">
          AI
        </span>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm',
          isVisitor
            ? 'rounded-br-sm bg-saffron text-saffron-foreground'
            : isAI
              ? 'rounded-bl-sm bg-turquoise/10 text-foreground ring-1 ring-turquoise/30'
              : 'rounded-bl-sm bg-secondary text-secondary-foreground',
        )}
      >
        {bubble.text}
      </div>
    </motion.div>
  )
}

function TypingBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-start"
    >
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-secondary px-3.5 py-2.5 shadow-sm">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
            transition={{
              duration: 1,
              repeat: Infinity,
              delay: i * 0.15,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>
    </motion.div>
  )
}
