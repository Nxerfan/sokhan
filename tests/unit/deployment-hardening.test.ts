/// <reference types="bun-types" />
/**
 * Deployment/build hardening regression tests.
 *
 * Verifies that:
 *   1. Production build does NOT suppress TypeScript errors.
 *   2. Secrets are NOT exposed via echoed shell commands.
 *   3. Docker commands do NOT interpolate secrets into command lines.
 *   4. The app tsconfig excludes non-app sample code (skills/).
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
}

const SECRET_VARS = [
  'NEXTAUTH_SECRET',
  'POSTGRES_PASSWORD',
  'ZARINPAL_MERCHANT_ID',
  'IDPAY_API_KEY',
  'DATABASE_URL',
  'DIRECT_URL',
  'REDIS_URL',
]

const SHELL_SCRIPTS = ['docker-entrypoint.sh', 'vercel-build.sh', 'vercel-install.sh']

test('next.config.ts does NOT suppress TypeScript build errors', () => {
  const src = readSrc('next.config.ts')
  // Strip comments (lines starting with //) to avoid flagging the
  // "Previously ignoreBuildErrors: true" explanatory comment.
  const codeLines = src.split('\n').filter(ln => !ln.trim().startsWith('//'))
  const code = codeLines.join('\n')
  expect(code).not.toContain('ignoreBuildErrors: true')
  expect(code).toContain('ignoreBuildErrors: false')
})

test('tsconfig.json excludes skills/ (not app code)', () => {
  const src = readSrc('tsconfig.json')
  expect(src).toContain('skills/**')
})

test('shell scripts do NOT echo secret variable VALUES', () => {
  for (const script of SHELL_SCRIPTS) {
    const src = readSrc(script)
    for (const line of src.split('\n')) {
      const trimmed = line.trim()
      // Only check echo lines (not export, not if, not comments).
      if (!trimmed.startsWith('echo ') && !trimmed.startsWith('echo\t')) continue
      for (const secret of SECRET_VARS) {
        // The line must NOT reference the secret's VALUE via $SECRET or ${SECRET}.
        // (Referencing the NAME in a string like "FATAL: SECRET is not set" is OK.)
        const valueRef = `$${secret}`
        const valueRefBraced = `${'${'}${secret}${'}'}`
        expect(
          line.includes(valueRef) || line.includes(valueRefBraced),
          `${script}: echo line must NOT reference the VALUE of ${secret} (line: ${trimmed})`,
        ).toBe(false)
      }
    }
  }
})

test('docker-entrypoint.sh only echoes secret NAMES (not values)', () => {
  const src = readSrc('docker-entrypoint.sh')
  for (const secret of SECRET_VARS) {
    const echoLines = src.split('\n').filter(ln => {
      const t = ln.trim()
      return (t.startsWith('echo ') || t.startsWith('echo\t')) && t.toLowerCase().includes(secret.toLowerCase())
    })
    for (const ln of echoLines) {
      expect(
        ln.includes(`$${secret}`),
        `docker-entrypoint.sh: echo line must not print ${secret} value (line: ${ln.trim()})`,
      ).toBe(false)
    }
  }
})

test('CI workflow validates the exact PR HEAD (not a merge commit)', () => {
  const src = readSrc('.github/workflows/ci.yml')
  expect(src).toContain('github.event.pull_request.head.sha')
  expect(src).not.toContain('fix/vercel-deployment')
  expect(src).toContain('branches: [main]')
})

test('SELF_HOSTING.md does not reference stale SQLite volumes or files', () => {
  const src = readSrc('SELF_HOSTING.md')
  expect(src).not.toContain('sukhan_sqlite-data')
  expect(src).not.toContain('sukhan.db')
  expect(src).not.toContain('pgloader')
  expect(src).not.toContain('/app/data')
})

test('SELF_HOSTING.md requires POSTGRES_PASSWORD for BOTH editions', () => {
  const src = readSrc('SELF_HOSTING.md')
  expect(src).not.toContain('Full only')
  expect(src).toMatch(/BOTH editions.*Postgres password/i)
})

test('SELF_HOSTING.md documents Lite edition with 4 containers', () => {
  const src = readSrc('SELF_HOSTING.md')
  expect(src).toMatch(/4 \(app \+ realtime \+ postgres \+ caddy\)/)
  expect(src).not.toMatch(/Containers \| 3 /)
})

test('SELF_HOSTING.md does not recommend prisma db push --accept-data-loss', () => {
  const src = readSrc('SELF_HOSTING.md')
  expect(src).not.toContain('db push --accept-data-loss')
  expect(src).not.toContain('prisma db push')
})

test('SELF_HOSTING.md documents prisma migrate deploy (the production migration strategy)', () => {
  const src = readSrc('SELF_HOSTING.md')
  expect(src).toContain('prisma migrate deploy')
})

test('SELF_HOSTING.md Lite migration does not claim an uploads copy with an unrelated docker compose up command', () => {
  const src = readSrc('SELF_HOSTING.md')
  // The uploads migration section should explain that the volume is shared,
  // not show a bare `docker compose up -d` as a "copy" command.
  expect(src).toContain('shared automatically')
  expect(src).toContain('No copy is needed')
})

test('SELF_HOSTING.md includes Lite uploads backup/restore guidance', () => {
  const src = readSrc('SELF_HOSTING.md')
  // Lite backup section must include uploads backup (not just pg_dump).
  expect(src).toMatch(/docker compose -f docker-compose\.lite\.yml cp app:\/app\/uploads/)
  // Lite restore section must include uploads restore.
  expect(src).toMatch(/docker compose -f docker-compose\.lite\.yml cp \.\/uploads-backup-YYYYMMDD app:\/app\/uploads/)
})
