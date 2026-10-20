-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked');

-- CreateTable
CREATE TABLE "Invitation" (
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

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_status_idx" ON "Invitation"("status");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;

-- Legacy migration: move existing Membership(status='invited') rows into Invitation table.
-- For each invited Membership, create an Invitation with status='pending' and a random token hash.
-- Then DELETE the invited Membership rows so they don't double-count against plan limits.
-- The invited User accounts (created by the old flow, with no password) remain but are harmless
-- — they can't log in (no passwordHash) and won't be selected by the login flow (no active membership).

-- Step 1: Create Invitation rows from legacy invited memberships.
-- Use md5(random()::text) for the token hash — pgcrypto's gen_random_bytes
-- is not available in all PostgreSQL configurations. The legacy tokens are
-- already invalid (they will need to be reissued), so cryptographic strength
-- is not critical here — the hash just needs to be unique.
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
WHERE m."status" = 'invited';

-- Step 2: Delete the legacy invited Membership rows.
-- The User rows remain (they may have other active memberships, or they may be orphaned
-- — but they can't log in without a passwordHash, and the login flow only selects
-- active memberships).
DELETE FROM "Membership" WHERE "status" = 'invited';
