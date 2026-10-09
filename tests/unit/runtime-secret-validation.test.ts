/// <reference types="bun-types" />
/**
 * RUNTIME secret-validation behavioral test.
 *
 * This is NOT a unit test of the pure validators (those live in
 * tests/unit/secret-validation.test.ts). This is a BEHAVIORAL test of
 * the actual Docker/web startup validation path — the script
 * `scripts/validate-secrets.ts` that `docker-entrypoint.sh` invokes
 * at container boot via `bun /app/scripts/validate-secrets.ts <which>`.
 *
 * The test runs the script directly (`bun scripts/validate-secrets.ts ...`)
 * with controlled env vars and asserts on the exit code + the captured
 * stderr output. This proves the runtime path stays synchronized with
 * the canonical validator (because the script IMPORTS the canonical
 * validators — there is no mirrored/duplicated logic).
 *
 * Coverage:
 *   1. placeholder NEXTAUTH_SECRET fails (exit 1, clear stderr message)
 *   2. placeholder POSTGRES_PASSWORD fails (exit 1, clear stderr message)
 *   3. valid test values pass the secret-validation stage (exit 0, no stderr)
 *   4. failure output does NOT contain the supplied secret/password value
 *
 * The script does NOT start Next.js, does NOT run migrations, and does
 * NOT touch the database — the validation stage is exercised in
 * isolation, deterministically.
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
}

const SCRIPT_PATH = resolve(__dirname, '../../scripts/validate-secrets.ts')

// Real non-placeholder CI/test values (must match the values used by
// the GitHub Actions workflow + the unit tests).
const CI_TEST_SECRET = 'ci-test-secret-not-for-production'
const CI_POSTGRES_PASSWORD = 'ci-postgres-password'

// Known-bad placeholder values (must match the values in
// src/lib/secret-validation.ts).
const NEXTAUTH_PLACEHOLDER = 'CHANGE_ME_generate_with_openssl_rand_base64_32'
const NEXTAUTH_DEV_FALLBACK = 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1'
const POSTGRES_PLACEHOLDER = 'CHANGE_ME_strong_password_here'

/**
 * Run `bun scripts/validate-secrets.ts <which>` with the given env vars
 * and return the exit code + stderr output.
 *
 * Uses Bun.spawn directly (not the `$` shell template) for explicit
 * stdout/stderr capture. The validator script writes failure messages
 * to stderr and nothing to stdout, so we capture both separately.
 */
async function runValidator(
  which: 'nextauth' | 'postgres',
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  // Build the env for the child process. Only the requested var is
  // set; everything else is inherited from the test runner's env
  // (which is fine — the validator only reads NEXTAUTH_SECRET or
  // POSTGRES_PASSWORD, never both).
  const childEnv: Record<string, string | undefined> = { ...process.env }
  if (which === 'nextauth') {
    childEnv.NEXTAUTH_SECRET = env.NEXTAUTH_SECRET
    // Unset POSTGRES_PASSWORD to prove the validator doesn't read it
    // in nextauth mode (defense — if it did, a bad password would
    // contaminate the NEXTAUTH_SECRET test result).
    delete childEnv.POSTGRES_PASSWORD
  } else {
    childEnv.POSTGRES_PASSWORD = env.POSTGRES_PASSWORD
    delete childEnv.NEXTAUTH_SECRET
  }
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  const proc = Bun.spawn({
    cmd: ['bun', SCRIPT_PATH, which],
    env: childEnv as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: resolve(__dirname, '../..'),
  })
  // Drain stdout + stderr concurrently (avoid pipe-buffer deadlock
  // when the child writes a large failure message).
  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stdoutChunks.push(value)
    }
  })()
  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderrChunks.push(value)
    }
  })()
  const exitCode = await proc.exited
  await Promise.all([stdoutPromise, stderrPromise])
  const decoder = new TextDecoder()
  return {
    exitCode,
    stdout: decoder.decode(Buffer.concat(stdoutChunks as Buffer[])),
    stderr: decoder.decode(Buffer.concat(stderrChunks as Buffer[])),
  }
}

// ============================================================
// NEXTAUTH_SECRET runtime validation (the `nextauth` mode)
// ============================================================

