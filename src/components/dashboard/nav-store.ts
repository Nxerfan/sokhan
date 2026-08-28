'use client'

import { create } from 'zustand'

export type DashboardView =
  | 'inbox'
  | 'contacts'
  | 'analytics'
  | 'automation'
  | 'integrations'
  | 'members'
  | 'departments'
  | 'widget'
  | 'general'
  | 'billing'
  | 'faq'
  | 'products'
  | 'websites'

interface NavState {
  view: DashboardView
  setView: (v: DashboardView) => void
  commandOpen: boolean
  setCommandOpen: (o: boolean) => void
}

export const useDashboardStore = create<NavState>((set) => ({
  view: 'inbox',
  setView: (view) => set({ view }),
  commandOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}))
