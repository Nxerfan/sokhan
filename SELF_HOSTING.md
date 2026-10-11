# Sukhan Live Chat SaaS — Self-Hosting Guide

This guide covers everything you need to deploy Sukhan on your own server using Docker.

> **License notice**: Sukhan is licensed under AGPL-3.0. If you modify the software and offer it as a web service to others, you must make your modified source code available to your users. See the [AGPL-3.0 plain-language summary](#agpl-30-license--plain-language-summary) below.

---

## Quick Start

### 1. Prerequisites

- **Docker Engine** 24+ and **Docker Compose** v2
- A server with at least **1 GB RAM** (2 GB recommended for the full edition)
- (Optional) A domain name pointing to your server — needed for automatic HTTPS

Check your installation:

```bash
docker --version        # Docker version 24+
docker compose version  # Docker Compose v2
```

### 2. Clone and configure

```bash
git clone <your-fork-url> sukhan
cd sukhan

# Create your env file from the template
cp .env.docker.example .env
```

Edit `.env` and set at minimum:

```bash
# REQUIRED — generate with: openssl rand -base64 32
NEXTAUTH_SECRET=<paste-the-generated-value>

# Your public URL (use your domain if you have one, else http://localhost)
NEXTAUTH_URL=https://chat.example.com

# Your domain for auto-HTTPS (leave empty for HTTP-only local testing)
DOMAIN=chat.example.com

# BOTH editions — strong Postgres password
POSTGRES_PASSWORD=$(openssl rand -hex 24)

# REQUIRED for production signup — Nixify OTP/email-verification API key.
# Without a real key, new-account signup fails with nixify_configuration_error.
# (Local/CI testing only: set NIXIFY_MOCK=true to bypass the real API with a
#  deterministic mock OTP code of 123456 — NEVER enable in production.)
NIXIFY_API_KEY=<your-nixify-api-key>
```

### 3. Choose your edition and start

#### Full edition (recommended for production)

Includes: Next.js app, realtime service, **Postgres**, **Redis**, Caddy.

```bash
docker compose up -d --build
```

#### Lite edition (small VPS / single-user)

Includes: Next.js app, realtime service (in-memory), Caddy, PostgreSQL. No Redis.

```bash
docker compose -f docker-compose.lite.yml up -d --build
```

### 4. Verify

```bash
# All services should show status "healthy" within ~60 seconds
docker compose ps

# Tail the app logs to confirm successful startup
docker compose logs -f app
```

Open your browser to `http://your-server-ip` (or `https://your-domain` if you set `DOMAIN`).
You should see the signup page. Create an account and start chatting.

---

## Environment Variable Reference

See `.env.docker.example` for the full list with comments. Key variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXTAUTH_SECRET` | **Yes** | — | Secret for signing session JWTs + realtime tokens. Generate with `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Yes | `http://localhost` | Public URL where users access the app. |
| `POSTGRES_PASSWORD` | **Yes** (both editions) | — | Password for the Postgres `sukhan` user. |
| `DATABASE_URL` | Auto | — | DB connection string. Set automatically by compose. Override for external DB. |
| `REDIS_URL` | Auto (full) | — | Redis connection string. Set automatically. Override for external Redis. |
| `DOMAIN` | No | empty | Domain for Caddy auto-HTTPS. Empty = HTTP-only. |
| `ACME_EMAIL` | No | `admin@example.com` | Email for Let's Encrypt notifications. |
| `ZARINPAL_MERCHANT_ID` | No | empty | Zarinpal payment gateway merchant ID. |
| `IDPAY_API_KEY` | No | empty | IDPay payment gateway API key. |
| `NIXIFY_API_KEY` | **Yes (production signup)** | empty | Nixify API key for OTP/email-verification delivery. **Required for production self-host signup** — without a real key, new-account signup fails with `nixify_configuration_error`. Both compose files pass this into the app container. |
| `NIXIFY_MOCK` | No | `false` | CI/dev testing ONLY. When `true`, the app bypasses the real Nixify API and accepts a deterministic mock OTP code (`123456`). **Never set `NIXIFY_MOCK=true` in production.** Defaults to `false` in both compose files. |
| `NEXT_PUBLIC_APP_NAME` | No | `Sukhan` | Public-facing app name shown in the UI. |

### Fail-fast on missing required vars

Both `docker-compose.yml` and `docker-compose.lite.yml` use the `${VAR:?error}` syntax for `NEXTAUTH_SECRET` and `POSTGRES_PASSWORD`. If these are missing or empty, `docker compose up` refuses to start and prints a clear error.

The Docker entrypoint (`docker-entrypoint.sh`) re-validates `NEXTAUTH_SECRET` (for both web and realtime modes) and `POSTGRES_PASSWORD` (for web mode only) at container startup. If the env var somehow slips through (e.g. someone runs `docker run` directly without compose), the container exits with a clear error message.

### Reject placeholder/default secrets

Required secret fields in `.env.docker.example` ship BLANK (not with usable-looking `CHANGE_ME_...` values). A fresh `cp .env.docker.example .env` therefore cannot start the stack until the operator pastes real values.

In addition to the empty/missing guard, the Docker entrypoint rejects known-bad placeholder values for `NEXTAUTH_SECRET` (in both web and realtime modes) and `POSTGRES_PASSWORD` (in web mode):

- `NEXTAUTH_SECRET`: the historical `.env.docker.example` placeholder (`CHANGE_ME_generate_with_openssl_rand_base64_32`), the deterministic dev-secret fallback documented in the realtime service (`sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-...`), and any value starting with `CHANGE_ME`.
- `POSTGRES_PASSWORD`: the historical `CHANGE_ME_strong_password_here` placeholder and any `CHANGE_ME`-prefixed value. This is a RUNTIME check (not just compose `${VAR:?...}` — a non-empty placeholder value would otherwise pass the compose guard). `POSTGRES_PASSWORD` is passed to the `app` service as a STANDALONE env var (NOT parsed back out of `DATABASE_URL`) so the entrypoint can validate it directly.

The runtime validator (`scripts/validate-secrets.ts`) imports the SAME canonical validators (`validateNextAuthSecret`, `validatePostgresPassword`) from `src/lib/secret-validation.ts` that the unit tests exercise. There is no mirrored/duplicated validation logic — the runtime path stays synchronized with the tested module by construction.

Startup fails closed: a copied `.env` left at the template defaults, or an `.env` where someone left a documented placeholder in place, cannot reach a running state.

Secret values are NEVER echoed. Failure messages mention the variable NAME only (e.g. `NEXTAUTH_SECRET is set to a known placeholder value`). The actual secret value is never interpolated into any echo, log, or error message.

### Production signup requires a Nixify API key

Account signup uses the Nixify service for OTP/email-verification code delivery. The application keys this off two environment variables, both of which are passed into the `app` container by `docker-compose.yml` and `docker-compose.lite.yml`:

- **`NIXIFY_API_KEY`** — **Required for production self-host signup.** Without a real key, the signup flow fails with a `nixify_configuration_error` and no account is created. Set this in `.env` before bringing the stack up.
- **`NIXIFY_MOCK`** — Defaults to `false`. When set to `true`, the app bypasses the real Nixify API and accepts a **deterministic mock OTP code of `123456`**. This exists for CI and local development only. **Never set `NIXIFY_MOCK=true` on a production deployment** — any visitor could complete signup by entering `123456`.

There is no fallback path: production signup either calls the real Nixify API (with a valid `NIXIFY_API_KEY`) or fails closed. The mock exists solely so CI and local test harnesses can drive the signup flow without consuming real Nixify quota or hitting an external network.

---

## AGPL-3.0 License — Plain Language Summary

Sukhan is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. Here's what that means in plain language.

### Your rights

- **Use** — Run this software for any purpose, including commercially.
- **Study** — Read and modify the source code.
- **Share** — Redistribute the software, in original or modified form.
- **Modify** — Create derivative works.

### Your obligations

- **Share modifications** — If you distribute modified versions, you must share the corresponding source code under the same AGPL-3.0 license.
- **Network use clause** *(the key part)* — **If you modify this software and offer it as a web service to others (over a network), you must make your modified source code available to your users.** This is the "remote network interaction" clause that distinguishes AGPL from regular GPL. It closes the so-called "application service provider loophole" — without it, a company could modify GPL software, run it as a hosted service, and never share their improvements.

### What this means in practice

| Scenario | Obligation |
|----------|------------|
| Running Sukhan **unmodified** for your own organization | None — no obligation to share anything. |
| Running Sukhan **unmodified** as a hosted service for customers | None — you're using the original code, which is already public. |
| Modifying Sukhan and using it **internally only** | None — internal use is not "offering to others". |
| Modifying Sukhan and **offering it as a web service** to users/customers | **You must make your modified source code available to those users.** |

If the last scenario applies to you, you typically satisfy the obligation by:

1. Including a **prominent link** to the source code in the UI (e.g. in the footer, with text like "Source code" linking to your fork).
2. Providing the **complete corresponding source code** — including your modifications — under AGPL-3.0, via a public git repository or on request.

### Attribution

The original Sukhan copyright notice and license must be preserved in all copies and derivative works.

> This plain-language summary is for understanding only. The legally binding text is the full [AGPL-3.0 license](https://www.gnu.org/licenses/agpl-3.0.html). When in doubt, consult a lawyer.

---

## Lite vs Full Edition

| Feature | Lite | Full |
|---------|------|------|
| Database | PostgreSQL (small container, postgres:16-alpine) | PostgreSQL |
| Realtime adapter | In-memory (single instance) | Redis (multi-instance) |
| Containers | 4 (app + realtime + postgres + caddy) | 5 (app + realtime + postgres + redis + caddy) |
| RAM usage | ~512 MB | ~1 GB |
| Horizontal scaling | No | Yes (add more `realtime` replicas) |
| Backup complexity | `pg_dump` + uploads volume | `pg_dump` + uploads volume |
| Best for | Personal use, small team, dev/staging | Production, multi-tenant, scaling |

### When to choose Lite

- Single VPS with ≤ 1 GB RAM.
- Personal or small-team use (under ~100 concurrent users).
- Simple backup (`pg_dump`).
- No need for multi-instance realtime or Redis-backed features.

### When to choose Full

- Production deployment with multiple users/tenants.
- Need horizontal scaling (multiple app or realtime replicas).
- Need Redis-backed features (caching, queues, multi-instance realtime).
- Want horizontal scaling (multiple app or realtime replicas).

### Migrating from Lite to Full

1. Stop the lite stack:
   ```bash
   docker compose -f docker-compose.lite.yml down
   ```
2. Export the Lite PostgreSQL database:
   ```bash
   docker compose -f docker-compose.lite.yml exec -T postgres pg_dump -U sukhan sukhan > backup.sql
   ```
3. Start the full stack (it creates its own fresh Postgres volume):
   ```bash
   docker compose up -d
   ```
4. Import the data into the full stack's Postgres:
   ```bash
   cat backup.sql | docker compose exec -T postgres psql -U sukhan sukhan
   ```
5. The `uploads` volume is shared automatically:
   Both `docker-compose.yml` and `docker-compose.lite.yml` define the same
   named volume `uploads`. When run from the same directory, Docker Compose
   uses the same project name (the directory name), so the `uploads` volume
   is the same physical volume. No copy is needed — uploaded files from the
   Lite stack are immediately available in the Full stack.

---

## Backup and Restore

> Always back up before upgrading or making schema changes.

### Scripted backup and restore (recommended)

The repo ships two operator-facing scripts under `scripts/` that automate the entire backup/restore flow for both Full and Lite editions. They are Compose-aware (no hard-coded project name or volume name) and never echo secrets.

- **`scripts/self-host-backup.sh`** — creates a versioned backup directory containing:
  - `database.sql` — PostgreSQL logical dump (`pg_dump`)
  - `uploads.tar` — tar of the app container's `/app/uploads` directory (message attachments, avatars, logos)
  - `metadata.json` — backup format version (`backup_version=1`), edition (`full`/`lite`), timestamp, compose file, postgres user/db/version, public-schema table list + count, and the latest applied Prisma migration

- **`scripts/self-host-restore.sh`** — destructive restore gated by an explicit `--force` flag.

**What is NOT backed up (and why):**

- **Redis** — holds only ephemeral realtime state (Socket.IO adapter + pub/sub channel). It is not authoritative; a fresh empty Redis is fine after restore because clients reconnect and re-establish state.
- **Logs** — operational, not user data.

**Backup:**

```bash
# Full edition
scripts/self-host-backup.sh --compose-file docker-compose.yml --output-dir /var/backups/sukhan

# Lite edition
scripts/self-host-backup.sh --compose-file docker-compose.lite.yml --output-dir /var/backups/sukhan
```

The script writes a fresh timestamped subdirectory under `--output-dir` (default `./backups`). It auto-detects the edition from the compose file's declared services, derives the postgres user/db from the postgres container env (not hard-coded), and reaches the uploads directory via `docker compose exec app tar` (no hard-coded Docker volume name).

**Restore:**

```bash
# Destructive — requires explicit --force. Refuses to run without it.
scripts/self-host-restore.sh --force \
  --backup-dir /var/backups/sukhan/<backup-timestamp> \
  --compose-file docker-compose.yml
```

The restore flow:

1. Stop `app` + `realtime` (so nothing writes during restore).
2. Start only `postgres`, wait for `pg_isready`.
3. `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then load the SQL dump via `psql` (or `pg_restore --clean --if-exists --no-owner` for a custom-format dump). Post-restore sanity check compares the table count against `metadata.json`.
4. Find the Docker volume backing `/app/uploads` by inspecting the app container (NOT a hard-coded name), clear it, and extract `uploads.tar`.
5. Restart `app` + `realtime`.

The script validates `metadata.json` (backup version, edition match against the target compose file) before touching anything. On any mid-flow failure it attempts to restart `app`+`realtime` so the stack isn't left stopped. Edition mismatch (e.g. restoring a Full backup onto a Lite target) is rejected — restore fails closed.

### Manual backup (advanced)

The scripts above wrap the underlying `pg_dump` / `tar` / `psql` operations. If you need to perform them by hand, the equivalent commands are below.

### Full edition (Postgres + uploads)

**Backup:**

```bash
# 1. Back up the database
docker compose exec -T postgres pg_dump -U sukhan sukhan > backup-$(date +%Y%m%d).sql

# 2. Back up uploads (user-attached files)
docker compose cp app:/app/uploads ./uploads-backup-$(date +%Y%m%d)

# 3. (Optional) Back up the entire postgres data volume for a raw snapshot
docker run --rm -v sukhan_postgres-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/postgres-data-$(date +%Y%m%d).tar.gz /data
```

**Restore:**

```bash
# 1. Stop the app (so nothing writes during restore)
docker compose stop app

# 2. Restore the database
cat backup-YYYYMMDD.sql | docker compose exec -T postgres psql -U sukhan sukhan

# 3. Restore uploads
docker compose cp ./uploads-backup-YYYYMMDD app:/app/uploads

# 4. Restart
docker compose up -d
```

### Lite edition (PostgreSQL)

**Backup:**

```bash
# 1. Back up the database (PostgreSQL)
docker compose -f docker-compose.lite.yml exec -T postgres pg_dump -U sukhan sukhan > backup-$(date +%Y%m%d).sql

# 2. Back up uploads (user-attached files)
docker compose -f docker-compose.lite.yml cp app:/app/uploads ./uploads-backup-$(date +%Y%m%d)
```

**Restore:**

```bash
# 1. Stop the app so nothing writes during restore
docker compose -f docker-compose.lite.yml stop app

# 2. Restore the database
cat backup-YYYYMMDD.sql | docker compose -f docker-compose.lite.yml exec -T postgres psql -U sukhan sukhan

# 3. Restore uploads
docker compose -f docker-compose.lite.yml cp ./uploads-backup-YYYYMMDD app:/app/uploads

# 4. Restart
docker compose -f docker-compose.lite.yml up -d
```

### Automated backups (cron)

The cron job should invoke `scripts/self-host-backup.sh` rather than hand-rolling `pg_dump` + `tar`. The script is Compose-aware (no hard-coded project name or volume name), writes a versioned backup directory with `metadata.json`, and never echoes secrets.

Create `/etc/cron.d/sukhan-backup`:

```cron
# Daily 03:00 — Full edition backup (use docker-compose.lite.yml for Lite)
0 3 * * *  root  cd /opt/sukhan && scripts/self-host-backup.sh --compose-file docker-compose.yml --output-dir /var/backups/sukhan >> /var/log/sukhan-backup.log 2>&1
```

Test the cron job by running the command manually first.

---

## Self-host verification

`scripts/verify-self-host.sh <public-origin>` is a non-destructive operator verification of a deployed Sukhan instance. It only makes `GET` requests — it never sends secrets and never requires admin or API credentials.

```bash
scripts/verify-self-host.sh https://chat.example.com
# or for a local HTTP test:
scripts/verify-self-host.sh http://localhost
```

The script runs four checks and exits `0` only if all pass (exit `1` on any failure, `2` on usage error):

1. **Application responds** — `GET /` returns HTTP 200.
2. **Widget script reachable** — `GET /api/widget/<probe-slug>/script` returns `200` (script served) or `404` (slug lookup miss). Either proves the app is alive and routing the widget-script path correctly.
3. **Public realtime route (port 3003) reachable** — `GET /?XTransformPort=3003&EIO=4&transport=polling` returns HTTP 200 with a body matching the Engine.IO OPEN packet (starts with `0{`). This strictly confirms Socket.IO is reachable through Caddy's public matcher.
4. **Internal port 3004 NOT exposed** — `GET /?XTransformPort=3004&path=/health` must NOT return the realtime `/health` JSON. If the body matches `{"ok":true,...}`, the internal health endpoint has leaked and the check FAILS.

For `https://` origins the script validates normally (no `curl -k`) — a bad certificate correctly fails the checks.

---

## Troubleshooting

### Container won't start: "NEXTAUTH_SECRET is required"

The container exits immediately if `NEXTAUTH_SECRET` is not set, is empty, or is set to a known placeholder value (any `CHANGE_ME_...` value or the realtime dev-secret fallback). Generate a real value and set it in your `.env`:

```bash
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

### Container won't start: "POSTGRES_PASSWORD is required" (both editions)

Same pattern — set a strong password in `.env`. Placeholder values (any `CHANGE_ME_...` value, including the historical `CHANGE_ME_strong_password_here`) are rejected by the runtime secret validator:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d
```

> If you change `POSTGRES_PASSWORD` after the first run, the existing Postgres data volume still has the OLD password. You'll need to either reset the password inside Postgres or delete the volume (`docker compose down -v` — **this deletes all data**).

### Migration fails at app startup

The Docker entrypoint (`docker-entrypoint.sh`) automatically runs
`prisma migrate deploy` before starting the app. If this fails, the
container exits without starting the web server (fail-closed — the app
must NOT run against an unmigrated schema).

Possible causes:

1. **Postgres not ready yet** — check `docker compose logs postgres`. The healthcheck should prevent this, but on slow machines it can race.
2. **Pending migration files missing** — ensure the `prisma/migrations/` directory is present in the image. Migrations are applied from these files, not generated at runtime.
3. **Wrong DATABASE_URL / DIRECT_URL** — verify the connection strings:
   ```bash
   docker compose exec app printenv DATABASE_URL
   docker compose exec app printenv DIRECT_URL
   ```

To manually re-run the production-safe migration (non-destructive — applies
pending migration files only):

```bash
docker compose exec app prisma migrate deploy
```

### Socket.IO not working (realtime messages not delivered)

1. Check the realtime service is running and healthy:
   ```bash
   docker compose ps realtime
   docker compose logs --tail 50 realtime
   ```
2. Hit the health endpoint directly (from inside the realtime container — port 3004 is **internal-only**, NOT publicly routable):
   ```bash
   docker compose exec realtime wget -qO- http://localhost:3004/health
   # Should print: {"ok":true,"connections":N,"redis":true/false}
   ```
3. Check Caddy is routing `?XTransformPort=3003` traffic to the realtime service:
   ```bash
   docker compose logs caddy | grep -i realtime
   ```
4. If using full edition, verify Redis is up:
   ```bash
   docker compose exec redis redis-cli ping  # should print PONG
   ```
5. In the browser console, check the Socket.IO connection URL — it should be relative (`/?XTransformPort=3003`), not `http://localhost:3003`.

#### Caddy realtime routing — exact matcher, not a wildcard

The Docker `Caddyfile` uses an **exact matcher** for the `XTransformPort=3003` query param. Only `?XTransformPort=3003` is proxied to the realtime container's public Socket.IO port (3003). This is deliberate hardening, not a glob/wildcard:

- **Port 3003** — the public realtime (Socket.IO) port. Reachable via `?XTransformPort=3003` through Caddy. This is the only realtime port a browser/widget/dashboard client ever needs.
- **Port 3004** — the realtime service's internal HTTP port (serves `/health` and `/internal/publish`). Used only server-to-server (the app publishes message events to realtime over `REALTIME_INTERNAL_URL=http://realtime:3004`). It is **NOT publicly routable** — a request with `?XTransformPort=3004` falls through to the Next.js app handler, which does not serve realtime endpoints.
- **Arbitrary `XTransformPort` values are NOT proxied.** Anything other than exactly `3003` falls through to the Next.js app. A client cannot reach the realtime container by inventing a port number.

If realtime is unreachable from the browser, verify the request URL uses exactly `?XTransformPort=3003` and that the realtime container is up.

### Caddy can't get an HTTPS certificate

> **Release gate — real-domain HTTPS not verified by CI.**
> Setting `DOMAIN` in `.env` enables Caddy's automatic HTTPS via Let's Encrypt (ACME HTTP-01 challenge on ports 80 + 443). The Sukhan CI pipeline does NOT verify real-domain HTTPS end-to-end — there is no real DNS A record and no real ACME issuance in CI. CI only verifies HTTP-only local routing and the Caddyfile's exact `XTransformPort` matcher logic. **State: `MANUAL EXTERNAL RELEASE GATE — REAL-DOMAIN HTTPS/ACME NOT VERIFIED BY CI`.** Before declaring a self-hosted release production-ready against a real domain, an operator MUST manually confirm Caddy issued a Let's Encrypt certificate and that `https://<domain>` loads over a valid cert.

- Ensure your domain's DNS **A record** points to your server's public IP:
  ```bash
  dig +short chat.example.com  # should print your server's IP
  ```
- Ensure **ports 80 AND 443** are open in your firewall (Caddy uses HTTP-01 challenge which needs port 80).
- Check Caddy logs for ACME errors:
  ```bash
  docker compose logs caddy | grep -i acme
  ```
- For local testing without a domain, leave `DOMAIN` empty (HTTP-only on port 80).

### Can't upload files (attachments)

The `uploads` directory might not be writable or might not exist:

```bash
docker compose exec app ls -la /app/uploads
```

If the directory is missing or owned by the wrong user, recreate the volume:

```bash
docker compose down
docker volume rm sukhan_uploads
docker compose up -d
```

### Database connection errors (full edition)

1. Verify Postgres is healthy: `docker compose ps postgres`
2. Verify the password in `.env` matches what Postgres was initialized with.
3. Try connecting manually:
   ```bash
   docker compose exec postgres psql -U sukhan -d sukhan
   ```
4. If the password was changed after first run, you'll need to reset it inside Postgres or delete the volume (data loss):
   ```bash
   docker compose down -v  # WARNING: deletes ALL data
   docker compose up -d
   ```

### Out of memory (OOM)

- Lite edition: minimum 512 MB RAM for the host.
- Full edition: minimum 1 GB RAM; recommended 2 GB.
- If you see OOM kills in `dmesg`, increase the server size or reduce replicas.
- For the app container specifically, set `NODE_OPTIONS=--max-old-space-size=512` to cap Node's heap.

### Realtime service says "redis setup failed"

The realtime service continues with the in-memory adapter if Redis is unavailable. To fix:

1. Check Redis health: `docker compose ps redis`
2. Check Redis logs: `docker compose logs redis`
3. Verify the `REDIS_URL` is set correctly in the realtime service:
   ```bash
   docker compose exec realtime printenv REDIS_URL
   # Should print: redis://redis:6379
   ```
4. If using an external Redis, ensure the realtime container can reach it (network, firewall, auth).

### Need more help?

- Check `worklog.md` in the repo root for known issues + fixes from prior development sessions.
- Search the project's issue tracker.
- When reporting a bug, include:
  - Output of `docker compose ps`
  - Output of `docker compose logs --tail 100 <problematic-service>`
  - Your `.env` file **with secrets redacted**

---

## Widget installation

The chat widget is delivered to visitor pages directly from your self-hosted Sukhan instance — there is no separate CDN and no external package fetch required at runtime.

### Script-tag installation (always supported)

After creating a widget config in the dashboard, embed the widget on any visitor-facing page using a script tag that points back at your Sukhan origin:

```html
<script async defer src="https://your-sukhan-domain/api/widget/<slug>/script"></script>
```

Replace `<slug>` with the widget slug shown in the dashboard's Widget settings, and `https://your-sukhan-domain` with your Sukhan origin. The script tag is self-contained: it fetches the per-slug config from the same origin, injects the launcher + chat panel, and opens a Socket.IO connection back to `/?XTransformPort=3003` on your Sukhan origin.

This installation method is **always supported** and is what the dashboard's Widget settings panel copy-snippet uses.

### NPM package status — NOT YET PUBLISHED

The repository also includes a buildable `sukhan-widget` NPM package (under `packages/widget-npm/`) for consumers who want to import the widget as an ES module from a bundler. The package is publication-ready:

- A proper build step (`tsc` → `dist/*.js` + `*.d.ts`).
- An `.npmignore` that excludes `src/`, `node_modules/`, `tsconfig.json`, tests, and `.env.example` from the published tarball.
- A GitHub Actions publish workflow (`.github/workflows/publish-npm.yml`) triggered by a GitHub Release/tag publication or manual `workflow_dispatch` (with a dry-run option that packs and verifies without publishing).

**The `sukhan-widget` package has NOT yet been published to the public NPM registry.** Until it is published, the following commands DO NOT work:

```bash
# THESE DO NOT WORK YET — the package is not on the public NPM registry:
npm install sukhan-widget
bun add sukhan-widget
```

The single remaining external action to make the package installable from NPM is for the repository owner to:

1. Create an `NPM_TOKEN` GitHub Actions secret in the repository settings (an NPM access token with publish permission for the package scope).
2. Trigger the publish workflow — either by publishing a GitHub Release (which fires the `release: published` trigger) or by manually running the "Publish NPM Package" workflow with `dry_run=false`.

Until that happens, use the **script-tag installation** above. It is the always-supported alternative and works on any self-hosted Sukhan instance regardless of NPM publication status.

---

## Updating to a new version

```bash
# 1. Back up first (see Backup section above)

# 2. Pull the new code
git pull

# 3. Rebuild the image
docker compose build

# 4. Recreate containers with the new image
#    The Docker entrypoint automatically applies pending Prisma migrations
#    (prisma migrate deploy) on startup — no manual migration step needed.
docker compose up -d

# 6. Verify
docker compose ps
```

For the lite edition, substitute `docker compose -f docker-compose.lite.yml` for `docker compose`.

---

## Uninstalling

```bash
# Stop and remove containers
docker compose down

# ALSO remove all data (DATABASE, UPLOADS, LOGS) — irreversibly:
docker compose down -v
docker volume ls | grep sukhan  # confirm volumes are gone
```

Remove the Docker image:

```bash
docker image rm sukhan:latest
```