test('runtime: placeholder NEXTAUTH_SECRET fails with exit 1', async () => {
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: NEXTAUTH_PLACEHOLDER })
  expect(r.exitCode, `must exit 1 for placeholder; stderr=${r.stderr}`).toBe(1)
  expect(r.stderr).toContain('NEXTAUTH_SECRET')
  expect(r.stderr.toLowerCase()).toMatch(/placeholder/)
})

test('runtime: documented dev-secret fallback NEXTAUTH_SECRET fails with exit 1', async () => {
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: NEXTAUTH_DEV_FALLBACK })
  expect(r.exitCode, `must exit 1 for dev fallback; stderr=${r.stderr}`).toBe(1)
  expect(r.stderr).toContain('NEXTAUTH_SECRET')
  expect(r.stderr.toLowerCase()).toMatch(/placeholder/)
})

test('runtime: any CHANGE_ME-prefixed NEXTAUTH_SECRET fails with exit 1', async () => {
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: 'CHANGE_ME_anything_new' })
  expect(r.exitCode).toBe(1)
  expect(r.stderr.toLowerCase()).toMatch(/placeholder/)
})

test('runtime: missing NEXTAUTH_SECRET fails with exit 1', async () => {
  // Pass undefined — the env var will not be set in the child process.
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: undefined })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).toContain('NEXTAUTH_SECRET')
  expect(r.stderr.toLowerCase()).toMatch(/missing/)
})

test('runtime: empty NEXTAUTH_SECRET fails with exit 1', async () => {
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: '' })
  expect(r.exitCode).toBe(1)
  expect(r.stderr.toLowerCase()).toMatch(/empty/)
})

test('runtime: valid NEXTAUTH_SECRET passes with exit 0 and no stderr', async () => {
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: CI_TEST_SECRET })
  expect(r.exitCode, `must exit 0 for valid secret; stderr=${r.stderr}`).toBe(0)
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe('')
})

test('runtime: NEXTAUTH_SECRET failure output NEVER contains the supplied value', async () => {
  // The most important security property: even when the value is a
  // known-bad placeholder, the failure message must NOT echo it.
  const r = await runValidator('nextauth', { NEXTAUTH_SECRET: NEXTAUTH_PLACEHOLDER })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).not.toContain(NEXTAUTH_PLACEHOLDER)
  expect(r.stderr).not.toContain(NEXTAUTH_DEV_FALLBACK)
  // Also verify with a value that is a placeholder prefix but NOT in
  // the explicit known-bad set — the failure message must still not
  // contain it.
  const r2 = await runValidator('nextauth', { NEXTAUTH_SECRET: 'CHANGE_ME_unique_value_xyz' })
  expect(r2.exitCode).toBe(1)
  expect(r2.stderr).not.toContain('CHANGE_ME_unique_value_xyz')
})

// ============================================================
// POSTGRES_PASSWORD runtime validation (the `postgres` mode)
// ============================================================

test('runtime: placeholder POSTGRES_PASSWORD fails with exit 1', async () => {
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: POSTGRES_PLACEHOLDER })
  expect(r.exitCode, `must exit 1 for placeholder; stderr=${r.stderr}`).toBe(1)
  expect(r.stderr).toContain('POSTGRES_PASSWORD')
  expect(r.stderr.toLowerCase()).toMatch(/placeholder/)
})

test('runtime: any CHANGE_ME-prefixed POSTGRES_PASSWORD fails with exit 1', async () => {
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: 'CHANGE_ME_anything_new' })
  expect(r.exitCode).toBe(1)
  expect(r.stderr.toLowerCase()).toMatch(/placeholder/)
})

test('runtime: missing POSTGRES_PASSWORD fails with exit 1', async () => {
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: undefined })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).toContain('POSTGRES_PASSWORD')
  expect(r.stderr.toLowerCase()).toMatch(/missing/)
})

test('runtime: empty POSTGRES_PASSWORD fails with exit 1', async () => {
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: '' })
  expect(r.exitCode).toBe(1)
  expect(r.stderr.toLowerCase()).toMatch(/empty/)
})

test('runtime: valid POSTGRES_PASSWORD passes with exit 0 and no stderr', async () => {
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: CI_POSTGRES_PASSWORD })
  expect(r.exitCode, `must exit 0 for valid password; stderr=${r.stderr}`).toBe(0)
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe('')
})

