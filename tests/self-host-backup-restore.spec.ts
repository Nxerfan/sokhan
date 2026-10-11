import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Self-host backup / destroy / restore CI drill — PRODUCTION SHAPE.
 *
 * For BOTH Full and Lite Docker editions:
 *   - Uses ONLY the production compose file
 *     (docker-compose.yml for Full, docker-compose.lite.yml for Lite).
 *   - NO test override compose (docker-compose.test.yml /
 *     docker-compose.lite.test.yml) — production ports only:
 *     80 (Caddy HTTP) + 443 (Caddy HTTPS) on the host.
 *   - ALL application requests go through http://127.0.0.1 (port 80,
 *     production Caddy origin). NO direct app:3000 access from the host.
 *   - NIXIFY_MOCK / NEXTAUTH_SECRET / POSTGRES_PASSWORD are passed as
 *     environment variables when invoking `docker compose`. They are
 *     NOT set via a test override compose file.
 *   - The test manages Docker itself: `docker compose -f <file> up -d`,
 *     `docker compose -f <file> down -v`, etc.
 *   - Internal operations (sentinel file creation, backup, restore,
 *     sentinel content verification) use `docker compose exec` inside
 *     the compose network — they do NOT bypass Caddy by hitting the
 *     app container from the host.
 *   - After `down -v`, the volumes are verified GENUINELY GONE using
 *     Compose project-aware inspection
 *     (`docker volume ls -q --filter "label=com.docker.compose.project=…"`).
 *   - The SAME public origin (http://127.0.0.1) is used BEFORE and AFTER
 *     restore — the test does not switch to a different port or host.
 *
 * Test flow (per edition):
 *   1.  Fresh volumes (down -v at start to clean any leftover state).
 *   2.  Start the PRODUCTION compose file with NIXIFY_MOCK=true.
 *   3.  Wait for Caddy on http://127.0.0.1.
 *   4.  Signup + login through Caddy.
 *   5.  Create visitor / conversation / messages through Caddy.
 *   6.  Create uploads sentinel via `docker compose exec`.
 *   7.  Run scripts/self-host-backup.sh (real operator script).
 *   8.  down -v + assert all project volumes are gone.
 *   9.  Fresh volumes (up -d again).
 *   10. Run scripts/self-host-restore.sh --force (real operator script).
 *   11. Login as original user through Caddy.
 *   12. Verify workspace / conversation / messages through Caddy.
 *   13. Verify uploads sentinel exact content via `docker compose exec`.
 *   14. Send a post-restore message through Caddy (proves DB is writable).
 *   15. Cleanup: down -v.
 */

const ORIGIN = 'http://127.0.0.1' // Caddy HTTP on port 80 (production).
const REPO_ROOT = process.cwd()
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts/self-host-backup.sh')
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts/self-host-restore.sh')

/**
 * Secrets passed as env vars when invoking docker compose. The canonical
 * secret validator (src/lib/secret-validation.ts) only rejects known
 * placeholder values (`CHANGE_ME_…`, the documented dev fallback, the
 * historical .env.docker.example values). These test values pass
 * production validation because they are non-empty, non-placeholder
 * strings. They are NOT used anywhere outside this test stack.
 */
const COMPOSE_ENV: Record<string, string> = {
  NIXIFY_MOCK: 'true',
  NEXTAUTH_SECRET: 'test-secret',
  POSTGRES_PASSWORD: 'test-password',
}

interface EditionSpec {
  composeFile: string
  /** Deterministic Compose project name. Sets volume label namespace. */
  projectName: string
  label: string
}

/**
 * Both Full and Lite tests use the SAME host port 80 (Caddy HTTP). They
 * cannot run in parallel. Playwright config sets `workers: 1,
 * fullyParallel: false`, so the two tests run sequentially. Each test
 * `down -v`s at the START and END so the second test always starts
 * with the previous stack fully torn down (port 80 free).
 *
 * The two editions use DIFFERENT Compose project names so their volumes
 * (some volume names overlap, e.g. `uploads`, `logs`, `caddy-data`,
 * `caddy-config`) never collide on the Docker daemon.
 */
const EDITIONS: EditionSpec[] = [
  {
    composeFile: join(REPO_ROOT, 'docker-compose.yml'),
    projectName: 'sukhan-bakres-full',
    label: 'full',
  },
  {
    composeFile: join(REPO_ROOT, 'docker-compose.lite.yml'),
    projectName: 'sukhan-bakres-lite',
    label: 'lite',
  },
]

/**
 * Run `docker compose` against the given edition with the deterministic
 * project name + COMPOSE_ENV. Captures stdout/stderr; on failure, logs
 * the captured output to the test console (Playwright attaches console
 * output to the test trace) so the operator can see WHY the docker
 * command failed.
 */
function runDocker(spec: EditionSpec, args: string, env: Record<string, string> = {}): string {
  const cmd = `docker compose -f ${spec.composeFile} -p ${spec.projectName} ${args}`
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      env: { ...process.env, ...COMPOSE_ENV, ...env },
      // The longest docker op is `up -d` (which includes migrations on
      // first start). 3 minutes is generous; matches Playwright's
      // 5-minute per-test timeout headroom.
      timeout: 180000,
    })
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    console.error(`[docker] FAILED: ${cmd}`)
    if (err.stdout) console.error(`[docker] stdout: ${err.stdout}`)
    if (err.stderr) console.error(`[docker] stderr: ${err.stderr}`)
    throw e
  }
}

