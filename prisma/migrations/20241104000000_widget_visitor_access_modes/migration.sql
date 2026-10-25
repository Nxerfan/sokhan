-- Widget Visitor Access Modes / Identity (feat/widget-visitor-access-modes)
--
-- FROZEN CONTRACT (accessMode):
--   * EXISTING WidgetConfig rows (pre-migration) → 'anonymous' (backfill —
--     preserves the current anonymous behavior for already-deployed workspaces;
--     no operator action required).
--   * ALL FUTURE WidgetConfig rows by DEFAULT → 'verified_visitor' (the DB
--     DEFAULT is set to 'verified_visitor' so correctness does NOT depend on
--     the signup route — any creation path that omits accessMode still gets
--     verified_visitor).
--   * Authoritative enum enforcement: a CHECK constraint restricts accessMode
--     to 'anonymous' | 'verified_visitor' | 'site_user_only'.
--
-- Safe migration sequence:
--   1. add the column backward-safe (nullable, no default)
--   2. backfill pre-existing rows to 'anonymous'
--   3. set NOT NULL
--   4. set the DB DEFAULT for FUTURE rows to 'verified_visitor'
--   5. add the authoritative CHECK constraint
--   (then the other access/identity columns + Contact.emailVerifiedAt +
--    OtpRequest visitor-verification link)
--
-- No destructive rewrite of explicit values. No Contacts/Conversations/Messages/
-- existing widget config are modified or deleted — purely additive.

-- === accessMode: the corrected 5-step strategy ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "accessMode" TEXT;
UPDATE "WidgetConfig" SET "accessMode" = 'anonymous' WHERE "accessMode" IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='WidgetConfig' AND column_name='accessMode' AND is_nullable='NO') THEN
    ALTER TABLE "WidgetConfig" ALTER COLUMN "accessMode" SET NOT NULL;
  END IF;
END $$;
ALTER TABLE "WidgetConfig" ALTER COLUMN "accessMode" SET DEFAULT 'verified_visitor';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WidgetConfig_accessMode_check') THEN
    ALTER TABLE "WidgetConfig" ADD CONSTRAINT "WidgetConfig_accessMode_check"
      CHECK ("accessMode" IN ('anonymous', 'verified_visitor', 'site_user_only'));
  END IF;
END $$;

-- === policyVersion (DEFAULT 1; incremented atomically on mode/secret changes) ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER NOT NULL DEFAULT 1;

-- === Mode 2 integration secret (hash only; raw shown once at generation) ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretHash" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretRotatedAt" TIMESTAMP(3);

-- === Mode 2 login UX (safe public fields) ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginButtonLabel" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginReturnUrlParam" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "identityEndpointPath" TEXT;

-- === Contact: verified-visitor email-verification timestamp ===
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- === OtpRequest: visitor-verification link (Contact + tenant scope) ===
ALTER TABLE "OtpRequest" ADD COLUMN IF NOT EXISTS "contactId" TEXT;
ALTER TABLE "OtpRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "OtpRequest_contactId_idx" ON "OtpRequest"("contactId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OtpRequest_contactId_fkey') THEN
    ALTER TABLE "OtpRequest"
      ADD CONSTRAINT "OtpRequest_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;
  END IF;
END $$;
