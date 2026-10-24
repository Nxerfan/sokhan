-- Stabilization audit (CUST-C): unify the canonical widget position
-- default to 'bottom-end'. Only the column DEFAULT changes — existing
-- stored positions are NOT rewritten. The only WidgetConfig row-creation
-- path (signup complete) already wrote 'bottom-end' explicitly, so this
-- aligns the schema default with actual product behavior.
ALTER TABLE "WidgetConfig" ALTER COLUMN "position" SET DEFAULT 'bottom-end';
