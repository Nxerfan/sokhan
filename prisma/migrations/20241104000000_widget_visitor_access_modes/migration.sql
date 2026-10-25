-- Widget Visitor Access Modes / Identity (feat/widget-visitor-access-modes)
--
-- Adds the access-policy + identity fields needed for THREE visitor access
-- modes (anonymous, verified_visitor, site_user_only) to WidgetConfig, plus
-- the verified-visitor email-verification timestamp on Contact, plus the
-- visitor-verification link fields on OtpRequest (reusing the existing OTP
-- infrastructure for visitor email verification).
--
-- MIGRATION BEHAVIOR (stabilization-safe, no destructive rewrite):
--   * Existing WidgetConfig rows: accessMode defaults to 'anonymous'
--     (preserves the current anonymous behavior for already-deployed
--      workspaces — no operator action required to keep existing behavior).
--   * New WidgetConfig rows created at signup: accessMode='verified_visitor'
--     (set explicitly in the signup-complete route, NOT via the column
--      DEFAULT — the column DEFAULT 'anonymous' is the safe fallback for
--      any other creation path).
--   * policyVersion defaults to 1 (incremented atomically on every
--     access-mode / integration-secret change so stricter policy transitions
--     invalidate older weaker credentials IMMEDIATELY).
--   * Contacts: emailVerifiedAt is NULL for all existing contacts (no
--     verification was performed before this feature). Anonymous/external
--     contacts remain NULL.
--   * OtpRequest: contactId/tenantId are NULL for all existing User-auth
--     OTP rows (signup/login/reset). They are set only for visitor
--     verification OTPs.
--
-- No Contacts / Conversations / Messages / existing widget config are
-- modified or deleted — this is purely additive (new columns + index + FK).
--
-- Idempotent guards (IF NOT EXISTS / DO blocks) so the migration is safe to
-- re-run against a non-pristine database (e.g. the real-PostgreSQL DB-boundary
-- test databases).

-- === WidgetConfig: access-policy + integration-secret + login-UX fields ===
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "accessMode" TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretHash" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "integrationSecretRotatedAt" TIMESTAMP(3);
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginUrl" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginButtonLabel" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "loginReturnUrlParam" TEXT;
ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "identityEndpointPath" TEXT;

-- === Contact: verified-visitor email-verification timestamp ===
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- === OtpRequest: visitor-verification link (Contact + tenant scope) ===
ALTER TABLE "OtpRequest" ADD COLUMN IF NOT EXISTS "contactId" TEXT;
ALTER TABLE "OtpRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Idempotent index on OtpRequest(contactId) for the visitor-verification lookup.
CREATE INDEX IF NOT EXISTS "OtpRequest_contactId_idx" ON "OtpRequest"("contactId");

-- Idempotent FK: OtpRequest.contactId -> Contact.id ON DELETE CASCADE
-- (a deleted Contact's visitor-verification OTPs are removed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OtpRequest_contactId_fkey') THEN
    ALTER TABLE "OtpRequest"
      ADD CONSTRAINT "OtpRequest_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;
  END IF;
END $$;
