-- AI-Q6 BLOCKER: Exact handoff boundary integrity.
--
-- Millisecond timestamp equality does not establish pre-handoff ordering.
-- A message committed AFTER human takeover can share the same persisted
-- millisecond as the takeover event. This migration adds a durable,
-- transactionally authoritative source boundary.
--
-- Architecture:
--   1. Message.seq — a global monotonic insertion sequence (SERIAL).
--      Strictly increasing across all messages regardless of conversation
--      or tenant. Each insert gets a unique, higher seq than all prior rows.
--   2. Conversation.handoffSourceSeq — the maximum Message.seq at the
--      moment of the first human takeover. Set atomically by triggers
--      in the SAME transaction as the takeover event.
--   3. Two PostgreSQL triggers capture the boundary:
--      a) BEFORE UPDATE on Conversation (assignment): when assignedUserId
--         transitions NULL → non-NULL, captures MAX(seq) for the conversation.
--      b) AFTER INSERT on Message (agent reply): when senderType = 'agent',
--         captures MAX(seq) excluding the agent message itself.
--      Both use COALESCE + IS NULL guards for first-takeover-wins semantics.
--
-- Messages with seq <= handoffSourceSeq are definitively pre-takeover.
-- Messages with seq > handoffSourceSeq are definitively post-takeover.
-- This works regardless of timestamp equality.

-- === Step 1: Add Conversation.handoffSourceSeq (nullable, no default) ===
ALTER TABLE "Conversation" ADD COLUMN "handoffSourceSeq" INTEGER;

-- === Step 2: Add Message.seq as a SERIAL (monotonic global sequence) ===
-- SERIAL creates a sequence, sets the default, and populates existing rows.
-- Existing rows receive sequential values in their current physical order,
-- which is acceptable — we only need a consistent monotonic ordering.
ALTER TABLE "Message" ADD COLUMN "seq" SERIAL;

-- Index for efficient seq-based filtering within a conversation
CREATE INDEX "Message_conversationId_seq_idx" ON "Message"("conversationId", "seq");

-- === Step 3: Recreate the assignment trigger to also capture handoffSourceSeq ===
-- The original trigger only set firstHandoffAt. Now it also captures the
-- authoritative seq boundary in the same BEFORE UPDATE transaction.
CREATE OR REPLACE FUNCTION "set_conversation_first_handoff_at"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."assignedUserId" IS NOT NULL
     AND OLD."assignedUserId" IS NULL
     AND NEW."firstHandoffAt" IS NULL THEN
    NEW."firstHandoffAt" = NOW();
    -- Capture the maximum message seq at this moment. All messages with
    -- seq <= this value were persisted before this assignment transaction.
    SELECT COALESCE(MAX("seq"), 0) INTO NEW."handoffSourceSeq"
    FROM "Message" WHERE "conversationId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself already exists from the previous migration; no need
-- to recreate it — CREATE OR REPLACE FUNCTION updates the function body
-- in place, and the existing trigger will use the new logic.

-- === Step 4: Add AFTER INSERT trigger on Message for agent replies ===
-- When the first human agent reply is sent (even without assignment),
-- capture the authoritative boundary. The agent message itself gets a
-- higher seq than all pre-existing messages. We capture MAX(seq) EXCLUDING
-- the agent message (id <> NEW.id) — this is the last pre-takeover seq.
CREATE OR REPLACE FUNCTION "set_handoff_on_agent_reply"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."senderType" = 'agent' THEN
    -- Only set if firstHandoffAt is still NULL (first-takeover-wins).
    -- Use COALESCE to preserve any existing value.
    UPDATE "Conversation"
    SET "firstHandoffAt" = COALESCE("firstHandoffAt", NEW."createdAt"),
        "handoffSourceSeq" = COALESCE("handoffSourceSeq", (
          SELECT COALESCE(MAX("seq"), 0) FROM "Message"
          WHERE "conversationId" = NEW."conversationId"
            AND "id" <> NEW."id"
        ))
    WHERE "id" = NEW."conversationId"
      AND "firstHandoffAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER INSERT trigger: fires only for agent messages (WHEN clause).
-- The WHEN clause is evaluated before the function runs, so non-agent
-- message inserts do not invoke the function at all.
CREATE TRIGGER "message_agent_reply_handoff_trigger"
AFTER INSERT ON "Message"
FOR EACH ROW
WHEN (NEW."senderType" = 'agent')
EXECUTE FUNCTION "set_handoff_on_agent_reply"();
