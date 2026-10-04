/**
 * Regression tests for critical identity & security fixes.
 *
 * These are STATIC source-grep + pure-logic tests that don't require a
 * running server. They verify that the security fixes are present in the
 * source code and that pure helper functions behave correctly.
 *
 * For end-to-end verification (actual HTTP requests, DB state), see the
 * Playwright specs in tests/.
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
}

// ------------------------------------------------------------------
// #1: Legacy signup bypass removed
// ------------------------------------------------------------------

test('#1 legacy /api/auth/signup returns 410 and does NOT create users/tenants', () => {
  const source = readSrc('src/app/api/auth/signup/route.ts')
  expect(source).toContain('410')
  expect(source).toContain('signup_deprecated')
  // Must NOT contain db.user.create or db.tenant.create
  expect(source).not.toContain('db.user.create')
  expect(source).not.toContain('db.tenant.create')
  expect(source).not.toContain('bcrypt')
})

test('#1 auth-form.tsx uses OTP 3-step flow for signup (not legacy endpoint)', () => {
  const source = readSrc('src/components/auth/auth-form.tsx')
  expect(source).toContain('/api/auth/signup/start')
  expect(source).toContain('/api/auth/signup/verify')
  expect(source).toContain('/api/auth/signup/complete')
  // Must NOT call the legacy endpoint
  expect(source).not.toMatch(/fetch\(['"]\/api\/auth\/signup['"]/)
})

// ------------------------------------------------------------------
// #2: Visitor contact takeover by email
// ------------------------------------------------------------------

test('#2 contact route requires visitorId (not email) as identity', () => {
  const source = readSrc('src/app/api/widget/[slug]/contact/route.ts')
  expect(source).toContain('visitorId_required')
  // Must NOT use email as the lookup identifier
  expect(source).not.toContain("identifier = email || visitorId")
  expect(source).not.toContain("identifierType = email ? 'email' : 'visitorId'")
  // Must look up by visitorId, not email
  expect(source).toContain('identifier: visitorId')
})

test('#2 contact route does NOT merge visitors by email', () => {
  const source = readSrc('src/app/api/widget/[slug]/contact/route.ts')
  // The dangerous "upgrade visitorId to email" branch must NOT exist
  expect(source).not.toContain("identifierType: 'email'")
  expect(source).not.toContain('identifier: email')
})

test('#2 widget scripts use crypto.randomUUID() for visitorId', () => {
  const slugScript = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(slugScript).toContain('crypto.randomUUID')

  const v1Script = readSrc('src/app/api/widget/v1/sukhan.js/route.ts')
  expect(v1Script).toContain('crypto.randomUUID')

  const npmWidget = readSrc('packages/widget-npm/src/widget.ts')
  expect(npmWidget).toContain('crypto.randomUUID')
})

// ------------------------------------------------------------------
// #3: Visitor token bound to widget slug
// ------------------------------------------------------------------

test('#3 messages route checks token.slug === route slug', () => {
  const source = readSrc('src/app/api/widget/[slug]/messages/route.ts')
  expect(source).toContain('token_slug_mismatch')
  expect(source).toContain('tokenSlug !== slug')
})

test('#3 csat route checks token.slug === route slug', () => {
  const source = readSrc('src/app/api/widget/[slug]/csat/route.ts')
  expect(source).toContain('token_slug_mismatch')
  expect(source).toContain('tokenSlug !== slug')
})

// ------------------------------------------------------------------
// #4: Membership privilege escalation
// ------------------------------------------------------------------

test('#4 members route rejects owner assignment', () => {
  const source = readSrc('src/app/api/members/route.ts')
  expect(source).toContain('cannot_assign_owner')
})

test('#4 members route rejects invalid roles', () => {
  const source = readSrc('src/app/api/members/route.ts')
  expect(source).toContain('invalid_role')
})

test('#4 members PATCH blocks self-modification', () => {
  const source = readSrc('src/app/api/members/route.ts')
  expect(source).toContain('target.userId === session.user.id')
})

test('#4 members PATCH checks target role below actor', () => {
  const source = readSrc('src/app/api/members/route.ts')
  expect(source).toContain('canManageRole')
})

test('#4 members UI shows only assignable roles', () => {
  const source = readSrc('src/components/dashboard/views/members-panel.tsx')
  expect(source).toContain('assignablRolesFor')
  expect(source).toContain('canModifyTarget')
})

test('#4 members UI does NOT show fake owner badge for current user', () => {
  const source = readSrc('src/components/dashboard/views/members-panel.tsx')
  // The old bug: always showing {t('roles.owner')} for current user
  // The fix: showing {tc('you')} instead
  expect(source).toContain("tc('you')")
  // Must NOT contain the old unconditional owner badge pattern
  expect(source).not.toContain("m.user.id === currentUserId && (")
  expect(source).not.toMatch(/\{t\('roles\.owner'\)\}.*You\b/)
})

// ------------------------------------------------------------------
// #5: Current DB role enforcement (not stale JWT)
// ------------------------------------------------------------------

test('#5 withSessionTenant checks membership.status === active', () => {
  const source = readSrc('src/lib/auth/index.ts')
  expect(source).toContain("membership.status !== 'active'")
})

test('#5 withSessionTenant replaces JWT role with fresh DB role', () => {
  const source = readSrc('src/lib/auth/index.ts')
  expect(source).toContain('role: membership.role')
  expect(source).toContain('freshSession')
})

// ------------------------------------------------------------------
// #6: Realtime token expiry
// ------------------------------------------------------------------

test('#6 shared token module has iat and exp fields', () => {
  const source = readSrc('src/lib/realtime-token-shared.ts')
  expect(source).toContain('iat')
  expect(source).toContain('exp')
  expect(source).toContain('TOKEN_TTL_SECONDS')
})

// ------------------------------------------------------------------
// #7: Agent realtime membership revalidation
// ------------------------------------------------------------------

test('#7 Vercel realtime revalidates agent membership on connect', () => {
  const source = readSrc('api/realtime.ts')
  expect(source).toContain('membership')
  expect(source).toContain("status: 'active'")
  expect(source).toContain('membership_inactive')
})

test('#7 Docker realtime revalidates agent membership via internal endpoint', () => {
  const source = readSrc('mini-services/realtime/index.ts')
  expect(source).toContain('verify-membership')
  expect(source).toContain('membership_inactive')
})

test('#7 verify-membership endpoint exists', () => {
  const source = readSrc('src/app/api/realtime/verify-membership/route.ts')
  expect(source).toContain('active')
  expect(source).toContain('timingSafeEqual')
})

// ------------------------------------------------------------------
// #8: Token refresh on reconnect
// ------------------------------------------------------------------

test('#8 dashboard realtime-client refreshes token on connect_error', () => {
  const source = readSrc('src/lib/realtime-client.ts')
  expect(source).toContain('connect_error')
  expect(source).toContain('/api/realtime-token')
  expect(source).toContain('freshToken')
})

test('#8 slug widget refreshes visitor token on reconnect', () => {
  const source = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(source).toContain('refreshVisitorToken')
  expect(source).toContain('connect_error')
})

test('#8 v1 widget refreshes visitor token on reconnect', () => {
  const source = readSrc('src/app/api/widget/v1/sukhan.js/route.ts')
  expect(source).toContain('refreshVisitorToken')
  expect(source).toContain('connect_error')
})

test('#8 NPM widget has onTokenExpired callback', () => {
  const source = readSrc('packages/widget-npm/src/socket.ts')
  expect(source).toContain('onTokenExpired')
  expect(source).toContain('connect_error')
})

// ------------------------------------------------------------------
// #9: Secret logging removed
// ------------------------------------------------------------------

test('#9 docker-entrypoint.sh does NOT print REDIS_URL value', () => {
  const source = readSrc('docker-entrypoint.sh')
  // Must NOT contain $REDIS_URL in an echo (which prints the value)
  expect(source).not.toContain('ENABLED ($REDIS_URL)')
  expect(source).not.toContain('echo "$REDIS_URL"')
  // Safe form is just "ENABLED" without the value
  expect(source).toContain('ENABLED')
})

test('#9 mini-service does NOT log secret values', () => {
  const source = readSrc('mini-services/realtime/index.ts')
  // Should log that REDIS_URL is set, but not the value
  expect(source).not.toMatch(/console\.(log|error|warn).*REDIS_URL.*\$\{?REDIS_URL/)
  // Should not log NEXTAUTH_SECRET value
  expect(source).not.toMatch(/console\.(log|error|warn).*SECRET.*\$\{?SECRET/)
})

// ------------------------------------------------------------------
// #10: Widget stored XSS
// ------------------------------------------------------------------

test('#10 slug widget uses textContent for config.name (not innerHTML)', () => {
  const source = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(source).toContain('titleText.textContent = config.name')
  // Must NOT pass config.name through el() as html
  expect(source).not.toContain("el('div', '', config.name")
})

test('#10 v1 widget uses textContent for config.name', () => {
  const source = readSrc('src/app/api/widget/v1/sukhan.js/route.ts')
  expect(source).toContain('titleText.textContent = config.name')
  expect(source).not.toContain("el('div', '', config.name")
})

test('#10 NPM widget uses textContent for config.name', () => {
  const source = readSrc('packages/widget-npm/src/widget.ts')
  expect(source).toContain('titleText.textContent = config.name')
  expect(source).not.toContain("el('div', '', config.name")
})

test('#10 slug widget uses textContent for message text (not esc+innerHTML)', () => {
  const source = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(source).toContain('p.textContent = msg.content.text')
  // Must NOT use the old esc() + el() pattern for message text
  expect(source).not.toContain("el('p', '', esc(msg.content.text))")
})

test('#10 slug widget uses textContent for attachment names', () => {
  const source = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(source).toContain('a.textContent = att.name')
  expect(source).not.toContain("el('a', '', esc(att.name))")
})

test('#10 v1 widget uses textContent for message text', () => {
  const source = readSrc('src/app/api/widget/v1/sukhan.js/route.ts')
  expect(source).toContain('p.textContent = msg.content.text')
  expect(source).not.toContain("el('p', '', esc(msg.content.text))")
})

test('#10 NPM widget uses textContent for message text', () => {
  const source = readSrc('packages/widget-npm/src/widget.ts')
  expect(source).toContain('p.textContent = msg.content.text')
  expect(source).not.toContain("el('p', '', esc(msg.content.text))")
})

test('#10 NPM widget uses textContent for attachment names', () => {
  const source = readSrc('packages/widget-npm/src/widget.ts')
  expect(source).toContain('a.textContent = att.name')
  expect(source).not.toContain("el('a', '', esc(att.name))")
})

// ------------------------------------------------------------------
// #10b: Internal endpoints use timing-safe comparison
// ------------------------------------------------------------------

test('#10b verify-conversation uses timing-safe comparison', () => {
  const source = readSrc('src/app/api/realtime/verify-conversation/route.ts')
  expect(source).toContain('timingSafeEqual')
  expect(source).not.toContain('authHeader !== secret')
})

test('#10b verify-membership uses timing-safe comparison', () => {
  const source = readSrc('src/app/api/realtime/verify-membership/route.ts')
  expect(source).toContain('timingSafeEqual')
})

test('#10b Docker realtime internal endpoints use timing-safe comparison', () => {
  const source = readSrc('mini-services/realtime/index.ts')
  expect(source).toContain('timingSafeEqualStr')
  expect(source).not.toContain('authHeader !== SECRET')
})


// ------------------------------------------------------------------
// #2: Docker packaging — shared token module must be in the image
// ------------------------------------------------------------------

test('#2 Dockerfile copies shared realtime-token module to runtime image', () => {
  const source = readSrc('Dockerfile')
  expect(source).toContain('realtime-token-shared')
  expect(source).toContain('COPY --from=builder /app/src/lib/realtime-token-shared.ts ./src/lib/realtime-token-shared.ts')
})

// ------------------------------------------------------------------
// #3: NIXIFY_MOCK is test-only (not in production Compose)
// ------------------------------------------------------------------

test('#3 test Compose overrides set NIXIFY_MOCK=true', () => {
  const testCompose = readSrc('docker-compose.test.yml')
  expect(testCompose).toContain('NIXIFY_MOCK: "true"')

  const liteTestCompose = readSrc('docker-compose.lite.test.yml')
  expect(liteTestCompose).toContain('NIXIFY_MOCK: "true"')
})

test('#3 production Compose does NOT set NIXIFY_MOCK', () => {
  const prodCompose = readSrc('docker-compose.yml')
  expect(prodCompose).not.toContain('NIXIFY_MOCK')

  const prodLiteCompose = readSrc('docker-compose.lite.yml')
  expect(prodLiteCompose).not.toContain('NIXIFY_MOCK')
})

// ------------------------------------------------------------------
// #5: Membership revalidation in Socket.IO middleware (not connection handler)
// ------------------------------------------------------------------

test('#5 Vercel realtime validates agent membership in io.use() middleware', () => {
  const source = readSrc('api/realtime.ts')
  // The middleware must be async and call next(new Error("membership_inactive"))
  expect(source).toContain('io.use(async')
  expect(source).toContain("membership_inactive")
  expect(source).toContain("membership_check_failed")
  // The middleware must call next(new Error(...)) — not socket.emit + disconnect
  expect(source).toContain("return next(new Error('membership_inactive'))")
})

test('#5 Docker realtime validates agent membership in io.use() middleware', () => {
  const source = readSrc('mini-services/realtime/index.ts')
  expect(source).toContain('io.use(async')
  expect(source).toContain("membership_inactive")
  expect(source).toContain("membership_check_failed")
  expect(source).toContain("return next(new Error('membership_inactive'))")
})

// ------------------------------------------------------------------
// #6: Expired-token manual reconnect (socket.connect())
// ------------------------------------------------------------------

test('#6 dashboard realtime-client calls socket.connect() after refresh', () => {
  const source = readSrc('src/lib/realtime-client.ts')
  expect(source).toContain('createdSocket.connect()')
  expect(source).toContain('refreshToken')
  expect(source).toContain('membershipRevoked')
  // membership_inactive stops reconnection
  expect(source).toContain("membership_inactive")
  expect(source).toContain('reconnection = false')
})

test('#6 slug widget calls socket.connect() after refresh', () => {
  const source = readSrc('src/app/api/widget/[slug]/script/route.ts')
  expect(source).toContain('state.socket.connect()')
  expect(source).toContain('visitorMembershipRevoked')
  expect(source).toContain("membership_inactive")
})

test('#6 v1 widget calls socket.connect() after refresh', () => {
  const source = readSrc('src/app/api/widget/v1/sukhan.js/route.ts')
  expect(source).toContain('state.socket.connect()')
  expect(source).toContain('visitorMembershipRevoked')
  expect(source).toContain("membership_inactive")
})

test('#6 NPM socket calls socket.connect() after refresh', () => {
  const source = readSrc('packages/widget-npm/src/socket.ts')
  expect(source).toContain('this.socket.connect()')
  expect(source).toContain('membershipRevoked')
  expect(source).toContain("membership_inactive")
})

// ------------------------------------------------------------------
// #8: exp <= now boundary (not exp < now)
// ------------------------------------------------------------------

test('#8 shared token module uses exp <= now (boundary-safe)', () => {
  const source = readSrc('src/lib/realtime-token-shared.ts')
  expect(source).toContain('exp <= now')
  expect(source).not.toContain('exp < now')
})

// ------------------------------------------------------------------
// #9: Agent artifacts removed
// ------------------------------------------------------------------

test('#9 agent-ctx directory is not present', () => {
  const fs = require('fs')
  const path = require('path')
  const agentCtxPath = path.resolve(__dirname, '../../agent-ctx')
  expect(fs.existsSync(agentCtxPath)).toBe(false)
})
