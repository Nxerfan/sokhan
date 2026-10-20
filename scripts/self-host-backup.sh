#!/usr/bin/env bash
#
# scripts/self-host-backup.sh — versioned backup of a Sukhan self-hosted
# deployment (Full or Lite Docker edition).
#
# Creates a deterministic backup directory containing:
#   metadata.json   — backup format version, edition, timestamp, postgres
#                     version, schema info, and a list of public-schema tables
#   database.sql    — PostgreSQL logical dump (pg_dump)
#   uploads.tar    — tar of the app container's /app/uploads directory
#                     (user-attached files: message attachments, avatars, logos)
#
# Redis and logs are NOT backed up:
#   - Redis holds only ephemeral realtime state (Socket.IO adapter + pub/sub
#     channel); it is not authoritative. A fresh empty Redis is fine after
#     restore — clients reconnect and re-establish state.
#   - Logs are operational, not user data.
#
# Does NOT depend on a hard-coded Docker Compose project name or volume name.
# The project is identified by `docker compose -f <file>` itself, and the
# uploads volume is reached via `docker compose exec app tar ...` (no need
# to know the actual Docker volume name).
#
# Usage:
#   scripts/self-host-backup.sh --compose-file docker-compose.yml
#   scripts/self-host-backup.sh --compose-file docker-compose.lite.yml --output-dir /var/backups/sukhan
#
# Secrets policy: progress messages NEVER print NEXTAUTH_SECRET,
# POSTGRES_PASSWORD, or any other secret value. Only variable names + the
# postgres user/db name (which is not a secret — it is published in the
# compose file) are echoed. pg_dump runs inside the postgres container,
# which uses peer/trust auth on local connections — no password is passed
# on the command line.
#
# Exit codes:
#   0 — backup completed
#   1 — runtime failure (container not running, pg_dump failed, etc.)
#   2 — usage error (missing/invalid arguments, missing docker/jq)

set -euo pipefail

# Bump when the on-disk backup layout changes. Restore validates this
# and refuses to load backups with an unsupported version.
BACKUP_VERSION=1
DEFAULT_OUTPUT_DIR="./backups"

COMPOSE_FILE=""
OUTPUT_DIR="${DEFAULT_OUTPUT_DIR}"

