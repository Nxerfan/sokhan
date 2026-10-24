#!/usr/bin/env bash
# =============================================================================
# Shared widget package qualification.
#
# Used by BOTH:
#   - .github/workflows/ci.yml            -> widget-package-qualification job (on PRs)
#   - .github/workflows/publish-npm.yml   -> pre-publish verification
#
# This script NEVER publishes and requires NO npm credential. It builds,
# packs, scans the tarball, and verifies clean npm + Bun consumer installs.
# A single source of truth so the two workflows cannot drift.
#
# Verification steps (in order):
#   1.  widget package build (tsc -> dist)
#   2.  dist/index.js exists
#   3.  dist/index.d.ts exists
#   4.  npm pack --dry-run
#   5.  real tarball creation
#   6.  tarball forbidden-file scan + required-file presence
#   7.  clean npm consumer install from tarball
#   8.  npm ESM import
#   9.  npm SSR-safe import (no window/document)
#   10. initSukhan export + missing-key rejection
#   11. clean Bun consumer install from tarball
#   12. Bun ESM import
#   13. Bun SSR-safe import (no window/document)
#   14. installed package version == package.json version (npm + Bun)
# =============================================================================
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PKG_DIR="$REPO_ROOT/packages/widget-npm"

PKG_NAME=$(node -p "require('$PKG_DIR/package.json').name")
PKG_VERSION=$(node -p "require('$PKG_DIR/package.json').version")

echo "============================================================"
echo "  Widget package qualification"
echo "  package: ${PKG_NAME}@${PKG_VERSION}"
echo "============================================================"

# ---------- 1. widget package build ----------
echo "--- step 1: build ---"
cd "$PKG_DIR"
npm run clean
npm run build

# ---------- 2. dist/index.js exists ----------
echo "--- step 2: assert dist/index.js ---"
test -f dist/index.js || { echo "::error::dist/index.js missing after build"; exit 1; }
echo "dist/index.js OK"

# ---------- 3. dist/index.d.ts exists ----------
echo "--- step 3: assert dist/index.d.ts ---"
test -f dist/index.d.ts || { echo "::error::dist/index.d.ts missing after build"; exit 1; }
echo "dist/index.d.ts OK"

# ---------- 4. npm pack --dry-run ----------
echo "--- step 4: npm pack --dry-run ---"
npm pack --dry-run

# ---------- 5. real tarball creation ----------
echo "--- step 5: create real tarball ---"
rm -f "${PKG_NAME}"-*.tgz
npm pack
TARBALL=$(ls "${PKG_NAME}"-*.tgz)
echo "TARBALL=${TARBALL}"

# ---------- 6. tarball forbidden-file scan + required-file presence ----------
echo "--- step 6: tarball contents scan ---"
# Capture tarball listing to a temp file once. Using a pipe (`tar | grep`)
# under `set -o pipefail` would let `grep -q` close the pipe early and kill
# `tar` with SIGPIPE (141), falsely failing the pipeline. A temp file is
# pipe-free and unambiguous.
TARLIST_FILE=$(mktemp)
tar -tzf "$TARBALL" > "$TARLIST_FILE"
echo "tarball contents:"
cat "$TARLIST_FILE"
FORBIDDEN=$(grep -E '\.env$|\.env\.|/prisma/|\.git/|database|schema\.prisma|migrate|\.secret|\.key$|\.pem$|\.pfx$|next\.config|tsconfig|docker-compose|Dockerfile|Caddyfile|vercel|\.github/|/src/|\.test\.' "$TARLIST_FILE" || true)
if [ -n "$FORBIDDEN" ]; then
  echo "::error::Tarball contains forbidden files:"
  echo "$FORBIDDEN"
  rm -f "$TARLIST_FILE"
  exit 1
fi
echo "forbidden-file scan: clean"
grep -q 'dist/index\.js$'   "$TARLIST_FILE" || { echo "::error::dist/index.js missing from tarball"; rm -f "$TARLIST_FILE"; exit 1; }
grep -q 'dist/index\.d\.ts$' "$TARLIST_FILE" || { echo "::error::dist/index.d.ts missing from tarball"; rm -f "$TARLIST_FILE"; exit 1; }
rm -f "$TARLIST_FILE"
echo "required files present: dist/index.js + dist/index.d.ts"

