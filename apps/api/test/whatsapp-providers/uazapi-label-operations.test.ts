import { describe, expect, it, vi } from "vitest";
import {
  UazapiLabelOperationsService,
  UazapiLabelOperationError,
} from "../../src/integrations/whatsapp-providers/uazapi-label-operations.service";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";

const phone = "5511999999999";
const chatId = `${phone}@s.whatsapp.net`;
function fixture(
  replies: Array<unknown | Response>,
  config: unknown = {
    provider: "uazapi_byo",
    config: {
      baseUrl: "https://connection.example.com",
      token: "connection-only",
    },
  },
) {
  const findFirst = vi.fn().mockResolvedValue({
    provider: "uazapi_byo",
    configEncrypted: "encrypted",
    configIv: "iv",
    configTag: "tag",
  });
  const fetchImpl = vi.fn().mockImplementation(async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response
      ? next
      : new Response(JSON.stringify(next), { status: 200 });
  });
  const service = new UazapiLabelOperationsService(
    { whatsappInstance: { findFirst } } as never,
    { decrypt: () => JSON.stringify(config) } as never,
    fetchImpl as never,
  );
  return { service, fetchImpl, findFirst };
}
describe("connection-scoped label operations", () => {
  it("awaits its setup hook before every individual catalogue request", async () => {
    const { service, fetchImpl } = fixture([
      [],
      { response: "Label created" },
      [{ id: "10", name: "N1" }],
    ]);
    const callsAtHooks: number[] = [];
    await service.ensureCatalogLabel("w", "i", "N1", async () => {
      callsAtHooks.push(fetchImpl.mock.calls.length);
    });
    expect(callsAtHooks).toEqual([0, 1, 2]);
  });
  it.each([
    { value: "123456789012345@lid", expected: "123456789012345@lid" },
    { value: undefined, expected: null },
    { value: "12345@s.whatsapp.net", expected: null },
    { value: "not-a-lid", expected: null },
    { value: "12345@lid trailing", expected: null },
  ])(
    "returns only an independently verified provider LID: $value",
    async ({ value, expected }) => {
      const { service } = fixture([
        { chats: [{ wa_chatid: chatId, wa_chatlid: value, wa_label: [] }] },
      ]);
      expect((await service.readChatLabels("w", "i", phone)).lid).toBe(
        expected,
      );
    },
  );
  it("supports existing adapter catalog callers with explicit connection configuration", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: "10", name: "N1" }])),
      );
    const adapter = new UazapiByoAdapter(
      new UazapiAdapter(
        {
          UAZAPI_BASE_URL: "https://legacy.example.com",
          UAZAPI_TOKEN: "legacy",
        },
        fetchImpl,
      ),
    );
    await adapter.listLabels("instance", null, {
      provider: "uazapi_byo",
      config: {
        baseUrl: "https://individual.example.com",
        token: "individual",
      },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://individual.example.com/labels",
    );
    expect(fetchImpl.mock.calls[0][1].headers.token).toBe("individual");
    fetchImpl.mockClear();
    expect(
      (
        await adapter.listLabels("instance", null, {
          provider: "uazapi_byo",
          config: { baseUrl: "", token: "" },
        })
      ).status,
    ).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("uses only the scoped connection URL/token and prefers actual WhatsApp label ID", async () => {
    const { service, findFirst, fetchImpl } = fixture([
      [{ id: "db-id", labelid: "10", name: "N1" }],
    ]);
    expect(await service.listCatalog("workspace", "connection")).toEqual([
      { id: "10", name: "N1" },
    ]);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: "connection",
      workspaceId: "workspace",
      provider: "uazapi_byo",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://connection.example.com/labels",
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { token: "connection-only" },
      redirect: "error",
    });
  });
  it.each([
    {},
    {
      provider: "uazapi_byo",
      config: { baseUrl: "https://safe.example.com", token: "" },
    },
    {
      provider: "uazapi_byo",
      config: { baseUrl: "http://127.0.0.1", token: "secret" },
    },
  ])("fails closed for invalid config %j", async (config) => {
    const { service, fetchImpl } = fixture([], config);
    await expect(service.listCatalog("w", "i")).rejects.toBeInstanceOf(
      UazapiLabelOperationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads exact chat identity and textual labels", async () => {
    const { service, fetchImpl } = fixture([
      {
        chats: [{ wa_chatid: chatId, wa_label: '["10","external"]' }],
        pagination: { totalRecords: 1 },
      },
    ]);
    expect(await service.readChatLabels("w", "i", phone)).toEqual({
      chatId,
      phone,
      labelIds: ["10", "external"],
      lid: null,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      wa_chatid: `=${chatId}`,
      limit: 2,
    });
  });
  it("resolves compound membership only through this connection's catalog", async () => {
    const { service, fetchImpl } = fixture([
      {
        chats: [
          {
            wa_chatid: chatId,
            wa_label: '["5511777777777:10","external","5511666666666:10"]',
          },
        ],
      },
      [{ id: "5511777777777:10", labelid: "10", name: "N1" }],
    ]);
    expect(await service.readChatLabels("w", "i", phone)).toMatchObject({
      labelIds: ["10", "external", "5511666666666:10"],
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/chat/find",
      "/labels",
    ]);
    expect(
      fetchImpl.mock.calls.every(
        ([, init]) => init.headers.token === "connection-only",
      ),
    ).toBe(true);
  });
  it("paces every request needed to verify compound membership", async () => {
    const { service, fetchImpl } = fixture([
      { chats: [{ wa_chatid: chatId, wa_label: ["5511777777777:10"] }] },
      [{ id: "5511777777777:10", labelid: "10", name: "N1" }],
    ]);
    const callsAtHooks: number[] = [];
    await service.readChatLabels("w", "i", phone, async () => {
      callsAtHooks.push(fetchImpl.mock.calls.length);
    });
    expect(callsAtHooks).toEqual([0, 1]);
  });
  it.each([
    { wa_chatid: "5511888888888@s.whatsapp.net", wa_label: [] },
    { wa_chatid: chatId },
    { wa_chatid: chatId, wa_label: "bad" },
  ])("rejects mismatched or unverifiable readback %j", async (chat) => {
    const { service } = fixture([{ chats: [chat] }]);
    await expect(
      service.readChatLabels("w", "i", phone),
    ).rejects.toBeInstanceOf(UazapiLabelOperationError);
  });
  it("blocks unresolved LID before provider mutation", async () => {
    const { service, fetchImpl } = fixture([]);
    await expect(
      service.addChatLabel("w", "i", "12345@lid", "10"),
    ).rejects.toMatchObject({ code: "chat_identity_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("adds/removes only the targeted label, never replaces membership", async () => {
    const { service, fetchImpl } = fixture([
      { response: "ok" },
      { response: "ok" },
    ]);
    await service.addChatLabel("w", "i", phone, "10");
    await service.removeChatLabel("w", "i", phone, "20");
    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body)),
    ).toEqual([
      { number: phone, add_labelid: "10" },
      { number: phone, remove_labelid: "20" },
    ]);
  });
  it("reuses normalized names and refuses duplicates", async () => {
    const one = fixture([[{ id: "10", name: " n1 " }]]);
    expect(await one.service.ensureCatalogLabel("w", "i", "N1")).toEqual({
      id: "10",
      name: " n1 ",
    });
    const two = fixture([
      [
        { id: "10", name: "N1" },
        { id: "11", name: "n1" },
      ],
    ]);
    await expect(
      two.service.ensureCatalogLabel("w", "i", "N1"),
    ).rejects.toMatchObject({ code: "label_name_ambiguous" });
    expect(two.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("creates via documented new marker and obtains real ID by readback", async () => {
    const { service, fetchImpl } = fixture([
      [],
      { response: "Label created" },
      [{ id: "db", labelid: "21", name: "N1" }],
    ]);
    expect(await service.ensureCatalogLabel("w", "i", "N1")).toEqual({
      id: "21",
      name: "N1",
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      labelid: "new",
      name: "N1",
      color: 0,
      delete: false,
    });
  });
  it("surfaces redacted retry metadata without provider body", async () => {
    const { service } = fixture([
      new Response("secret payload", {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    ]);
    await expect(service.listCatalog("w", "i")).rejects.toMatchObject({
      code: "provider_http_error",
      httpStatus: 429,
      retryAfterMs: 7000,
      retryable: true,
      message: "provider_http_error",
    });
  });
  it("redacts network error details", async () => {
    const { service } = fixture([new Error("token=secret")]);
    await expect(service.listCatalog("w", "i")).rejects.toMatchObject({
      message: "provider_request_failed",
      retryable: true,
    });
  });
  it("respects Retry-After HTTP date and distinguishes permanent errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    try {
      const limited = fixture([
        new Response("", {
          status: 429,
          headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:12 GMT" },
        }),
      ]);
      await expect(limited.service.listCatalog("w", "i")).rejects.toMatchObject(
        { retryAfterMs: 12000, retryable: true },
      );
      const denied = fixture([new Response("secret", { status: 401 })]);
      await expect(denied.service.listCatalog("w", "i")).rejects.toMatchObject({
        retryAfterMs: null,
        retryable: false,
        httpStatus: 401,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("refuses another workspace/missing connection before any request", async () => {
    const { service, findFirst, fetchImpl } = fixture([]);
    findFirst.mockResolvedValueOnce(null);
    await expect(
      service.listCatalog("other-workspace", "i"),
    ).rejects.toMatchObject({ code: "connection_config_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects multiple chats and pagination ambiguity", async () => {
    const { service } = fixture([
      {
        chats: [{ wa_chatid: chatId, wa_label: [] }],
        pagination: { totalRecords: 2 },
      },
    ]);
    await expect(service.readChatLabels("w", "i", phone)).rejects.toMatchObject(
      { code: "chat_identity_ambiguous" },
    );
  });
});
