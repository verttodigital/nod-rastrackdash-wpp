import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma, type ReportSyncIntent } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  canonical,
  canonicalIntent,
  digest,
  intentKey,
  stageKey,
  stages,
  type SyncConfig,
  type SyncIntent,
  type BaselinePart,
} from "./report-sync.contract";

@Injectable()
export class ReportSyncRepository {
  constructor(
    @Inject(PrismaService) readonly db: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
  ) {}

  async sourceLock(tx: Prisma.TransactionClient, sourceId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-sync:${sourceId}`}, 0))`;
  }
  async assertSource(tx: Prisma.TransactionClient, c: SyncConfig) {
    await this.sourceLock(tx, c.sourceId);
    const source = await tx.reportSyncSource.upsert({
      where: { id: c.sourceId },
      create: {
        id: c.sourceId,
        workspaceId: c.workspaceId,
        tenantId: c.tenantId,
      },
      update: {},
    });
    if (source.workspaceId !== c.workspaceId || source.tenantId !== c.tenantId)
      throw new ConflictException("source_scope_changed");
    if (
      source.activatedAt &&
      source.cutoverAt?.toISOString() !==
        new Date(c.cutoverAt ?? 0).toISOString()
    )
      throw new ConflictException("cutover_immutable");
    if (c.mode === "production") {
      if (
        !source.baselineComplete ||
        !source.cutoverAt ||
        source.cutoverAt.toISOString() !== new Date(c.cutoverAt!).toISOString()
      )
        throw new ConflictException("baseline_required");
      if (!source.activatedAt)
        await tx.reportSyncSource.update({
          where: { id: c.sourceId },
          data: { activatedAt: new Date() },
        });
    }
    return source;
  }
  async accept(c: SyncConfig, raw: SyncIntent) {
    const body = canonicalIntent(raw),
      id = intentKey(body),
      payloadHash = digest(body);
    return this.db.$transaction(async (tx) => {
      await this.assertSource(tx, c);
      const existing = await tx.reportSyncIntent.findUnique({ where: { id } });
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ConflictException("intent_payload_conflict");
        return { row: existing, duplicate: true };
      }
      if (body.mode === "production")
        for (const transition of body.transitions) {
          const consumed = await tx.reportSyncStage.findUnique({
            where: { id: stageKey(c, body.lead.id, transition.stage) },
          });
          if (
            consumed?.occurredAt &&
            consumed.occurredAt.getTime() !== Date.parse(transition.occurredAt)
          )
            throw new ConflictException("semantic_stage_timestamp_conflict");
        }
      const encrypted = this.encryption.encrypt(Buffer.from(canonical(body)), {
        workspaceId: c.workspaceId,
        connectionId: c.sourceId,
        deliveryId: id,
      });
      const row = await tx.reportSyncIntent.create({
        data: {
          id,
          sourceId: c.sourceId,
          workspaceId: c.workspaceId,
          tenantId: c.tenantId,
          publicationId: body.publication.id,
          publicationVersion: body.publication.version,
          sourceLeadId: body.lead.id,
          payloadHash,
          ...encrypted,
          mode: body.mode,
          status:
            body.mode === "observation"
              ? "observed"
              : c.mode === "paused"
                ? "paused"
                : c.mode === "observation"
                  ? "blocked"
                  : "pending",
          reasonCode:
            body.mode === "production" && c.mode === "observation"
              ? "mode_mismatch"
              : null,
        },
      });
      // Observation never consumes semantic stages and cannot be promoted later.
      if (body.mode === "production" && c.mode !== "observation")
        for (const transition of body.transitions) {
          await tx.reportSyncStage.upsert({
            where: { id: stageKey(c, body.lead.id, transition.stage) },
            update: {},
            create: {
              id: stageKey(c, body.lead.id, transition.stage),
              sourceId: c.sourceId,
              workspaceId: c.workspaceId,
              tenantId: c.tenantId,
              sourceLeadId: body.lead.id,
              stage: transition.stage,
              occurredAt: new Date(transition.occurredAt),
              intentId: id,
              status:
                c.cutoverAt &&
                Date.parse(transition.occurredAt) <= Date.parse(c.cutoverAt)
                  ? "ineligible"
                  : "pending",
              reasonCode:
                c.cutoverAt &&
                Date.parse(transition.occurredAt) <= Date.parse(c.cutoverAt)
                  ? "before_cutover"
                  : null,
            },
          });
        }
      return { row, duplicate: false };
    });
  }
  decode(row: ReportSyncIntent): SyncIntent {
    return JSON.parse(
      this.encryption
        .decrypt(row, {
          workspaceId: row.workspaceId,
          connectionId: row.sourceId,
          deliveryId: row.id,
        })
        .toString("utf8"),
    ) as SyncIntent;
  }
  async baseline(c: SyncConfig, part: BaselinePart) {
    if (c.mode === "production")
      throw new ConflictException("baseline_production_forbidden");
    return this.db.$transaction(
      async (tx) => {
        const source = await this.assertSource(tx, c);
        if (source.baselineId && source.baselineId !== part.baselineId)
          throw new ConflictException("baseline_immutable");
        if (
          source.cutoverAt &&
          source.cutoverAt.toISOString() !==
            new Date(part.cutoverAt).toISOString()
        )
          throw new ConflictException("cutover_immutable");
        if (
          source.baselineManifest &&
          canonical(source.baselineManifest) !== canonical(part.manifest)
        )
          throw new ConflictException("baseline_manifest_conflict");
        const parts = (source.baselineParts ?? {}) as Record<
          string,
          BaselinePart["entries"]
        >;
        if (
          parts[String(part.part)] &&
          canonical(parts[String(part.part)]) !== canonical(part.entries)
        )
          throw new ConflictException("baseline_part_conflict");
        if (source.baselineComplete)
          return {
            baselineId: part.baselineId,
            status: "complete",
            ...part.manifest,
          };
        parts[String(part.part)] = part.entries;
        if (part.final) {
          if (
            Object.keys(parts).length !== part.part + 1 ||
            Array.from(
              { length: part.part + 1 },
              (_, i) => parts[String(i)],
            ).some((p) => !p)
          )
            throw new ConflictException("baseline_parts_missing");
          const entries = Object.values(parts)
            .flat()
            .map((e) => ({
              ...e,
              stages: [...new Set(e.stages)].sort(
                (a, b) => stages.indexOf(a) - stages.indexOf(b),
              ),
            }))
            .sort((a, b) => a.sourceLeadId.localeCompare(b.sourceLeadId));
          const hash = createHash("sha256")
            .update(JSON.stringify(entries))
            .digest("hex");
          if (
            entries.length !== part.manifest.entryCount ||
            new Set(entries.map((e) => e.sourceLeadId)).size !==
              entries.length ||
            hash !== part.manifest.sha256
          )
            throw new ConflictException("baseline_manifest_mismatch");
          for (const entry of entries)
            for (const stage of entry.stages) {
              const id = stageKey(c, entry.sourceLeadId, stage);
              const existing = await tx.reportSyncStage.findUnique({
                where: { id },
              });
              if (existing && existing.status !== "baseline")
                throw new ConflictException("baseline_stage_already_active");
              await tx.reportSyncStage.upsert({
                where: { id },
                update: {},
                create: {
                  id,
                  sourceId: c.sourceId,
                  workspaceId: c.workspaceId,
                  tenantId: c.tenantId,
                  sourceLeadId: entry.sourceLeadId,
                  stage,
                  status: "baseline",
                },
              });
            }
        }
        await tx.reportSyncSource.update({
          where: { id: c.sourceId },
          data: {
            baselineId: part.baselineId,
            cutoverAt: new Date(part.cutoverAt),
            baselineManifest: part.manifest,
            baselineParts: parts as Prisma.InputJsonValue,
            baselineComplete: part.final,
          },
        });
        return {
          baselineId: part.baselineId,
          status: part.final ? "complete" : "receiving",
          ...part.manifest,
        };
      },
      { timeout: 60000 },
    );
  }
  async acquire(key: string) {
    const owner = randomUUID();
    const rows = await this.db.$queryRaw<
      Array<{ version: number }>
    >`INSERT INTO "ReportSyncLease" (id,owner,"expiresAt",version) VALUES (${key},${owner},NOW()+INTERVAL '2 minutes',1)
      ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,"expiresAt"=EXCLUDED."expiresAt",version="ReportSyncLease".version+1
      WHERE "ReportSyncLease"."expiresAt"<NOW() RETURNING version`;
    return rows[0] ? { key, owner, version: rows[0].version } : null;
  }
  async fence(lease: { key: string; owner: string; version: number }) {
    const count = await this.db
      .$executeRaw`UPDATE "ReportSyncLease" SET "expiresAt"=NOW()+INTERVAL '2 minutes' WHERE id=${lease.key} AND owner=${lease.owner} AND version=${lease.version} AND "expiresAt">NOW()`;
    if (count !== 1) throw new Error("conversation_lease_lost");
  }
  async release(lease: { key: string; owner: string; version: number }) {
    await this.db.reportSyncLease.deleteMany({
      where: { id: lease.key, owner: lease.owner, version: lease.version },
    });
  }
  async reserve(instanceId: string, delayMs = 1000) {
    const rows = await this.db.$queryRaw<
      Array<{ waitMs: number }>
    >`INSERT INTO "ReportSyncRateLimit" (id,"nextAt") VALUES (${instanceId},NOW()+(${delayMs}*INTERVAL '1 millisecond'))
      ON CONFLICT(id) DO UPDATE SET "nextAt"=GREATEST("ReportSyncRateLimit"."nextAt",NOW())+(${delayMs}*INTERVAL '1 millisecond')
      RETURNING GREATEST(0, EXTRACT(EPOCH FROM ("nextAt"-NOW()))*1000-${delayMs})::integer AS "waitMs"`;
    return rows[0]?.waitMs ?? 0;
  }
}
