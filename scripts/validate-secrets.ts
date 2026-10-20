/**
 * Runtime secret validator — runs at Docker container boot.
 *
 * This is the RUNTIME counterpart of `src/lib/secret-validation.ts`. It
 * imports the SAME canonical validators (`validateNextAuthSecret`,
 * `validatePostgresPassword`, `formatSecretFailure`) so the runtime
 * path stays synchronized with the unit-tested pure module. There is
 * no mirrored/duplicated validation logic — the entrypoint calls
 * this script via `bun /app/scripts/validate-secrets.ts <which>`, and
 * this script reads the env var, calls the canonical validator, and
 * prints the failure message (or exits 0 on success).
 *
 * Why a separate script (not inline node -e in the entrypoint)?
 *   - The entrypoint runs in a shell. The validator logic lives in a
 *     TypeScript module that is unit-tested. Inlining the validator
 *     logic as a node one-liner in shell would create a second copy
 *     of the logic that drifts from the canonical module.
 *   - This script is the SINGLE runtime caller of the canonical
 *     validators. The entrypoint just invokes it and prints the
 *     captured stderr on failure.
 *
 * Usage:
 *   bun scripts/validate-secrets.ts nextauth   # validates NEXTAUTH_SECRET
 *   bun scripts/validate-secrets.ts postgres   # validates POSTGRES_PASSWORD
 *
 * Exit codes:
 *   0  — valid (no output)
 *   1  — invalid (failure message on stderr, NEVER the secret value)
 *   2  — usage error (unknown `<which>` argument)
 *
 * The failure message is written to STDERR (not stdout) so the
 * entrypoint can capture it via `2>&1` and conditionally print it
 * wrapped in a clear FATAL banner.
 *
 * DESIGN INVARIANTS (verified by tests/unit/runtime-secret-validation.test.ts):
 *   - The failure message NEVER contains the supplied secret/password value.
 *   - A missing env var fails.
 *   - An empty env var fails.
 *   - A known-placeholder env var fails (CHANGE_ME_..., documented dev
 *     fallback, historical .env.docker.example placeholders).
 *   - A real non-placeholder value passes (exit 0, no output).
 */
import {
  validateNextAuthSecret,
  validatePostgresPassword,
  formatSecretFailure,
} from '../src/lib/secret-validation'

const which = process.argv[2]

let result: ReturnType<typeof validateNextAuthSecret> | null = null
if (which === 'nextauth') {
  result = validateNextAuthSecret(process.env.NEXTAUTH_SECRET)
} else if (which === 'postgres') {
  result = validatePostgresPassword(process.env.POSTGRES_PASSWORD)
} else {
  process.stderr.write(
    `Usage: bun scripts/validate-secrets.ts <nextauth|postgres>\n` +
    `  nextauth  → validate NEXTAUTH_SECRET (required for web + realtime modes)\n` +
    `  postgres  → validate POSTGRES_PASSWORD (required for web mode only)\n`,
  )
  process.exit(2)
}

if (!result.ok) {
  // The formatSecretFailure() function is contract-bound to NEVER
  // interpolate the secret value — only the variable name + a generic
  // reason. This is verified by the unit tests + the runtime behavioral
  // test.
  process.stderr.write(formatSecretFailure(result) + '\n')
  process.exit(1)
}

process.exit(0)
