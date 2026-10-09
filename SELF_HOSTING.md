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
| `NEXT_PUBLIC_APP_NAME` | No | `Sukhan` | Public-facing app name shown in the UI. |

### Fail-fast on missing required vars

Both `docker-compose.yml` and `docker-compose.lite.yml` use the `${VAR:?error}` syntax for `NEXTAUTH_SECRET` and `POSTGRES_PASSWORD`. If these are missing or empty, `docker compose up` refuses to start and prints a clear error.

The Docker entrypoint (`docker-entrypoint.sh`) re-validates `NEXTAUTH_SECRET` at container startup. If the env var somehow slips through (e.g. someone runs `docker run` directly without compose), the container exits with a clear error message.

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

Create `/etc/cron.d/sukhan-backup`:

```cron
0 3 * * *  root  cd /opt/sukhan && docker compose exec -T postgres pg_dump -U sukhan sukhan > /backups/sukhan/db-$(date +\%Y\%m\%d).sql
15 3 * * *  root  cd /opt/sukhan && docker run --rm -v sukhan_uploads:/data -v /backups/sukhan:/backup alpine tar czf /backup/uploads-$(date +\%Y\%m\%d).tar.gz /data
```

Test the cron job by running the commands manually first.

---

## Troubleshooting

### Container won't start: "NEXTAUTH_SECRET is required"

The container exits immediately if `NEXTAUTH_SECRET` is not set. Generate a value and set it in your `.env`:

```bash
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

### Container won't start: "POSTGRES_PASSWORD is required" (both editions)

Same pattern — set a strong password in `.env`:

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
2. Hit the health endpoint directly:
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

### Caddy can't get an HTTPS certificate

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
