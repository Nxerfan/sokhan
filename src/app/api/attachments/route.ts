import { NextRequest, NextResponse } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { getStorage } from '@/lib/storage'
import path from 'path'

/**
 * File attachment upload.
 *
 * Uses the storage abstraction (`src/lib/storage/index.ts`) so the same
 * route works in:
 *   - docker/dev (LocalStorageAdapter → writes to public/uploads/)
 *   - vercel     (VercelBlobStorageAdapter → uploads to Vercel Blob)
 *
 * Authorization: only agents/admins/managers can upload. Visitors use
 * the public /api/widget/[slug]/upload endpoint instead (separate route,
 * separate authorization, scoped to the visitor's own conversation).
 *
 * Validation: file size (10MB max) and a MIME-type + extension whitelist
 * that explicitly rejects HTML/SVG/JS (which could execute when served).
 */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'agent')) {
      return { forbidden: true as const }
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return { error: 'no_file' as const }
    }

    // Validate file size (10MB max for MVP)
    if (file.size > 10 * 1024 * 1024) {
      return { error: 'file_too_large' as const }
    }

    // File type whitelist — only safe image/document types.
    // Prevents uploading HTML/SVG/JS files that could execute when served.
    const ALLOWED_MIME = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'text/plain', 'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    ]
    const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.txt', '.csv', '.docx', '.xlsx']
    const ext = path.extname(file.name).toLowerCase()

    if (!ALLOWED_MIME.includes(file.type) || !ALLOWED_EXT.includes(ext)) {
      return { error: 'file_type_not_allowed' as const }
    }

    // Read bytes once — the storage adapter handles the rest.
    const bytes = new Uint8Array(await file.arrayBuffer())

    // Use the storage abstraction. The tenantId namespaces the key so a
    // single bucket can host multiple tenants without collisions.
    const storage = getStorage()
    const stored = await storage.put({
      tenantId: session.user.workspaceId,
      filename: file.name,
      bytes,
      contentType: file.type,
    })

    const isImage = file.type.startsWith('image/')

    return {
      url: stored.url,
      type: isImage ? 'image' : 'file',
      name: file.name,
      size: file.size,
    } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json(result.result)
}
