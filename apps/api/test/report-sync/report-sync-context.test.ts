import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UazapiProviderConversionService } from "../../src/inbound-webhooks/uazapi-provider-conversion.service";

describe("context required rules are not generic manual label rules", () => {
  it("a manual label delta cannot evaluate or enqueue a publication-only rule", async () => {
    const engine = { evaluate: vi.fn() },
      queue = { enqueueProviderConversion: vi.fn() };
    const db: any = {
      uazapiChatLabelState: {
        findUnique: vi.fn(async () => ({ labelIds: [] })),
        upsert: vi.fn(async () => ({})),
      },
      providerConversionRuleConfig: {
        findMany: vi.fn(async () => [
          { id: "rule", requiresReportContext: true },
        ]),
      },
      inboundWebhookChannel: {
        findFirst: vi.fn(async () => ({
          status: "active",
          productionActivatedAt: new Date(0),
        })),
      },
    };
    const env = {
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_CONVERSION_RULES_ENABLED: "true",
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
      API_PUBLIC_URL: "https://api.example.test",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    const service = new UazapiProviderConversionService(
      db,
      env,
      {
        ensureBridge: vi.fn(async () => ({
          connectionId: "source",
          channelId: "channel",
        })),
      } as any,
      engine as any,
      {} as any,
      {} as any,
      { resolve: vi.fn(async () => ({ status: "resolved" })) } as any,
      queue as any,
      {} as any,
      {} as any,
    );
    vi.spyOn(service as any, "listLabelCatalog").mockResolvedValue([
      { name: "N1", keys: ["10"] },
    ]);
    const result = await service.evaluateLabels({
      workspaceId: "workspace",
      instance: {
        id: "instance",
        workspaceId: "workspace",
        name: "wa",
        providerInstanceId: "provider",
      },
      phone: "5511999999999",
      labelIds: ["10"],
    });
    expect(result.evaluated).toBe(false);
    expect(engine.evaluate).not.toHaveBeenCalled();
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();
  });
  it("inventing an internal stage ID still fails with no active configured source", async () => {
    const db: any = {
      uazapiChatLabelState: {
        findUnique: vi.fn(async () => ({ labelIds: [] })),
        upsert: vi.fn(async () => ({})),
      },
      providerConversionRuleConfig: {
        findMany: vi.fn(async () => [
          { id: "rule", requiresReportContext: true },
        ]),
      },
      inboundWebhookChannel: {
        findFirst: vi.fn(async () => ({ status: "active" })),
      },
    };
    const env = {
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_CONVERSION_RULES_ENABLED: "true",
      API_PUBLIC_URL: "https://api.example.test",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    const engine = { evaluate: vi.fn() };
    const service = new UazapiProviderConversionService(
      db,
      env,
      {
        ensureBridge: vi.fn(async () => ({
          connectionId: "source",
          channelId: "channel",
        })),
      } as any,
      engine as any,
      {} as any,
      {} as any,
      { resolve: vi.fn(async () => ({ status: "resolved" })) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const result = await service.evaluateLabels({
      workspaceId: "workspace",
      instance: {
        id: "instance",
        workspaceId: "workspace",
        name: "wa",
        providerInstanceId: "provider",
      },
      phone: "5511999999999",
      labelIds: ["10"],
      reportStageId: "untrusted",
    });
    expect(result.evaluated).toBe(false);
    expect(engine.evaluate).not.toHaveBeenCalled();
  });
});
