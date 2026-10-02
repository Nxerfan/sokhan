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

test('verify-conversation endpoint fails closed on invalid type', () => {
  const txt = readFileSync(join(root, 'src/app/api/realtime/verify-conversation/route.ts'), 'utf8')
  // Must validate type — only 'agent' and 'visitor' are accepted.
  expect(txt).toMatch(/type\s*!==\s*['"]agent['"]\s*&&\s*type\s*!==\s*['"]visitor['"]/)
  // Must return 400 on invalid type.
  expect(txt).toMatch(/invalid_type/)
})

test('verify-conversation endpoint rejects visitor without contactId', () => {
  const txt = readFileSync(join(root, 'src/app/api/realtime/verify-conversation/route.ts'), 'utf8')
  // Visitor MUST have a contactId — reject if missing.
  expect(txt).toMatch(/type\s*===\s*['"]visitor['"]\s*&&\s*!contactId/)
  expect(txt).toMatch(/missing_contact_id/)
  // The contactId filter must be applied for visitors (not silently skipped).
  expect(txt).toMatch(/where\.contactId\s*=\s*contactId/)
})

test('Docker compose files set APP_INTERNAL_URL=http://app:3000 for realtime service', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.lite.yml']) {
    const txt = readFileSync(join(root, f), 'utf8')
    expect(txt).toContain('APP_INTERNAL_URL: http://app:3000')
  }
})

test('mini-services/realtime does not hardcode localhost:3000 for app communication', () => {
  const txt = readFileSync(join(root, 'mini-services/realtime/index.ts'), 'utf8')
  // The /internal/verify-conversation proxy must use APP_INTERNAL_URL,
  // not a hardcoded http://localhost:3000 in the fetch URL construction.
  // The ONLY allowed occurrence is the dev-mode fallback in the variable
  // declaration: `process.env.APP_INTERNAL_URL || 'http://localhost:3000'`.
  // (Docker compose overrides this via env var, so the fallback never
  // kicks in inside a container.)
  const codeLines = txt.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('//') && !l.startsWith('*'))
  // Find lines that mention localhost:3000.
  const offenders = codeLines.filter((l) => /http:\/\/localhost:3000/.test(l))
  // Allow ONLY the variable-declaration fallback (env var with || default).
  for (const line of offenders) {
    expect(line).toMatch(/APP_INTERNAL_URL\s*\|\|\s*['"]http:\/\/localhost:3000['"]/)
  }
})

test('widget [slug]/script: NO io("/api/realtime"...) namespace bug on Vercel', () => {
  const txt = readFileSync(join(root, 'src/app/api/widget/[slug]/script/route.ts'), 'utf8')
  // The GET handler must NOT bake "/api/realtime" as the SOCKET_URL on Vercel.
  // (Vercel uses the __API_URL__ placeholder which the script replaces with
  // the Sukhan origin at runtime, then connects via path /api/realtime/socket.io.)
  expect(txt).toContain('__API_URL__')
  expect(txt).not.toMatch(/VERCEL\s*===\s*['"]1['"]\s*\)\s*\?\s*['"]\/api\/realtime['"]/)
})

test('widget v1/sukhan.js: NO io("/api/realtime"...) namespace bug on Vercel', () => {
  const txt = readFileSync(join(root, 'src/app/api/widget/v1/sukhan.js/route.ts'), 'utf8')
  expect(txt).toContain('__API_URL__')
  // The fallback for Vercel must NOT be the Caddy pattern.
  // (The Caddy pattern falls through only when NOT on Vercel.)
  expect(txt).not.toMatch(/VERCEL\s*===\s*['"]1['"]\s*\)\s*\?\s*['"]\/api\/realtime['"]/)
})

test('realtime-client.ts: Vercel uses empty URL + /api/realtime/socket.io path (no namespace bug)', () => {
  const txt = readFileSync(join(root, 'src/lib/realtime-client.ts'), 'utf8')
  // Vercel mode must return an empty URL (default namespace).
  expect(txt).toMatch(/return\s*\{\s*url:\s*['"]['"]/)
  // Vercel path must be /api/realtime/socket.io.
  expect(txt).toMatch(/path:\s*['"]\/api\/realtime\/socket\.io['"]/)
  // Must NOT return "/api/realtime" as the URL on Vercel.
  expect(txt).not.toMatch(/VERCEL\s*===\s*['"]1['"]\s*.*return\s*['"]\/api\/realtime['"]/)
})

test('inbox-view.tsx: Vercel uses empty URL + /api/realtime/socket.io path (no namespace bug)', () => {
  const txt = readFileSync(join(root, 'src/components/dashboard/views/inbox-view.tsx'), 'utf8')
  // Vercel mode must use empty socketUrl (default namespace).
  expect(txt).toMatch(/isVercel\s*\?\s*['"]['"]/)
  expect(txt).toMatch(/isVercel\s*\|\|\s*isApiRealtime\s*\?\s*['"]\/api\/realtime\/socket\.io['"]/)
  // Must NOT pass "/api/realtime" as URL on Vercel.
  expect(txt).not.toMatch(/isVercel\s*\?\s*['"]\/api\/realtime['"]/)
})


test('slug widget REST URLs are prefixed with API_URL (cross-origin support)', () => {
  const txt = readFileSync(join(root, 'src/app/api/widget/[slug]/script/route.ts'), 'utf8')
  // All REST endpoints must be prefixed with API_URL so the widget works
  // when embedded on a customer's website (different origin from the
  // Sukhan app). When API_URL is empty (script src couldn't be resolved),
  // the URLs become relative — which works behind Caddy reverse proxy.
  expect(txt).toMatch(/var CONFIG_URL = API_URL \+ ["']\/api\/widget\/["']/)
  expect(txt).toMatch(/var CONTACT_URL = API_URL \+ ["']\/api\/widget\/["']/)
  expect(txt).toMatch(/var MESSAGES_URL = API_URL \+ ["']\/api\/widget\/["']/)
  expect(txt).toMatch(/var CSAT_URL = API_URL \+ ["']\/api\/widget\/["']/)
  // The CSAT fetch must use the CSAT_URL variable (not a hardcoded path).
  expect(txt).toMatch(/fetch\(CSAT_URL,/)
  // Must NOT have hardcoded relative REST URLs.
  expect(txt).not.toMatch(/var CONFIG_URL = ["']\/api\/widget\/["']/)
  expect(txt).not.toMatch(/var CONTACT_URL = ["']\/api\/widget\/["']/)
  expect(txt).not.toMatch(/var MESSAGES_URL = ["']\/api\/widget\/["']/)
})

test('slug widget Docker-mode SOCKET_URL uses API_URL prefix (cross-origin support)', () => {
  const txt = readFileSync(join(root, 'src/app/api/widget/[slug]/script/route.ts'), 'utf8')
  // In Docker/dev mode (no Vercel, no explicit URL), the SOCKET_URL must
  // be baked as the runtime JavaScript expression `API_URL + "/?XTransformPort=3003"`
  // (NOT a JSON string). This makes the socket URL absolute (prefixed
  // with API_URL) so the widget works on a customer's website.
  // Match the literal: bakedSocketUrlExpr = 'API_URL + "/?XTransformPort=3003"'
  // Use a template literal to avoid quote-escaping headaches.
  expect(txt).toContain(`bakedSocketUrlExpr = 'API_URL + "/?XTransformPort=3003"'`)
})