print_usage() {
  cat <<EOF
Usage: $0 --compose-file <path> [--output-dir <path>]

Required:
  --compose-file PATH   Path to docker-compose.yml or docker-compose.lite.yml

Optional:
  --output-dir   PATH   Where to write the backup directory (default: ${DEFAULT_OUTPUT_DIR})
  -h, --help            Show this help and exit

Creates: <output-dir>/sukhan-<edition>-backup-<UTC-timestamp>/{metadata.json,database.sql,uploads.tar}

Secrets are never printed. Redis and logs are not backed up (Redis is not
authoritative state; logs are operational, not user data).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      [[ $# -ge 2 ]] || { echo "Error: --compose-file requires a path argument" >&2; exit 2; }
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo "Error: --output-dir requires a path argument" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      print_usage
      exit 2
      ;;
  esac
done

if [[ -z "${COMPOSE_FILE}" ]]; then
  echo "Error: --compose-file is required" >&2
  print_usage
  exit 2
fi
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Error: compose file not found: ${COMPOSE_FILE}" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker not found in PATH (Docker Engine 24+ and Docker Compose v2 required)" >&2
  exit 2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose (v2) not available. Install Docker Compose v2." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq not found in PATH (required to write metadata.json)" >&2
  exit 2
fi

# Helper: run docker compose against the given compose file.
dc() { docker compose -f "${COMPOSE_FILE}" "$@"; }

echo "[backup] compose file: ${COMPOSE_FILE}"
echo "[backup] output dir:    ${OUTPUT_DIR}"

# --- Detect edition (full vs lite) by inspecting declared services ---
SERVICES=$(dc config --services 2>/dev/null)
if [[ -z "${SERVICES}" ]]; then
  echo "Error: could not enumerate services from compose file (does it parse?)" >&2
  exit 1
fi

if echo "${SERVICES}" | grep -qx 'redis'; then
  EDITION="full"
else
  EDITION="lite"
fi
echo "[backup] edition:       ${EDITION}"

# --- Required services: postgres + app (both must be declared) ---
for svc in postgres app; do
  if ! echo "${SERVICES}" | grep -qx "${svc}"; then
    echo "Error: required service '${svc}' not declared in compose file" >&2
    exit 1
  fi
done

# --- Verify postgres + app are running ---
# Use probes that work regardless of `docker compose ps` JSON-shape variations:
#   - postgres: pg_isready (returns 0 only when accepting connections)
#   - app:      test -d /app/uploads inside the container (also confirms the
#               uploads mount exists)
echo "[backup] checking services are running..."
if ! dc exec -T postgres pg_isready -q 2>/dev/null; then
  echo "Error: postgres service is not running or not ready." >&2
  echo "       Start the stack first: docker compose -f ${COMPOSE_FILE} up -d" >&2
  exit 1
fi
if ! dc exec -T app sh -c 'test -d /app/uploads' 2>/dev/null; then
  echo "Error: app service is not running, or /app/uploads does not exist." >&2
  echo "       Start the stack first: docker compose -f ${COMPOSE_FILE} up -d" >&2
  exit 1
fi

# --- Get Postgres user / database name (do NOT hardcode 'sukhan') ---
# The Postgres container sets POSTGRES_USER and POSTGRES_DB as env vars at
# init time (POSTGRES_USER=sukhan in the full compose file; defaults to
# sukhan in the lite compose file but is overridable). Reading from the
# container's env is more robust than assuming the canonical value.
PG_USER=$(dc exec -T postgres printenv POSTGRES_USER 2>/dev/null | tr -d '[:space:]')
PG_DB=$(dc exec -T postgres printenv POSTGRES_DB 2>/dev/null | tr -d '[:space:]')
PG_USER="${PG_USER:-sukhan}"
PG_DB="${PG_DB:-sukhan}"
echo "[backup] postgres user: ${PG_USER}"
echo "[backup] postgres db:   ${PG_DB}"

# --- Get Postgres server version (metadata) ---
PG_VERSION=$(dc exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
  'SHOW server_version' 2>/dev/null | tr -d '[:space:]')
echo "[backup] postgres version: ${PG_VERSION:-unknown}"

# --- Schema info: list public-schema table names + count (metadata only) ---
SCHEMA_TABLES_CSV=$(dc exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
  "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public'" \
  2>/dev/null | tr -d '\n')
TABLE_COUNT=$(dc exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
  2>/dev/null | tr -d '[:space:]')
TABLE_COUNT="${TABLE_COUNT:-0}"

# Latest applied Prisma migration (best-effort — table may not exist on a
# fresh/empty DB, which is fine for restore; we just record it if present).
LATEST_MIGRATION=$(dc exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
  "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1" \
  2>/dev/null | tr -d '[:space:]')

# --- Create backup directory ---
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR_NAME="sukhan-${EDITION}-backup-${TIMESTAMP}"
BACKUP_DIR="${OUTPUT_DIR}/${BACKUP_DIR_NAME}"
mkdir -p "${BACKUP_DIR}"
echo "[backup] target dir:    ${BACKUP_DIR}"

# --- Backup database (pg_dump, plain SQL format) ---
# pg_dump streams to stdout; we redirect to the file. With set -o pipefail,
# any pg_dump failure propagates and the script exits non-zero.
echo "[backup] dumping database via pg_dump (user: ${PG_USER}, db: ${PG_DB})..."
if ! dc exec -T postgres pg_dump -U "${PG_USER}" "${PG_DB}" > "${BACKUP_DIR}/database.sql"; then
  echo "Error: pg_dump failed. Partial backup left at ${BACKUP_DIR}" >&2
  exit 1
fi
DB_SIZE=$(wc -c < "${BACKUP_DIR}/database.sql")
if [[ "${DB_SIZE}" -eq 0 ]]; then
  echo "Error: database.sql is empty (pg_dump produced no output)." >&2
  exit 1
fi
echo "[backup] database.sql: ${DB_SIZE} bytes"

# --- Backup uploads (tar streamed from the app container) ---
# `docker compose exec -T app tar -C /app -cf - uploads` streams a tar of
# /app/uploads to stdout. We redirect into uploads.tar. This is the
# version-independent approach (does not depend on `docker compose cp`,
# which is only available in newer Compose v2 releases).
echo "[backup] tarring /app/uploads from app container..."
if ! dc exec -T app tar -C /app -cf - uploads > "${BACKUP_DIR}/uploads.tar"; then
  echo "Error: uploads tar failed. Partial backup left at ${BACKUP_DIR}" >&2
  exit 1
fi
UPLOADS_SIZE=$(wc -c < "${BACKUP_DIR}/uploads.tar")
echo "[backup] uploads.tar: ${UPLOADS_SIZE} bytes"

# --- Write metadata.json ---
# Build via jq for safe JSON escaping of table names + migration name.
jq -n \
  --argjson backup_version "${BACKUP_VERSION}" \
  --arg edition "${EDITION}" \
  --arg timestamp "${TIMESTAMP}" \
  --arg compose_file "${COMPOSE_FILE}" \
  --arg postgres_version "${PG_VERSION:-unknown}" \
  --arg pg_user "${PG_USER}" \
  --arg pg_db "${PG_DB}" \
  --arg schema_tables "${SCHEMA_TABLES_CSV}" \
  --argjson table_count "${TABLE_COUNT}" \
  --arg latest_migration "${LATEST_MIGRATION}" \
  --argjson db_size "${DB_SIZE}" \
  --argjson uploads_size "${UPLOADS_SIZE}" \
  '{
    backup_version: $backup_version,
    edition: $edition,
    timestamp: $timestamp,
    compose_file: $compose_file,
    postgres: {
      user: $pg_user,
      database: $pg_db,
      version: $postgres_version
    },
    schema: {
      public_tables_count: $table_count,
      public_tables: ($schema_tables | split(",") | map(select(length > 0))),
      latest_prisma_migration: $latest_migration
    },
    sizes: {
      database_sql_bytes: $db_size,
      uploads_tar_bytes: $uploads_size
    },
    contents: ["metadata.json", "database.sql", "uploads.tar"],
    notes: [
      "Redis is not backed up (not authoritative state).",
      "Logs are not backed up (operational, not user data).",
      "Restore with scripts/self-host-restore.sh --force --backup-dir <this dir> --compose-file <target compose>."
    ]
  }' > "${BACKUP_DIR}/metadata.json"

echo "[backup] metadata.json written"
echo
echo "[backup] DONE: ${BACKUP_DIR}"
echo
echo "Contents:"
( cd "${BACKUP_DIR}" && ls -la )
