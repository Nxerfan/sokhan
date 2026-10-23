import { create } from 'zustand'

export type AuthMode = 'login' | 'signup'

interface AuthModalState {
  isOpen: boolean
  mode: AuthMode
  /** Optional URL to redirect to after a successful login/signup. Defaults to
   *  `'/'` when not set. Used by the /invite flow so an invitee can sign in
   *  and land back on the invitation-acceptance page in one go. */
  callbackUrl: string | null
  open: (mode?: AuthMode, callbackUrl?: string | null) => void
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
  callbackUrl: null,
  open: (mode = 'signup', callbackUrl = null) =>
    set({ isOpen: true, mode, callbackUrl }),
  close: () => set({ isOpen: false, callbackUrl: null }),
  setMode: (mode) => set({ mode }),
}))