/**
 * List Docker volumes belonging to the Compose project, using the
 * project-aware filter label `com.docker.compose.project=<project>`.
 * Returns the raw `docker volume ls -q` output (one volume name per
 * line, trimmed). Empty string means no project volumes exist.
 */
function listProjectVolumes(spec: EditionSpec): string {
  return execSync(
    `docker volume ls -q --filter "label=com.docker.compose.project=${spec.projectName}"`,
    { encoding: 'utf-8' },
  ).trim()
}

/**
 * Poll the Caddy origin until /api returns 200. Caddy proxies /api to
 * app:3000 (Next.js). Returns once the Next.js app is responding.
 * Throws if the origin does not return 200 within maxMs.
 */
async function waitForCaddy(maxMs = 120000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${ORIGIN}/api`)
      // 200 = Next.js app catch-all route is responding through Caddy.
      // Other statuses (502 = Caddy up but app down, 404 = app up but
      // no route) keep polling.
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(
    `${ORIGIN}/api did not return 200 within ${maxMs}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  )
}

/**
 * Login via the NextAuth credentials callback through Caddy. The
 * APIRequestContext carries cookies, so subsequent requests on the
 * same context are authenticated.
 */
async function loginViaCaddy(request: APIRequestContext, email: string, password: string): Promise<void> {
  const csrfRes = await request.get(`${ORIGIN}/api/auth/csrf`)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  await request.post(`${ORIGIN}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=${password}&csrfToken=${csrfToken}&json=true`,
  })
}

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `bakres-${stamp}@test.com`,
    workspace: `BakRes ${stamp}`,
    password: 'password123',
  }
}

