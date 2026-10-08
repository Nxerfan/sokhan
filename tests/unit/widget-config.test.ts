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

test('widget SOCKET_PATH uses /api/realtime for Vercel', () => {
  for (const f of [
    'src/app/api/widget/[slug]/script/route.ts',
    'src/app/api/widget/v1/sukhan.js/route.ts',
  ]) {
    const txt = readFileSync(join(root, f), 'utf8')
    expect(txt).toContain('/api/realtime')
    expect(txt).not.toContain("/api/realtime/socket.io")
  }
})

test('realtime-client.ts uses /api/realtime path', () => {
  const txt = readFileSync(join(root, 'src/lib/realtime-client.ts'), 'utf8')
  expect(txt).toContain("path: '/api/realtime'")
  expect(txt).not.toContain("path: '/api/realtime/socket.io'")
})

test('inbox-view.tsx uses /api/realtime path', () => {
  const txt = readFileSync(join(root, 'src/components/dashboard/views/inbox-view.tsx'), 'utf8')
  expect(txt).toContain("path: isVercel || isApiRealtime ? '/api/realtime' : '/'")
  expect(txt).not.toContain("/api/realtime/socket.io")
})

test('api/realtime.ts sets path to /api/realtime (Vercel does not strip prefix)', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  // Vercel does NOT strip the /api/realtime prefix — the function receives
  // the full URL. The Socket.IO path must match the rewritten URL (dest).
  expect(txt).toMatch(/path:\s*['"]\/api\/realtime['"]/)
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

test('realtime config: Vercel uses empty URL + /api/realtime path (no namespace bug)', () => {
  // The resolver now lives in src/lib/realtime-config.ts (shared single source
  // of truth). realtime-client.ts imports resolveRealtimeConfig() from it.
  const txt = readFileSync(join(root, 'src/lib/realtime-config.ts'), 'utf8')
  expect(txt).toMatch(/url:\s*['"]['"]/)
  expect(txt).toMatch(/path:\s*['"]\/api\/realtime['"]/)
  const clientTxt = readFileSync(join(root, 'src/lib/realtime-client.ts'), 'utf8')
  expect(clientTxt).toContain("import { resolveRealtimeConfig } from './realtime-config'")
})

test('inbox-view.tsx: Vercel uses empty URL + /api/realtime path (no namespace bug)', () => {
  const txt = readFileSync(join(root, 'src/components/dashboard/views/inbox-view.tsx'), 'utf8')
  // Vercel mode must use empty socketUrl (default namespace).
  expect(txt).toMatch(/isVercel\s*\?\s*['"]['"]/)
  expect(txt).toMatch(/isVercel\s*\|\|\s*isApiRealtime\s*\?\s*['"]\/api\/realtime['"]/)
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

test('vercel-install.sh DIRECT_URL: falls back to DATABASE_URL_UNPOOLED, fails closed otherwise', () => {
  const txt = readFileSync(join(root, 'vercel-install.sh'), 'utf8')
  // Must fall back to DATABASE_URL_UNPOOLED (Neon direct, non-pooled)
  expect(txt).toContain('export DIRECT_URL="$DATABASE_URL_UNPOOLED"')
  // Must NOT fall back to pooled DATABASE_URL
  expect(txt).not.toContain('export DIRECT_URL="$DATABASE_URL"')
  // Must fail closed if neither DIRECT_URL nor DATABASE_URL_UNPOOLED is set
  expect(txt).toContain('exit 1')
})



test('all Vercel clients use addTrailingSlash: false', () => {
  for (const f of [
    'src/lib/realtime-client.ts',
    'src/components/dashboard/views/inbox-view.tsx',
    'src/app/api/widget/[slug]/script/route.ts',
    'src/app/api/widget/v1/sukhan.js/route.ts',
  ]) {
    const txt = readFileSync(join(root, f), 'utf8')
    expect(txt).toContain('addTrailingSlash: false')
  }
})

test('api/realtime.ts server uses addTrailingSlash: false', () => {
  const txt = readFileSync(join(root, 'api/realtime.ts'), 'utf8')
  expect(txt).toContain('addTrailingSlash: false')
})

test('Vercel mode uses websocket-only transports (resolver in realtime-config.ts)', () => {
  // The resolver now lives in src/lib/realtime-config.ts (single source of truth).
  const cfgTxt = readFileSync(join(root, 'src/lib/realtime-config.ts'), 'utf8')
  expect(cfgTxt).toContain('NEXT_PUBLIC_VERCEL')
  expect(cfgTxt).toContain("transports: ['websocket']")
  // realtime-client.ts consumes the shared resolver.
  const clientTxt = readFileSync(join(root, 'src/lib/realtime-client.ts'), 'utf8')
  expect(clientTxt).toContain('resolveRealtimeConfig')
})

test('Full docker-compose.yml sets DIRECT_URL for app service', () => {
  const txt = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  // Full Compose must set both DATABASE_URL and DIRECT_URL
  expect(txt).toContain('DATABASE_URL: postgresql://sukhan:')
  expect(txt).toContain('DIRECT_URL: postgresql://sukhan:')
})

test('Lite docker-compose.lite.yml sets both DATABASE_URL and DIRECT_URL', () => {
  const txt = readFileSync(join(root, 'docker-compose.lite.yml'), 'utf8')
  expect(txt).toContain('DATABASE_URL: postgresql://')
  expect(txt).toContain('DIRECT_URL: postgresql://')
})

test('docker-entrypoint.sh runs prisma migrate deploy (not --skip-generate)', () => {
  const txt = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8')
  expect(txt).toMatch(/prisma\s+migrate\s+deploy/)
  expect(txt).not.toContain('--skip-generate')
})

test('docker-entrypoint.sh does NOT swallow migration failure', () => {
  const txt = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8')
  // Must NOT contain the old "|| { echo WARNING ... continue }" pattern
  expect(txt).not.toContain('Continuing anyway')
  expect(txt).not.toMatch(/migrate\s+deploy.*\|\|/)
  // Must NOT skip migrations when DATABASE_URL is set
  expect(txt).not.toContain('skipping migrations')
})

test('docker-entrypoint.sh fails closed on missing env vars', () => {
  const txt = readFileSync(join(root, 'docker-entrypoint.sh'), 'utf8')
  expect(txt).toContain('exit 1')
  // Must check for NEXTAUTH_SECRET
  expect(txt).toMatch(/NEXTAUTH_SECRET.*exit 1|exit 1.*NEXTAUTH_SECRET/)
  // Must check for DATABASE_URL
  expect(txt).toMatch(/DATABASE_URL.*exit 1|exit 1.*DATABASE_URL/)
  // Must check for DIRECT_URL
  expect(txt).toMatch(/DIRECT_URL.*exit 1|exit 1.*DIRECT_URL/)
})
