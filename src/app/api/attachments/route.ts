import { NextRequest, NextResponse } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

/**
 * File attachment upload. Stores files locally in /public/uploads/ for the
 * sandbox. In production, this would use S3/MinIO via the object storage layer.
 *
 * Accepts multipart form data with a single 'file' field.
 * Returns the public URL of the stored file.
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

    // Generate a unique filename (extension already validated)
    const filename = `${crypto.randomUUID()}${ext}`
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    await mkdir(uploadDir, { recursive: true })

    // Write the file
    const bytes = await file.arrayBuffer()
    await writeFile(path.join(uploadDir, filename), Buffer.from(bytes))

    const isImage = file.type.startsWith('image/')
    const url = `/uploads/${filename}`

    return {
      url,
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
