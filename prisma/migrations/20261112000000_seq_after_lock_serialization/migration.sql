-- AI-Q6 BLOCKER: SERIAL default allocates BEFORE FK lock — seq ≠ commit order.
--
-- PostgreSQL evaluates the SERIAL DEFAULT (nextval) BEFORE BEFORE INSERT
-- triggers and before the AFTER-statement foreign-key check that locks
-- Conversation FOR KEY SHARE. A writer can allocate a lower seq but remain
-- uncommitted (held before its FK lock), while another writer commits a
-- higher seq. MAX(seq) during takeover sees the higher value; when the
-- first writer commits after takeover, its lower seq passes the filter.
--
-- Fix: assign the authoritative seq AFTER acquiring the per-conversation
-- lock, in a BEFORE INSERT trigger.
--
-- ## Architecture
--
-- 1. A BEFORE INSERT trigger on Message acquires FOR NO KEY UPDATE on the
--    parent Conversation row FIRST, then calls nextval() to assign the
--    authoritative seq. The SERIAL default (0) is overwritten.
--    The lock is held until the message's transaction commits/rolls back.
--
-- 2. The takeover triggers (assignment + agent reply) upgrade the
--    Conversation lock to FOR UPDATE before capturing MAX(seq).
--    FOR UPDATE conflicts with FOR NO KEY UPDATE, so the takeover blocks
--    on any uncommitted message insert.
--
-- This ensures seq assignment agrees with the serialization order:
-- a message that acquires the Conversation lock first gets a lower seq,
-- and MAX(seq) during takeover sees only messages whose transactions
-- committed before the takeover acquired FOR UPDATE.
--
-- ## Both serial orders supported
--
-- 1. Takeover commits first: the message's BEFORE INSERT trigger blocks on
--    FOR NO KEY UPDATE (takeover holds FOR UPDATE). The message gets its
--    seq AFTER the takeover commits and releases the lock. Its seq >
--    handoffSourceSeq → excluded. ✓
-- 2. Message commits first: the takeover's FOR UPDATE blocks on the
--    message's FOR NO KEY UPDATE. The message commits, releases the lock.
--    The takeover acquires FOR UPDATE, captures MAX(seq) which includes
--    the committed message. Its seq <= handoffSourceSeq → included. ✓
--
-- ## Deadlock safety
--
-- Lock order is always: Conversation (single row).
-- - Message insert: locks Conversation (FOR NO KEY UPDATE) → no other locks.
-- - Takeover: locks Conversation (FOR UPDATE) → no other locks.
-- - Q5 commitAiReply: AiReplyReservation → Conversation (via message
--   insert FOR NO KEY UPDATE) → AiUsagePeriod.
-- No circular dependency: the takeover only locks Conversation; Q5 locks
-- AiReplyReservation first, then Conversation, then AiUsagePeriod.

-- === Step 1: Change seq column default from SERIAL to 0 ===
-- The authoritative seq is now assigned by the BEFORE INSERT trigger,
-- NOT by a SERIAL default. We keep the existing sequence object for the
-- trigger to call nextval() on.
ALTER TABLE "Message" ALTER COLUMN "seq" SET DEFAULT 0;

-- === Step 2: BEFORE INSERT trigger on Message ===
-- Acquires FOR NO KEY UPDATE on the Conversation row, then assigns the
-- authoritative seq via nextval(). This ensures seq agrees with the
-- serialization order.
CREATE OR REPLACE FUNCTION "assign_message_seq_after_lock"()
RETURNS TRIGGER AS $$
BEGIN
  -- Acquire per-conversation row lock BEFORE assigning seq.
  -- FOR NO KEY UPDATE conflicts with FOR UPDATE (takeover) and with other
  -- FOR NO KEY UPDATE locks, but NOT with FOR KEY SHARE (FK checks from
  -- other inserts). This serializes message inserts with takeover without
  -- unnecessarily blocking foreign-key checks from non-Message tables.
  --
  -- If the Conversation row is already locked by a FOR UPDATE (takeover),
  -- this PERFORM blocks until the takeover commits/rolls back. The seq
  -- is assigned AFTER the lock is acquired — so the seq value agrees with
  -- the serialization order.
  PERFORM 1 FROM "Conversation" WHERE "id" = NEW."conversationId" FOR NO KEY UPDATE;
  -- Assign the authoritative seq AFTER acquiring the lock.
  -- This overwrites the SERIAL default (0) with a real sequence value.
  -- nextval is called once per message, and the value is strictly
  -- increasing. Because the lock was acquired first, the seq value
  -- reflects the serialization order, not the allocation order.
  NEW."seq" = nextval('"Message_seq_seq"');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop the old trigger if it exists (from previous migration attempts),
-- then create the new one. This trigger fires for ALL message inserts.
DROP TRIGGER IF EXISTS "message_assign_seq_after_lock_trigger" ON "Message";
CREATE TRIGGER "message_assign_seq_after_lock_trigger"
BEFORE INSERT ON "Message"
FOR EACH ROW
EXECUTE FUNCTION "assign_message_seq_after_lock"();

-- === Step 3: Recreate takeover triggers with FOR UPDATE lock upgrade ===
-- These are the same functions from the previous migration, but now they
-- conflict with the message insert's FOR NO KEY UPDATE (not just FOR KEY
-- SHARE). This provides stronger serialization: the takeover blocks on
-- any uncommitted message insert, even if the message hasn't reached its
-- FK check yet.

CREATE OR REPLACE FUNCTION "set_conversation_first_handoff_at"()
RETURNS TRIGGER AS $$
BEGIN
  -- Assignment takeover: assignedUserId transitions NULL → non-NULL.
  IF NEW."assignedUserId" IS NOT NULL
     AND OLD."assignedUserId" IS NULL
     AND NEW."firstHandoffAt" IS NULL THEN
    -- Upgrade the row lock to FOR UPDATE BEFORE capturing the boundary.
    -- FOR UPDATE conflicts with FOR NO KEY UPDATE (held by uncommitted
    -- message inserts). The takeover blocks until all concurrent message
    -- transactions commit/rollback.
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    NEW."firstHandoffAt" = NOW();
    -- Capture MAX(seq). After the lock upgrade, all concurrent message
    -- transactions have committed. Their seq values (assigned after the
    -- lock) are visible. Messages that haven't committed yet don't have
    -- visible rows (and their seq hasn't been assigned because they're
    -- blocked on the lock).
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id";
  END IF;

  -- Agent reply takeover: firstHandoffAt transitions NULL → non-NULL
  -- (set by the AFTER INSERT trigger's UPDATE SET clause).
  IF OLD."firstHandoffAt" IS NULL
     AND NEW."firstHandoffAt" IS NOT NULL
     AND NEW."assignedUserId" IS NULL THEN
    -- Same lock upgrade as assignment case.
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    -- Capture MAX(seq) excluding agent messages.
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id"
      AND "senderType" <> 'agent';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The set_handoff_on_agent_reply function is unchanged from the previous
-- migration — it only sets firstHandoffAt, and the BEFORE UPDATE trigger
-- captures handoffSourceSeq after the lock upgrade.
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
