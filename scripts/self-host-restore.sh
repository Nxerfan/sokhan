#!/usr/bin/env bash
#
# scripts/self-host-restore.sh — deterministic, DESTRUCTIVE restore of a
# Sukhan self-hosted deployment from a backup produced by
# scripts/self-host-backup.sh.
#
# DESTRUCTIVE:
#   - DROP SCHEMA public CASCADE; CREATE SCHEMA public; (then load SQL dump)
#     — every existing table, row, and the _prisma_migrations log are wiped.
#   - rm -rf the existing /app/uploads volume, then extract uploads.tar.
#
# Safety:
#   - Requires --force (without it, refuses to run).
#   - Requires --backup-dir pointing at a valid backup directory.
#   - Requires --compose-file pointing at the target edition's compose file.
#   - Validates metadata.json (backup_version must be supported; edition must
#     match the target compose file's edition; schema/tables count is verified
#     after restore).
#   - Validates that a database backup (database.sql or database.dump) exists
#     and is non-empty.
#   - Validates that uploads.tar exists and is a valid tar archive.
#
# Flow:
#   1. stop app + realtime (so nothing writes during restore)
#   2. start ONLY postgres
#   3. wait for postgres to be ready
#   4. DROP SCHEMA public CASCADE; CREATE SCHEMA public; load database dump
#   5. clear uploads volume (rm -rf), extract uploads.tar into it
#   6. start app + realtime
#
# Secrets policy: progress messages NEVER print NEXTAUTH_SECRET,
# POSTGRES_PASSWORD, or any other secret value. Only variable names + the
# postgres user/db name (which is not a secret) are echoed.
#
# Exit codes:
#   0 — restore completed
#   1 — runtime failure (postgres didn't come up, psql/pg_restore failed, etc.)
#   2 — usage error or backup-validation failure

set -euo pipefail

# Supported backup format version. Must match what self-host-backup.sh writes.
SUPPORTED_BACKUP_VERSION=1

BACKUP_DIR=""
COMPOSE_FILE=""
FORCE=false

