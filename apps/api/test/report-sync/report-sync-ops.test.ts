import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ReportSyncOps } from "../../src/report-sync/report-sync-ops";
import { UazapiLabelOperationError } from "../../src/integrations/whatsapp-providers/uazapi-label-operations.service";
const config = {
  schemaVersion: 1,
  sourceId: "source",
  tenantId: "tenant",
  tenantSlug: "pilot",
  workspaceId: "workspace",
  mode: "observation",
  bindings: [
    { instanceName: "first", whatsappInstanceId: "a" },
    { instanceName: "second", whatsappInstanceId: "b" },
  ],
};
function setup(mode = "observation", existingCount = 0) {
  const bindings = Array.from({ length: existingCount }, (_, i) => ({
    id: String(i),
    whatsappInstanceId: i < 3 ? "a" : "b",
    stage: ["n1", "n2", "agendamento"][i % 3],
  }));
  const db: any = {
    whatsappInstance: {
      findMany: vi.fn(async () => [
        { id: "a", configEncrypted: "encrypted" },
        { id: "b", configEncrypted: "encrypted" },
      ]),
    },
    reportSyncBinding: { findMany: vi.fn(async () => bindings) },
    inboundWebhookConnection: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "connection",
        parserReleaseId: "parser",
      })),
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  const repo: any = {
    db,
    assertSource: vi.fn(async () => ({})),
    reserve: vi.fn(async () => 0),
    acquire: vi.fn(async (key: string) => ({
      key,
      owner: "owner",
      version: 1,
    })),
    fence: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const bridge: any = {
    ensureBridge: vi.fn(async () => ({
      connectionId: "connection",
      channelId: "channel",
    })),
  };
  const labels: any = { ensureCatalogLabel: vi.fn() };
  const ops = new ReportSyncOps(
    repo,
    {
      REPORT_SYNC_CONFIG_JSON: JSON.stringify({
        ...config,
        mode,
        cutoverAt: "2026-10-06T00:00:00Z",
      }),
    },
    bridge,
    labels,
  );
  return { ops, repo, labels, bridge };
}
describe("explicit six-rule provisioning", () => {
  it("refuses a concurrent instance setup before catalog operations", async () => {
    const h = setup("paused", 6);
    h.repo.acquire.mockResolvedValue(null);
    await expect(
      h.ops.provision({ apply: true, expectedRules: 6 }),
    ).rejects.toThrow("setup_instance_busy");
    expect(h.labels.ensureCatalogLabel).not.toHaveBeenCalled();
  });
  it("fences each HTTP hook and persists Retry-After cooldown before releasing lease", async () => {
    const h = setup();
    h.labels.ensureCatalogLabel.mockImplementation(
      async (
        _w: string,
        _i: string,
        _n: string,
        before: () => Promise<void>,
      ) => {
        await before();
        await before();
        throw new UazapiLabelOperationError(
          "provider_http_error",
          429,
          120000,
          true,
        );
      },
    );
    await expect(
      h.ops.provision({ apply: true, expectedRules: 6 }),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(h.repo.reserve.mock.calls).toEqual([
      ["a", 1000],
      ["a", 1000],
      ["a", 120000],
    ]);
    expect(h.repo.fence).toHaveBeenCalledTimes(2);
    expect(h.repo.release).toHaveBeenCalledOnce();
  });
  it("defaults to read-only and reports exact stage/value plan", async () => {
    const h = setup();
    const result = await h.ops.provision();
    expect(result.dryRun).toBe(true);
    expect(result.expectedRules).toBe(6);
    expect(
      result.stages?.find((s) => s.stage === "agendamento")?.valueCents,
    ).toBe(10000);
    expect(h.labels.ensureCatalogLabel).not.toHaveBeenCalled();
    expect(h.bridge.ensureBridge).not.toHaveBeenCalled();
    expect(h.repo.acquire).not.toHaveBeenCalled();
  });
  it("requires explicit expected count and paused/observation mode", async () => {
    await expect(setup().ops.provision({ apply: true })).rejects.toThrow(
      "expected_rule_count_required",
    );
    await expect(
      setup("production").ops.provision({ apply: true, expectedRules: 6 }),
    ).rejects.toThrow("setup_requires_paused_or_observation");
  });
  it("rereads six existing bindings and makes no new label/rule", async () => {
    const h = setup("paused", 6);
    expect(await h.ops.provision({ apply: true, expectedRules: 6 })).toEqual({
      dryRun: false,
      ruleCount: 6,
      productionEnabled: false,
    });
    expect(h.labels.ensureCatalogLabel).not.toHaveBeenCalled();
    expect(h.repo.db.reportSyncBinding.findMany).toHaveBeenCalledTimes(2);
  });
});
