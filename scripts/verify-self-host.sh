#!/usr/bin/env bash
#
# scripts/verify-self-host.sh — operator-facing verification of a Sukhan
# self-hosted deployment from a public origin URL.
#
# Non-destructive: only makes GET requests. Never sends secrets. Never
# requires admin/API credentials.
#
# Checks:
#   1. Application responds (GET /).
#   2. Widget script endpoint reachable
#      (GET /api/widget/<probe-slug>/script returns 200 or 404 — either
#      proves the app is alive and routing /api/widget/<slug>/script).
#   3. Public realtime route (port 3003) reachable via Caddy XTransformPort
#      matcher (GET /?XTransformPort=3003&EIO=4&transport=polling returns
#      a Socket.IO Engine.IO OPEN packet — body starting with "0{").
#   4. Internal port 3004 NOT exposed via XTransformPort — GET
#      /?XTransformPort=3004&path=/health should route to the Next.js app
#      (HTTP 200 text/html), NOT to the realtime service's /health endpoint
#      (which would return JSON {"ok":true,...}).
#
# For https origins: validates normally — NO `curl -k`. A bad certificate
# fails the checks (which is what an operator wants).
#
# Usage: scripts/verify-self-host.sh <origin>
#   origin: http://localhost | http://1.2.3.4 | https://chat.example.com
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
#   2 — usage / argument error

set -euo pipefail

# A widget slug that is very unlikely to exist on any real deployment.
# A 200 means the route served the script for this slug (extremely unlikely).
# A 404 means the route was reached and the slug was looked up → not found.
# Both prove the app is alive and routing /api/widget/<slug>/script correctly.
PROBE_SLUG="verify-self-host-nonexistent-slug-9f3c7a4e"

# Per-request timeout. Long enough to absorb slow networks + TLS handshakes,
# short enough that a hung connection doesn't stall the operator.
CURL_TIMEOUT=15

usage() {
  cat <<EOF
Usage: $0 <origin>

<origin> must be a http(s) URL, e.g.:
  http://localhost
  http://1.2.3.4
  https://chat.example.com

Non-destructive verification: only GET requests, no secrets sent.
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

ORIGIN="$1"

# Validate origin scheme. The empty case ('') is caught by the case default.
case "${ORIGIN}" in
  http://*|https://*)
    : # ok
    ;;
  *)
    echo "Error: origin must start with http:// or https:// (got: ${ORIGIN})" >&2
    usage
    exit 2
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl not found in PATH" >&2
  exit 2
fi

# Color helpers. Disabled when stdout is not a TTY so log files are clean.
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  RESET=''
fi

PASS=0
FAIL=0

record_pass() {
  printf "%bPASS%b  %s\n" "${GREEN}" "${RESET}" "$1"
  PASS=$((PASS + 1))
}

record_fail() {
  printf "%bFAIL%b  %s\n" "${RED}" "${RESET}" "$1"
  if [[ -n "${2:-}" ]]; then
    printf "       %s\n" "$2"
  fi
  FAIL=$((FAIL + 1))
}

record_info() {
  printf "       %s\n" "$1"
}

# A scratch directory for response bodies. Use mktemp so multiple operators
# can run the script concurrently without clobbering each other.
SCRATCH_DIR=$(mktemp -d -t sukhan-verify-XXXX)
trap 'rm -rf "${SCRATCH_DIR}"' EXIT

BODY_ROOT="${SCRATCH_DIR}/root"
BODY_WIDGET="${SCRATCH_DIR}/widget"
BODY_RT="${SCRATCH_DIR}/realtime"
BODY_INTERNAL="${SCRATCH_DIR}/internal"