print_usage() {
  cat <<EOF
Usage: $0 --force --backup-dir <path> --compose-file <path>

Required:
  --force                Acknowledge the restore is destructive. Without
                          this flag the script refuses to run.
  --backup-dir   PATH    Directory created by self-host-backup.sh
                          (must contain metadata.json, database.sql or
                          database.dump, and uploads.tar).
  --compose-file PATH    Target edition's docker-compose.yml (or .lite.yml).

Optional:
  -h, --help             Show this help and exit.

The script:
  1. Stops app + realtime services.
  2. Starts ONLY postgres.
  3. DROP SCHEMA public CASCADE, then loads the database dump via psql
     (for .sql) or pg_restore (for .dump).
  4. Clears the /app/uploads volume, then extracts uploads.tar into it.
  5. Starts app + realtime services.

Secrets are never printed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --backup-dir)
      [[ $# -ge 2 ]] || { echo "Error: --backup-dir requires a path" >&2; exit 2; }
      BACKUP_DIR="$2"
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || { echo "Error: --compose-file requires a path" >&2; exit 2; }
      COMPOSE_FILE="$2"
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

# --- Validate flags ---
if [[ "${FORCE}" != "true" ]]; then
  echo "Error: --force is required. Restore is destructive — it drops the public" >&2
  echo "       schema and clears the uploads volume. Re-run with --force to acknowledge." >&2
  exit 2
fi
if [[ -z "${BACKUP_DIR}" ]]; then
  echo "Error: --backup-dir is required" >&2
  exit 2
fi
if [[ -z "${COMPOSE_FILE}" ]]; then
  echo "Error: --compose-file is required" >&2
  exit 2
fi

# --- Validate compose file exists ---
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Error: compose file not found: ${COMPOSE_FILE}" >&2
  exit 2
fi

# --- Validate backup directory + required files ---
if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "Error: backup directory does not exist: ${BACKUP_DIR}" >&2
  exit 2
fi
METADATA_FILE="${BACKUP_DIR}/metadata.json"
if [[ ! -f "${METADATA_FILE}" ]]; then
  echo "Error: metadata.json not found in backup directory" >&2
  exit 2
fi

# Database backup: accept either .sql (plain dump) or .dump (custom format).
DB_FILE=""
DB_FORMAT=""
if [[ -f "${BACKUP_DIR}/database.sql" ]]; then
  DB_FILE="${BACKUP_DIR}/database.sql"
  DB_FORMAT="sql"
elif [[ -f "${BACKUP_DIR}/database.dump" ]]; then
  DB_FILE="${BACKUP_DIR}/database.dump"
  DB_FORMAT="dump"
else
  echo "Error: no database backup found in ${BACKUP_DIR}" >&2
  echo "       (looked for database.sql and database.dump)" >&2
  exit 2
fi

UPLOADS_FILE="${BACKUP_DIR}/uploads.tar"
if [[ ! -f "${UPLOADS_FILE}" ]]; then
  echo "Error: uploads.tar not found in backup directory" >&2
  exit 2
fi

# --- Validate backup contents are non-empty (fail-closed on malformed backup) ---
if [[ "$(wc -c < "${DB_FILE}")" -eq 0 ]]; then
  echo "Error: ${DB_FILE##*/} is empty (malformed backup)" >&2
  exit 2
fi
if [[ "$(wc -c < "${UPLOADS_FILE}")" -eq 0 ]]; then
  echo "Error: uploads.tar is empty (malformed backup)" >&2
  exit 2
fi
# Validate uploads.tar is actually a tar archive.
if ! tar -tf "${UPLOADS_FILE}" >/dev/null 2>&1; then
  echo "Error: uploads.tar is not a valid tar archive (malformed backup)" >&2
  exit 2
fi

# --- Validate required tools ---
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker not found in PATH (Docker Engine 24+ and Docker Compose v2 required)" >&2
  exit 2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose (v2) not available. Install Docker Compose v2." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq not found in PATH (required to parse metadata.json)" >&2
  exit 2
fi

dc() { docker compose -f "${COMPOSE_FILE}" "$@"; }

# --- Parse + validate metadata.json ---
BACKUP_VERSION=$(jq -r '.backup_version // empty' "${METADATA_FILE}")
BACKUP_EDITION=$(jq -r '.edition // empty' "${METADATA_FILE}")
BACKUP_TIMESTAMP=$(jq -r '.timestamp // empty' "${METADATA_FILE}")
BACKUP_PG_USER=$(jq -r '.postgres.user // empty' "${METADATA_FILE}")
BACKUP_PG_DB=$(jq -r '.postgres.database // empty' "${METADATA_FILE}")
BACKUP_PG_VERSION=$(jq -r '.postgres.version // "unknown"' "${METADATA_FILE}")
BACKUP_TABLE_COUNT=$(jq -r '.schema.public_tables_count // 0' "${METADATA_FILE}")
BACKUP_LATEST_MIGRATION=$(jq -r '.schema.latest_prisma_migration // ""' "${METADATA_FILE}")

if [[ -z "${BACKUP_VERSION}" ]]; then
  echo "Error: metadata.json missing 'backup_version' field" >&2
  exit 2
fi
if [[ -z "${BACKUP_EDITION}" ]]; then
  echo "Error: metadata.json missing 'edition' field" >&2
  exit 2
fi
if [[ -z "${BACKUP_PG_USER}" ]]; then
  echo "Error: metadata.json missing 'postgres.user' field" >&2
  exit 2
fi
if [[ -z "${BACKUP_PG_DB}" ]]; then
  echo "Error: metadata.json missing 'postgres.database' field" >&2
  exit 2
fi
if [[ "${BACKUP_VERSION}" != "${SUPPORTED_BACKUP_VERSION}" ]]; then
  echo "Error: backup version ${BACKUP_VERSION} is not supported by this script" >&2
  echo "       (supported: ${SUPPORTED_BACKUP_VERSION}). The backup layout may have" >&2
  echo "       changed; use a matching version of self-host-restore.sh." >&2
  exit 2
fi
if [[ "${BACKUP_EDITION}" != "full" && "${BACKUP_EDITION}" != "lite" ]]; then
  echo "Error: metadata.json edition '${BACKUP_EDITION}' is not 'full' or 'lite'" >&2
  exit 2
fi

# --- Validate target compose file's edition matches the backup's edition ---
TARGET_SERVICES=$(dc config --services 2>/dev/null)
if [[ -z "${TARGET_SERVICES}" ]]; then
  echo "Error: could not enumerate services from target compose file" >&2
  exit 2
fi
if echo "${TARGET_SERVICES}" | grep -qx 'redis'; then
  TARGET_EDITION="full"
else
  TARGET_EDITION="lite"
fi
if [[ "${BACKUP_EDITION}" != "${TARGET_EDITION}" ]]; then
  echo "Error: edition mismatch. Backup is '${BACKUP_EDITION}', target compose is '${TARGET_EDITION}'." >&2
  echo "       Use a ${BACKUP_EDITION} compose file to restore this backup, or back up" >&2
  echo "       from the matching edition first." >&2
  exit 2
fi

# --- Confirm required services are declared in the target compose ---
for svc in postgres app realtime; do
  if ! echo "${TARGET_SERVICES}" | grep -qx "${svc}"; then
    echo "Error: required service '${svc}' not declared in compose file" >&2
    exit 2
  fi
done

echo "[restore] backup dir:      ${BACKUP_DIR}"
echo "[restore] backup version:  ${BACKUP_VERSION}"
echo "[restore] backup edition:   ${BACKUP_EDITION}"
echo "[restore] backup timestamp:${BACKUP_TIMESTAMP}"
echo "[restore] backup pg user:   ${BACKUP_PG_USER}"
echo "[restore] backup pg db:     ${BACKUP_PG_DB}"
echo "[restore] backup pg ver:    ${BACKUP_PG_VERSION}"
echo "[restore] backup tables:    ${BACKUP_TABLE_COUNT}"
echo "[restore] backup migration: ${BACKUP_LATEST_MIGRATION:-none}"
echo "[restore] db format:         ${DB_FORMAT}"
echo "[restore] target compose:    ${COMPOSE_FILE}"
echo "[restore] target edition:    ${TARGET_EDITION}"
echo
echo "WARNING: this will DROP the public schema and CLEAR the uploads volume."
echo "         Re-run with --force (already set) to proceed."
echo

# --- Step 1: stop app + realtime (so nothing writes during restore) ---
echo "[restore] (1/5) stopping app + realtime services..."
if ! dc stop app realtime; then
  echo "Error: failed to stop app + realtime services" >&2
  exit 1
fi

# --- Step 2: start ONLY postgres ---
echo "[restore] (2/5) starting postgres service (only)..."
if ! dc start postgres; then
  echo "Error: failed to start postgres service" >&2
  # Try to bring app+realtime back so we leave the system in a known state.
  echo "[restore] attempting to restart app + realtime (state may be inconsistent)..." >&2
  dc start app realtime || true
  exit 1
fi

# --- Step 3: wait for postgres to be ready ---
echo "[restore] waiting for postgres to accept connections..."
PG_READY=false
for i in $(seq 1 30); do
  if dc exec -T postgres pg_isready -U "${BACKUP_PG_USER}" -d "${BACKUP_PG_DB}" -q 2>/dev/null; then
    PG_READY=true
    break
  fi
  sleep 1
done
if [[ "${PG_READY}" != "true" ]]; then
  echo "Error: postgres did not become ready within 30 seconds" >&2
  dc start app realtime || true
  exit 1
fi
echo "[restore] postgres is ready"

# --- Step 4: restore database (DROP public schema, recreate, load dump) ---
echo "[restore] (3/5) restoring database — DROP SCHEMA public CASCADE → CREATE SCHEMA → load dump..."
# Drop and recreate the public schema. This is the destructive bit.
# Drops every table, view, sequence, and the _prisma_migrations log in public.
if ! dc exec -T postgres psql -U "${BACKUP_PG_USER}" -d "${BACKUP_PG_DB}" -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${BACKUP_PG_USER}; GRANT ALL ON SCHEMA public TO public;"; then
  echo "Error: failed to drop/recreate public schema" >&2
  dc start app realtime || true
  exit 1
fi

# Load the dump. Use --set ON_ERROR_STOP=1 so psql aborts on the first error.
if [[ "${DB_FORMAT}" == "sql" ]]; then
  if ! cat "${DB_FILE}" | dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "${BACKUP_PG_USER}" -d "${BACKUP_PG_DB}"; then
    echo "Error: database restore failed (psql reported an error)" >&2
    dc start app realtime || true
    exit 1
  fi
else
  # Custom-format dump (.dump) → pg_restore with --clean --if-exists.
  # The schema was just dropped, so --clean is a safety net (no-op on empty schema).
  if ! dc exec -T postgres pg_restore --clean --if-exists --no-owner -U "${BACKUP_PG_USER}" -d "${BACKUP_PG_DB}" < "${DB_FILE}"; then
    echo "Error: database restore failed (pg_restore reported an error)" >&2
    dc start app realtime || true
    exit 1
  fi
fi

# Sanity check: count tables in restored schema vs. backup metadata.
RESTORED_TABLES=$(dc exec -T postgres psql -U "${BACKUP_PG_USER}" -d "${BACKUP_PG_DB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
  2>/dev/null | tr -d '[:space:]')
echo "[restore] restored table count: ${RESTORED_TABLES:-0} (backup metadata said ${BACKUP_TABLE_COUNT})"
if [[ "${RESTORED_TABLES:-0}" -ne "${BACKUP_TABLE_COUNT}" ]]; then
  echo "[restore] WARNING: table count mismatch — verify the restore before relying on it" >&2
fi

# --- Step 5: restore uploads volume (rm -rf existing, then extract tar) ---
echo "[restore] (4/5) restoring uploads volume (clearing existing, extracting tar)..."

# Find the app container ID (works even when stopped, since `docker compose ps -a`
# includes stopped containers in Compose v2). Fall back to running-only query.
APP_CONTAINER_ID=$(dc ps -a -q app 2>/dev/null | head -1 || true)
if [[ -z "${APP_CONTAINER_ID}" ]]; then
  APP_CONTAINER_ID=$(dc ps -q app 2>/dev/null | head -1 || true)
fi
if [[ -z "${APP_CONTAINER_ID}" ]]; then
  echo "Error: could not get app container ID. Is the compose project created?" >&2
  echo "       Run \`docker compose -f ${COMPOSE_FILE} up -d\` first to materialize the project." >&2
  dc start app realtime || true
  exit 1
fi

# Find the Docker volume backing /app/uploads (do NOT hard-code 'sukhan_uploads').
# docker inspect prints the source volume name for the mount whose
# Destination is /app/uploads. This works on stopped containers (inspect
# reads container metadata, not runtime state).
VOLUME_NAME=$(docker inspect -f \
  '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' \
  "${APP_CONTAINER_ID}")
if [[ -z "${VOLUME_NAME}" ]]; then
  echo "Error: could not find Docker volume backing /app/uploads in app container" >&2
  echo "       (container: ${APP_CONTAINER_ID})" >&2
  dc start app realtime || true
  exit 1
fi
echo "[restore] uploads volume: ${VOLUME_NAME}"

# Use a one-shot alpine container to clear + extract. We mount the volume at
# /uploads (rw) and the backup tar at /restore/uploads.tar (ro).
# `--strip-components=1` strips the leading "uploads/" entry from the tarball
# (the backup tar contains uploads/... entries).
# Note: alpine:3 will be pulled if not present. On air-gapped hosts, run
#       `docker pull alpine:3` first.
if ! docker run --rm \
    -v "${VOLUME_NAME}:/uploads:rw" \
    -v "${UPLOADS_FILE}:/restore/uploads.tar:ro" \
    alpine:3 \
    sh -c 'rm -rf /uploads/* /uploads/.[!.]* /uploads/..?* 2>/dev/null || true; tar -xf /restore/uploads.tar -C /uploads --strip-components=1'; then
  echo "Error: uploads restore failed (alpine helper container failed)" >&2
  dc start app realtime || true
  exit 1
fi
echo "[restore] uploads volume restored"

# --- Step 6: start app + realtime ---
echo "[restore] (5/5) starting app + realtime services..."
if ! dc start app realtime; then
  echo "Error: failed to start app + realtime services" >&2
  echo "       Database + uploads are restored; you may need to start services manually:" >&2
  echo "       docker compose -f ${COMPOSE_FILE} up -d" >&2
  exit 1
fi

echo
echo "[restore] DONE."
echo "Backup restored from: ${BACKUP_DIR}"
echo "Target compose file:   ${COMPOSE_FILE}"
echo
echo "Next steps:"
echo "  1. Verify services are healthy: docker compose -f ${COMPOSE_FILE} ps"
echo "  2. Verify the app responds at the configured NEXTAUTH_URL."
echo "  3. Run scripts/verify-self-host.sh <origin> for an end-to-end check."
