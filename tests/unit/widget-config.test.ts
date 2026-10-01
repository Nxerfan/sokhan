/// <reference types="bun-types" />
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

test('widget [slug]/script defines SOCKET_PATH (not undefined)', () => {
  const f = join(root, 'src/app/api/widget/[slug]/script/route.ts')
  const txt = readFileSync(f, 'utf8')
  expect(txt).toContain('var SOCKET_PATH')
  expect(txt).not.toMatch(/path: SOCKET_PATH,\s*path:/)
})

test('widget v1/sukhan.js defines SOCKET_PATH (not undefined)', () => {
  const f = join(root, 'src/app/api/widget/v1/sukhan.js/route.ts')
  const txt = readFileSync(f, 'utf8')
  expect(txt).toContain('var SOCKET_PATH')
  expect(txt).not.toMatch(/path: SOCKET_PATH,\s*path:/)
})

test('widget SOCKET_PATH uses /api/realtime/socket.io for Vercel', () => {
  for (const f of [
    'src/app/api/widget/[slug]/script/route.ts',
    'src/app/api/widget/v1/sukhan.js/route.ts',
  ]) {
    const txt = readFileSync(join(root, f), 'utf8')
    expect(txt).toContain('/api/realtime/socket.io')
  }
})

test('realtime-client.ts uses /api/realtime/socket.io path', () => {
  const txt = readFileSync(join(root, 'src/lib/realtime-client.ts'), 'utf8')
  expect(txt).toContain('/api/realtime/socket.io')
})

test('inbox-view.tsx uses /api/realtime/socket.io path', () => {
  const txt = readFileSync(join(root, 'src/components/dashboard/views/inbox-view.tsx'), 'utf8')
  expect(txt).toContain('/api/realtime/socket.io')
})

test('api/realtime.ts does NOT set a custom path (uses default /socket.io)', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  expect(txt).not.toMatch(/path:\s*['"]\/api\/realtime['"]/)
})

test('api/realtime.ts does NOT fall back to dev secret', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  expect(txt).not.toContain('sukhan-dev-secret')
})

test('env-check.ts fails closed in production (process.exit)', () => {
  const txt = readFileSync(join(root, 'src/lib/env-check.ts'), 'utf8')
  expect(txt).toContain('process.exit(1)')
  // Must NOT set dev secret in production branch
  const prodBranch = txt.match(/NODE_ENV.*production[\s\S]*?else/)
  expect(prodBranch).toBeTruthy()
  expect(prodBranch![0]).toContain('process.exit')
  expect(prodBranch![0]).not.toContain('DEV_SECRET')
})

test('visitor authz: api/realtime.ts checks contactId for visitors', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  expect(txt).toContain("payload.type === 'visitor'")
  expect(txt).toContain('contactId')
})

test('typing/read events check rooms.has() in api/realtime.ts', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  expect(txt).toContain('rooms.has')
  // Should have 3 rooms.has checks (typing:start, typing:stop, message:read)
  const count = (txt.match(/rooms\.has/g) || []).length
  expect(count).toBeGreaterThanOrEqual(3)
})

test('typing/read events check rooms.has() in mini-services/realtime/index.ts', () => {
  const txt = readFileSync(join(root, 'mini-services/realtime/index.ts'), 'utf8')
  expect(txt).toContain('rooms.has')
  const count = (txt.match(/rooms\.has/g) || []).length
  expect(count).toBeGreaterThanOrEqual(3)
})

test('visitors do NOT join tenant room (only agents do)', () => {
  for (const [f, label] of [
    ['api/realtime.ts', 'Vercel'],
    ['mini-services/realtime/index.ts', 'Docker'],
  ] as [string, string][]) {
    const txt = readFileSync(join(root, f), 'utf8')
    // Find the connection handler — visitors should not join tenant room
    expect(txt).toMatch(/if \(payload\.type === ['"]agent['"]\)/)
  }
})

test('widget transports: websocket-only for Vercel, websocket+polling for Docker', () => {
  for (const f of [
    'src/app/api/widget/[slug]/script/route.ts',
    'src/app/api/widget/v1/sukhan.js/route.ts',
  ]) {
    const txt = readFileSync(join(root, f), 'utf8')
    expect(txt).toContain('"websocket"')
    expect(txt).toContain('"polling"')
    // Conditional transports based on SOCKET_URL
    expect(txt).toMatch(/SOCKET_URL\.indexOf.*\/api\/realtime/)
  }
})
