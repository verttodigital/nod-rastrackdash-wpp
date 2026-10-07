import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { UazapiLabelOperationsService } from "../../src/integrations/whatsapp-providers/uazapi-label-operations.service";
import { UazapiProviderConversionService } from "../../src/inbound-webhooks/uazapi-provider-conversion.service";

function fixture(previous: string[] = []) {
  const db: any = {
    whatsappInstance: {
      findFirst: vi.fn(async () => ({
        configEncrypted: "encrypted",
        configIv: "iv",
        configTag: "tag",
      })),
    },
    uazapiChatLabelState: {
      findUnique: vi.fn(async () => ({ labelIds: previous })),
      upsert: vi.fn(async () => ({})),
    },
    providerConversionRuleConfig: { findMany: vi.fn(async () => []) },
    inboundWebhookChannel: {
      findFirst: vi.fn(async () => ({ status: "active" })),
    },
    reportSyncStage: { findMany: vi.fn(async () => []) },
  };
  const env = {
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_CONVERSION_RULES_ENABLED: "true",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    REPORT_SYNC_CONFIG_JSON: JSON.stringify({
      schemaVersion: 1,
      sourceId: "source",
      tenantId: "tenant",
      tenantSlug: "pilot",
      workspaceId: "workspace",
      mode: "production",
      cutoverAt: "2026-10-06T00:00:00.000Z",
      bindings: [
        { instanceName: "first", whatsappInstanceId: "instance" },
        { instanceName: "second", whatsappInstanceId: "other" },
      ],
    }),
  };
  const fetchImpl = vi.fn(async () =>
    Response.json([{ id: "5511777777777:10", labelid: "10", name: "N1" }]),
  );
  const labels = new UazapiLabelOperationsService(
    db,
    {
      decrypt: () =>
        JSON.stringify({
          provider: "uazapi_byo",
          config: {
            baseUrl: "https://connection.example.test",
            token: "scoped",
          },
        }),
    } as any,
    fetchImpl,
  );
  const bridge = {
    ensureBridge: vi.fn(async () => ({
      connectionId: "connection",
      channelId: "channel",
    })),
  };
  const service = new UazapiProviderConversionService(
    db,
    env,
    bridge as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    labels,
  );
  const input = {
    workspaceId: "workspace",
    instance: {
      id: "instance",
      workspaceId: "workspace",
      name: "first",
      providerInstanceId: "provider",
      provider: "uazapi_byo",
    },
    phone: "5511999999999",
    labelIds: ["5511777777777:10"],
    waChatId: "5511999999999@s.whatsapp.net",
  };
  return { db, service, bridge, input, fetchImpl };
}
describe("compound Uazapi labels across report and webhook paths", () => {
  it("does not match an unresolved foreign membership against a local short ID", () => {
    const h = fixture();
    const rule = {
      messageTriggerPhrases: [],
      conversionRule: {
        defaultItems: { uazapiLabels: [{ name: "N1", matchKeys: ["10"] }] },
      },
    };
    expect(
      (h.service as any).matchLabels(
        rule,
        ["5511666666666:10"],
        [{ name: "N1", keys: ["10"] }],
        true,
      ),
    ).toBeNull();
    expect(
      (h.service as any).matchLabels(
        rule,
        ["10"],
        [{ name: "N1", keys: ["10"] }],
        true,
      ),
    ).toMatchObject({ id: "10" });
  });
  it("preserves other providers' label contracts without using BYO credentials", async () => {
    const h = fixture();
    await h.service.evaluateLabels({
      ...h.input,
      instance: { ...h.input.instance, provider: "nod_api" },
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(
      h.db.uazapiChatLabelState.upsert.mock.calls[0][0].update.labelIds,
    ).toEqual(h.input.labelIds);
  });
  it("fences and paces both incoming and previously persisted alias lookups", async () => {
    const h = fixture(["5511777777777:10"]);
    const callsAtHooks: number[] = [];
    await h.service.evaluateLabels({
      ...h.input,
      beforeLabelRequest: async () => {
        callsAtHooks.push(h.fetchImpl.mock.calls.length);
      },
    });
    expect(callsAtHooks).toEqual([0, 1]);
    expect(h.bridge.ensureBridge).not.toHaveBeenCalled();
  });
  it("does not request a catalog or consume membership after fencing fails", async () => {
    const h = fixture();
    await expect(
      h.service.evaluateLabels({
        ...h.input,
        beforeLabelRequest: async () => {
          throw new Error("conversation_lease_lost");
        },
      }),
    ).rejects.toThrow("conversation_lease_lost");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.db.uazapiChatLabelState.upsert).not.toHaveBeenCalled();
  });
  it("stores the connection's canonical membership while preserving foreign labels", async () => {
    const h = fixture();
    await h.service.evaluateLabels({
      ...h.input,
      labelIds: [...h.input.labelIds, "5511666666666:10", "external"],
    });
    expect(
      h.db.uazapiChatLabelState.upsert.mock.calls[0][0].update.labelIds,
    ).toEqual(["10", "5511666666666:10", "external"]);
  });
  it("does not invent a new delta for an already stored compound membership", async () => {
    const h = fixture(["5511777777777:10"]);
    await h.service.evaluateLabels({ ...h.input, labelIds: ["10"] });
    expect(h.bridge.ensureBridge).not.toHaveBeenCalled();
  });
  it("finds persisted publication context using the canonical label ID", async () => {
    const h = fixture();
    await h.service.evaluatePublishedLabels(h.input);
    expect(
      h.db.reportSyncStage.findMany.mock.calls[0][0].where.labelId,
    ).toEqual({ in: ["10"] });
    expect(
      h.db.reportSyncStage.findMany.mock.calls[0][0].where.whatsappInstanceId,
    ).toBe("instance");
  });
});
