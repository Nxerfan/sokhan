'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageSquare, Terminal, Copy, Check, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

// ============ Prompt texts (hardcoded — long-form, locale-independent) ============

const WEB_PROMPT = `You are an expert web developer assistant. I need you to integrate the Sukhan live chat widget into my website.

## Context
Sukhan is a live chat SaaS platform. The widget can be embedded on any website using either an NPM package or a script tag.

## Installation Methods

### Method 1: NPM Package (React/Next.js/Vue/etc.)
\`\`\`bash
npm install sukhan-widget
# or
bun add sukhan-widget
\`\`\`

Then add to your environment variables:
\`\`\`
SUKHAN_API_KEY=sk_your-workspace-slug
\`\`\`

Then import it in your app:
\`\`\`jsx
// React/Next.js — just import, it auto-initializes
import 'sukhan-widget';
\`\`\`

For Next.js, make sure to use it in a client component:
\`\`\`jsx
'use client';
import 'sukhan-widget';

export function ChatWidget() {
  return null; // The widget auto-mounts itself
}
\`\`\`

### Method 2: HTML Script Tag (WordPress, Shopify, static HTML, etc.)
Add this before the closing </body> tag:
\`\`\`html
<script async defer src="https://your-sukhan-domain/api/widget/v1/sukhan.js" data-api-key="sk_your-workspace-slug"></script>
\`\`\`

## Platform-Specific Instructions

### WordPress
1. Go to Appearance → Theme Editor (or use a plugin like "Insert Headers and Footers")
2. Find the footer.php file
3. Add the script tag before </body>
4. Save changes

### Shopify
1. Go to Online Store → Themes → Edit Code
2. Find theme.liquid in the Layout folder
3. Add the script tag before </body>
4. Save

### Static HTML
1. Open your HTML file
2. Add the script tag before </body>
3. Upload to your server

## Configuration Options
The widget supports these options (Pro plan and above):
- Custom accent color
- Launcher shape (tab, rounded, pill)
- Position (bottom-start, bottom-end)
- Custom avatar/logo
- Bilingual greetings (Persian + English)

Free plan: customization is locked to Sukhan brand defaults with a "Powered by Sukhan" badge.

## What I need you to do:
1. Tell me which installation method is best for my platform
2. Give me the EXACT code to copy-paste
3. Tell me where to put it in my specific platform
4. Explain any platform-specific gotchas
5. Tell me how to test that it's working

My platform is: [TELL THE AI YOUR PLATFORM - e.g., WordPress, Shopify, plain HTML, React, Next.js, etc.]
My Sukhan API key is: [PASTE YOUR API KEY HERE - format: sk_your-workspace-slug]`

