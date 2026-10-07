/**
 * Reconnect regression tests — real Socket.IO protocol-level testing.
 *
 * These tests connect a real Socket.IO client to the Docker realtime
 * service and verify authentication/authorization middleware behavior.
 *
 * Run in BOTH Full and Lite Docker stacks.
 */

import { test, expect, type Page } from '@playwright/test'
import { execSync } from 'child_process'
import { otpSignupPlaywright } from './helpers/otp-signup'

const BASE = 'http://127.0.0.1:81'

async function signupAndSignIn(page: Page, email: string, workspace: string): Promise<void> {
  await otpSignupPlaywright(page.request, BASE, email, workspace)
  const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
    form: { email, password: 'password123', csrfToken },
  })
  if (!signinRes.ok()) throw new Error(`signin failed: ${signinRes.status()}`)
}

/**
 * Helper: load socket.io client into the page if not already loaded.
 */
async function ensureSocketIO(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (typeof (window as any).io !== 'function') {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = '/socket.io.min.js'
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('Failed to load socket.io'))
        document.head.appendChild(s)
      })
    }
  })
}

/**
 * Helper: connect a Socket.IO client with a given auth token.
 * Returns a promise that resolves with { connected, error }.
 */
async function connectWithToken(
  page: Page,
  token: string,
  timeoutMs: number = 6000,
): Promise<{ connected: boolean; error?: string }> {
  return page.evaluate(async ({ token, timeoutMs }) => {
    const io = (window as any).io
    return new Promise<{ connected: boolean; error?: string }>((resolve) => {
      const socket = io('/?XTransformPort=3003', {
        path: '/',
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 5000,
      })
      const timeout = setTimeout(() => {
        socket.disconnect()
        resolve({ connected: false, error: 'timeout' })
      }, timeoutMs)
      socket.on('connect', () => {
        clearTimeout(timeout)
        socket.disconnect()
        resolve({ connected: true })
      })
      socket.on('connect_error', (err: Error) => {
        clearTimeout(timeout)
        resolve({ connected: false, error: err.message })
      })
    })
  }, { token, timeoutMs })
}

/**
 * Helper: deactivate a membership via test-only DB access.
 * Uses docker compose exec to run a Prisma command inside the app container.
 */
async function deactivateMembership(userId: string, tenantId: string): Promise<void> {
  // Try Full compose first, then Lite
  const commands = [
    `docker compose -f docker-compose.yml -f docker-compose.test.yml exec -T app node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.membership.updateMany({where:{userId:'${userId}',tenantId:'${tenantId}'},data:{status:'inactive'}}).then(()=>p.\\$disconnect()).then(()=>process.exit(0))"`,
    `docker compose -f docker-compose.lite.yml -f docker-compose.lite.test.yml exec -T app node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.membership.updateMany({where:{userId:'${userId}',tenantId:'${tenantId}'},data:{status:'inactive'}}).then(()=>p.\\$disconnect()).then(()=>process.exit(0))"`,
  ]
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 15000, stdio: 'pipe' })
      return
    } catch {
      // Try next compose file
    }
  }
  throw new Error('Failed to deactivate membership via docker compose exec')
}

/**
 * A. Auth middleware: valid token connects, invalid token rejected.
 *
 * Uses a real Socket.IO client to prove:
 * 1. A valid agent token connects successfully
 * 2. An invalid token is rejected with connect_error: invalid_token
 */
test('auth middleware: valid token connects, invalid token rejected', async ({ page }) => {
  const email = `auth-${Date.now()}@test.com`
  const workspace = `Auth${Date.now()}`
  await signupAndSignIn(page, email, workspace)

  await page.goto(`${BASE}/`)
  await page.waitForLoadState('networkidle')
  await ensureSocketIO(page)

  // Fetch a valid realtime token
  const tokenData = await page.evaluate(async () => {
    const res = await fetch('/api/realtime-token')
    return res.ok ? await res.json() : null
  })
  expect(tokenData).toBeTruthy()
  expect(tokenData.token).toBeTruthy()

  // Valid token must connect
  const validResult = await connectWithToken(page, tokenData.token)
  expect(validResult.connected).toBe(true)

  // Invalid token must be rejected with 'invalid_token'
  const invalidResult = await connectWithToken(page, 'invalid-token-xyz')
  expect(invalidResult.connected).toBe(false)
  expect(invalidResult.error).toBe('invalid_token')
})

/**
 * B. Membership authorization: active connects, inactive is rejected.
 *
 * Uses test-only DB access to deactivate the agent's membership, then
 * verifies the server middleware rejects the fresh handshake with
 * membership_inactive.
 */
test('membership authorization: active connects, inactive rejected with membership_inactive', async ({ page }) => {
  const email = `inactive-${Date.now()}@test.com`
  const workspace = `Inactive${Date.now()}`
  await signupAndSignIn(page, email, workspace)

  await page.goto(`${BASE}/`)
  await page.waitForLoadState('networkidle')
  await ensureSocketIO(page)

  // Fetch session to get userId and tenantId
  const session = await page.evaluate(async () => {
    const res = await fetch('/api/auth/session')
    return res.ok ? await res.json() : null
  })
  expect(session).toBeTruthy()
  const userId = session?.user?.id
  const tenantId = session?.user?.workspaceId
  expect(userId).toBeTruthy()
  expect(tenantId).toBeTruthy()

  // Fetch a valid realtime token
  const tokenData = await page.evaluate(async () => {
    const res = await fetch('/api/realtime-token')
    return res.ok ? await res.json() : null
  })
  expect(tokenData).toBeTruthy()

  // Step 1: Active membership → connect succeeds
  const activeResult = await connectWithToken(page, tokenData.token)
  expect(activeResult.connected).toBe(true)

  // Step 2: Deactivate the membership via test-only DB access
  await deactivateMembership(userId, tenantId)

  // Step 3: Same valid token, but membership is now inactive
  // The server middleware must reject with membership_inactive
  const inactiveResult = await connectWithToken(page, tokenData.token)
  expect(inactiveResult.connected).toBe(false)
  expect(inactiveResult.error).toBe('membership_inactive')
})
