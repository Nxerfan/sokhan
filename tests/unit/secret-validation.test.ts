/// <reference types="bun-types" />
/**
 * Production secret validation regression tests.
 *
 * Verifies the behaviour of `src/lib/secret-validation.ts` and the
 * documented fail-closed contract:
 *
 *   - missing NEXTAUTH_SECRET fails
 *   - empty NEXTAUTH_SECRET fails
 *   - the historical `CHANGE_ME_...` NEXTAUTH_SECRET placeholder fails
 *   - the documented realtime dev-secret fallback fails in production
 *   - any value starting with `CHANGE_ME` fails
 *   - a real non-placeholder CI/test secret is accepted
 *   - the same guarantees apply to POSTGRES_PASSWORD
 *   - secret values are NEVER echoed in failure output
 *
 * Also verifies `.env.docker.example` no longer ships usable non-empty
 * `CHANGE_ME` values for required secrets, and that the Docker
 * entrypoint and the realtime service both reference the known-bad
 * placeholder values (so a future template/placeholder change must
 * touch all three locations consistently).
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  validateNextAuthSecret,
  validatePostgresPassword,
  formatSecretFailure,
  nextAuthSecretProductionFailure,
  postgresPasswordProductionFailure,
} from '../../src/lib/secret-validation'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
}

// Real non-placeholder CI/test secret. Matches the value used by the
// GitHub Actions workflow (`.github/workflows/ci.yml`).
const CI_TEST_SECRET = 'ci-test-secret-not-for-production'
const CI_POSTGRES_PASSWORD = 'ci-postgres-password'
const REAL_RANDOM_SECRET = 'a8f3c1d9e7b2f4a6c8d0e2b4f6a8c0d2e4b6f8a0c2d4e6b8f0a2c4d6e8f0b2a'
const REAL_RANDOM_PASSWORD = '7c9b1a3d5e7f9b2c4d6e8a0f2b4c6d8e9a1b3c5d7e9f1a3b5c7d9e1f3a5b7'

test('validateNextAuthSecret: missing/undefined fails', () => {
  const r = validateNextAuthSecret(undefined)
  expect(r.ok).toBe(false)
  expect(r.varName).toBe('NEXTAUTH_SECRET')
  const msg = formatSecretFailure(r)
  expect(msg).toContain('NEXTAUTH_SECRET')
  expect(msg.toLowerCase()).toMatch(/missing/)
})

test('validateNextAuthSecret: null fails', () => {
  const r = validateNextAuthSecret(null)
  expect(r.ok).toBe(false)
  const msg = formatSecretFailure(r)
  expect(msg).toContain('NEXTAUTH_SECRET')
  expect(msg.toLowerCase()).toMatch(/missing/)
})

test('validateNextAuthSecret: empty string fails', () => {
  const r = validateNextAuthSecret('')
  expect(r.ok).toBe(false)
  const msg = formatSecretFailure(r)
  expect(msg).toContain('NEXTAUTH_SECRET')
  expect(msg.toLowerCase()).toMatch(/empty/)
})

test('validateNextAuthSecret: whitespace-only fails', () => {
  const r = validateNextAuthSecret('   \t  ')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/empty/)
})

test('validateNextAuthSecret: historical CHANGE_ME placeholder fails', () => {
  const r = validateNextAuthSecret('CHANGE_ME_generate_with_openssl_rand_base64_32')
  expect(r.ok).toBe(false)
  const msg = formatSecretFailure(r)
  expect(msg).toContain('NEXTAUTH_SECRET')
  expect(msg.toLowerCase()).toMatch(/placeholder/)
})

test('validateNextAuthSecret: documented realtime dev-secret fallback fails', () => {
  // This is the deterministic dev secret that mini-services/realtime
  // uses when NEXTAUTH_SECRET is unset in dev. It MUST NOT be accepted
  // as a real production value (otherwise an operator who literally
  // pastes the dev fallback into .env would silently ship with it).
  const r = validateNextAuthSecret('sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/placeholder/)
})

test('validateNextAuthSecret: any value starting with CHANGE_ME fails', () => {
  // Future-proof: a developer who adds a new CHANGE_ME_something
  // placeholder to a committed template MUST NOT be able to start the
  // app with it. The prefix check catches this without enumerating
  // each new placeholder.
  const r = validateNextAuthSecret('CHANGE_ME_anything_new')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/placeholder/)
})

test('validateNextAuthSecret: a real non-placeholder CI/test secret is accepted', () => {
  const r = validateNextAuthSecret(CI_TEST_SECRET)
  expect(r.ok).toBe(true)
  expect(formatSecretFailure(r)).toBe('')
})

test('validateNextAuthSecret: a real random openssl-style value is accepted', () => {
  // openssl rand -base64 32 produces a 44-char base64 string.
  const r = validateNextAuthSecret(REAL_RANDOM_SECRET)
  expect(r.ok).toBe(true)
})

test('validateNextAuthSecret: failure messages NEVER echo the secret value', () => {
  // The validator must NEVER include the secret value in any message
  // it returns. Even if a placeholder value happens to be a known-bad
  // one, the failure message must not interpolate the value.
  const placeholder = 'CHANGE_ME_generate_with_openssl_rand_base64_32'
  const r = validateNextAuthSecret(placeholder)
  expect(r.ok).toBe(false)
  const msg = formatSecretFailure(r)
  expect(msg).not.toContain(placeholder)
  expect(msg).not.toContain('sukhan-dev-secret')
})

test('validateNextAuthSecret: failure messages NEVER echo the real secret value either', () => {
  // Edge case: a real secret value that happens to be very long or
  // unusual must NEVER appear in failure output. Because the real
  // secret is ACCEPTED, the failure path isn't hit — but we still
  // verify the accepted-result message is empty (no value echoed).
  const r = validateNextAuthSecret(REAL_RANDOM_SECRET)
  expect(r.ok).toBe(true)
  expect(formatSecretFailure(r)).toBe('')
  expect(nextAuthSecretProductionFailure(REAL_RANDOM_SECRET)).toBe('')
})

test('validatePostgresPassword: missing/undefined fails', () => {
  const r = validatePostgresPassword(undefined)
  expect(r.ok).toBe(false)
  expect(r.varName).toBe('POSTGRES_PASSWORD')
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/missing/)
})

test('validatePostgresPassword: empty string fails', () => {
  const r = validatePostgresPassword('')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/empty/)
})

test('validatePostgresPassword: historical CHANGE_ME placeholder fails', () => {
  const r = validatePostgresPassword('CHANGE_ME_strong_password_here')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/placeholder/)
})

test('validatePostgresPassword: any value starting with CHANGE_ME fails', () => {
  const r = validatePostgresPassword('CHANGE_ME_something_new')
  expect(r.ok).toBe(false)
  expect(formatSecretFailure(r).toLowerCase()).toMatch(/placeholder/)
})

test('validatePostgresPassword: a real non-placeholder CI/test password is accepted', () => {
  const r = validatePostgresPassword(CI_POSTGRES_PASSWORD)
  expect(r.ok).toBe(true)
  expect(formatSecretFailure(r)).toBe('')
})

test('validatePostgresPassword: a real random openssl-style password is accepted', () => {
  // openssl rand -hex 24 produces a 48-char hex string.
  const r = validatePostgresPassword(REAL_RANDOM_PASSWORD)
  expect(r.ok).toBe(true)
})

test('validatePostgresPassword: failure messages NEVER echo the password value', () => {
  const placeholder = 'CHANGE_ME_strong_password_here'
  const r = validatePostgresPassword(placeholder)
  expect(r.ok).toBe(false)
  const msg = formatSecretFailure(r)
  expect(msg).not.toContain(placeholder)
})

test('nextAuthSecretProductionFailure returns "" for a real secret', () => {
  expect(nextAuthSecretProductionFailure(REAL_RANDOM_SECRET)).toBe('')
})

test('nextAuthSecretProductionFailure returns a non-empty message for a placeholder', () => {
  expect(nextAuthSecretProductionFailure('CHANGE_ME_x')).not.toBe('')
})

test('postgresPasswordProductionFailure returns "" for a real password', () => {
  expect(postgresPasswordProductionFailure(REAL_RANDOM_PASSWORD)).toBe('')
})

test('postgresPasswordProductionFailure returns a non-empty message for a placeholder', () => {
  expect(postgresPasswordProductionFailure('CHANGE_ME_x')).not.toBe('')
})

// ============================================================
// Static invariants over .env.docker.example, docker-entrypoint.sh,
// and the realtime service. These prove the runtime fail-closed
// contract is wired in all three places.
// ============================================================

test('.env.docker.example: NEXTAUTH_SECRET ships BLANK (not a usable CHANGE_ME value)', () => {
  const src = readSrc('.env.docker.example')
  // Find the NEXTAUTH_SECRET= line. It must NOT have a non-empty
  // CHANGE_ME value (the historical `CHANGE_ME_generate_with_openssl_rand_base64_32`
  // would have satisfied compose ${VAR:?...}).
  const line = src.split('\n').find(l => /^NEXTAUTH_SECRET=/.test(l))
  expect(line, 'NEXTAUTH_SECRET= line must exist in .env.docker.example').toBeDefined()
  // The value after `=` must be empty (or whitespace-only).
  const value = line!.replace(/^NEXTAUTH_SECRET=/, '').trim()
  expect(value, 'NEXTAUTH_SECRET must be blank in the template').toBe('')
})

test('.env.docker.example: POSTGRES_PASSWORD ships BLANK (not a usable CHANGE_ME value)', () => {
  const src = readSrc('.env.docker.example')
  const line = src.split('\n').find(l => /^POSTGRES_PASSWORD=/.test(l))
  expect(line, 'POSTGRES_PASSWORD= line must exist in .env.docker.example').toBeDefined()
  const value = line!.replace(/^POSTGRES_PASSWORD=/, '').trim()
  expect(value, 'POSTGRES_PASSWORD must be blank in the template').toBe('')
})

test('.env.docker.example: no usable non-empty CHANGE_ME value for any required secret', () => {
  const src = readSrc('.env.docker.example')
  // Walk every non-comment line that assigns a value to a variable.
  // If the value (after =) is non-empty AND starts with CHANGE_ME,
  // the template is shipping a usable placeholder — which is exactly
  // what we must NOT do for required secrets.
  const requiredSecrets = ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD']
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue
    const [, name, value] = m
    if (!requiredSecrets.includes(name)) continue
    const v = value.trim()
    expect(
      v === '' || !v.startsWith('CHANGE_ME'),
      `${name} in .env.docker.example must be blank or a real value — not a CHANGE_ME placeholder (got: "${v.slice(0, 20)}…")`,
    ).toBe(true)
  }
})

test('.env.docker.example: keeps clear generation instructions for both secrets', () => {
  const src = readSrc('.env.docker.example')
  // The template must keep the documented `openssl rand ...` commands
  // so the operator knows how to generate real values.
  expect(src).toContain('openssl rand -base64 32')
  expect(src).toContain('openssl rand -hex 24')
})

test('.env.docker.example: does NOT silently auto-generate secrets', () => {
  const src = readSrc('.env.docker.example')
  // The template must NOT contain a backtick-subshell that would
  // silently generate a secret on `cp .env.docker.example .env` or
  // `docker compose up`. Secrets must be provided by the operator.
  expect(src).not.toMatch(/NEXTAUTH_SECRET=\$\(/)
  expect(src).not.toMatch(/POSTGRES_PASSWORD=\$\(/)
})

test('docker-entrypoint.sh: invokes the canonical validator for NEXTAUTH_SECRET (no inline validator)', () => {
  const src = readSrc('docker-entrypoint.sh')
  // The entrypoint must delegate to the canonical validator script
  // (which imports validateNextAuthSecret from src/lib/secret-validation.ts).
  // This is the synchronization guarantee: the runtime path uses the
  // SAME validators the unit tests exercise. There is no inline
  // mirrored validator in the entrypoint.
  expect(src).toContain('bun /app/scripts/validate-secrets.ts nextauth')
  // Must NOT contain the old inline `CHANGE_ME` references — the
  // canonical validator in src/lib/secret-validation.ts owns the
  // known-bad list now.
  expect(src).not.toContain('CHANGE_ME_generate_with_openssl_rand_base64_32')
  expect(src).not.toContain('sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1')
  // The entrypoint must mention the variable NAME (never the value).
  // Word-boundary matching so $NEXTAUTH_SECRET_FAILURE (the failure
  // message variable) does NOT match $NEXTAUTH_SECRET (the secret value).
  const echoLines = src.split('\n').filter(l => {
    const t = l.trim()
    return (t.startsWith('echo ') || t.startsWith('echo\t'))
  })
  for (const ln of echoLines) {
    const bareRef = /\$NEXTAUTH_SECRET(?![A-Za-z0-9_])/
    const bracedRef = /\$\{NEXTAUTH_SECRET\}/
    expect(
      bareRef.test(ln) || bracedRef.test(ln),
      `docker-entrypoint.sh echo line must NOT print NEXTAUTH_SECRET value (line: ${ln.trim()})`,
    ).toBe(false)
  }
})

test('docker-entrypoint.sh: invokes the canonical validator for POSTGRES_PASSWORD in web mode', () => {
  const src = readSrc('docker-entrypoint.sh')
  // The entrypoint must delegate to the canonical validator for
  // POSTGRES_PASSWORD too (in web mode only — realtime mode doesn't
  // touch the database). This is the contract fix that closes the
  // POSTGRES_PASSWORD runtime-enforcement gap.
  expect(src).toContain('bun /app/scripts/validate-secrets.ts postgres')
  // Word-boundary matching so $POSTGRES_PASSWORD_FAILURE (the failure
  // message variable) does NOT match $POSTGRES_PASSWORD (the password value).
  const echoLines = src.split('\n').filter(l => {
    const t = l.trim()
    return (t.startsWith('echo ') || t.startsWith('echo\t')) && t.toLowerCase().includes('postgres_password')
  })
  for (const ln of echoLines) {
    const bareRef = /\$POSTGRES_PASSWORD(?![A-Za-z0-9_])/
    const bracedRef = /\$\{POSTGRES_PASSWORD\}/
    expect(
      bareRef.test(ln) || bracedRef.test(ln),
      `docker-entrypoint.sh echo line must NOT print POSTGRES_PASSWORD value (line: ${ln.trim()})`,
    ).toBe(false)
  }
})

test('mini-services/realtime/index.ts: rejects NEXTAUTH_SECRET placeholder values', () => {
  const src = readSrc('mini-services/realtime/index.ts')
  expect(src).toContain('CHANGE_ME_generate_with_openssl_rand_base64_32')
  expect(src).toContain('sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1')
  expect(src).toContain('CHANGE_ME')
  // The realtime service must NOT echo the secret value when it
  // rejects a placeholder. Verify no console.error/log line
  // interpolates $NEXTAUTH_SECRET or process.env.NEXTAUTH_SECRET as
  // part of an error message.
  const logLines = src.split('\n').filter(l => {
    const t = l.trim()
    return t.startsWith('console.error(') || t.startsWith('console.log(') || t.startsWith('console.warn(')
  })
  for (const ln of logLines) {
    // A line like `console.error('FATAL: ' + process.env.NEXTAUTH_SECRET)`
    // would print the value. Reject any interpolation of the env var
    // in a log call.
    expect(
      ln.includes('process.env.NEXTAUTH_SECRET') && !ln.includes('process.env.NEXTAUTH_SECRET ==') && !ln.includes('process.env.NEXTAUTH_SECRET !=') && !ln.includes('!process.env.NEXTAUTH_SECRET'),
      `realtime: log line must NOT interpolate process.env.NEXTAUTH_SECRET as a value (line: ${ln.trim()})`,
    ).toBe(false)
  }
})

test('docker-compose.yml: NEXTAUTH_SECRET + POSTGRES_PASSWORD use ${VAR:?...} fail-closed guard', () => {
  const src = readSrc('docker-compose.yml')
  // The compose file must use the ${VAR:?error} syntax so a missing
  // or empty value prevents the stack from starting.
  expect(src).toMatch(/\$\{NEXTAUTH_SECRET:\?[^}]+\}/)
  expect(src).toMatch(/\$\{POSTGRES_PASSWORD:\?[^}]+\}/)
})

test('docker-compose.lite.yml: NEXTAUTH_SECRET + POSTGRES_PASSWORD use ${VAR:?...} fail-closed guard', () => {
  const src = readSrc('docker-compose.lite.yml')
  expect(src).toMatch(/\$\{NEXTAUTH_SECRET:\?[^}]+\}/)
  expect(src).toMatch(/\$\{POSTGRES_PASSWORD:\?[^}]+\}/)
})
