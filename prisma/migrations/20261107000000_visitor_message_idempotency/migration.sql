-- AI-Q2: Durable HTTP idempotency for visitor message POSTs.
-- Additive migration: creates the VisitorMessageIdempotency table with a
-- unique constraint on (tenantId, contactId, clientMessageId) so that
-- retrying the same clientMessageId resolves to the original persisted
-- visitor Message — no duplicate message, no duplicate AI charge.

CREATE TABLE "VisitorMessageIdempotency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorMessageIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VisitorMessageIdempotency_tenantId_contactId_clientMessageId_key" ON "VisitorMessageIdempotency"("tenantId", "contactId", "clientMessageId");
CREATE INDEX "VisitorMessageIdempotency_tenantId_contactId_idx" ON "VisitorMessageIdempotency"("tenantId", "contactId");

ALTER TABLE "VisitorMessageIdempotency" ADD CONSTRAINT "VisitorMessageIdempotency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
