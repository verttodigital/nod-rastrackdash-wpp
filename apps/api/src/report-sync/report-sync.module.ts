import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../common/prisma/prisma.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { WhatsappProvidersModule } from "../integrations/whatsapp-providers/whatsapp-providers.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { ReportSyncRepository } from "./report-sync.repository";
import { ReportSyncService } from "./report-sync.service";
import { ReportSyncController } from "./report-sync.controller";
import {
  ReportSyncProcessor,
  ReportSyncRecovery,
  REPORT_SYNC_QUEUE,
} from "./report-sync.processor";
import { ReportSyncOps } from "./report-sync-ops";
import { CONVERSION_EVENTS_QUEUE } from "../common/queue/queue.constants";
@Module({
  imports: [
    PrismaModule,
    RuntimeModule,
    WhatsappProvidersModule,
    InboundWebhooksModule,
    BullModule.registerQueue(
      { name: REPORT_SYNC_QUEUE },
      { name: CONVERSION_EVENTS_QUEUE },
    ),
  ],
  providers: [
    ReportSyncRepository,
    ReportSyncService,
    ReportSyncProcessor,
    ReportSyncRecovery,
    ReportSyncOps,
  ],
  controllers: [ReportSyncController],
  exports: [ReportSyncService, ReportSyncOps],
})
export class ReportSyncModule {}
