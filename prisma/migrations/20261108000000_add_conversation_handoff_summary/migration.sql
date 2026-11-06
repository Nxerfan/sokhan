-- CreateTable
CREATE TABLE "ConversationHandoffSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "sourceMessageIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationHandoffSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationHandoffSummary_tenantId_conversationId_key" ON "ConversationHandoffSummary"("tenantId", "conversationId");

-- CreateIndex
CREATE INDEX "ConversationHandoffSummary_tenantId_idx" ON "ConversationHandoffSummary"("tenantId");

-- AddForeignKey
ALTER TABLE "ConversationHandoffSummary" ADD CONSTRAINT "ConversationHandoffSummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationHandoffSummary" ADD CONSTRAINT "ConversationHandoffSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
