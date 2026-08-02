'use client'

import { useSession } from 'next-auth/react'
import { AuthScreen } from '@/components/auth/auth-screen'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { LoadingScreen } from '@/components/loading-screen'

export default function Home() {
  const { data: session, status } = useSession()

  if (status === 'loading') return <LoadingScreen />
  if (!session) return <AuthScreen />
  return <DashboardShell />
}
