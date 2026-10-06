import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { ReportSyncService } from "./report-sync.service";
export const REPORT_SYNC_QUEUE = "report-sync";
@Injectable()
export class ReportSyncRecovery implements OnModuleInit {
  constructor(@InjectQueue(REPORT_SYNC_QUEUE) private readonly queue: Queue) {}
  async onModuleInit() {
    await this.queue.add(
      "recover",
      {},
      {
        jobId: "report-sync-recover",
        repeat: { every: 30000 },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }
}
@Processor(REPORT_SYNC_QUEUE, { concurrency: 1 })
export class ReportSyncProcessor extends WorkerHost {
  constructor(
    @Inject(ReportSyncService) private readonly sync: ReportSyncService,
  ) {
    super();
  }
  async process(_job: Job) {
    let config;
    try {
      config = this.sync.config();
    } catch {
      return;
    }
    if (config.mode !== "production") return;
    const rows = await this.sync.repo.db.reportSyncIntent.findMany({
      where: {
        sourceId: config.sourceId,
        workspaceId: config.workspaceId,
        mode: "production",
        AND: [
          {
            OR: [
              { status: { in: ["pending", "processing", "paused"] } },
              {
                status: { in: ["blocked", "failed"] },
                nextAttemptAt: { not: null },
              },
            ],
          },
          {
            OR: [
              { nextAttemptAt: null },
              { nextAttemptAt: { lte: new Date() } },
            ],
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const row of rows) await this.sync.process(row.id);
  }
}
