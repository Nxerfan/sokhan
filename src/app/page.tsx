'use client'

import { useSession } from 'next-auth/react'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { LoadingScreen } from '@/components/loading-screen'
import { MarketingNav } from '@/components/marketing/marketing-nav'
import { MarketingFooter } from '@/components/marketing/marketing-footer'
import { AuthModal } from '@/components/marketing/auth-modal'
import { MarketingHome } from '@/components/marketing/home/marketing-home'

/**
 * Root route. Two states:
 *  - Authenticated → dashboard (DashboardShell + its own nav rail).
 *  - Unauthenticated → marketing homepage, with nav + footer + auth modal.
 *
 * The auth modal (triggered by "Sign up" / "Log in" buttons) handles both
 * the legacy password login and the new OTP signup flow.
 */
export default function Home() {
  const { data: session, status } = useSession()

  if (status === 'loading') return <LoadingScreen />
  if (session) return <DashboardShell />

  return (
    <>
      <MarketingNav />
      <main className="flex flex-1 flex-col">
        <MarketingHome />
      </main>
      <MarketingFooter />
      <AuthModal />
    </>
  )
}