const CLI_PROMPT = `You are an expert coding agent. Your task is to set up and integrate the Sukhan live chat widget into this project automatically.

## What is Sukhan
Sukhan is a live chat SaaS platform. The widget is installed via an NPM package called "sukhan-widget" or via a script tag.

## YOUR INSTRUCTIONS — DO EVERYTHING AUTOMATICALLY

### Step 1: Determine the project type
Examine the project files to determine:
- Is this a Next.js project? (check for next.config.js/ts, package.json with "next" dependency)
- Is this a React project? (check for package.json with "react" but no "next")
- Is this a Vue project?
- Is this a plain HTML project?
- Is this a WordPress/PHP project?

### Step 2: Install the package (for JS projects)
Run the appropriate install command:
\`\`\`bash
# If bun is available:
bun add sukhan-widget

# Otherwise:
npm install sukhan-widget
\`\`\`

### Step 3: Add the environment variable
Check if a .env file exists. If not, create one.
Add this line to .env (or .env.local for Next.js):
\`\`\`
SUKHAN_API_KEY=sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY
\`\`\`

IMPORTANT: Use "sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY" as the value so the user knows to replace it.
Do NOT make up a fake key. The user will enter their real key.

### Step 4: Integrate based on project type

#### If Next.js:
Create or edit a client component (e.g., src/components/SukhanWidget.tsx):
\`\`\`tsx
'use client'
import 'sukhan-widget'

export function SukhanWidget() {
  return null
}
\`\`\`

Then import and render it in the root layout (src/app/layout.tsx for App Router, or _app.tsx for Pages Router):
\`\`\`tsx
import { SukhanWidget } from '@/components/SukhanWidget'

// Add <SukhanWidget /> inside the <body> tag, after {children}
\`\`\`

For Next.js, also add NEXT_PUBLIC_ prefix to the env var so it's available client-side:
\`\`\`
NEXT_PUBLIC_SUKHAN_API_KEY=sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY
SUKHAN_API_KEY=sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY
\`\`\`

#### If React (Vite, CRA, etc.):
Add to src/main.tsx or src/index.tsx (the entry point):
\`\`\`tsx
import 'sukhan-widget'
\`\`\`

Make sure VITE_SUKHAN_API_KEY is set (Vite requires VITE_ prefix):
\`\`\`
VITE_SUKHAN_API_KEY=sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY
\`\`\`

#### If plain HTML:
Add before </body> in every HTML file:
\`\`\`html
<script async defer src="https://your-sukhan-domain/api/widget/v1/sukhan.js" data-api-key="sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY"></script>
\`\`\`

#### If WordPress/PHP:
Add to functions.php or header.php:
\`\`\`php
<?php
add_action('wp_footer', function() {
    echo '<script async defer src="https://your-sukhan-domain/api/widget/v1/sukhan.js" data-api-key="sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY"></script>';
});
?>
\`\`\`

### Step 5: Verify
After making all changes, run the dev server and verify the widget launcher appears in the bottom corner of the page.

### Step 6: Report
Tell the user:
1. What you did (files created/modified)
2. That they need to replace "sk_PLACEHOLDER_REPLACE_WITH_YOUR_KEY" in .env with their real API key
3. How to get their API key (from the Sukhan dashboard → Settings → Widget)
4. How to test (run the dev server, look for the chat icon in the corner)

## IMPORTANT RULES
- Do NOT ask me questions. Figure out the project type yourself.
- Do NOT wait for my confirmation. Make all changes immediately.
- Do NOT skip any step.
- The ONLY thing I should need to do is replace the placeholder API key with my real one.
- If something fails, try to fix it yourself before reporting.`


export function PromptSection() {
  const t = useTranslations('marketing.doc.prompts')
  const [activeTab, setActiveTab] = useState<'web' | 'cli'>('web')
  const [copied, setCopied] = useState(false)

  const currentPrompt = activeTab === 'web' ? WEB_PROMPT : CLI_PROMPT

  function copyPrompt() {
    navigator.clipboard.writeText(currentPrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      {/* Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-xl border border-border bg-card p-1">
          <button
            onClick={() => setActiveTab('web')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all',
              activeTab === 'web'
                ? 'bg-saffron text-saffron-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <MessageSquare className="h-4 w-4" />
            {t('webTab')}
          </button>
          <button
            onClick={() => setActiveTab('cli')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all',
              activeTab === 'cli'
                ? 'bg-saffron text-saffron-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Terminal className="h-4 w-4" />
            {t('cliTab')}
          </button>
        </div>

        <button
          onClick={copyPrompt}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 text-turquoise" />
              {t('copied')}
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              {t('copy')}
            </>
          )}
        </button>
      </div>

      {/* Description */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-saffron" />
          <div>
            <p className="text-sm font-medium">
              {activeTab === 'web' ? t('webTitle') : t('cliTitle')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {activeTab === 'web' ? t('webDescription') : t('cliDescription')}
            </p>
          </div>
        </div>
      </div>

      {/* Prompt content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          <div className="relative rounded-2xl border border-border bg-ink overflow-hidden">
            {/* Terminal-style header bar */}
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-red-500/80" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
                <div className="h-3 w-3 rounded-full bg-green-500/80" />
              </div>
              <span className="ms-2 font-mono text-xs text-white/50">
                {activeTab === 'web' ? 'sukhan-web-prompt.txt' : 'sukhan-cli-prompt.txt'}
              </span>
            </div>

            {/* Scrollable prompt content */}
            <div className="max-h-[500px] overflow-y-auto scroll-thin p-4 sm:p-6">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-white/80" dir="ltr">
                <code>{currentPrompt}</code>
              </pre>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
