import { create } from 'zustand'

export type AuthMode = 'login' | 'signup'

interface AuthModalState {
  isOpen: boolean
  mode: AuthMode
  open: (mode?: AuthMode) => void
  close: () => void
  setMode: (mode: AuthMode) => void
}

/**
 * Global auth-modal state. Lets any marketing page button trigger the auth
 * modal (sign-up or login) without prop drilling.
 */
export const useAuthModal = create<AuthModalState>((set) => ({
  isOpen: false,
  mode: 'signup',
  open: (mode = 'signup') => set({ isOpen: true, mode }),
  close: () => set({ isOpen: false }),
  setMode: (mode) => set({ mode }),
}))
