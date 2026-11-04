-- AI-Q2: Atomic successful-reply accounting.
-- Additive migration: creates AiUsagePeriod and AiReplyReservation tables
-- with unique constraints for idempotent billing-period accounting and
-- reservation idempotency. Existing data is preserved.

CREATE TABLE "AiUsagePeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsagePeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiUsagePeriod_tenantId_periodStart_periodEnd_key" ON "AiUsagePeriod"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "AiUsagePeriod_tenantId_periodEnd_idx" ON "AiUsagePeriod"("tenantId", "periodEnd");

ALTER TABLE "AiUsagePeriod" ADD CONSTRAINT "AiUsagePeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiReplyReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "visitorMessageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "usagePeriodId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "aiMessageId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReplyReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiReplyReservation_tenantId_visitorMessageId_key" ON "AiReplyReservation"("tenantId", "visitorMessageId");
CREATE INDEX "AiReplyReservation_tenantId_status_idx" ON "AiReplyReservation"("tenantId", "status");
CREATE INDEX "AiReplyReservation_tenantId_conversationId_idx" ON "AiReplyReservation"("tenantId", "conversationId");

ALTER TABLE "AiReplyReservation" ADD CONSTRAINT "AiReplyReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiReplyReservation" ADD CONSTRAINT "AiReplyReservation_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "AiUsagePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
