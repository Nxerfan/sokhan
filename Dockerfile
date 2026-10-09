# syntax=docker/dockerfile:1
# ============================================================
# Sukhan Live Chat SaaS — multi-stage Dockerfile
# ============================================================
# Builds a single image that supports two entrypoints:
#   - `web`       → Next.js standalone server (port 3000)
#   - `realtime`  → Socket.IO + internal HTTP (ports 3003 + 3004)
#
# The entrypoint is chosen via the CMD argument, e.g.:
#   docker run sukhan web        # Next.js app
#   docker run sukhan realtime   # realtime service
#
# Both modes share the same image so docker-compose can use the same
# `image:` for the `app` and `realtime` services (with different
# `command:` values), saving disk + build time.
#
# Base image: node:20-alpine (musl libc — Prisma needs libc6-compat).
# ============================================================
ARG NODE_VERSION=20-alpine

# ------------------------------------------------------------
# Stage 1: deps — install all dependencies (cached layer)
# ------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install bun for fast installs + for running the realtime TS service.
RUN npm install -g bun

# Copy lockfiles + package.jsons first for better layer caching.
COPY package.json bun.lock ./
COPY mini-services/realtime/package.json mini-services/realtime/bun.lock ./mini-services/realtime/

# Install main app deps + realtime service deps. Use --frozen-lockfile so
# the build fails loudly if lockfiles are out of sync with package.json.
RUN bun install --frozen-lockfile \
    && cd mini-services/realtime \
    && bun install --frozen-lockfile

# Copy the Prisma schema and generate the client in the deps stage.
# This downloads the platform-specific query engine binary from Prisma's CDN.
# We do it here (not in the builder stage) so it's cached across code changes —
# the engine binary only changes when the Prisma version changes.
# Retry logic: the CDN download can fail with ECONNRESET on slower connections.
# PRISMA_ENGINES_MIRROR can be set to use an alternative mirror if needed.
COPY prisma ./prisma
RUN npx prisma generate \
    || (sleep 3 && npx prisma generate) \
    || (sleep 10 && PRISMA_ENGINES_MIRROR=https://prisma-builds.s3-eu-west-1.amazonaws.com npx prisma generate)

# ------------------------------------------------------------
# Stage 2: builder — build Next.js standalone output
# ------------------------------------------------------------
FROM deps AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholder for NEXTAUTH_SECRET. The real secret is provided
# at RUNTIME via docker-compose environment. This placeholder exists ONLY
# so the Next.js build can complete (env-check.ts fail-closes in production
# without it). This value is NEVER used at runtime — docker-entrypoint.sh
# validates the real secret before starting the server.
ENV NEXTAUTH_SECRET=sukhan-build-time-placeholder-not-for-runtime

# Copy the rest of the source.
COPY . .

# Prisma client was already generated in the deps stage (cached).
# But the schema might have changed since deps — regenerate to be safe.
# Uses npx (not bunx) for more reliable network handling during engine download.
RUN npx prisma generate \
    || (sleep 3 && npx prisma generate) \
    || (sleep 10 && PRISMA_ENGINES_MIRROR=https://prisma-builds.s3-eu-west-1.amazonaws.com npx prisma generate)

# Build Next.js. The build script (package.json) also copies .next/static
# and public/ into the standalone output dir.
RUN bun run build

# Ensure the Prisma client + query engine binary are in the standalone
# output. Next.js traces most deps but the .prisma/client directory (with
# the platform-specific query engine) is sometimes missed. Copying it
# explicitly is a known workaround for Prisma + Next.js standalone.
RUN mkdir -p .next/standalone/node_modules/.prisma \
    && cp -r node_modules/.prisma/client .next/standalone/node_modules/.prisma/client 2>/dev/null || true

# ------------------------------------------------------------
# Stage 3: runtime — minimal image with standalone output
# ------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache libc6-compat openssl tini wget
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install bun (for running the realtime TS service without a transpile
# step) + prisma CLI (for `prisma db push` at container startup).
RUN npm install -g --no-save bun prisma@6

# Copy Next.js standalone output (already includes static + public from
# the build script). This is the Next.js server + bundled deps.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy the Prisma schema (for `prisma db push` at startup).
COPY --from=builder /app/prisma ./prisma

# Copy the shared realtime-token module — the realtime service imports it
# via a relative path (../../src/lib/realtime-token-shared) and the Next.js
# app also imports it. Without this, the realtime service fails at runtime:
#   Cannot find module '../../src/lib/realtime-token-shared'
COPY --from=builder /app/src/lib/realtime-token-shared.ts ./src/lib/realtime-token-shared.ts

# Copy the canonical secret validator + the runtime validator script.
# docker-entrypoint.sh runs `bun /app/scripts/validate-secrets.ts ...` at
# boot time to reject missing/empty/placeholder NEXTAUTH_SECRET and (in
# web mode) POSTGRES_PASSWORD. This is the SAME validator the unit tests
# exercise — there is no mirrored/duplicated validation logic.
COPY --from=builder /app/src/lib/secret-validation.ts ./src/lib/secret-validation.ts
COPY --from=builder /app/scripts ./scripts

# Copy the realtime service source + install its production deps.
# We use --frozen-lockfile so the build fails loudly if out of sync.
COPY --from=builder /app/mini-services/realtime ./mini-services/realtime
RUN cd mini-services/realtime && bun install --production --frozen-lockfile

# Create runtime directories for uploads + logs.
RUN mkdir -p /app/uploads /app/logs

# Entrypoint script — validates NEXTAUTH_SECRET and launches the right
# service based on the CMD argument ("web" or "realtime").
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose all three ports so the same image can run in either mode.
#   - 3000: Next.js (web mode)
#   - 3003: Socket.IO (realtime mode — public, via Caddy)
#   - 3004: internal HTTP (realtime mode — server-to-server only)
EXPOSE 3000 3003 3004

# tini handles PID 1 / signal forwarding properly (avoiding zombie
# processes when bun or node spawns child workers).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Default mode — docker-compose overrides this with `command: [web|realtime]`.
CMD ["web"]
