# Sukhan — Headless Linux Server Deployment Guide

This guide covers deploying Sukhan on a headless Linux server (VPS, dedicated server, or cloud instance) using Docker.

---

## Prerequisites

### 1. Install Docker Engine + Docker Compose

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Add the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add your user to the docker group (avoid sudo for every command)
sudo usermod -aG docker $USER

# Log out and back in (or: newgrp docker)
newgrp docker

# Verify
docker --version          # Docker version 24+
docker compose version    # Docker Compose v2+
```

### 2. Server Requirements

- **RAM:** 1 GB minimum (2 GB recommended for full edition)
- **Disk:** 10 GB minimum (for Docker images + database + uploads)
- **OS:** Ubuntu 22.04+ / Debian 12+ / CentOS 9+ (any modern Linux with Docker support)
- **Ports:** 80 (HTTP) and 443 (HTTPS) open in your firewall

---

## Deployment — Lite Edition (SQLite, no Redis)

Best for: small VPS, single-tenant, testing, low traffic.

### Step 1: Get the code

```bash
git clone <your-repo-url> sukhan
cd sukhan
```

### Step 2: Configure environment

```bash
cp .env.docker.example .env
nano .env
```

Set these required values:

```bash
# REQUIRED — generate with: openssl rand -base64 32
NEXTAUTH_SECRET=<paste the generated value here>

# For OTP email verification (required for signup)
NIXIFY_API_KEY=<your-nixify-api-key>
NIXIFY_BASE_URL=https://your-nixify-domain.com/api/v1
```

Optional values (have defaults):

```bash
NEXTAUTH_URL=http://localhost       # Change to your domain for production
DOMAIN=chat.example.com             # Set for auto-HTTPS via Let's Encrypt
ACME_EMAIL=admin@example.com        # Email for Let's Encrypt notifications
```

### Step 3: Build and start

```bash
docker compose -f docker-compose.lite.yml up -d --build
```

This will:
1. Build the Docker image (Next.js standalone + realtime service)
2. Start three containers: app (Next.js), realtime (Socket.IO), caddy (reverse proxy)
3. Apply the database schema automatically (Prisma `db push` at startup)

### Step 4: Verify

```bash
# Check container status
docker compose -f docker-compose.lite.yml ps

# All three should show "Up" + "healthy":
# sukhan-app-lite      Up (healthy)
# sukhan-realtime-lite Up (healthy)
# sukhan-caddy-lite    Up (healthy)

# Test the app
curl http://localhost
# Should return the Sukhan marketing homepage HTML
```

Open your browser to `http://your-server-ip` — you should see the Sukhan marketing site.

---

## Deployment — Full Edition (PostgreSQL + Redis)

Best for: production, multi-tenant, higher traffic, horizontal scaling.

### Step 1: Get the code + configure

```bash
git clone <your-repo-url> sukhan
cd sukhan
cp .env.docker.example .env
nano .env
```

Set these required values:

```bash
# REQUIRED
NEXTAUTH_SECRET=<openssl rand -base64 32>
POSTGRES_PASSWORD=<a-strong-password>
NIXIFY_API_KEY=<your-nixify-api-key>
NIXIFY_BASE_URL=https://your-nixify-domain.com/api/v1

# For production with HTTPS
NEXTAUTH_URL=https://chat.example.com
DOMAIN=chat.example.com
ACME_EMAIL=admin@example.com
```

### Step 2: Build and start

```bash
docker compose up -d --build
```

This starts 5 containers: app, realtime, postgres, redis, caddy.

### Step 3: Verify

```bash
docker compose ps
# All 5 should be "Up (healthy)"
```

---

## Common Operations

### View logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f app
docker compose logs -f realtime

