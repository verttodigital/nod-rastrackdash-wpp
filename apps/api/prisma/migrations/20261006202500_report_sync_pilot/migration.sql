-- AlterTable
ALTER TABLE "ProviderConversionRuleConfig" ADD COLUMN     "requiresReportContext" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ReportSyncSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cutoverAt" TIMESTAMP(3),
    "baselineId" TEXT,
    "baselineComplete" BOOLEAN NOT NULL DEFAULT false,
    "baselineManifest" JSONB,
    "baselineParts" JSONB NOT NULL DEFAULT '{}',
    "activatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSyncSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSyncIntent" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "publicationVersion" INTEGER NOT NULL,
    "sourceLeadId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "payloadIv" TEXT NOT NULL,
    "payloadTag" TEXT NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "whatsappInstanceId" TEXT,
    "contactKey" TEXT,
    "finalLabelVerified" BOOLEAN NOT NULL DEFAULT false,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSyncIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSyncStage" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceLeadId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "intentId" TEXT,
    "whatsappInstanceId" TEXT,
    "contactKey" TEXT,
    "labelId" TEXT,
    "providerRuleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "executionId" TEXT,
    "conversionEventId" TEXT,
    "metaAcceptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSyncStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSyncBinding" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "providerRuleId" TEXT NOT NULL,

    CONSTRAINT "ReportSyncBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSyncLease" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReportSyncLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSyncRateLimit" (
    "id" TEXT NOT NULL,
    "nextAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSyncRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncSource_id_workspaceId_tenantId_key" ON "ReportSyncSource"("id", "workspaceId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncSource_id_workspaceId_key" ON "ReportSyncSource"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "ReportSyncIntent_sourceId_status_nextAttemptAt_idx" ON "ReportSyncIntent"("sourceId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ReportSyncIntent_sourceId_sourceLeadId_publicationVersion_idx" ON "ReportSyncIntent"("sourceId", "sourceLeadId", "publicationVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncIntent_sourceId_tenantId_publicationId_sourceLead_key" ON "ReportSyncIntent"("sourceId", "tenantId", "publicationId", "sourceLeadId");

-- CreateIndex
CREATE INDEX "ReportSyncStage_workspaceId_whatsappInstanceId_contactKey_s_idx" ON "ReportSyncStage"("workspaceId", "whatsappInstanceId", "contactKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncStage_sourceId_tenantId_sourceLeadId_stage_key" ON "ReportSyncStage"("sourceId", "tenantId", "sourceLeadId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncBinding_providerRuleId_key" ON "ReportSyncBinding"("providerRuleId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncBinding_sourceId_whatsappInstanceId_stage_key" ON "ReportSyncBinding"("sourceId", "whatsappInstanceId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSyncBinding_workspaceId_providerRuleId_key" ON "ReportSyncBinding"("workspaceId", "providerRuleId");

-- AddForeignKey
ALTER TABLE "ReportSyncIntent" ADD CONSTRAINT "ReportSyncIntent_sourceId_workspaceId_tenantId_fkey" FOREIGN KEY ("sourceId", "workspaceId", "tenantId") REFERENCES "ReportSyncSource"("id", "workspaceId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSyncStage" ADD CONSTRAINT "ReportSyncStage_sourceId_workspaceId_tenantId_fkey" FOREIGN KEY ("sourceId", "workspaceId", "tenantId") REFERENCES "ReportSyncSource"("id", "workspaceId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSyncBinding" ADD CONSTRAINT "ReportSyncBinding_sourceId_workspaceId_fkey" FOREIGN KEY ("sourceId", "workspaceId") REFERENCES "ReportSyncSource"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSyncBinding" ADD CONSTRAINT "ReportSyncBinding_workspaceId_providerRuleId_fkey" FOREIGN KEY ("workspaceId", "providerRuleId") REFERENCES "ProviderConversionRuleConfig"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Semantic stages and states are constrained independently of queue delivery.
ALTER TABLE "ReportSyncStage" ADD CONSTRAINT "ReportSyncStage_stage_check" CHECK ("stage" IN ('n1','n2','agendamento'));
ALTER TABLE "ReportSyncBinding" ADD CONSTRAINT "ReportSyncBinding_stage_check" CHECK ("stage" IN ('n1','n2','agendamento'));
ALTER TABLE "ReportSyncIntent" ADD CONSTRAINT "ReportSyncIntent_mode_check" CHECK ("mode" IN ('observation','production'));
ALTER TABLE "ReportSyncIntent" ADD CONSTRAINT "ReportSyncIntent_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "ReportSyncIntent" ADD CONSTRAINT "ReportSyncIntent_status_check" CHECK ("status" IN ('observed','pending','processing','succeeded','partial','blocked','failed','paused'));
ALTER TABLE "ReportSyncStage" ADD CONSTRAINT "ReportSyncStage_status_check" CHECK ("status" IN ('baseline','pending','label_verified','decision_recorded','awaiting_meta','delivered','ineligible','blocked','failed'));
ALTER TABLE "ReportSyncStage" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReportSyncStage" ADD CONSTRAINT "ReportSyncStage_deliveryAttempts_check" CHECK ("deliveryAttempts" >= 0);
