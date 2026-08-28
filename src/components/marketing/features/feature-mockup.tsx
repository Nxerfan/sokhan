'use client'

import {
  MessageSquareText,
  Check,
  Star,
  Bot,
  CreditCard,
  CircleDot,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type MockupKind =
  | 'chat'
  | 'faq'
  | 'product'
  | 'routing'
  | 'analytics'
  | 'csat'
  | 'widget'
  | 'billing'

interface FeatureMockupProps {
  kind: MockupKind
  accent: 'saffron' | 'turquoise'
}

/**
 * Stylized CSS-only mockup for each feature section. No real data — these
 * are decorative visuals that hint at what the feature looks like.
 *
 * Each mockup is wrapped in a "browser-frame" container (rounded corners +
 * subtle border + a top-bar with three dots) for visual consistency.
 */
export function FeatureMockup({ kind, accent }: FeatureMockupProps) {
  return (
    <div className="relative">
      {/* Ambient glow */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-4 -z-10 rounded-3xl blur-2xl',
          accent === 'saffron' ? 'bg-saffron/10' : 'bg-turquoise/10',
        )}
      />
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg shadow-ink/5">
        {/* Browser frame top bar */}
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-destructive/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-saffron/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-turquoise/60" />
          <div className="ms-2 h-4 flex-1 rounded-full bg-background/70" />
        </div>
        <div className="p-6">
          <MockupContent kind={kind} accent={accent} />
        </div>
      </div>
    </div>
  )
}

function MockupContent({ kind, accent }: FeatureMockupProps) {
  switch (kind) {
    case 'chat':
      return <ChatMockup accent={accent} />
    case 'faq':
      return <FaqMockup accent={accent} />
    case 'product':
      return <ProductMockup accent={accent} />
    case 'routing':
      return <RoutingMockup accent={accent} />
    case 'analytics':
      return <AnalyticsMockup accent={accent} />
    case 'csat':
      return <CsatMockup accent={accent} />
    case 'widget':
      return <WidgetMockup accent={accent} />
    case 'billing':
      return <BillingMockup accent={accent} />
  }
}

// ============ Individual mockups ============

function Bubble({
  side,
  children,
  variant = 'agent',
}: {
  side: 'start' | 'end'
  children: React.ReactNode
  variant?: 'agent' | 'visitor' | 'ai'
}) {
  return (
    <div className={cn('flex', side === 'end' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-1.5 text-xs',
          variant === 'visitor'
            ? 'rounded-br-sm bg-saffron text-saffron-foreground'
            : variant === 'ai'
              ? 'rounded-bl-sm bg-turquoise/10 ring-1 ring-turquoise/30'
              : 'rounded-bl-sm bg-secondary text-secondary-foreground',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function ChatMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
        <div
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full',
            accent === 'saffron' ? 'bg-saffron/20' : 'bg-turquoise/20',
          )}
        >
          <MessageSquareText className="h-3.5 w-3.5" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold">Sukhan Support</span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-turquoise" />
            Online
          </span>
        </div>
      </div>
      <Bubble side="start">Hi! How can we help today?</Bubble>
      <Bubble side="end" variant="visitor">
        Do you ship to Karaj?
      </Bubble>
      <Bubble side="start">Yes! Same-day inside Karaj.</Bubble>
      <div className="mt-2 flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-[11px] text-muted-foreground">
        Type a message…
      </div>
    </div>
  )
}

function FaqMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  const faqs = [
    'Do you ship to Karaj?',
    'What is your return policy?',
    'How much is shipping?',
  ]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <Bot
          className={cn(
            'h-4 w-4',
            accent === 'saffron' ? 'text-saffron' : 'text-turquoise',
          )}
        />
        <span className="text-xs font-semibold">FAQ matcher</span>
        <span className="ms-auto rounded-full bg-turquoise/15 px-2 py-0.5 text-[10px] font-medium text-turquoise">
          94% match
        </span>
      </div>
      <div className="rounded-lg border border-turquoise/40 bg-turquoise/5 p-2.5">
        <p className="text-[11px] font-medium text-turquoise">
          Visitor: “Do you deliver to Karaj?”
        </p>
      </div>
      {faqs.map((q, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-2 rounded-lg border px-2.5 py-2',
            i === 0
              ? 'border-turquoise/50 bg-turquoise/10'
              : 'border-border bg-background',
          )}
        >
          <Check
            className={cn(
              'h-3.5 w-3.5',
              i === 0 ? 'text-turquoise' : 'text-muted-foreground/50',
            )}
          />
          <span className="text-xs text-foreground">{q}</span>
        </div>
      ))}
    </div>
  )
}

function ProductMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-semibold">Product knowledge</span>
        <span className="ms-auto rounded-full bg-saffron/15 px-2 py-0.5 text-[10px] font-medium text-saffron">
          grounded
        </span>
      </div>
      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-md',
              accent === 'saffron' ? 'bg-saffron/15' : 'bg-turquoise/15',
            )}
          >
            <span className="text-lg">🎧</span>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-semibold">Sony WH-1000XM5</span>
            <span className="text-xs text-muted-foreground">
              Wireless noise-canceling headphones
            </span>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-display text-sm font-semibold">
                12,500,000
              </span>
              <span className="text-[10px] text-muted-foreground">Toman</span>
              <span className="ms-auto rounded-full bg-turquoise/15 px-2 py-0.5 text-[10px] font-medium text-turquoise">
                In stock
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="rounded-lg bg-muted/40 p-2.5">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">Q:</span> How much is
          the headphone?
        </p>
        <p className="mt-1 text-[11px]">
          <span className="font-semibold text-turquoise">A:</span> The Sony
          WH-1000XM5 is 12,500,000 Toman and currently in stock.
        </p>
      </div>
    </div>
  )
}

function RoutingMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  const steps = [
    { label: 'Visitor message', sub: '"I need help with billing"' },
    { label: 'Match: keyword', sub: 'billing → Billing dept' },
    { label: 'Assign to', sub: 'Sara (online)' },
  ]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-semibold">Routing rule #3</span>
        <span className="ms-auto rounded-full bg-saffron/15 px-2 py-0.5 text-[10px] font-medium text-saffron">
          active
        </span>
      </div>
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
              accent === 'saffron'
                ? 'bg-saffron/15 text-saffron'
                : 'bg-turquoise/15 text-turquoise',
            )}
          >
            {i + 1}
          </div>
          <div className="flex flex-1 flex-col">
            <span className="text-xs font-medium">{step.label}</span>
            <span className="text-[11px] text-muted-foreground" dir="ltr">
              {step.sub}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="absolute" aria-hidden>
              {/* spacer */}
            </div>
          )}
        </div>
      ))}
      <div className="mt-1 rounded-lg border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
        Evaluated in order · first match wins · drag to reorder
      </div>
    </div>
  )
}

function AnalyticsMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  const bars = [40, 65, 50, 80, 75, 95, 60]
  const labels = ['S', 'S', 'M', 'T', 'W', 'T', 'F']
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <span className="text-xs font-semibold">Conversations this week</span>
        <span className="text-[11px] text-turquoise">+18%</span>
      </div>
      <div className="flex h-32 items-end justify-between gap-1.5">
        {bars.map((h, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={cn(
                'w-full rounded-t',
                accent === 'saffron' ? 'bg-saffron/70' : 'bg-turquoise/70',
                i === 5 && 'ring-2 ring-foreground/20',
              )}
              style={{ height: `${h}%` }}
            />
            <span className="text-[9px] text-muted-foreground">{labels[i]}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-border pt-2">
        <Stat label="Volume" value="478" />
        <Stat label="Avg. response" value="42s" />
        <Stat label="CSAT" value="4.6" />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-display text-sm font-semibold">{value}</span>
    </div>
  )
}

function CsatMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-border pb-2">
        <span className="text-xs font-semibold">How did we do?</span>
        <p className="text-[11px] text-muted-foreground">
          Rate your conversation
        </p>
      </div>
      <div className="flex justify-center gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={cn(
              'h-7 w-7 transition-transform',
              n <= 4
                ? accent === 'saffron'
                  ? 'fill-saffron text-saffron'
                  : 'fill-turquoise text-turquoise'
                : 'fill-none text-muted-foreground/40',
            )}
          />
        ))}
      </div>
      <div className="rounded-lg bg-turquoise/10 p-2.5 text-center">
        <span className="text-[11px] text-turquoise">
          Thanks! Your feedback helps us improve.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border pt-2 text-center">
        <Stat label="Avg. CSAT" value="4.6 / 5" />
        <Stat label="Responses" value="312" />
      </div>
    </div>
  )
}

function WidgetMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  const shapes = [
    { name: 'Tab', cls: 'rounded-b-md rounded-t-none' },
    { name: 'Rounded', cls: 'rounded-lg' },
    { name: 'Pill', cls: 'rounded-full' },
  ]
  const colors = ['bg-saffron', 'bg-turquoise', 'bg-ink', 'bg-destructive']
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-semibold">Widget appearance</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Launcher shape
        </span>
        <div className="flex items-end gap-3">
          {shapes.map((s, i) => (
            <div key={s.name} className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'h-10 w-10',
                  s.cls,
                  accent === 'saffron' ? 'bg-saffron' : 'bg-turquoise',
                  i === 0 && 'ring-2 ring-foreground/30 ring-offset-2',
                )}
              />
              <span className="text-[10px] text-muted-foreground">{s.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Accent color
        </span>
        <div className="flex items-center gap-2">
          {colors.map((c, i) => (
            <div
              key={c}
              className={cn(
                'h-7 w-7 rounded-full',
                c,
                i === 0 && 'ring-2 ring-foreground/40 ring-offset-2',
              )}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-2">
        <CircleDot className="h-3.5 w-3.5 text-turquoise" />
        <span className="text-[11px] text-muted-foreground">
          Live preview updates as you change settings
        </span>
      </div>
    </div>
  )
}

function BillingMockup({ accent }: { accent: 'saffron' | 'turquoise' }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <span className="text-xs font-semibold">Pro plan</span>
        <span className="rounded-full bg-turquoise/15 px-2 py-0.5 text-[10px] font-medium text-turquoise">
          Active
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-display text-2xl font-bold">290,000</span>
        <span className="text-xs text-muted-foreground">Toman / month</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {['5 agents', '1,000 conversations / mo', '500 AI actions / mo'].map(
          (f) => (
            <div key={f} className="flex items-center gap-2 text-[11px]">
              <Check
                className={cn(
                  'h-3 w-3',
                  accent === 'saffron' ? 'text-saffron' : 'text-turquoise',
                )}
              />
              <span>{f}</span>
            </div>
          ),
        )}
      </div>
      <div className="border-t border-border pt-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Payment gateway
        </span>
        <div className="mt-1.5 flex items-center gap-2">
          {['ZarinPal', 'IDPay', 'ZarinLink'].map((g, i) => (
            <div
              key={g}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium',
                i === 0
                  ? 'border-saffron/50 bg-saffron/10 text-saffron'
                  : 'border-border bg-background text-muted-foreground',
              )}
            >
              <CreditCard className="h-3 w-3" />
              {g}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