# Lite edition
docker compose -f docker-compose.lite.yml logs -f
```

### Restart a service

```bash
docker compose restart app
docker compose -f docker-compose.lite.yml restart app
```

### Update to a new version

```bash
git pull origin main
docker compose up -d --build
```

### Stop everything

```bash
docker compose down
# Lite:
docker compose -f docker-compose.lite.yml down
```

### Backup

#### Lite edition (SQLite)

```bash
# The SQLite database is in a Docker volume named sukhan_sqlite-data
docker compose -f docker-compose.lite.yml exec app cp /app/data/sukhan.db /app/uploads/sukhan-backup.db
docker cp sukhan-app-lite:/app/uploads/sukhan-backup.db ./sukhan-backup-$(date +%Y%m%d).db
```

#### Full edition (PostgreSQL)

```bash
docker compose exec postgres pg_dump -U sukhan sukhan > backup-$(date +%Y%m%d).sql
```

### Restore

#### Lite edition

```bash
docker cp ./sukhan-backup-20240101.db sukhan-app-lite:/app/data/sukhan.db
docker compose -f docker-compose.lite.yml restart app
```

#### Full edition

```bash
docker compose exec -T postgres psql -U sukhan sukhan < backup-20240101.sql
```

---

## HTTPS / Domain Setup

### Option A: Let Caddy handle it (recommended)

1. Point your domain (`chat.example.com`) to your server's IP address (A record in DNS)
2. Set in `.env`:
   ```bash
   DOMAIN=chat.example.com
   ACME_EMAIL=admin@example.com
   ```
3. Restart: `docker compose restart caddy`
4. Caddy automatically provisions a Let's Encrypt TLS certificate

### Option B: Behind an existing reverse proxy (Nginx, Cloudflare, etc.)

If you already have a reverse proxy:

1. Don't set `DOMAIN` in `.env` (leave empty for HTTP-only on port 80)
2. Configure your reverse proxy to forward to `http://your-server-ip:80`
3. Set `NEXTAUTH_URL=https://chat.example.com` in `.env`

---

## Firewall Configuration

```bash
# Allow HTTP + HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# If using the full edition with external database access (not recommended):
# sudo ufw allow 5432/tcp  # PostgreSQL
# sudo ufw allow 6379/tcp  # Redis

# Enable firewall
sudo ufw enable
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs app
docker compose logs realtime

# Common issues:
# - NEXTAUTH_SECRET not set → add to .env
# - NIXIFY_API_KEY not set → add to .env (or set NIXIFY_MOCK=true for testing)
# - Port 80 already in use → stop the conflicting service (e.g., nginx, apache)
```

### Database errors

```bash
# Lite: reset the database (WARNING: loses all data)
docker compose -f docker-compose.lite.yml down
docker volume rm sukhan_sqlite-data
docker compose -f docker-compose.lite.yml up -d --build

# Full: check PostgreSQL logs
docker compose logs postgres
```

### Widget not loading on customer site

1. Check that the domain is in the allowed domains list (Dashboard → Websites)
2. Check the browser console for CORS errors
3. Verify the widget script URL is correct: `https://your-domain/api/widget/<slug>/script`
4. For the NPM package, verify `SUKHAN_API_KEY` is set correctly in `.env`

### Socket.IO not connecting

1. Check that the realtime container is healthy: `docker compose ps realtime`
2. Check realtime logs: `docker compose logs realtime`
3. The widget connects via `/?XTransformPort=3003` — this is handled by Caddy internally
4. If using a custom reverse proxy, ensure WebSocket upgrade headers are forwarded

### Let's Encrypt certificate not provisioning

1. Ensure port 443 is open in your firewall
2. Ensure your domain's A record points to this server
3. Check Caddy logs: `docker compose logs caddy`
4. Caddy retries automatically — wait 5 minutes

---

## Quick Reference

| Command | What it does |
|---------|-------------|
| `docker compose up -d --build` | Build + start all services |
| `docker compose ps` | Check status |
| `docker compose logs -f app` | Follow app logs |
| `docker compose down` | Stop all services |
| `docker compose restart app` | Restart just the app |
| `git pull && docker compose up -d --build` | Update to latest version |

---

## AGPL-3.0 License Notice

Sukhan is licensed under AGPL-3.0. If you modify the software and offer it as a web service to others, you must make your modified source code available to your users. See `SELF_HOSTING.md` for the full plain-language summary.
