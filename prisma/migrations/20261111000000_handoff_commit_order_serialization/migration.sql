-- AI-Q6 BLOCKER: PostgreSQL SERIAL allocation order ≠ transaction commit order.
--
-- A writer can allocate a lower Message.seq but remain uncommitted, while
-- another writer commits a higher seq. MAX(seq) during takeover sees the
-- higher committed seq; if the first writer then commits AFTER takeover,
-- seq <= MAX wrongly includes its facts.
--
-- Fix: serialize the takeover boundary capture with message persistence
-- using a per-conversation FOR UPDATE lock upgrade.
--
-- ## How it works
--
-- Message inserts acquire FOR KEY SHARE on the parent Conversation row via
-- PostgreSQL's foreign key check. FOR KEY SHARE is held until the message's
-- transaction commits.
--
-- The BEFORE UPDATE trigger on Conversation upgrades the row lock to
-- FOR UPDATE BEFORE capturing MAX(seq). FOR UPDATE conflicts with
-- FOR KEY SHARE, so the lock upgrade blocks on any uncommitted message
-- insert. The takeover can only proceed after all concurrent message
-- transactions commit or roll back.
--
-- This makes MAX(seq) authoritative: it sees only committed messages,
-- and no message can commit with a lower seq after the boundary is captured.
--
-- ## Both serial orders are supported
--
-- 1. Takeover commits first: the message insert's FK check (FOR KEY SHARE)
--    blocks on the takeover's FOR UPDATE. The message commits after the
--    takeover releases the lock. Its seq > handoffSourceSeq → excluded. ✓
-- 2. Message commits first: the takeover's lock upgrade blocks on the
--    message's FOR KEY SHARE. The message commits, the lock upgrade
--    succeeds, MAX(seq) includes the message. Its seq <= handoffSourceSeq
--    → included. ✓
--
-- ## No BEFORE INSERT trigger on Message
--
-- Message inserts do NOT acquire a Conversation row lock beyond the
-- automatic foreign key check (FOR KEY SHARE). This allows concurrent
-- uncommitted message writers (one can commit while another is pending),
-- which is a legitimate serial order the reviewer tests require.
--
-- ## Deadlock safety
--
-- Lock order is always: Conversation (single row). No circular dependency
-- with AiReplyReservation, AiUsagePeriod, or other tables. Compatible with
-- the existing AI-Q5 commitAiReply transaction, which locks
-- AiReplyReservation → Conversation (via message insert FK) → AiUsagePeriod.

-- === Step 1: Recreate set_conversation_first_handoff_at with lock upgrade ===
-- The lock upgrade (PERFORM ... FOR UPDATE) runs BEFORE MAX(seq) capture.
-- This ensures the boundary sees only committed messages.
CREATE OR REPLACE FUNCTION "set_conversation_first_handoff_at"()
RETURNS TRIGGER AS $$
BEGIN
  -- Assignment takeover: assignedUserId transitions NULL → non-NULL.
  -- firstHandoffAt is NULL at this point (the SET clause doesn't include it).
  IF NEW."assignedUserId" IS NOT NULL
     AND OLD."assignedUserId" IS NULL
     AND NEW."firstHandoffAt" IS NULL THEN
    -- 1. Upgrade the row lock to FOR UPDATE BEFORE capturing the boundary.
    --    This blocks on any pending FOR KEY SHARE locks held by uncommitted
    --    message inserts (foreign key checks). The takeover waits for all
    --    concurrent message transactions to commit/rollback before proceeding.
    --    After the upgrade succeeds, MAX(seq) sees only committed messages.
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    -- 2. Set the takeover timestamp.
    NEW."firstHandoffAt" = NOW();
    -- 3. Capture the authoritative boundary. All concurrent message
    --    transactions have now committed. MAX(seq) is the definitive
    --    pre-takeover boundary.
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id";
  END IF;

  -- Agent reply takeover: firstHandoffAt transitions NULL → non-NULL.
  -- This happens when the AFTER INSERT trigger on Message (for agent
  -- messages) does UPDATE Conversation SET firstHandoffAt = X.
  -- assignedUserId is NULL (no assignment — agent message is the only signal).
  IF OLD."firstHandoffAt" IS NULL
     AND NEW."firstHandoffAt" IS NOT NULL
     AND NEW."assignedUserId" IS NULL THEN
    -- 1. Upgrade the row lock to FOR UPDATE BEFORE capturing the boundary.
    --    Same serialization as the assignment case.
    PERFORM 1 FROM "Conversation" WHERE "id" = NEW."id" FOR UPDATE;
    -- 2. Capture the authoritative boundary, excluding agent messages.
    --    The agent message was just inserted in the same transaction;
    --    the senderType filter excludes it. Other agent messages don't
    --    exist (this is the first takeover, so firstHandoffAt was NULL).
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id"
      AND "senderType" <> 'agent';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- === Step 2: Recreate set_handoff_on_agent_reply without handoffSourceSeq in SET ===
-- The handoffSourceSeq is now captured by the BEFORE UPDATE trigger
-- (set_conversation_first_handoff_at) AFTER the lock upgrade. If it were
-- in the SET clause, the subquery would evaluate BEFORE the BEFORE UPDATE
-- trigger fires (at SET expression evaluation time), bypassing the lock
-- upgrade and seeing uncommitted data.
CREATE OR REPLACE FUNCTION "set_handoff_on_agent_reply"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."senderType" = 'agent' THEN
    -- Only set firstHandoffAt. The handoffSourceSeq is captured by the
    -- BEFORE UPDATE trigger after the lock upgrade.
    -- COALESCE + WHERE firstHandoffAt IS NULL → first-takeover-wins.
    UPDATE "Conversation"
    SET "firstHandoffAt" = COALESCE("firstHandoffAt", NEW."createdAt")
    WHERE "id" = NEW."conversationId"
      AND "firstHandoffAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The triggers themselves already exist from the previous migration.
-- CREATE OR REPLACE FUNCTION updates the function bodies in place, and
-- the existing triggers will use the new logic.
