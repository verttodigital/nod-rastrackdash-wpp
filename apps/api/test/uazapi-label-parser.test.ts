import { describe, expect, it } from "vitest";
import { parseUazapiWebhook } from "../src/webhooks/uazapi-webhook-parser";

describe("Uazapi label membership contract", () => {
  it.each([["10", "20"], '["10","20"]'].map((wa_label) => ({ wa_label })))(
    "accepts array and JSON array: %j",
    ({ wa_label }) => {
      const result = parseUazapiWebhook({
        EventType: "chat_labels",
        chat: { wa_label },
      });
      expect(result.waLabelState).toBe("valid");
      expect(result.waLabelIds).toEqual(["10", "20"]);
    },
  );
  it.each([[], "[]"].map((wa_label) => ({ wa_label })))(
    "preserves explicit empty membership %j",
    ({ wa_label }) => {
      expect(parseUazapiWebhook({ chat: { wa_label } })).toMatchObject({
        waLabelState: "valid",
        waLabelIds: [],
      });
    },
  );
  it("distinguishes absent from malformed and empty", () => {
    expect(parseUazapiWebhook({ chat: {} }).waLabelState).toBe("absent");
  });
  it.each(
    [
      null,
      "10",
      "not-json",
      {},
      ["10", null],
      ["10", {}],
      [""],
      [10],
      '["10", false]',
    ].map((wa_label) => ({ wa_label })),
  )("rejects the entire malformed membership %j", ({ wa_label }) => {
    expect(parseUazapiWebhook({ chat: { wa_label } })).toMatchObject({
      waLabelState: "invalid",
      waLabelIds: [],
    });
  });
  it("distinguishes catalog from membership including event alias", () => {
    expect(parseUazapiWebhook({ EventType: "labels" }).labelEventKind).toBe(
      "labels_catalog",
    );
    expect(parseUazapiWebhook({ event: "chat_labels" }).labelEventKind).toBe(
      "chat_labels",
    );
  });
});
