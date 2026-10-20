/**
 * Object storage abstraction.
 *
 * Two adapters:
 *   - LocalStorageAdapter  : writes to `public/uploads/` and serves via
 *                            Next.js static middleware. Used in dev and
 *                            Docker (where the FS is persistent).
 *   - VercelBlobStorageAdapter : uses Vercel Blob (`@vercel/blob`) when
 *                            `BLOB_READ_WRITE_TOKEN` is set. Used on
 *                            Vercel (read-only FS).
 *
 * The factory `getStorage()` chooses based on the deployment mode and
 * presence of credentials, so the rest of the app never needs to know
 * which backend is in use.
 *
 * Storage keys are namespaced by tenantId so that a single bucket can
 * host multiple tenants without collisions. The public URL returned by
 * `put()` is what gets stored on the Message row and embedded in the
 * chat UI.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { hasPersistentFilesystem } from '@/lib/deployment'

export interface StorageObject {
  /** Public URL the client can fetch to download the object. */
  url: string
  /** Storage key (path) within the bucket / local dir. */
  key: string
  /** Size in bytes. */
  size: number
  /** MIME type. */
  contentType: string
}

export interface PutOptions {
  /** Tenant namespace — used to partition one bucket across tenants. */
  tenantId: string
  /** Original filename, used to derive the extension only. */
  filename: string
  /** Raw bytes to store. */
  bytes: Uint8Array
  /** MIME type — stored as metadata. */
  contentType: string
}

export interface StorageAdapter {
  put(opts: PutOptions): Promise<StorageObject>
  /** Delete an object by its storage key. Best-effort; never throws. */
  delete(key: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Local filesystem adapter                                           */
/* ------------------------------------------------------------------ */

function localUploadDir(): string {
  // Resolve lazily so tests that change process.cwd() see the new dir.
  return path.join(process.cwd(), 'public', 'uploads')
}

class LocalStorageAdapter implements StorageAdapter {
  async put({ tenantId, filename, bytes, contentType }: PutOptions): Promise<StorageObject> {
    const ext = path.extname(filename).toLowerCase()
    const key = `${tenantId}/${cryptoRandomUuid()}${ext}`
    const abs = path.join(localUploadDir(), key)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, Buffer.from(bytes))
    return {
      // Served by Next.js from /public. The tenant prefix is part of the
      // path so multi-tenant buckets in a single shared FS don't collide.
      url: `/uploads/${key}`,
      key,
      size: bytes.byteLength,
      contentType,
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const abs = path.join(localUploadDir(), key)
      await fs.unlink(abs)
    } catch {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Vercel Blob adapter                                                */
/* ------------------------------------------------------------------ */
//
// We import `@vercel/blob` lazily so that:
//   - the package is only required when actually running on Vercel;
//   - tests and Docker builds do not need `@vercel/blob` installed;
//   - the module loads cleanly even if `@vercel/blob` is absent.
//
// In Vercel production, `BLOB_READ_WRITE_TOKEN` MUST be set or uploads will
// fail at runtime with a clear error message.

interface VercelBlobPutResult {
  url: string
  pathname: string
  size: number
  contentType: string
}

class VercelBlobStorageAdapter implements StorageAdapter {
  private blob: typeof import('@vercel/blob') | null = null

  private async load(): Promise<typeof import('@vercel/blob')> {
    if (this.blob) return this.blob
    try {
      // Use a non-static import so the package is optional in dev/docker.
      const mod = await import('@vercel/blob')
      this.blob = mod
      return mod
    } catch {
      throw new Error(
        'Vercel Blob storage is configured (BLOB_READ_WRITE_TOKEN set) but ' +
          'the `@vercel/blob` package is not installed. ' +
          'Run `bun add @vercel/blob` to enable Vercel Blob storage.',
      )
    }
  }

  async put({ tenantId, filename, bytes, contentType }: PutOptions): Promise<StorageObject> {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error(
        'Vercel Blob storage selected but BLOB_READ_WRITE_TOKEN is not set.',
      )
    }
    const mod = await this.load()
    const ext = path.extname(filename).toLowerCase()
    const key = `${tenantId}/${cryptoRandomUuid()}${ext}`
    // @vercel/blob's `put` accepts a string | Blob | Buffer | ReadableStream.
    // We pass a Node Buffer (subclass of Uint8Array) which is the most
    // portable option across runtimes.
    const body = Buffer.from(bytes)
    // `addRandomSuffix` is disabled because we already include a uuid in
    // the key — avoids double suffixing in the public URL.
    const result = (await mod.put(key, body, {
      access: 'public',
      addRandomSuffix: false,
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })) as unknown as VercelBlobPutResult
    return {
      url: result.url,
      key,
      size: result.size ?? bytes.byteLength,
      contentType: result.contentType ?? contentType,
    }
  }

  async delete(key: string): Promise<void> {
    try {
      if (!process.env.BLOB_READ_WRITE_TOKEN) return
      const mod = await this.load()
      // `del` accepts either a URL or a pathname. Use pathname to match
      // what we stored.
      await mod.del([key], {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
    } catch {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

let cached: StorageAdapter | null = null

/**
 * Returns the active storage adapter.
 *
 * Selection order:
 *   1. If `BLOB_READ_WRITE_TOKEN` is set → Vercel Blob.
 *   2. Else if deployment has a persistent FS (docker/dev) → local FS.
 *   3. Else (vercel without Blob token) → throw a clear configuration error.
 */
export function getStorage(): StorageAdapter {
  if (cached) return cached
  let adapter: StorageAdapter
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    adapter = new VercelBlobStorageAdapter()
  } else if (hasPersistentFilesystem()) {
    adapter = new LocalStorageAdapter()
  } else {
    throw new Error(
      'No storage backend available. On Vercel you MUST set ' +
        'BLOB_READ_WRITE_TOKEN (Vercel Blob) to enable attachment uploads.',
    )
  }
  cached = adapter
  return adapter
}

/**
 * Reset the cached adapter — for tests that flip env vars between cases.
 */
export function __resetStorageCache(): void {
  cached = null
}

/**
 * Whether the local-fs adapter is currently in use. Used by tests to
 * assert that Vercel mode does not write to public/uploads.
 */
export function isLocalStorage(): boolean {
  // Re-resolve without caching so tests that flip env vars see the change.
  if (process.env.BLOB_READ_WRITE_TOKEN) return false
  return hasPersistentFilesystem()
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function cryptoRandomUuid(): string {
  // Avoid importing `crypto` at the top-level so this file can be imported
  // from the browser bundle (the widget) without pulling in Node polyfills.
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  // Fallback: time-based pseudo-uuid (sufficient for filename uniqueness).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