for (const spec of EDITIONS) {
  test(`Backup/destroy/restore drill — ${spec.label} edition (production shape)`, async ({ browser }) => {
    test.setTimeout(300000) // 5 minutes per edition — slow Docker test.
    const { email, workspace, password } = creds(spec.label)
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const backupDir = `/tmp/backup-drill-${spec.label}-${stamp}`

    try {
      // ---- Step 1: Fresh volumes (clean any leftover state). ----
      // Tolerate failure here — if a previous test crashed mid-cleanup
      // the project may already be gone.
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch {
        // ignore — the project may not exist yet
      }
      expect(
        listProjectVolumes(spec),
        `no volumes should exist for project ${spec.projectName} at the start`,
      ).toBe('')

      // ---- Step 2: Start the PRODUCTION compose file. ----
      // No --no-build: if the image is missing, docker compose builds it
      // (the production Dockerfile is the build source). In CI the image
      // is pre-built; locally this also works.
      runDocker(spec, 'up -d')

      // ---- Step 3: Wait for Caddy on http://127.0.0.1. ----
      await waitForCaddy()

      // ---- Step 4: Signup + login through Caddy. ----
      const page = await browser.newPage()
      await otpSignupPlaywright(page.request, ORIGIN, email, workspace)
      await loginViaCaddy(page.request, email, password)
      await page.goto(ORIGIN)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(2000)
      await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })

      // Get slug + tenant info via Caddy.
      const tenantRes = await page.request.get(`${ORIGIN}/api/tenants/me`)
      const tenantData = (await tenantRes.json()) as { tenant?: { slug?: string; id?: string } }
      const slug = tenantData.tenant?.slug
      expect(slug, 'slug should be set').toBeTruthy()

      // ---- Step 5: Create visitor + conversation + messages through Caddy. ----
      const visitorId = `bakres-${stamp}`
      const contactRes = await page.request.post(`${ORIGIN}/api/widget/${slug}/contact`, {
        data: { visitorId, name: `BackupTest-${stamp}` },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(contactRes.ok()).toBe(true)
      const contactData = (await contactRes.json()) as { realtimeToken?: string }
      const realtimeToken = contactData.realtimeToken
      expect(realtimeToken, 'widget contact should return a realtimeToken').toBeTruthy()

      const visitorMsg = `BAKRES_VISITOR_${stamp}`
      const msgRes = await page.request.post(`${ORIGIN}/api/widget/${slug}/messages`, {
        data: { text: visitorMsg },
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realtimeToken}` },
      })
      expect(msgRes.ok()).toBe(true)
      const msgData = (await msgRes.json()) as { conversationId?: string }
      const conversationId = msgData.conversationId
      expect(conversationId, 'visitor message should return a conversationId').toBeTruthy()

      // Agent reply via the authenticated dashboard API through Caddy.
      const agentReply = `BAKRES_AGENT_${stamp}`
      const replyRes = await page.request.post(
        `${ORIGIN}/api/conversations/${conversationId}/messages`,
        {
          data: { text: agentReply },
          headers: { 'Content-Type': 'application/json' },
        },
      )
      expect(replyRes.ok()).toBe(true)

      // ---- Step 6: Create uploads sentinel via `docker compose exec`. ----
      // Operates INSIDE the compose network. The sentinel content is
      // deterministic and shell-safe (alnum + underscore only).
      const sentinelContent = `SENTINEL_${stamp}`
      const sentinelPath = `/app/uploads/sentinel-${stamp}.txt`
      runDocker(spec, `exec -T app sh -c "echo '${sentinelContent}' > ${sentinelPath}"`)

      // ---- Step 7: Run the real operator backup script. ----
      // The script reads COMPOSE_PROJECT_NAME from the env so all its
      // internal `docker compose -f <file> …` calls operate on the
      // same project we just spun up.
      rmSync(backupDir, { recursive: true, force: true })
      execSync(`${BACKUP_SCRIPT} --compose-file ${spec.composeFile} --output-dir ${backupDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, ...COMPOSE_ENV, COMPOSE_PROJECT_NAME: spec.projectName },
        timeout: 180000,
      })
      const actualBackupDir = execSync(`ls -d ${backupDir}/sukhan-*`, {
        encoding: 'utf-8',
      }).trim()
      expect(existsSync(`${actualBackupDir}/metadata.json`), 'metadata.json must exist').toBe(true)
      expect(existsSync(`${actualBackupDir}/database.sql`), 'database.sql must exist').toBe(true)
      expect(existsSync(`${actualBackupDir}/uploads.tar`), 'uploads.tar must exist').toBe(true)

      // ---- Step 8: down -v + verify volumes are genuinely gone. ----
      runDocker(spec, 'down -v --remove-orphans')
      const volumesAfterDown = listProjectVolumes(spec)
      expect(
        volumesAfterDown,
        `all volumes for project "${spec.projectName}" must be gone after down -v (got: ${volumesAfterDown})`,
      ).toBe('')

      // ---- Step 9: Fresh volumes — start the production compose again. ----
      runDocker(spec, 'up -d')
      await waitForCaddy()

      // ---- Step 10: Run the real operator restore script with --force. ----
      // The script stops app + realtime, starts only postgres, DROPs the
      // public schema, loads the SQL dump, clears the uploads volume +
      // extracts the tar, then restarts app + realtime. After it exits,
      // we wait for Caddy to confirm the app is back up.
      execSync(
        `${RESTORE_SCRIPT} --force --backup-dir ${actualBackupDir} --compose-file ${spec.composeFile}`,
        {
          encoding: 'utf-8',
          env: { ...process.env, ...COMPOSE_ENV, COMPOSE_PROJECT_NAME: spec.projectName },
          timeout: 180000,
        },
      )
      await waitForCaddy()

      // ---- Step 11: Login as the original user through Caddy. ----
      await loginViaCaddy(page.request, email, password)

      // ---- Step 12: Verify workspace + conversation + messages through Caddy. ----
      const tenantRes2 = await page.request.get(`${ORIGIN}/api/tenants/me`)
      expect(tenantRes2.ok(), 'tenant endpoint should work after restore').toBe(true)
      const tenantData2 = (await tenantRes2.json()) as {
        tenant?: { name?: string; slug?: string }
      }
      expect(tenantData2.tenant?.name, 'workspace name should match').toBe(workspace)
      expect(tenantData2.tenant?.slug, 'slug should match').toBe(slug)

      // Conversation list should contain the original conversation.
      const convRes = await page.request.get(`${ORIGIN}/api/conversations`)
      expect(convRes.ok()).toBe(true)
      const convData = (await convRes.json()) as { conversations?: Array<{ id: string }> }
      const conv = convData.conversations?.find((c) => c.id === conversationId)
      expect(conv, 'conversation should exist after restore').toBeTruthy()

      // Messages endpoint should return both the visitor + agent messages.
      const msgRes2 = await page.request.get(
        `${ORIGIN}/api/widget/${slug}/messages?conversationId=${conversationId}`,
        { headers: { Authorization: `Bearer ${realtimeToken}` } },
      )
      expect(msgRes2.ok(), 'messages endpoint should work after restore').toBe(true)
      const msgData2 = (await msgRes2.json()) as {
        messages?: Array<{ content?: { text?: string } }>
      }
      const messages = msgData2.messages ?? []
      const hasVisitorMsg = messages.some((m) => m.content?.text === visitorMsg)
      const hasAgentReply = messages.some((m) => m.content?.text === agentReply)
      expect(hasVisitorMsg, 'visitor message should exist after restore').toBe(true)
      expect(hasAgentReply, 'agent reply should exist after restore').toBe(true)

      // ---- Step 13: Verify uploads sentinel exact content via exec. ----
      const sentinelRes = runDocker(spec, `exec -T app cat ${sentinelPath}`)
      expect(sentinelRes.trim(), 'uploads sentinel content must match exactly').toBe(
        sentinelContent,
      )

      // ---- Step 14: Send a post-restore message through Caddy (DB writable). ----
      const postRestoreMsg = `POST_RESTORE_${stamp}`
      const postRes = await page.request.post(`${ORIGIN}/api/widget/${slug}/messages`, {
        data: { text: postRestoreMsg },
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realtimeToken}` },
      })
      expect(postRes.ok(), 'post-restore message should persist (DB is writable)').toBe(true)
      const postData = (await postRes.json()) as { message?: { id?: string } }
      expect(postData.message?.id, 'post-restore message should have a persisted id').toBeTruthy()

      await page.close()
    } finally {
      // ---- Step 15: Cleanup — always tear down, even on test failure. ----
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch (e) {
        console.error(`[cleanup] failed to down -v for ${spec.label}:`, e)
      }
      rmSync(backupDir, { recursive: true, force: true })
    }
  })
}
