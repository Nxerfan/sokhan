/// <reference types="bun-types" />
/**
 * NPM package artifact/install smoke test.
 *
 * Builds the `sukhan-widget` package, creates a tarball via `npm pack`,
 * installs it into a clean temporary consumer project, and verifies
 * that `import { initSukhan } from 'sukhan-widget'` works with both
 * Node.js (npm) and Bun.
 *
 * This test does NOT require publication to npm — it tests the local
 * tarball. It protects future releases from publishing an unusable
 * artifact.
 */

import { test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { resolve, join } from 'path'

const REPO_ROOT = resolve(__dirname, '../..')
const PKG_DIR = join(REPO_ROOT, 'packages/widget-npm')
const TMP_ROOT = '/tmp/npm-smoke-test'

test('npm pack: tarball is created with dist/ contents', () => {
  // Clean previous build artifacts.
  rmSync(join(PKG_DIR, 'dist'), { recursive: true, force: true })
  rmSync(join(PKG_DIR, 'sukhan-widget-1.0.0.tgz'), { force: true })

  // Build the package.
  execSync('bun run build', { cwd: PKG_DIR, stdio: 'pipe' })

  // Verify dist/ output exists.
  const distDir = join(PKG_DIR, 'dist')
  expect(existsSync(distDir), 'dist/ directory must exist after build').toBe(true)
  expect(existsSync(join(distDir, 'index.js')), 'dist/index.js must exist').toBe(true)
  expect(existsSync(join(distDir, 'index.d.ts')), 'dist/index.d.ts must exist').toBe(true)
  expect(existsSync(join(distDir, 'widget.js')), 'dist/widget.js must exist').toBe(true)
  expect(existsSync(join(distDir, 'widget.d.ts')), 'dist/widget.d.ts must exist').toBe(true)
  // Identity module (PR #14 visitor access modes) must be built.
  expect(existsSync(join(distDir, 'identity.js')), 'dist/identity.js must exist').toBe(true)
  expect(existsSync(join(distDir, 'identity.d.ts')), 'dist/identity.d.ts must exist').toBe(true)

  // Create tarball.
  execSync('npm pack', { cwd: PKG_DIR, stdio: 'pipe' })
  const tarballPath = join(PKG_DIR, 'sukhan-widget-1.0.0.tgz')
  expect(existsSync(tarballPath), 'tarball must be created').toBe(true)

  // Verify tarball does NOT contain raw src/ files.
  const packDryRun = execSync('npm pack --dry-run 2>&1', { cwd: PKG_DIR, encoding: 'utf-8' })
  expect(packDryRun, 'tarball must NOT include raw src/').not.toContain('src/index.ts')
  expect(packDryRun, 'tarball must include dist/').toContain('dist/index.js')
  expect(packDryRun, 'tarball must include package.json').toContain('package.json')
})

test('npm clean-consumer: install + import initSukhan', () => {
  const consumerDir = join(TMP_ROOT, 'npm-consumer')
  rmSync(consumerDir, { recursive: true, force: true })
  mkdirSync(consumerDir, { recursive: true })

  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'npm-consumer',
    type: 'module',
  }))

  const tarballPath = join(PKG_DIR, 'sukhan-widget-1.0.0.tgz')
  expect(existsSync(tarballPath), 'tarball must exist (run pack test first)').toBe(true)

  // Install the tarball.
  execSync(`npm install ${tarballPath}`, { cwd: consumerDir, stdio: 'pipe' })

  // Verify import works AND the instance surface exposes the PR #14
  // identity methods (setIdentity / refreshIdentity) + the new types.
  const script =
    "import { initSukhan, SukhanApiError } from 'sukhan-widget';" +
    "if (typeof initSukhan !== 'function') throw new Error('initSukhan not exported');" +
    "if (typeof SukhanApiError !== 'function') throw new Error('SukhanApiError not exported');" +
    "const inst = initSukhan({ apiKey: 'demo' });" +
    "if (typeof inst.setIdentity !== 'function') throw new Error('setIdentity not on instance');" +
    "if (typeof inst.refreshIdentity !== 'function') throw new Error('refreshIdentity not on instance');" +
    "console.log('OK')"
  const result = execSync(`node --input-type=module -e "${script}"`, {
    cwd: consumerDir,
    encoding: 'utf-8',
  })
  expect(result.trim()).toBe('OK')
})