test('runtime: POSTGRES_PASSWORD failure output NEVER contains the supplied value', async () => {
  // The most important security property: even when the password is a
  // known-bad placeholder, the failure message must NOT echo it.
  const r = await runValidator('postgres', { POSTGRES_PASSWORD: POSTGRES_PLACEHOLDER })
  expect(r.exitCode).toBe(1)
  expect(r.stderr).not.toContain(POSTGRES_PLACEHOLDER)
  // Also verify with a value that is a placeholder prefix but NOT in
  // the explicit known-bad set.
  const r2 = await runValidator('postgres', { POSTGRES_PASSWORD: 'CHANGE_ME_unique_pw_xyz' })
  expect(r2.exitCode).toBe(1)
  expect(r2.stderr).not.toContain('CHANGE_ME_unique_pw_xyz')
})

// ============================================================
// Usage error
// ============================================================

test('runtime: unknown <which> argument exits 2 with usage message', async () => {
  const childEnv: Record<string, string | undefined> = { ...process.env }
  childEnv.NEXTAUTH_SECRET = CI_TEST_SECRET
  childEnv.POSTGRES_PASSWORD = CI_POSTGRES_PASSWORD
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  const proc = Bun.spawn({
    cmd: ['bun', SCRIPT_PATH, 'bogus'],
    env: childEnv as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: resolve(__dirname, '../..'),
  })
  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stdoutChunks.push(value)
    }
  })()
  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderrChunks.push(value)
    }
  })()
  const exitCode = await proc.exited
  await Promise.all([stdoutPromise, stderrPromise])
  const stderr = new TextDecoder().decode(Buffer.concat(stderrChunks as Buffer[]))
  expect(exitCode).toBe(2)
  expect(stderr).toMatch(/Usage:/)
  expect(stderr).toMatch(/nextauth/)
  expect(stderr).toMatch(/postgres/)
})

// ============================================================
// Static invariants: the entrypoint + Dockerfile wire the validator
// into the actual Docker runtime path. These prove the runtime path
// is exercised (not just the standalone script).
// ============================================================

