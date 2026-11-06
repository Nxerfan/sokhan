-- AI-Q6 BLOCKER 2: Additive first-handoff timestamp column.
-- Records the FIRST authoritative human assignment timestamp atomically so
-- that delayed summary generation never includes post-assignment messages.
-- The column is nullable: existing conversations (assigned before this
-- migration) keep NULL and fall back to firstResponseAt / first agent
-- message as the takeover cutoff. Only NEW assignments (NULL → non-NULL
-- transition on assignedUserId) populate it — first assignment wins.

-- AddColumn: firstHandoffAt (nullable, no default — first assignment fills it)
ALTER TABLE "Conversation" ADD COLUMN "firstHandoffAt" TIMESTAMP(3);

-- Trigger function: set firstHandoffAt on the first assignment only.
-- Conditions (ALL must hold for the column to be written):
--   1. This is an UPDATE (OLD exists).
--   2. OLD.assignedUserId IS NULL  (was NOT previously assigned).
--   3. NEW.assignedUserId IS NOT NULL  (is now being assigned).
--   4. NEW.firstHandoffAt IS NULL  (never overwrite the original cutoff).
-- Reassignment (non-NULL → different non-NULL) does NOT touch the column.
-- Unassignment (non-NULL → NULL) does NOT touch the column.
CREATE OR REPLACE FUNCTION "set_conversation_first_handoff_at"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."assignedUserId" IS NOT NULL
     AND OLD."assignedUserId" IS NULL
     AND NEW."firstHandoffAt" IS NULL THEN
    NEW."firstHandoffAt" = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE UPDATE row-level trigger: fires on every Conversation UPDATE
-- regardless of whether it originates from the API route, a direct Prisma
-- update, or any other client. This guarantees the cutoff is persisted
-- atomically with the assignment write.
CREATE TRIGGER "conversation_set_first_handoff_at_trigger"
BEFORE UPDATE ON "Conversation"
FOR EACH ROW
EXECUTE FUNCTION "set_conversation_first_handoff_at"();
