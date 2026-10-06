import { describe, it, expect } from "vitest";
import {
  bearerMatches,
  canonicalIntent,
  digest,
  intentKey,
  intentSchema,
  mapping,
  stageKey,
} from "../../src/report-sync/report-sync.contract";
const payload = {
  schemaVersion: 1 as const,
  sourceId: "source",
  tenantId: "tenant",
  mode: "production" as const,
  publication: {
    id: "p1",
    version: 1,
    publishedAt: "2026-10-06T16:00:00.000Z",
  },
  lead: { id: "lead", phone: "5511999999999", adId: "ad", ctwaClid: "ctwa" },
  origin: {
    instanceName: "instance",
    waChatId: "5511999999999@s.whatsapp.net",
    evidenceMessageId: "message",
  },
  finalStage: "agendamento" as const,
  transitions: [
    { id: "t1", stage: "n1" as const, occurredAt: "2026-10-06T12:00:00.000Z" },
  ],
};
describe("report synchronization immutable contract", () => {
  it("requires exact dedicated bearer, including equal length wrong tokens", () => {
    expect(bearerMatches("Bearer " + "a".repeat(32), "a".repeat(32))).toBe(
      true,
    );
    expect(bearerMatches("Bearer " + "b".repeat(32), "a".repeat(32))).toBe(
      false,
    );
    expect(bearerMatches(undefined, undefined)).toBe(false);
  });
  it("rejects missing timezone, repeated stages and inverted chronology", () => {
    expect(
      intentSchema.safeParse({
        ...payload,
        transitions: [{ ...payload.transitions[0], occurredAt: "2026-10-06" }],
      }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({
        ...payload,
        transitions: [...payload.transitions, ...payload.transitions],
      }).success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({
        ...payload,
        transitions: [
          ...payload.transitions,
          { id: "t2", stage: "n2", occurredAt: "2026-10-06T11:00:00Z" },
        ],
      }).success,
    ).toBe(false);
  });
  it("semantic stage remains consumed across republications and telephone changes", () => {
    const republished = {
      ...payload,
      publication: { ...payload.publication, id: "p2" },
    };
    expect(stageKey(payload, "lead", "n1")).toBe(
      stageKey(republished, "lead", "n1"),
    );
    expect(intentKey(payload)).not.toBe(
      intentKey({
        ...payload,
        publication: { ...payload.publication, id: "p2" },
      }),
    );
    expect(digest(canonicalIntent(payload))).not.toBe(
      digest({ ...payload, finalStage: "n2" }),
    );
  });
  it("appointment is exactly 10000 cents and never Purchase", () => {
    expect(mapping.agendamento).toEqual({
      label: "Agendamento",
      eventName: "InitiateCheckout",
      valueCents: 10000,
    });
    expect(mapping.n1.valueCents).toBeNull();
    expect(mapping.n2.valueCents).toBeNull();
  });
  it("refuses a conversion above the curated final stage", () => {
    expect(
      intentSchema.safeParse({ ...payload, finalStage: "conversa" }).success,
    ).toBe(false);
  });
});