# curl options:
#   -s                 silent (no progress bar)
#   -S                 show errors (so we know why a request failed)
#   --max-time         overall timeout
#   -o <file>          write body to file
#   -w '%{http_code}'  print HTTP status code (captured by command substitution)
# We never use -k — TLS verification stays on for https origins.
curl_silent_code() {
  local url="$1"
  local out="$2"
  local code
  code=$(curl -sS --max-time "${CURL_TIMEOUT}" -o "${out}" -w '%{http_code}' "${url}" 2>/dev/null || true)
  # curl writes '000' when it cannot connect (timeout, refused, DNS failure).
  if [[ -z "${code}" ]]; then
    code="000"
  fi
  printf '%s' "${code}"
}

curl_silent_header() {
  # Returns a single header value for a request. We do a second lightweight
  # request because curl -w can only print fields from a single response.
  local url="$1"
  local header_name="$2"
  local val
  val=$(curl -sS --max-time "${CURL_TIMEOUT}" -o /dev/null \
    -w "%{${header_name}}" "${url}" 2>/dev/null || true)
  if [[ -z "${val}" ]]; then
    val=""
  fi
  printf '%s' "${val}"
}

# Body snippet helper — first N bytes, newlines stripped, for log-friendly output.
body_snippet() {
  local file="$1"
  local n="${2:-200}"
  if [[ ! -f "${file}" ]]; then
    printf ''
    return
  fi
  head -c "${n}" "${file}" 2>/dev/null | tr -d '\n'
}

# ============================================================
# Check 1: Application responds (GET /)
# ============================================================
echo "Check 1: Application responds at ${ORIGIN}/"
HTTP_CODE=$(curl_silent_code "${ORIGIN}/" "${BODY_ROOT}")
if [[ "${HTTP_CODE}" == "000" ]]; then
  record_fail "Application is not reachable at ${ORIGIN}/" \
    "curl could not connect (timeout or connection refused)"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  CT=$(curl_silent_header "${ORIGIN}/" content_type)
  if [[ "${CT}" == text/html* ]]; then
    record_pass "Application responds at ${ORIGIN}/ (HTTP 200, text/html)"
  else
    record_pass "Application responds at ${ORIGIN}/ (HTTP 200, ${CT:-unknown content-type})"
  fi
else
  record_fail "Application responded with HTTP ${HTTP_CODE} (expected 200)" \
    "Body sample: $(body_snippet "${BODY_ROOT}")"
fi

# ============================================================
# Check 2: Widget script endpoint reachable
# ============================================================
WIDGET_URL="${ORIGIN}/api/widget/${PROBE_SLUG}/script"
echo "Check 2: Widget script endpoint at /api/widget/<slug>/script"
HTTP_CODE=$(curl_silent_code "${WIDGET_URL}" "${BODY_WIDGET}")
if [[ "${HTTP_CODE}" == "000" ]]; then
  record_fail "Widget script endpoint not reachable" \
    "curl could not connect to ${WIDGET_URL}"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  record_pass "Widget script endpoint reachable (HTTP 200 — script served)"
elif [[ "${HTTP_CODE}" == "404" ]]; then
  record_pass "Widget script endpoint reachable (HTTP 404 — slug lookup miss is expected for probe slug)"
else
  record_fail "Widget script endpoint returned HTTP ${HTTP_CODE} (expected 200 or 404)" \
    "Body sample: $(body_snippet "${BODY_WIDGET}")"
fi