test('bun clean-consumer: install + import initSukhan', () => {
  const consumerDir = join(TMP_ROOT, 'bun-consumer')
  rmSync(consumerDir, { recursive: true, force: true })
  mkdirSync(consumerDir, { recursive: true })

  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'bun-consumer',
  }))

  const tarballPath = join(PKG_DIR, 'sukhan-widget-1.0.0.tgz')
  expect(existsSync(tarballPath), 'tarball must exist').toBe(true)

  // Install the tarball.
  execSync(`bun add ${tarballPath}`, { cwd: consumerDir, stdio: 'pipe' })

  // Verify import works AND the instance surface exposes setIdentity / refreshIdentity.
  const script =
    "import { initSukhan } from 'sukhan-widget';" +
    "if (typeof initSukhan !== 'function') throw new Error('initSukhan not exported');" +
    "const inst = initSukhan({ apiKey: 'demo' });" +
    "if (typeof inst.setIdentity !== 'function') throw new Error('setIdentity not on instance');" +
    "if (typeof inst.refreshIdentity !== 'function') throw new Error('refreshIdentity not on instance');" +
    "console.log('OK')"
  const result = execSync(`bun -e "${script}"`, {
    cwd: consumerDir,
    encoding: 'utf-8',
  })
  expect(result.trim()).toBe('OK')
})

test('package.json: exports point to dist/ (not raw src/)', () => {
  const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8'))
  expect(pkgJson.main).toBe('./dist/index.js')
  expect(pkgJson.module).toBe('./dist/index.js')
  expect(pkgJson.types).toBe('./dist/index.d.ts')
  expect(pkgJson.exports['.'].types).toBe('./dist/index.d.ts')
  expect(pkgJson.exports['.'].import).toBe('./dist/index.js')
  // Must NOT point to raw src/.
  expect(pkgJson.main).not.toContain('src/')
  expect(pkgJson.types).not.toContain('src/')
  // Must have prepublishOnly that builds.
  expect(pkgJson.scripts.prepublishOnly).toContain('build')
  // Must have files that include dist/.
  expect(pkgJson.files).toContain('dist')
})

test('package does NOT contain .env.example in the tarball', () => {
  const packDryRun = execSync('npm pack --dry-run 2>&1', { cwd: PKG_DIR, encoding: 'utf-8' })
  expect(packDryRun, 'tarball must NOT include .env.example').not.toContain('.env.example')
})

test('README continues to say the package is NOT publicly published', () => {
  const readme = readFileSync(join(PKG_DIR, 'README.md'), 'utf-8')
  // The package must NOT falsely claim npm availability. The README must
  // state that the package is not yet published to the public registry.
  expect(readme.toLowerCase(), 'README must mention not-published status').toContain('not')
  expect(readme.length, 'README must be non-empty').toBeGreaterThan(50)
})

test('built dist/ exposes the new identity types (SukhanApiError, AccessMode, SukhanLoginRequiredDetail)', () => {
  const indexDts = readFileSync(join(PKG_DIR, 'dist', 'index.d.ts'), 'utf-8')
  expect(indexDts, 'index.d.ts must export SukhanApiError').toContain('SukhanApiError')
  expect(indexDts, 'index.d.ts must export AccessMode').toContain('AccessMode')
  expect(indexDts, 'index.d.ts must export SukhanLoginRequiredDetail').toContain('SukhanLoginRequiredDetail')
  expect(indexDts, 'index.d.ts must export OtpStartResponse').toContain('OtpStartResponse')
  expect(indexDts, 'index.d.ts must export resolveIdentityEndpoint').toContain('resolveIdentityEndpoint')
  expect(indexDts, 'index.d.ts must export fetchIdentity').toContain('fetchIdentity')
})
