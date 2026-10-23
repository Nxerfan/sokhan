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
--
-- BLOCKER 4 — these legacy rows carry a SYNTHETIC tokenHash
-- ('legacy_' || md5(random() || id)) for which NO raw token ever
-- existed. They are therefore PERMANENTLY UNUSABLE as invitation
-- links (acceptance requires the raw token, which was never
-- generated). Marking them status='pending' would (a) display them
-- as normal usable invitations in the members UI (a lie — no link
-- can ever be recovered) and (b) consume a plan-limit seat forever
-- (the seat count is active memberships + UNEXPIRED pending
-- invitations). Both are unacceptable.
--
-- The cleanest representation is status='revoked' — an explicit
-- non-usable state that is already excluded from the pending list
-- and from the seat count. The `id` prefix `legacy_'` lets the UI
-- and the reissue endpoint identify migrated rows distinctly (the
-- reissue endpoint accepts any revoked invitation and produces a
-- fresh usable one for the same email/role).
INSERT INTO "Invitation" ("id", "tenantId", "email", "role", "status", "tokenHash", "expiresAt", "createdAt", "updatedAt", "invitedByUserId")
SELECT
  'legacy_' || m."id",
  m."tenantId",
  u."email",
  m."role",
  'revoked',
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

-- BLOCKER 4 — convert any legacy rows that a PREVIOUS partial run of
-- this migration left as status='pending' into status='revoked'.
-- The INSERT above has a NOT EXISTS guard, so it won't touch rows
-- already inserted by a prior run; those prior rows kept the old
-- 'pending' status. Their synthetic tokenHash ('legacy_' || md5(...))
-- has NO recoverable raw token, so they must NOT remain 'pending'
-- (which would display them as usable invitations and consume a seat
-- forever). This UPDATE is idempotent — re-running it on already-
-- revoked rows is a no-op.
UPDATE "Invitation" SET "status" = 'revoked', "updatedAt" = NOW()
WHERE "id" LIKE 'legacy\_%' AND "status" = 'pending';