# ---------- 7. clean npm consumer install from tarball ----------
echo "--- step 7: npm clean consumer install from tarball ---"
NPM_CONSUMER="/tmp/qualify-npm-$$"
rm -rf "$NPM_CONSUMER"
mkdir -p "$NPM_CONSUMER"
cd "$NPM_CONSUMER"
npm init -y >/dev/null
npm install "$PKG_DIR/$TARBALL"

# ---------- 8. npm ESM import ----------
echo "--- step 8: npm ESM import ---"
node --input-type=module -e "import { initSukhan } from '${PKG_NAME}'; if (typeof initSukhan !== 'function') throw new Error('initSukhan not exported'); console.log('npm ESM import OK');"

# ---------- 9. npm SSR-safe import (no window/document) ----------
echo "--- step 9: npm SSR-safe import ---"
node --input-type=module -e "import '${PKG_NAME}'; console.log('npm SSR import OK (no crash)');"

# ---------- 10. initSukhan export + missing-key rejection ----------
echo "--- step 10: initSukhan missing-key rejection ---"
node --input-type=module -e "import { initSukhan } from '${PKG_NAME}'; try { initSukhan(); throw new Error('should have thrown for missing key'); } catch (e) { if (!/no API key/i.test(e.message)) throw e; console.log('initSukhan missing-key rejection OK'); }"

# ---------- 11. clean Bun consumer install from tarball ----------
echo "--- step 11: bun clean consumer install from tarball ---"
BUN_CONSUMER="/tmp/qualify-bun-$$"
rm -rf "$BUN_CONSUMER"
mkdir -p "$BUN_CONSUMER"
cd "$BUN_CONSUMER"
echo '{"name":"qualify-bun"}' > package.json
bun add "$PKG_DIR/$TARBALL"

# ---------- 12. Bun ESM import ----------
echo "--- step 12: bun ESM import ---"
bun -e "import { initSukhan } from '${PKG_NAME}'; if (typeof initSukhan !== 'function') throw new Error('initSukhan not exported'); console.log('bun ESM import OK');"

# ---------- 13. Bun SSR-safe import (no window/document) ----------
# NOTE: the parentheses are properly balanced here. The previous workflow
# had `console.log('bun SSR import OK (no crash)';` which left console.log(
# unclosed and was a JS syntax error. This fixed version is exercised by
# the widget-package-qualification CI job on every PR.
echo "--- step 13: bun SSR-safe import ---"
bun -e "import '${PKG_NAME}'; console.log('bun SSR import OK (no crash)');"

# ---------- 14. installed package version == package.json version ----------
echo "--- step 14: installed version check ---"
NPM_INSTALLED=$(node -p "require('$NPM_CONSUMER/node_modules/${PKG_NAME}/package.json').version")
BUN_INSTALLED=$(node -p "require('$BUN_CONSUMER/node_modules/${PKG_NAME}/package.json').version")
echo "npm installed version:  ${NPM_INSTALLED}"
echo "bun installed version:  ${BUN_INSTALLED}"
echo "package.json version:   ${PKG_VERSION}"
if [ "$NPM_INSTALLED" != "$PKG_VERSION" ]; then
  echo "::error::npm installed version '${NPM_INSTALLED}' != package.json version '${PKG_VERSION}'"
  exit 1
fi
if [ "$BUN_INSTALLED" != "$PKG_VERSION" ]; then
  echo "::error::bun installed version '${BUN_INSTALLED}' != package.json version '${PKG_VERSION}'"
  exit 1
fi

# cleanup
rm -f "$PKG_DIR/$TARBALL"
rm -rf "$NPM_CONSUMER" "$BUN_CONSUMER"

echo "============================================================"
echo "  Widget package qualification PASSED"
echo "  ${PKG_NAME}@${PKG_VERSION}"
echo "============================================================"
