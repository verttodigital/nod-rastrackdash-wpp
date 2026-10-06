import "reflect-metadata";
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { ReportSyncRepository } from "../../src/report-sync/report-sync.repository";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  baselineSchema,
  type SyncConfig,
} from "../../src/report-sync/report-sync.contract";

const url = process.env.REPORT_SYNC_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "multipart baseline through real PostgreSQL JSONB",
  () => {
    let db: PrismaService;
    let repo: ReportSyncRepository;
    const sourceId = `baseline-probe-${randomUUID()}`;
    const config: SyncConfig = {
      schemaVersion: 1,
      sourceId,
      tenantId: "fixture-tenant",
      tenantSlug: "fixture",
      workspaceId: "fixture-workspace",
      mode: "paused",
      bindings: [
        { instanceName: "one", whatsappInstanceId: "one" },
        { instanceName: "two", whatsappInstanceId: "two" },
      ],
    };
    beforeAll(async () => {
      const target = new URL(url!);
      if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        !target.pathname.endsWith("_pilot")
      )
        throw new Error("disposable_database_required");
      db = new PrismaService({ datasourceUrl: url });
      repo = new ReportSyncRepository(
        db,
        new InboundWebhookPayloadEncryptionService({}),
      );
      await db.$connect();
    });
    afterAll(async () => {
      if (!db) return;
      await db.reportSyncStage.deleteMany({ where: { sourceId } });
      await db.reportSyncSource.deleteMany({ where: { id: sourceId } });
      await db.$disconnect();
    });
    it("closes the same manifest after a persisted first part changes key order", async () => {
      const entries = [
        { sourceLeadId: "lead-a", stages: ["n1", "n2"] },
        { sourceLeadId: "lead-b", stages: ["n1"] },
      ];
      const manifest = {
        entryCount: 2,
        sha256: createHash("sha256")
          .update(JSON.stringify(entries))
          .digest("hex"),
      };
      const base = {
        schemaVersion: 1,
        sourceId,
        tenantId: config.tenantId,
        baselineId: "fixture-baseline",
        cutoverAt: "2026-10-06T00:00:00.000Z",
        manifest,
      };
      await repo.baseline(
        config,
        baselineSchema.parse({
          ...base,
          part: 0,
          final: false,
          entries: [entries[0]],
        }),
      );
      const stored = await db.reportSyncSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      const parts = stored.baselineParts as Record<
        string,
        Array<Record<string, unknown>>
      >;
      expect(Object.keys(parts["0"]![0]!)).toEqual(["stages", "sourceLeadId"]);
      const final = baselineSchema.parse({
        ...base,
        part: 1,
        final: true,
        entries: [entries[1]],
      });
      expect(await repo.baseline(config, final)).toEqual({
        baselineId: base.baselineId,
        status: "complete",
        ...manifest,
      });
      expect(await repo.baseline(config, final)).toEqual({
        baselineId: base.baselineId,
        status: "complete",
        ...manifest,
      });
      expect(
        await db.reportSyncStage.count({
          where: { sourceId, status: "baseline" },
        }),
      ).toBe(3);
    }, 20000);
  },
);
