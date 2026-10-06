import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";

const stageId = "a".repeat(64);
const occurredAt = new Date("2026-10-06T10:00:00Z");
const config = {
  schemaVersion: 1,
  sourceId: "source",
  tenantId: "tenant",
  tenantSlug: "pilot",
  workspaceId: "workspace",
  mode: "production",
  cutoverAt: "2026-10-06T09:00:00Z",
  bindings: [
    { instanceName: "one", whatsappInstanceId: "one" },
    { instanceName: "two", whatsappInstanceId: "two" },
  ],
};
function fixture() {
  const env = { REPORT_SYNC_CONFIG_JSON: JSON.stringify(config) };
  const log: any = {
    id: "event",
    workspaceId: "workspace",
    externalConnectorId: null,
    eventId: "immutable-event",
    status: "ready_to_send",
    eventName: "InitiateCheckout",
    eventOccurredAt: occurredAt,
    sourcePayload: {
      occurrenceKey: `report-sync:${stageId}`,
      providerConversionExecutionId: "execution",
      providerRuleId: "rule",
    },
    phoneHash: "hash",
    adId: "ad",
    ctwaClid: "ctwa",
    valueCents: 10000,
    currency: "BRL",
    valueSource: "configured_average",
    errorCode: null,
  };
  const stage: any = {
    id: stageId,
    sourceId: "source",
    tenantId: "tenant",
    workspaceId: "workspace",
    whatsappInstanceId: "one",
    providerRuleId: "rule",
    executionId: "execution",
    occurredAt,
    status: "awaiting_meta",
    stage: "agendamento",
    contactKey: "hash",
  };
  const rule: any = {
    id: "rule",
    workspaceId: "workspace",
    requiresReportContext: true,
    mode: "production",
    removedAt: null,
    conversionRule: {
      active: true,
      triggerType: "provider_automation",
      eventName: "InitiateCheckout",
      defaultValueCents: 10000,
      defaultCurrency: "BRL",
    },
  };
  const execution: any = {
    id: "execution",
    workspaceId: "workspace",
    providerRuleId: "rule",
    conversionEventLogId: "event",
    occurredAt,
    status: "materialized",
    providerRule: rule,
  };
  const db: any = {
    conversionEventLog: {
      findUnique: vi.fn(async () => ({ ...log })),
      update: vi.fn(async ({ data }: any) => Object.assign(log, data)),
      updateMany: vi.fn(async ({ data }: any) => {
        Object.assign(log, data);
        return { count: 1 };
      }),
    },
    reportSyncStage: {
      findUnique: vi.fn(async () => stage),
      updateMany: vi.fn(async ({ data }: any) => {
        if (data.status) {
          Object.assign(stage, data);
          return { count: 1 };
        }
        if ((stage.deliveryAttempts ?? 0) >= 3) return { count: 0 };
        stage.deliveryAttempts = (stage.deliveryAttempts ?? 0) + 1;
        return { count: 1 };
      }),
    },
    reportSyncSource: {
      findUnique: vi.fn(async () => ({
        id: "source",
        workspaceId: "workspace",
        tenantId: "tenant",
        baselineComplete: true,
        cutoverAt: new Date(config.cutoverAt),
      })),
    },
    reportSyncBinding: {
      findFirst: vi.fn(async () => ({
        sourceId: "source",
        workspaceId: "workspace",
        whatsappInstanceId: "one",
        stage: "agendamento",
        providerRuleId: "rule",
      })),
    },
    providerConversionRuleExecution: {
      findFirst: vi.fn(async () => execution),
    },
  };
  const sendEvent = vi.fn().mockResolvedValue({
    status: "sent",
    requestPayload: { data: [] },
    responseSummary: { events_received: 1 },
    errorCode: null,
    errorMessage: null,
  });
  const service = new ConversionEventsService(
    db,
    { sendEvent } as never,
    {} as never,
    undefined,
    env,
  );
  vi.spyOn(service as any, "resolveDeliveryRoute").mockResolvedValue({
    source: "manual",
    accessToken: "not-real",
    pixelId: "pixel",
    pageId: "page",
    routeError: null,
  });
  vi.spyOn(service as any, "recordMetaCapiIntegrationLog").mockResolvedValue(
    "integration-log",
  );
  vi.spyOn(service as any, "syncProviderConversionDelivery").mockResolvedValue(
    undefined,
  );
  vi.spyOn(service as any, "recordMetaCapiDiagnosticEvent").mockResolvedValue(
    undefined,
  );
  db.purchaseReview = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
  return { service, sendEvent, env, log, stage, execution, rule, db };
}
describe("published-report Meta delivery boundary", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-06T12:00:00Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each(["expired", "future"])(
    "rejects %s original date without consuming delivery budget",
    async (kind) => {
      const f = fixture();
      const now =
        kind === "expired"
          ? occurredAt.getTime() + 7 * 86400000 + 1
          : occurredAt.getTime() - 1;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        expect((await f.service.sendReadyEvent("event")).status).toBe(
          "skipped",
        );
        expect(f.stage).toMatchObject({
          status: "ineligible",
          reasonCode: "original_event_outside_window",
        });
        expect(f.stage.deliveryAttempts ?? 0).toBe(0);
        expect(f.sendEvent).not.toHaveBeenCalled();
        expect(f.log.eventOccurredAt).toBe(occurredAt);
      } finally {
        clock.mockRestore();
      }
    },
  );
  it("enforces three persisted requests even when the queue job is recreated", async () => {
    const f = fixture();
    f.sendEvent.mockResolvedValue({
      status: "error",
      requestPayload: null,
      responseSummary: null,
      errorCode: "MetaCapiNetworkError",
      errorMessage: "retry",
    });
    for (let i = 0; i < 4; i++) await f.service.sendReadyEvent("event");
    expect(f.sendEvent).toHaveBeenCalledTimes(3);
    expect(f.stage.deliveryAttempts).toBe(3);
  });
  it("does not consume retry budget during a pause and resumes the same event", async () => {
    const f = fixture();
    f.log.status = "error";
    f.log.errorCode = "MetaCapiNetworkError";
    f.stage.deliveryAttempts = 1;
    f.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify({
      ...config,
      mode: "paused",
    });
    await f.service.sendReadyEvent("event");
    expect(f.stage.deliveryAttempts).toBe(1);
    f.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify(config);
    expect((await f.service.sendReadyEvent("event")).status).toBe("sent");
    expect(f.stage.deliveryAttempts).toBe(2);
  });
  it("retries network failure with the identical event ID and original date", async () => {
    const f = fixture();
    f.sendEvent.mockResolvedValueOnce({
      status: "error",
      requestPayload: null,
      responseSummary: null,
      errorCode: "MetaCapiNetworkError",
      errorMessage: "network failed",
    });
    expect((await f.service.sendReadyEvent("event")).status).toBe("error");
    expect((await f.service.sendReadyEvent("event")).status).toBe("sent");
    expect(f.sendEvent).toHaveBeenCalledTimes(2);
    for (const [arg] of f.sendEvent.mock.calls)
      expect(arg).toMatchObject({
        dedupeKey: "immutable-event",
        eventTime: occurredAt,
        valueCents: 10000,
        currency: "BRL",
      });
  });
  it.each(["paused", "observation", "disabled"])(
    "does not send or terminalize when %s",
    async (mode) => {
      const f = fixture();
      f.env.REPORT_SYNC_CONFIG_JSON =
        mode === "disabled" ? "" : JSON.stringify({ ...config, mode });
      expect((await f.service.sendReadyEvent("event")).status).toBe("skipped");
      expect(f.sendEvent).not.toHaveBeenCalled();
      expect(f.log.status).toBe("ready_to_send");
    },
  );
  it("rechecks pause after asynchronous route lookup", async () => {
    const f = fixture();
    vi.spyOn(f.service as any, "resolveDeliveryRoute").mockImplementation(
      async () => {
        f.env.REPORT_SYNC_CONFIG_JSON = JSON.stringify({
          ...config,
          mode: "paused",
        });
        return { source: "manual", routeError: null };
      },
    );
    await f.service.sendReadyEvent("event");
    expect(f.sendEvent).not.toHaveBeenCalled();
  });
  it.each([{}, { events_received: 0 }, { events_received: "1" }])(
    "requires positive numeric Meta acknowledgement %j",
    async (responseSummary) => {
      const f = fixture();
      f.sendEvent.mockResolvedValueOnce({
        status: "sent",
        requestPayload: { data: [] },
        responseSummary,
        errorCode: null,
        errorMessage: null,
      });
      expect(await f.service.sendReadyEvent("event")).toMatchObject({
        status: "error",
        errorCode: "MetaCapiNetworkError",
      });
      expect(f.log.sentAt).toBeNull();
      expect((await f.service.sendReadyEvent("event")).status).toBe("sent");
    },
  );
  it.each([
    "value",
    "timestamp",
    "scope",
    "marker",
    "stage",
    "trigger",
    "inactive",
    "rule-mode",
  ])("blocks invalid immutable context: %s", async (field) => {
    const f = fixture();
    if (field === "value") f.log.valueCents = 20000;
    if (field === "timestamp")
      f.stage.occurredAt = new Date("2026-10-06T10:01:00Z");
    if (field === "scope") f.stage.tenantId = "other";
    if (field === "marker") f.rule.requiresReportContext = false;
    if (field === "stage") f.stage.status = "baseline";
    if (field === "trigger")
      f.rule.conversionRule.triggerType = "message_phrase";
    if (field === "inactive") f.rule.conversionRule.active = false;
    if (field === "rule-mode") f.rule.mode = "observation";
    await f.service.sendReadyEvent("event");
    expect(f.sendEvent).not.toHaveBeenCalled();
  });
  it("preserves other clients' response and retry behavior without report lookups", async () => {
    const f = fixture();
    f.log.sourcePayload = { occurrenceKey: "generic-event" };
    f.sendEvent.mockResolvedValueOnce({
      status: "sent",
      requestPayload: null,
      responseSummary: {},
      errorCode: null,
      errorMessage: null,
    });
    expect((await f.service.sendReadyEvent("event")).status).toBe("sent");
    expect(f.db.reportSyncStage.findUnique).not.toHaveBeenCalled();
    f.log.status = "error";
    f.log.errorCode = "MetaCapiNetworkError";
    expect((await f.service.sendReadyEvent("event")).status).toBe("skipped");
    expect(f.sendEvent).toHaveBeenCalledTimes(1);
  });
});