test('docker-entrypoint.sh: invokes bun /app/scripts/validate-secrets.ts for NEXTAUTH_SECRET', () => {
  const src = readSrc('docker-entrypoint.sh')
  // Must call the canonical validator script (not an inline validator).
  expect(src).toContain('bun /app/scripts/validate-secrets.ts nextauth')
  // Must NOT contain the old no-op preliminary `node -e` invocation.
  expect(src).not.toContain("require('/app/node_modules/bun') ? null : null")
  // Must NOT contain the old inline NEXTAUTH_SECRET validator (the
  // `const knownBad = new Set(...)` node one-liner that mirrored the
  // canonical validator inline). The runtime path must delegate to the
  // canonical validator instead.
  expect(src).not.toMatch(/const knownBad = new Set\(/)
})

test('docker-entrypoint.sh: invokes bun /app/scripts/validate-secrets.ts for POSTGRES_PASSWORD (web mode)', () => {
  const src = readSrc('docker-entrypoint.sh')
  expect(src).toContain('bun /app/scripts/validate-secrets.ts postgres')
  // The POSTGRES_PASSWORD validation must be in the web) case (NOT
  // the realtime case — realtime doesn't touch the database).
  const webCaseIdx = src.indexOf('web)')
  const postgresValidatorIdx = src.indexOf('bun /app/scripts/validate-secrets.ts postgres')
  expect(webCaseIdx, 'web) case must exist').toBeGreaterThan(-1)
  expect(postgresValidatorIdx, 'POSTGRES_PASSWORD validator call must exist').toBeGreaterThan(-1)
  expect(postgresValidatorIdx, 'POSTGRES_PASSWORD validator must be AFTER the web) case').toBeGreaterThan(webCaseIdx)
})

test('docker-entrypoint.sh: never echoes the secret/password VALUE', () => {
  const src = readSrc('docker-entrypoint.sh')
  // Word-boundary matching so $NEXTAUTH_SECRET_FAILURE (the failure
  // message variable) does NOT match $NEXTAUTH_SECRET (the secret value).
  const echoLines = src.split('\n').filter(l => {
    const t = l.trim()
    return (t.startsWith('echo ') || t.startsWith('echo\t'))
  })
  for (const ln of echoLines) {
    const bareNextAuth = /\$NEXTAUTH_SECRET(?![A-Za-z0-9_])/
    const bracedNextAuth = /\$\{NEXTAUTH_SECRET\}/
    const barePostgres = /\$POSTGRES_PASSWORD(?![A-Za-z0-9_])/
    const bracedPostgres = /\$\{POSTGRES_PASSWORD\}/
    expect(
      bareNextAuth.test(ln) || bracedNextAuth.test(ln) || barePostgres.test(ln) || bracedPostgres.test(ln),
      `docker-entrypoint.sh echo line must NOT print secret/password value (line: ${ln.trim()})`,
    ).toBe(false)
  }
})

test('Dockerfile: copies scripts/validate-secrets.ts + src/lib/secret-validation.ts into the runtime image', () => {
  const src = readSrc('Dockerfile')
  // The runtime image must contain the canonical validator module
  // AND the runtime validator script — otherwise `bun /app/scripts/validate-secrets.ts`
  // would fail at boot with "cannot find module".
  expect(src).toContain('COPY --from=builder /app/src/lib/secret-validation.ts ./src/lib/secret-validation.ts')
  expect(src).toContain('COPY --from=builder /app/scripts ./scripts')
})

test('docker-compose.yml: passes POSTGRES_PASSWORD as a STANDALONE env var to the app service', () => {
  const src = readSrc('docker-compose.yml')
  // The app service must have POSTGRES_PASSWORD as a standalone env var
  // (NOT just interpolated into DATABASE_URL/DIRECT_URL). The entrypoint
  // reads process.env.POSTGRES_PASSWORD directly — it does NOT parse
  // the password back out of DATABASE_URL.
  expect(src).toMatch(/POSTGRES_PASSWORD:\s*'\$\{POSTGRES_PASSWORD:\?[^}]+\}'/)
  // The standalone POSTGRES_PASSWORD line must come BEFORE the
  // DATABASE_URL line (which interpolates the password into the
  // connection string). This ordering makes it obvious to a reader
  // that the standalone var is the source of truth.
  const standaloneIdx = src.indexOf("POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?")
  const dbUrlIdx = src.indexOf('DATABASE_URL: postgresql://sukhan:${POSTGRES_PASSWORD}')
  expect(standaloneIdx, 'standalone POSTGRES_PASSWORD env var must exist').toBeGreaterThan(-1)
  expect(dbUrlIdx, 'DATABASE_URL line must exist').toBeGreaterThan(-1)
  expect(standaloneIdx, 'standalone POSTGRES_PASSWORD must come before DATABASE_URL').toBeLessThan(dbUrlIdx)
})

test('docker-compose.lite.yml: passes POSTGRES_PASSWORD as a STANDALONE env var to the app service', () => {
  const src = readSrc('docker-compose.lite.yml')
  expect(src).toMatch(/POSTGRES_PASSWORD:\s*'\$\{POSTGRES_PASSWORD:\?[^}]+\}'/)
  const standaloneIdx = src.indexOf("POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?")
  const dbUrlIdx = src.indexOf('DATABASE_URL: postgresql://')
  expect(standaloneIdx, 'standalone POSTGRES_PASSWORD env var must exist').toBeGreaterThan(-1)
  expect(dbUrlIdx, 'DATABASE_URL line must exist').toBeGreaterThan(-1)
  expect(standaloneIdx, 'standalone POSTGRES_PASSWORD must come before DATABASE_URL').toBeLessThan(dbUrlIdx)
})

test('scripts/validate-secrets.ts: imports from the canonical src/lib/secret-validation.ts (no mirrored logic)', () => {
  const src = readSrc('scripts/validate-secrets.ts')
  // The runtime validator must IMPORT the canonical validators —
  // NOT re-implement them inline. This is the synchronization
  // guarantee: any change to the canonical validator automatically
  // affects the runtime path.
  expect(src).toContain("from '../src/lib/secret-validation'")
  expect(src).toContain('validateNextAuthSecret')
  expect(src).toContain('validatePostgresPassword')
  expect(src).toContain('formatSecretFailure')
  // Must NOT contain a mirrored KNOWN_BAD set or PLACEHOLDER_PREFIX
  // (those live in the canonical module only).
  expect(src).not.toMatch(/const KNOWN_BAD_/)
  expect(src).not.toMatch(/const PLACEHOLDER_PREFIX/)
  expect(src).not.toMatch(/\.startsWith\(['"]CHANGE_ME/)
})
