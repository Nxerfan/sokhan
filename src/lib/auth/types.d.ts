import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      workspaceId: string | null
      role: string
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    workspaceId?: string | null
    role?: string
  }
}
