-- Widget Customization V2 Foundation (feat/widget-customization-v2)
-- Phase 1: additive appearanceV2 column.
--
-- WidgetConfig: appearanceV2 (JSONB, nullable) — the versioned appearance V2
--   config. null = V1 behavior (flat fields are the source of truth).
--   Existing rows get null (no destructive rewrite, no data migration).
--   No changes to identity/access policy fields (accessMode, policyVersion,
--   integrationSecretHash, loginUrl, etc.).
--
-- Idempotent (IF NOT EXISTS) — safe to run on databases with existing data.

ALTER TABLE "WidgetConfig" ADD COLUMN IF NOT EXISTS "appearanceV2" JSONB;