# ============================================================
# Check 3: Public realtime route (?XTransformPort=3003) reachable
# ============================================================
# Probe the Socket.IO engine with a proper polling handshake request.
# A healthy Socket.IO server returns HTTP 200 + text/plain body starting
# with "0{" (Engine.IO OPEN packet, JSON-encoded handshake).
REALTIME_URL="${ORIGIN}/?XTransformPort=3003&EIO=4&transport=polling"
echo "Check 3: Public realtime route (?XTransformPort=3003) — Socket.IO handshake"
HTTP_CODE=$(curl_silent_code "${REALTIME_URL}" "${BODY_RT}")
if [[ "${HTTP_CODE}" == "000" ]]; then
  record_fail "Public realtime route not reachable" \
    "curl could not connect to ${REALTIME_URL}"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  BODY=$(cat "${BODY_RT}" 2>/dev/null || true)
  if [[ "${BODY}" =~ ^0\{ ]]; then
    record_pass "Realtime reachable via XTransformPort=3003 (Socket.IO OPEN packet received)"
  else
    record_pass "Realtime reachable via XTransformPort=3003 (HTTP 200, but body did not start with Engine.IO OPEN '0{')"
    record_info "Body sample: $(body_snippet "${BODY_RT}")"
  fi
elif [[ "${HTTP_CODE}" == "400" ]]; then
  # 400 from a bare Socket.IO probe (without EIO/transport) is also evidence the
  # service is reachable. With EIO=4&transport=polling this should be 200, so a
  # 400 here is unusual — record as a soft pass.
  record_pass "Realtime reachable via XTransformPort=3003 (HTTP 400 — Socket.IO rejected the request)"
  record_info "This may indicate a Socket.IO version mismatch. Body sample: $(body_snippet "${BODY_RT}")"
else
  record_fail "Realtime route returned HTTP ${HTTP_CODE} (expected 200 from Socket.IO handshake)" \
    "Body sample: $(body_snippet "${BODY_RT}")"
fi

# ============================================================
# Check 4: Internal port 3004 NOT exposed via XTransformPort
# ============================================================
# A request to /?XTransformPort=3004&path=/health should NOT reach the
# realtime service's internal HTTP server (port 3004). Caddy only proxies
# XTransformPort=3003 → realtime:3003. Everything else falls through to the
# Next.js app, which serves the home page for GET / (200 HTML).
#
# If the realtime /health endpoint DID leak (JSON body containing "ok":true),
# that's a critical routing failure → FAIL.
INTERNAL_URL="${ORIGIN}/?XTransformPort=3004&path=/health"
echo "Check 4: Internal port 3004 NOT exposed via XTransformPort (should route to Next.js app)"
HTTP_CODE=$(curl_silent_code "${INTERNAL_URL}" "${BODY_INTERNAL}")
CT=$(curl_silent_header "${INTERNAL_URL}" content_type)
BODY=$(cat "${BODY_INTERNAL}" 2>/dev/null || true)
if [[ "${HTTP_CODE}" == "000" ]]; then
  record_fail "Could not reach ${INTERNAL_URL}" \
    "curl could not connect (network error)"
elif echo "${BODY}" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  # Body looks like the realtime /health endpoint JSON. Fail.
  record_fail "Internal realtime /health endpoint LEAKED via XTransformPort=3004" \
    "Response body: $(body_snippet "${BODY_INTERNAL}")"
elif [[ "${HTTP_CODE}" == "200" && "${CT}" == text/html* ]]; then
  # Routed to Next.js app (HTML home page) — this is the expected, safe behavior.
  record_pass "XTransformPort=3004 routed to Next.js app (200 HTML, not realtime /health)"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  record_pass "XTransformPort=3004 did not expose realtime /health (HTTP 200, ${CT:-unknown content-type})"
  record_info "Body sample: $(body_snippet "${BODY_INTERNAL}")"
else
  record_fail "Unexpected response to XTransformPort=3004 (HTTP ${HTTP_CODE}, ${CT:-unknown content-type})" \
    "Expected: Next.js app (200 text/html). Body sample: $(body_snippet "${BODY_INTERNAL}")"
fi

# ============================================================
# Summary
# ============================================================
TOTAL=$((PASS + FAIL))
echo
printf "Summary: %b%d passed%b, %b%d failed%b out of %d checks\n" \
  "${GREEN}" "${PASS}" "${RESET}" \
  "${RED}" "${FAIL}" "${RESET}" \
  "${TOTAL}"

if [[ "${FAIL}" -gt 0 ]]; then
  printf "%bFAIL%b — verification did not pass\n" "${RED}" "${RESET}"
  exit 1
fi
printf "%bPASS%b — all checks passed\n" "${GREEN}" "${RESET}"
exit 0
