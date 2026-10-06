import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const stages = ["n1", "n2", "agendamento"] as const;
export type Stage = (typeof stages)[number];
const text = z.string().trim().min(1).max(255);
const date = z.string().datetime({ offset: true });
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: text,
    tenantId: text,
    tenantSlug: text,
    workspaceId: text,
    mode: z.enum(["observation", "production", "paused"]),
    cutoverAt: date.optional(),
    bindings: z
      .array(
        z.object({ instanceName: text, whatsappInstanceId: text }).strict(),
      )
      .length(2),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.bindings.map((b) => b.instanceName)).size === 2 &&
      new Set(c.bindings.map((b) => b.whatsappInstanceId)).size === 2,
    "distinct_bindings_required",
  )
  .refine(
    (c) => c.mode !== "production" || Boolean(c.cutoverAt),
    "cutover_required",
  );
export type SyncConfig = z.infer<typeof configSchema>;
export const intentSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: text,
    tenantId: text,
    mode: z.enum(["observation", "production"]),
    publication: z
      .object({
        id: text,
        version: z.number().int().nonnegative(),
        publishedAt: date,
      })
      .strict(),
    lead: z
      .object({
        id: text,
        phone: z.string().max(64).nullable(),
        adId: text.nullable(),
        ctwaClid: text.nullable(),
      })
      .strict(),
    origin: z
      .object({ instanceName: text, waChatId: text, evidenceMessageId: text })
      .strict()
      .nullable(),
    finalStage: z.enum(["conversa", ...stages]),
    transitions: z
      .array(
        z
          .object({ id: text, stage: z.enum(stages), occurredAt: date })
          .strict(),
      )
      .max(3),
  })
  .strict()
  .superRefine((v, ctx) => {
    const finalIndex =
      v.finalStage === "conversa" ? -1 : stages.indexOf(v.finalStage);
    if (v.transitions.some((t) => stages.indexOf(t.stage) > finalIndex))
      ctx.addIssue({ code: "custom", message: "stage_above_curated_final" });
    if (
      new Set(v.transitions.map((t) => t.stage)).size !== v.transitions.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_stage" });
    const sorted = [...v.transitions].sort(
      (a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage),
    );
    if (
      sorted.some(
        (t, i) =>
          i > 0 &&
          Date.parse(t.occurredAt) < Date.parse(sorted[i - 1]!.occurredAt),
      )
    )
      ctx.addIssue({ code: "custom", message: "stage_chronology_invalid" });
    if (
      v.transitions.some(
        (t) => Date.parse(t.occurredAt) > Date.parse(v.publication.publishedAt),
      )
    )
      ctx.addIssue({ code: "custom", message: "transition_after_publication" });
  });
export type SyncIntent = z.infer<typeof intentSchema>;
export const baselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: text,
    tenantId: text,
    baselineId: text,
    cutoverAt: date,
    part: z.number().int().nonnegative(),
    final: z.boolean(),
    manifest: z
      .object({
        entryCount: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    entries: z
      .array(
        z
          .object({
            sourceLeadId: text,
            stages: z.array(z.enum(stages)).max(3),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type BaselinePart = z.infer<typeof baselineSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const tupleHash = (tuple: string[]) =>
  createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
export const intentKey = (v: SyncIntent) =>
  tupleHash([v.sourceId, v.tenantId, v.publication.id, v.lead.id]);
export const stageKey = (
  c: Pick<SyncConfig, "sourceId" | "tenantId">,
  lead: string,
  stage: Stage,
) => tupleHash([c.sourceId, c.tenantId, lead, stage]);
export const canonicalIntent = (v: SyncIntent): SyncIntent => ({
  ...v,
  transitions: [...v.transitions].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      stages.indexOf(a.stage) - stages.indexOf(b.stage),
  ),
});
export function bearerMatches(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || expected.length < 32 || !actual?.startsWith("Bearer "))
    return false;
  const a = createHash("sha256").update(actual.slice(7)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
export function readSyncConfig(
  env: Record<string, string | undefined>,
): SyncConfig | null {
  if (!env.REPORT_SYNC_CONFIG_JSON) return null;
  try {
    return configSchema.parse(JSON.parse(env.REPORT_SYNC_CONFIG_JSON));
  } catch {
    return null;
  }
}
export const mapping = {
  n1: { label: "N1", eventName: "ViewContent", valueCents: null },
  n2: { label: "N2", eventName: "QualifiedLead", valueCents: null },
  agendamento: {
    label: "Agendamento",
    eventName: "InitiateCheckout",
    valueCents: 10000,
  },
} as const;

export function publishedRuleMatches(
  stage: string,
  rule: {
    requiresReportContext: boolean;
    conversionRule: {
      eventName: string;
      defaultValueCents: number | null;
      defaultCurrency: string | null;
      triggerType: string;
    };
  },
): boolean {
  if (
    !stages.includes(stage as Stage) ||
    !rule.requiresReportContext ||
    rule.conversionRule.triggerType !== "provider_automation"
  )
    return false;
  const expected = mapping[stage as Stage];
  return (
    rule.conversionRule.eventName === expected.eventName &&
    rule.conversionRule.defaultValueCents === expected.valueCents &&
    rule.conversionRule.defaultCurrency ===
      (expected.valueCents === null ? null : "BRL")
  );
}
