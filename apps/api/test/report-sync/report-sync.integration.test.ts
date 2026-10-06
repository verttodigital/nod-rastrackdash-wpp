import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { UazapiLabelOperationError } from "../../src/integrations/whatsapp-providers/uazapi-label-operations.service";
import { ReportSyncService } from "../../src/report-sync/report-sync.service";
import { ReportSyncRepository } from "../../src/report-sync/report-sync.repository";
import { ReportSyncController } from "../../src/report-sync/report-sync.controller";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  digest,
  intentKey,
  stageKey,
  mapping,
  type SyncIntent,
} from "../../src/report-sync/report-sync.contract";

const config = {
  schemaVersion: 1,
  sourceId: "source",
  tenantId: "tenant",
  tenantSlug: "pilot",
  workspaceId: "workspace",
  mode: "production",
  cutoverAt: "2026-10-06T00:00:00.000Z",
  bindings: [
    { instanceName: "first", whatsappInstanceId: "wa1" },
    { instanceName: "second", whatsappInstanceId: "wa2" },
  ],
};
const phone = "5511999999999";
const payload = (overrides: Partial<SyncIntent> = {}): SyncIntent => ({
  schemaVersion: 1,
  sourceId: "source",
  tenantId: "tenant",
  mode: "production",
  publication: {
    id: "pub1",
    version: 1,
    publishedAt: "2026-10-06T15:00:00.000Z",
  },
  lead: { id: "sourceLead", phone, adId: "ad", ctwaClid: "click" },
  origin: {
    instanceName: "first",
    waChatId: `${phone}@s.whatsapp.net`,
    evidenceMessageId: "m1",
  },
  finalStage: "n1",
  transitions: [
    { id: "t1", stage: "n1", occurredAt: "2026-10-06T12:34:56.789Z" },
  ],
  ...overrides,
});
function model() {
  const rows = new Map<string, any>();
  const match = (r: any, w: any): boolean =>
    Object.entries(w ?? {}).every(([k, v]: any) =>
      k === "OR"
        ? v.some((x: any) => match(r, x))
        : k === "providerDecision"
          ? r.providerDecision?.occurrenceKey === v.occurrenceKey
          : typeof v === "object" && v !== null && !(v instanceof Date)
            ? "in" in v
              ? v.in.includes(r[k])
              : "notIn" in v
                ? !v.notIn.includes(r[k])
                : "lte" in v
                  ? r[k] <= v.lte
                  : match(r, v)
            : r[k] === v,
    );
  return {
    rows,
    findUnique: vi.fn(
      async ({ where }: any) =>
        rows.get(where.id) ??
        [...rows.values()].find((r) => match(r, Object.values(where)[0])) ??
        null,
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const row = rows.get(where.id);
      if (!row) throw Error("missing");
      return row;
    }),
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      const all = [...rows.values()].filter((r) => match(r, where));
      if (orderBy?.publicationVersion)
        all.sort((a, b) => b.publicationVersion - a.publicationVersion);
      return all[0] ?? null;
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...rows.values()].filter((r) => match(r, where)),
    ),
    create: vi.fn(async ({ data }: any) => {
      const r = {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        finalLabelVerified: data.finalLabelVerified ?? false,
        attempts: 0,
      };
      rows.set(r.id, r);
      return r;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const r = rows.get(where.id);
      Object.assign(r, data);
      r.updatedAt = new Date();
      return r;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      let r = rows.get(where.id);
      if (r) Object.assign(r, update);
      else {
        r = { ...create, updatedAt: new Date() };
        rows.set(r.id, r);
      }
      return r;
    }),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
}
function harness() {
  const db: any = {
    reportSyncSource: model(),
    reportSyncIntent: model(),
    reportSyncStage: model(),
    reportSyncBinding: model(),
    reportSyncLease: model(),
    reportSyncRateLimit: model(),
    whatsappInstance: model(),
    lead: model(),
    providerConversionRuleExecution: model(),
    conversionEventLog: model(),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ version: 1, waitMs: 0 }]),
  };
  db.$transaction = async (fn: any) => fn(db);
  db.reportSyncSource.rows.set("source", {
    id: "source",
    workspaceId: "workspace",
    tenantId: "tenant",
    baselineComplete: true,
    cutoverAt: new Date(config.cutoverAt),
    activatedAt: new Date(config.cutoverAt),
  });
  db.whatsappInstance.rows.set("wa1", {
    id: "wa1",
    workspaceId: "workspace",
    provider: "uazapi_byo",
    configEncrypted: "encrypted",
    name: "first",
    providerInstanceId: "first",
  });
  db.whatsappInstance.rows.set("wa2", {
    id: "wa2",
    workspaceId: "workspace",
    provider: "uazapi_byo",
    configEncrypted: "encrypted",
    name: "second",
    providerInstanceId: "second",
  });
  db.lead.findUnique = vi.fn(async () => ({
    id: "nodLead",
    workspaceId: "workspace",
    whatsappInstanceId: "wa1",
    adId: "ad",
    ctwaClid: "click",
  }));
  for (const [i, stage] of ["n1", "n2", "agendamento"].entries())
    for (const instance of ["wa1", "wa2"])
      db.reportSyncBinding.rows.set(instance + stage, {
        id: instance + stage,
        sourceId: "source",
        workspaceId: "workspace",
        whatsappInstanceId: instance,
        stage,
        labelId: instance + "-" + i,
        providerRuleId: "rule-" + instance + "-" + i,
      });
  db.providerConversionRuleConfig = {
    findFirst: vi.fn(async ({ where }: any) => {
      const b: any = [...db.reportSyncBinding.rows.values()].find(
        (b: any) => b.providerRuleId === where.id,
      );
      const m = mapping[b.stage as keyof typeof mapping];
      return {
        requiresReportContext: true,
        conversionRule: {
          triggerType: "provider_automation",
          eventName: m.eventName,
          defaultValueCents: m.valueCents,
          defaultCurrency: m.valueCents ? "BRL" : null,
        },
        channels: [{ channel: { whatsappInstanceId: b.whatsappInstanceId } }],
      };
    }),
  };
  const env: any = {
    REPORT_SYNC_CONFIG_JSON: JSON.stringify(config),
    REPORT_SYNC_BEARER_TOKEN: "x".repeat(32),
  };
  // Encryption mocked at the boundary; production repository still freezes immutable ciphertext fields.
  const encryption = {
    encrypt: (b: Buffer) => ({
      encryptedPayload: b.toString("base64"),
      payloadIv: "iv",
      payloadTag: "tag",
      encryptionKeyVersion: 1,
    }),
    decrypt: (r: any) => Buffer.from(r.encryptedPayload, "base64"),
  } as unknown as InboundWebhookPayloadEncryptionService;
  const repo = new ReportSyncRepository(db, encryption);
  const labelState = new Set(["unrelated"]);
  const calls: string[] = [];
  const labels: any = {
    readChatLabels: vi.fn(async () => ({
      phone,
      chatId: `${phone}@s.whatsapp.net`,
      labelIds: [...labelState],
    })),
    addChatLabel: vi.fn(
      async (_w: string, _i: string, _p: string, label: string) => {
        calls.push("add:" + label);
        labelState.add(label);
      },
    ),
    removeChatLabel: vi.fn(
      async (_w: string, _i: string, _p: string, label: string) => {
        calls.push("remove:" + label);
        labelState.delete(label);
      },
    ),
  };
  const conversions: any = {
    evaluateLabels: vi.fn(async (input: any) => {
      const stage = db.reportSyncStage.rows.get(input.reportStageId);
      const id = "exec-" + stage.stage;
      db.providerConversionRuleExecution.rows.set(id, {
        id,
        status: "eligible",
        workspaceId: "workspace",
        providerRuleId: stage.providerRuleId,
        occurredAt: stage.occurredAt,
        providerDecision: { occurrenceKey: "report-sync:" + stage.id },
      });
      calls.push("decision:" + stage.stage);
    }),
    resumeReportExecution: vi.fn(async () => {}),
  };
  const service = new ReportSyncService(repo, env, labels, conversions);
  const controller = new ReportSyncController(service, env);
  return {
    db,
    repo,
    env,
    labels,
    labelState,
    calls,
    conversions,
    service,
    controller,
  };
}
describe("report sync authenticated durable vertical flow", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-10-06T16:00:00.000Z")));
  it("rejects foreign tenant and wrong token before writing an intent", async () => {
    const h = harness(),
      p = payload({ tenantId: "another" });
    await expect(h.service.accept(p, intentKey(p))).rejects.toThrow(
      "integration_scope_mismatch",
    );
    await expect(
      h.controller.accept("Bearer " + "z".repeat(32), intentKey(p), p, {
        status: vi.fn(),
      } as any),
    ).rejects.toThrow("integration_auth_required");
    expect(h.db.reportSyncIntent.rows.size).toBe(0);
  });
  it("freezes the same body and returns the same syncId, rejects a mutated republication", async () => {
    const h = harness(),
      p = payload();
    const first = await h.service.accept(p, intentKey(p));
    const again = await h.service.accept(p, intentKey(p));
    expect(again.syncId).toBe(first.syncId);
    expect(again.duplicate).toBe(true);
    await expect(
      h.service.accept({ ...p, finalStage: "n2" }, intentKey(p)),
    ).rejects.toThrow("intent_payload_conflict");
    expect(h.db.reportSyncStage.rows.size).toBe(1);
  });
  it("rejects a different timestamp for a consumed semantic stage before persisting the next publication", async () => {
    const h = harness(),
      p = payload();
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    h.db.reportSyncStage.rows.get(stageKey(config, "sourceLead", "n1")).status =
      "delivered";
    const corrected: SyncIntent = {
      ...p,
      publication: { ...p.publication, id: "pub2", version: 2 },
      transitions: [
        { ...p.transitions[0]!, occurredAt: "2026-10-06T12:45:00.000Z" },
      ],
    };
    await expect(
      h.service.accept(corrected, intentKey(corrected)),
    ).rejects.toThrow("semantic_stage_timestamp_conflict");
    expect(h.db.reportSyncIntent.rows.size).toBe(1);
  });
  it("continues reconciling N1 when a later label blocks, then exposes partial with its acknowledgement", async () => {
    const h = harness(),
      p = payload({
        finalStage: "n2",
        transitions: [
          ...payload().transitions,
          { id: "t2", stage: "n2", occurredAt: "2026-10-06T13:00:00.000Z" },
        ],
      });
    const a = await h.service.accept(p, intentKey(p));
    h.labels.addChatLabel
      .mockImplementationOnce(
        async (_w: string, _i: string, _p: string, label: string) =>
          h.labelState.add(label),
      )
      .mockRejectedValueOnce(
        new UazapiLabelOperationError("label_missing", 404, null, false),
      );
    await h.service.process(a.syncId);
    expect(h.db.reportSyncIntent.rows.get(a.syncId).status).toBe("blocked");
    expect((await h.service.result(a.syncId)).status).toBe("pending");
    expect(h.db.reportSyncIntent.rows.get(a.syncId).nextAttemptAt).toBeTruthy();
    h.db.providerConversionRuleExecution.rows.get(
      "exec-n1",
    ).conversionEventLogId = "accepted-n1";
    h.db.conversionEventLog.rows.set("accepted-n1", {
      id: "accepted-n1",
      status: "sent",
      sentAt: new Date(),
      providerResponseSummary: { events_received: 1 },
    });
    await h.service.process(a.syncId);
    const result = await h.service.result(a.syncId);
    expect(result.status).toBe("partial");
    expect(result.finalLabelVerified).toBe(false);
    expect(result.transitions[0]!.status).toBe("delivered");
  });
  it("N1 uses original milliseconds, provider success is not Meta delivery, then recognizes real ledger ack", async () => {
    const h = harness(),
      p = payload();
    const accepted = await h.service.accept(p, intentKey(p));
    await h.service.process(accepted.syncId);
    expect(h.labelState).toEqual(new Set(["unrelated", "wa1-0"]));
    expect(
      h.db.providerConversionRuleExecution.rows
        .get("exec-n1")
        .occurredAt.toISOString(),
    ).toBe(p.transitions[0]!.occurredAt);
    const waiting = await h.service.result(accepted.syncId);
    expect(waiting.status).toBe("pending");
    expect(waiting.transitions[0]!.metaAcceptedAt).toBeNull();
    h.db.providerConversionRuleExecution.rows.get(
      "exec-n1",
    ).conversionEventLogId = "event1";
    h.db.conversionEventLog.rows.set("event1", {
      id: "event1",
      status: "sent",
      providerResponseSummary: { events_received: 1 },
      sentAt: new Date(),
    });
    const final = await h.service.result(accepted.syncId);
    expect(final.status).toBe("succeeded");
    expect(final.transitions[0]!.status).toBe("delivered");
  });
  it("jump confirms each decision before next label and leaves only appointment", async () => {
    const h = harness(),
      p = payload({
        finalStage: "agendamento",
        transitions: [
          { id: "1", stage: "n1", occurredAt: "2026-10-06T11:00:00.000Z" },
          { id: "2", stage: "n2", occurredAt: "2026-10-06T12:00:00.000Z" },
          {
            id: "3",
            stage: "agendamento",
            occurredAt: "2026-10-06T13:00:00.000Z",
          },
        ],
      });
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect(h.calls.slice(0, 6)).toEqual([
      "add:wa1-0",
      "decision:n1",
      "add:wa1-1",
      "decision:n2",
      "add:wa1-2",
      "decision:agendamento",
    ]);
    expect(h.labelState).toEqual(new Set(["unrelated", "wa1-2"]));
    await h.service.process(a.syncId);
    expect(h.labels.addChatLabel).toHaveBeenCalledTimes(3);
  });
  it("already present label is read back and reconciled without remove/re-add", async () => {
    const h = harness(),
      p = payload();
    h.labelState.add("wa1-0");
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    expect(h.labels.removeChatLabel).not.toHaveBeenCalled();
    expect(h.conversions.evaluateLabels).toHaveBeenCalledOnce();
  });
  it("observation body never promotes after runtime activation", async () => {
    const h = harness(),
      p = payload({ mode: "observation" });
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect(h.db.reportSyncStage.rows.size).toBe(0);
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    expect(h.conversions.evaluateLabels).not.toHaveBeenCalled();
  });
  it.each(["origin", "attribution", "missing"])(
    "blocks %s uncertainty before any provider mutation",
    async (kind) => {
      const h = harness();
      let p = payload();
      if (kind === "origin") p = { ...p, origin: null };
      if (kind === "attribution")
        p = { ...p, lead: { ...p.lead, adId: "different" } };
      if (kind === "missing") h.db.lead.findUnique.mockResolvedValue(null);
      const a = await h.service.accept(p, intentKey(p));
      await h.service.process(a.syncId);
      expect((await h.service.result(a.syncId)).status).toBe("blocked");
      expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    },
  );
  it("second number uses its own label IDs and refuses a paid lead attributed to the first", async () => {
    const h = harness(),
      p = payload({
        origin: {
          instanceName: "second",
          waChatId: `${phone}@s.whatsapp.net`,
          evidenceMessageId: "m2",
        },
      });
    h.db.lead.findUnique.mockResolvedValue({
      id: "lead2",
      whatsappInstanceId: "wa2",
      adId: "ad",
      ctwaClid: "click",
    });
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect(h.labelState.has("wa2-0")).toBe(true);
    expect(h.labelState.has("wa1-0")).toBe(false);
  });
  it("an expired original time is ineligible and is never replaced by publish time", async () => {
    const h = harness(),
      p = payload({
        transitions: [
          { id: "old", stage: "n1", occurredAt: "2026-09-20T12:00:00.000Z" },
        ],
      });
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    const result = await h.service.result(a.syncId);
    expect(result.status).toBe("partial");
    expect(result.transitions[0]!.status).toBe("ineligible");
    expect(h.conversions.evaluateLabels).not.toHaveBeenCalled();
  });
  it("downgrade removes managed labels without emitting a new stage", async () => {
    const h = harness(),
      p = payload({ finalStage: "conversa", transitions: [] });
    h.labelState.add("wa1-2");
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect(h.labelState).toEqual(new Set(["unrelated"]));
    expect(h.conversions.evaluateLabels).not.toHaveBeenCalled();
  });
  it("missing LID mapping blocks even when the caller supplied the correct phone", async () => {
    const h = harness(),
      p = payload({
        origin: {
          instanceName: "first",
          waChatId: "unmapped@lid",
          evidenceMessageId: "m",
        },
      });
    const a = await h.service.accept(p, intentKey(p));
    await h.service.process(a.syncId);
    expect((await h.service.result(a.syncId)).reasonCode).toBe(
      "lid_mapping_required",
    );
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
  });
  it("lease contention performs no label mutation", async () => {
    const h = harness(),
      p = payload();
    const a = await h.service.accept(p, intentKey(p));
    vi.spyOn(h.repo, "acquire").mockResolvedValue(null);
    await h.service.process(a.syncId);
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    expect(h.conversions.evaluateLabels).not.toHaveBeenCalled();
  });
  it("429 Retry-After and another conversation rate backlog remain retryable", async () => {
    const h = harness(),
      p = payload();
    const accepted = await h.service.accept(p, intentKey(p));
    h.labels.readChatLabels.mockRejectedValueOnce(
      new UazapiLabelOperationError("rate_limited", 429, 120000, true),
    );
    await h.service.process(accepted.syncId);
    let result = await h.service.result(accepted.syncId);
    expect(result.status).toBe("pending");
    expect(result.nextAttemptAt!.getTime() - Date.now()).toBe(120000);
    vi.spyOn(h.repo, "reserve").mockResolvedValue(120000);
    await h.service.process(accepted.syncId);
    result = await h.service.result(accepted.syncId);
    expect(result.status).toBe("pending");
    expect(result.reasonCode).toBe("instance_rate_backlog");
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
  });
  it("a changed rule event or amount blocks before touching labels", async () => {
    const h = harness(),
      p = payload();
    h.db.providerConversionRuleConfig.findFirst.mockResolvedValue({
      requiresReportContext: true,
      conversionRule: {
        triggerType: "provider_automation",
        eventName: "Purchase",
        defaultValueCents: 10000,
        defaultCurrency: "BRL",
      },
      channels: [{ channel: { whatsappInstanceId: "wa1" } }],
    });
    const accepted = await h.service.accept(p, intentKey(p));
    await h.service.process(accepted.syncId);
    expect((await h.service.result(accepted.syncId)).reasonCode).toBe(
      "published_rule_mapping_changed",
    );
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
  });
  it("HTTP 200 without Meta events_received acknowledgement never delivers", async () => {
    const h = harness(),
      p = payload();
    const accepted = await h.service.accept(p, intentKey(p));
    await h.service.process(accepted.syncId);
    h.db.providerConversionRuleExecution.rows.get(
      "exec-n1",
    ).conversionEventLogId = "empty-ack";
    h.db.conversionEventLog.rows.set("empty-ack", {
      id: "empty-ack",
      status: "sent",
      sentAt: new Date(),
      providerResponseSummary: {},
    });
    const result = await h.service.result(accepted.syncId);
    expect(result.status).toBe("pending");
    expect(result.transitions[0]!.metaAcceptedAt).toBeNull();
    expect(result.transitions[0]!.reasonCode).toBe(
      "meta_acknowledgement_missing",
    );
  });
  it("recovers a missing delivery job only while active and below the persistent request budget", async () => {
    const h = harness(),
      p = payload();
    const accepted = await h.service.accept(p, intentKey(p));
    await h.service.process(accepted.syncId);
    const stage = h.db.reportSyncStage.rows.get(
      stageKey(config, "sourceLead", "n1"),
    );
    stage.deliveryAttempts = 2;
    h.db.providerConversionRuleExecution.rows.get("exec-n1").status =
      "materialized";
    h.db.providerConversionRuleExecution.rows.get(
      "exec-n1",
    ).conversionEventLogId = "paused-event";
    h.db.conversionEventLog.rows.set("paused-event", {
      id: "paused-event",
      status: "error",
      errorCode: "MetaCapiNetworkError",
    });
    const queue: any = {
      getJob: vi.fn(async () => null),
      add: vi.fn(async () => ({ id: "job" })),
    };
    const service = new ReportSyncService(
      h.repo,
      h.env,
      h.labels,
      h.conversions,
      queue,
    );
    h.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify({
      ...config,
      mode: "paused",
    });
    await service.result(accepted.syncId);
    expect(queue.add).not.toHaveBeenCalled();
    h.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify(config);
    await service.result(accepted.syncId);
    expect(queue.add).toHaveBeenCalledOnce();
    stage.deliveryAttempts = 3;
    expect((await service.result(accepted.syncId)).status).toBe("partial");
    expect(queue.add).toHaveBeenCalledOnce();
    expect(stage.status).toBe("failed");
  });
  it("baseline manifest is verified and consumes prior stages without labels", async () => {
    const h = harness();
    h.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify({
      ...config,
      mode: "paused",
    });
    Object.assign(h.db.reportSyncSource.rows.get("source"), {
      activatedAt: null,
      baselineComplete: false,
      baselineParts: {},
    });
    const entries = [{ sourceLeadId: "oldLead", stages: ["n1", "n2"] }];
    const manifest = {
      entryCount: 1,
      sha256: createHash("sha256")
        .update(JSON.stringify(entries))
        .digest("hex"),
    };
    const part = {
      schemaVersion: 1,
      sourceId: "source",
      tenantId: "tenant",
      baselineId: "base",
      cutoverAt: config.cutoverAt,
      part: 0,
      final: true,
      manifest,
      entries,
    };
    expect((await h.service.baseline(part)).status).toBe("complete");
    expect(h.db.reportSyncStage.rows.size).toBe(2);
    expect(
      [...h.db.reportSyncStage.rows.values()].every(
        (s) => s.status === "baseline",
      ),
    ).toBe(true);
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    await expect(
      h.service.baseline({
        ...part,
        entries: [{ sourceLeadId: "changed", stages: ["n1"] }],
      }),
    ).rejects.toThrow("baseline_part_conflict");
  });
  it("multipart baseline preserves manifest hash after JSONB reorders persisted entry keys", async () => {
    const h = harness();
    h.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify({
      ...config,
      mode: "paused",
    });
    const source = h.db.reportSyncSource.rows.get("source");
    Object.assign(source, {
      activatedAt: null,
      baselineComplete: false,
      baselineParts: {},
    });
    const entries = [
      { sourceLeadId: "lead-a", stages: ["n1", "n2"] },
      { sourceLeadId: "lead-b", stages: ["n1"] },
    ];
    const manifest = {
      entryCount: entries.length,
      sha256: createHash("sha256")
        .update(JSON.stringify(entries))
        .digest("hex"),
    };
    const base = {
      schemaVersion: 1,
      sourceId: "source",
      tenantId: "tenant",
      baselineId: "multipart",
      cutoverAt: config.cutoverAt,
      manifest,
    };
    expect(
      (
        await h.service.baseline({
          ...base,
          part: 0,
          final: false,
          entries: [entries[0]],
        })
      ).status,
    ).toBe("receiving");
    // PostgreSQL JSONB returns shorter property names first; the stored part
    // no longer has the insertion order of the HTTP payload.
    source.baselineParts = JSON.parse(
      JSON.stringify({
        "0": [{ stages: ["n1", "n2"], sourceLeadId: "lead-a" }],
      }),
    );
    expect(Object.keys(source.baselineParts["0"][0])).toEqual([
      "stages",
      "sourceLeadId",
    ]);
    const final = { ...base, part: 1, final: true, entries: [entries[1]] };
    expect(await h.service.baseline(final)).toEqual({
      baselineId: "multipart",
      status: "complete",
      ...manifest,
    });
    expect(h.db.reportSyncStage.rows.size).toBe(3);
    expect(await h.service.baseline(final)).toEqual({
      baselineId: "multipart",
      status: "complete",
      ...manifest,
    });
    expect(h.labels.addChatLabel).not.toHaveBeenCalled();
    expect(h.conversions.evaluateLabels).not.toHaveBeenCalled();
  });
  it("crash recovery after the first decision does not reapply the first tag", async () => {
    const h = harness(),
      p = payload({
        finalStage: "n2",
        transitions: [
          ...payload().transitions,
          { id: "t2", stage: "n2", occurredAt: "2026-10-06T13:00:00.000Z" },
        ],
      });
    const a = await h.service.accept(p, intentKey(p));
    h.labels.addChatLabel
      .mockImplementationOnce(
        async (_w: string, _i: string, _p: string, label: string) =>
          h.labelState.add(label),
      )
      .mockRejectedValueOnce(new Error("connection_lost"));
    await h.service.process(a.syncId);
    expect(
      h.db.reportSyncStage.rows.get(stageKey(config, "sourceLead", "n1"))
        .executionId,
    ).toBe("exec-n1");
    h.labels.addChatLabel.mockImplementation(
      async (_w: string, _i: string, _p: string, label: string) =>
        h.labelState.add(label),
    );
    await h.service.process(a.syncId);
    expect(
      h.conversions.evaluateLabels.mock.calls.filter(
        ([i]: any) => i.reportStageId === stageKey(config, "sourceLead", "n1"),
      ),
    ).toHaveLength(1);
    expect(h.labelState).toEqual(new Set(["unrelated", "wa1-1"]));
  });
});
