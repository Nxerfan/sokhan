-- AI-Q6 BLOCKER: SERIAL default allocates before FK lock — seq ≠ commit order.
--
-- PostgreSQL evaluates the SERIAL DEFAULT (nextval) BEFORE BEFORE INSERT
-- triggers and before the foreign-key check. A writer can allocate a lower
-- seq but remain uncommitted, while another writer commits a higher seq.
--
-- Previous fix (FOR NO KEY UPDATE on message insert) blocked ALL concurrent
-- message inserts for the same conversation, breaking the commit-order test
-- which requires concurrent uncommitted writers.
--
-- Fix: use pg_current_snapshot() + pg_visible_in_snapshot() for a
-- commit-order-aware boundary that doesn't lock message inserts.
--
-- ## Architecture
--
-- 1. Message inserts are NOT locked. Concurrent uncommitted writers are
--    allowed (Writer B can commit while Writer A is uncommitted).
--
-- 2. At takeover time, the BEFORE UPDATE trigger captures
--    pg_current_snapshot()::text — a snapshot of which transactions were
--    committed (visible) at that moment. This is stored as
--    Conversation.handoffSnapshot.
--
-- 3. The takeover trigger also upgrades the lock to FOR UPDATE (blocks on
--    FOR KEY SHARE from FK checks of committed-but-uncommitted message
--    transactions). This ensures the snapshot captures a stable state.
--
-- 4. When generating the summary, messages are filtered by
--    pg_visible_in_snapshot(m.xmin, handoffSnapshot::pg_snapshot).
--    This returns true ONLY for messages whose inserting transaction was
--    committed (visible) at the time of the snapshot. Messages committed
--    after the takeover return false and are excluded.
--
-- ## Why this works
--
-- - pg_current_snapshot() captures the exact set of committed transactions
--   at the moment of takeover.
-- - m.xmin is the XID of the transaction that inserted each message row.
-- - pg_visible_in_snapshot(xmin, snapshot) returns true iff that transaction
--   was committed and visible at the snapshot time.
-- - This is independent of SERIAL allocation order: a message with a lower
--   seq that commits AFTER the takeover has an xmin that was NOT visible
--   at snapshot time → excluded.
-- - A message with a higher seq that commits BEFORE the takeover has an
--   xmin that WAS visible → included.
--
-- ## Both serial orders supported
--
-- 1. Takeover commits first: Writer A's xmin is not visible in the snapshot
--    (A was uncommitted). pg_visible_in_snapshot returns false → excluded.
-- 2. Writer commits first while takeover waits (FOR UPDATE blocks on
--    FOR KEY SHARE): Writer commits → snapshot includes its xmin →
--    pg_visible_in_snapshot returns true → included.

-- === Step 1: Revert seq default to SERIAL ===
-- The BEFORE INSERT trigger that reassigned seq is removed. seq is now
-- a simple SERIAL default again. The authoritative boundary is the
-- snapshot, not the seq.
ALTER TABLE "Message" ALTER COLUMN "seq" SET DEFAULT nextval('"Message_seq_seq"');

-- === Step 2: Drop the BEFORE INSERT trigger that locked Conversation ===
DROP TRIGGER IF EXISTS "message_assign_seq_after_lock_trigger" ON "Message";
DROP FUNCTION IF EXISTS "assign_message_seq_after_lock"();

-- === Step 3: Add handoffSnapshot column to Conversation ===
ALTER TABLE "Conversation" ADD COLUMN "handoffSnapshot" TEXT;

-- === Step 4: Recreate takeover triggers to capture snapshot ===
-- The FOR UPDATE lock upgrade is retained: it blocks on FOR KEY SHARE
-- from uncommitted message FK checks, serializing the snapshot capture.
-- The snapshot is captured AFTER the lock upgrade, ensuring a stable state.

CREATE OR REPLACE FUNCTION "set_conversation_first_handoff_at"()
RETURNS TRIGGER AS $$
BEGIN
  -- Assignment takeover: assignedUserId transitions NULL → non-NULL.
  IF NEW."assignedUserId" IS NOT NULL
     AND OLD."assignedUserId" IS NULL
     AND NEW."firstHandoffAt" IS NULL THEN
    -- 1. Upgrade the row lock to FOR UPDATE. Blocks on any pending
    --    FOR KEY SHARE locks from uncommitted message inserts (FK checks).
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    -- 2. Set the takeover timestamp.
    NEW."firstHandoffAt" = NOW();
    -- 3. Capture the authoritative commit-order boundary.
    --    pg_current_snapshot() records which transactions are committed
    --    (visible) at this moment. This is independent of SERIAL allocation
    --    order — it reflects actual commit status.
    NEW."handoffSnapshot" = pg_current_snapshot()::text;
    -- 4. Also capture MAX(seq) as a secondary/fallback boundary.
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id";
  END IF;

  -- Agent reply takeover: firstHandoffAt transitions NULL → non-NULL
  -- (set by the AFTER INSERT trigger's UPDATE SET clause).
  IF OLD."firstHandoffAt" IS NULL
     AND NEW."firstHandoffAt" IS NOT NULL
     AND NEW."assignedUserId" IS NULL THEN
    -- 1. Upgrade the row lock to FOR UPDATE.
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    -- 2. Capture the authoritative commit-order boundary.
    NEW."handoffSnapshot" = pg_current_snapshot()::text;
    -- 3. Also capture MAX(seq) excluding agent messages.
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id"
      AND "senderType" <> 'agent';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- set_handoff_on_agent_reply is unchanged — only sets firstHandoffAt.
-- The BEFORE UPDATE trigger captures the snapshot.
CREATE OR REPLACE FUNCTION "set_handoff_on_agent_reply"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."senderType" = 'agent' THEN
    UPDATE "Conversation"
    SET "firstHandoffAt" = COALESCE("firstHandoffAt", NEW."createdAt")
    WHERE "id" = NEW."conversationId"
      AND "firstHandoffAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
