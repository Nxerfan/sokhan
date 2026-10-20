-- Idempotent migration for Invitation model (PR #11).
-- Uses IF NOT EXISTS / IF EXISTS to handle partial application from
-- a previous failed attempt on Neon (where gen_random_bytes was
-- unavailable, causing the legacy INSERT to fail after the CREATE TABLE
-- had already succeeded).

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "invitedByUserId" TEXT,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "Invitation_tenantId_idx" ON "Invitation"("tenantId");
CREATE INDEX IF NOT EXISTS "Invitation_email_idx" ON "Invitation"("email");
CREATE INDEX IF NOT EXISTS "Invitation_status_idx" ON "Invitation"("status");

-- AddForeignKey (idempotent — use DO block to check if constraint exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Invitation_tenantId_fkey') THEN
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Invitation_invitedByUserId_fkey') THEN
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Legacy migration: move existing Membership(status='invited') rows
-- into Invitation table. Only insert rows that don't already exist
-- (in case a previous partial run already inserted some).
INSERT INTO "Invitation" ("id", "tenantId", "email", "role", "status", "tokenHash", "expiresAt", "createdAt", "updatedAt", "invitedByUserId")
SELECT
  'legacy_' || m."id",
  m."tenantId",
  u."email",
  m."role",
  'pending',
  'legacy_' || md5(random()::text || m."id"::text),
  NOW() + INTERVAL '7 days',
  m."createdAt",
  NOW(),
  NULL
FROM "Membership" m
JOIN "User" u ON m."userId" = u."id"
WHERE m."status" = 'invited'
  AND NOT EXISTS (SELECT 1 FROM "Invitation" WHERE "id" = 'legacy_' || m."id");

-- Delete the legacy invited Membership rows.
DELETE FROM "Membership" WHERE "status" = 'invited';
