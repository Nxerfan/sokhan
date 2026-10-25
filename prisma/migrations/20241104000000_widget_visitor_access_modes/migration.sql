-- Widget Visitor Access Modes / Identity (feat/widget-visitor-access-modes)
-- CORRECTED FOUNDATION (Blockers 2, 3, 12).
--
-- WidgetConfig: accessMode (DB DEFAULT verified_visitor; existing backfilled
--   anonymous; CHECK enum), policyVersion, integrationSecretHash (@unique),
--   integrationSecretRotatedAt, loginUrl, loginButtonLabel, loginReturnUrlParam,
--   identityEndpointPath.
-- Contact: emailVerifiedAt, externalUserId (@@unique [tenantId, externalUserId]).
-- OtpRequest: REVERTED widget-specific fields (contactId/tenantId/FK/index
--   dropped if a prior migration run added them — idempotent).
-- WidgetOtpRequest: NEW tenant-scoped widget verification state model.
--
-- All idempotent (IF NOT EXISTS / DO blocks / IF EXISTS drops).

-- === WidgetConfig access-policy fields ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "accessMode" TEXT;
UPDATE "WidgetConfig" SET "accessMode" = 'anonymous' WHERE "accessMode" IS NULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='WidgetConfig' AND column_name='accessMode' AND is_nullable='NO') THEN ALTER TABLE "WidgetConfig" ALTER COLUMN "accessMode" SET NOT NULL; END IF; END $$;
ALTER TABLE "WidgetConfig" ALTER COLUMN "accessMode" SET DEFAULT 'verified_visitor';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='WidgetConfig_accessMode_check') THEN ALTER TABLE "WidgetConfig" ADD CONSTRAINT "WidgetConfig_accessMode_check" CHECK ("accessMode" IN ('anonymous','verified_visitor','site_user_only')); END IF; END $$;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretHash" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretRotatedAt" TIMESTAMP(3);
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginButtonLabel" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginReturnUrlParam" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "identityEndpointPath" TEXT;
-- B12: unique index on integrationSecretHash (direct indexed lookup; multiple NULLs allowed)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='WidgetConfig_integrationSecretHash_key') THEN CREATE UNIQUE INDEX "WidgetConfig_integrationSecretHash_key" ON "WidgetConfig"("integrationSecretHash"); END IF; END $$;

-- === Contact: emailVerifiedAt + externalUserId (B2) ===
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "externalUserId" TEXT;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='Contact_tenantId_externalUserId_key') THEN CREATE UNIQUE INDEX "Contact_tenantId_externalUserId_key" ON "Contact"("tenantId","externalUserId"); END IF; END $$;

-- === OtpRequest: REVERT widget-specific fields (B3 — OtpRequest is global auth) ===
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='OtpRequest' AND column_name='contactId') THEN ALTER TABLE "OtpRequest" DROP CONSTRAINT IF EXISTS "OtpRequest_contactId_fkey"; ALTER TABLE "OtpRequest" DROP COLUMN IF EXISTS "contactId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='OtpRequest' AND column_name='tenantId') THEN ALTER TABLE "OtpRequest" DROP COLUMN IF EXISTS "tenantId"; END IF; END $$;
DROP INDEX IF EXISTS "OtpRequest_contactId_idx";

-- === WidgetOtpRequest: NEW tenant-scoped widget verification state (B3) ===
CREATE TABLE IF NOT EXISTS "WidgetOtpRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "pendingName" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'widget_verify',
    "providerRequestId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WidgetOtpRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WidgetOtpRequest_providerRequestId_key" ON "WidgetOtpRequest"("providerRequestId");
CREATE INDEX IF NOT EXISTS "WidgetOtpRequest_tenantId_idx" ON "WidgetOtpRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "WidgetOtpRequest_contactId_idx" ON "WidgetOtpRequest"("contactId");
CREATE INDEX IF NOT EXISTS "WidgetOtpRequest_email_idx" ON "WidgetOtpRequest"("email");
CREATE INDEX IF NOT EXISTS "WidgetOtpRequest_tenantId_contactId_idx" ON "WidgetOtpRequest"("tenantId","contactId");
CREATE INDEX IF NOT EXISTS "WidgetOtpRequest_tenantId_purpose_email_idx" ON "WidgetOtpRequest"("tenantId","purpose","email");
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='WidgetOtpRequest_purpose_check') THEN ALTER TABLE "WidgetOtpRequest" ADD CONSTRAINT "WidgetOtpRequest_purpose_check" CHECK ("purpose" = 'widget_verify'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='WidgetOtpRequest_tenantId_fkey') THEN ALTER TABLE "WidgetOtpRequest" ADD CONSTRAINT "WidgetOtpRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='WidgetOtpRequest_contactId_fkey') THEN ALTER TABLE "WidgetOtpRequest" ADD CONSTRAINT "WidgetOtpRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE; END IF; END $$;

-- BLOCKER 2+3: status column CHECK + one-active-flow partial unique index
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='WidgetOtpRequest_status_check') THEN ALTER TABLE "WidgetOtpRequest" ADD CONSTRAINT "WidgetOtpRequest_status_check" CHECK ("status" IN ('active','superseded','verified')); END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "WidgetOtpRequest_active_unique" ON "WidgetOtpRequest" ("tenantId","contactId") WHERE "status" = 'active';
