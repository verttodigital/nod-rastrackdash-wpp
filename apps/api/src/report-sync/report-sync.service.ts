import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { CONVERSION_EVENTS_QUEUE } from "../common/queue/queue.constants";
import { createBullJobId } from "../common/queue/job-id";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import {
  UazapiLabelOperationsService,
  UazapiLabelOperationError,
} from "../integrations/whatsapp-providers/uazapi-label-operations.service";
import { UazapiProviderConversionService } from "../inbound-webhooks/uazapi-provider-conversion.service";
import { ReportSyncRepository } from "./report-sync.repository";
import {
  baselineSchema,
  intentSchema,
  intentKey,
  readSyncConfig,
  stageKey,
  stages,
  publishedRuleMatches,
  type SyncConfig,
} from "./report-sync.contract";

class SyncBlocked extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
@Injectable()
export class ReportSyncService {
  constructor(
    @Inject(ReportSyncRepository) readonly repo: ReportSyncRepository,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(UazapiLabelOperationsService)
    private readonly labels: UazapiLabelOperationsService,
    @Inject(UazapiProviderConversionService)
    private readonly conversions: UazapiProviderConversionService,
    @Optional()
    @InjectQueue(CONVERSION_EVENTS_QUEUE)
    private readonly deliveryQueue?: Queue,
  ) {}
  config(): SyncConfig {
    const c = readSyncConfig(this.env);
    if (!c) throw new NotFoundException("integration_disabled");
    return c;
  }
  scope(c: SyncConfig, body: { sourceId: string; tenantId: string }) {
    if (body.sourceId !== c.sourceId || body.tenantId !== c.tenantId)
      throw new ForbiddenException("integration_scope_mismatch");
  }
  async validateBindings(c: SyncConfig) {
    const rows = await this.repo.db.whatsappInstance.findMany({
      where: {
        workspaceId: c.workspaceId,
        id: { in: c.bindings.map((b) => b.whatsappInstanceId) },
        provider: "uazapi_byo",
      },
    });
    if (rows.length !== 2 || rows.some((r) => !r.configEncrypted))
      throw new ConflictException("connection_scope_invalid");
    return rows;
  }
  async accept(raw: unknown, key: string | undefined) {
    const parsed = intentSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnprocessableEntityException("intent_invalid");
    const body = parsed.data,
      c = this.config();
    this.scope(c, body);
    if (Date.parse(body.publication.publishedAt) > Date.now())
      throw new UnprocessableEntityException("future_publication");
    if (!key || key !== intentKey(body))
      throw new UnprocessableEntityException("idempotency_key_invalid");
    await this.validateBindings(c);
    const result = await this.repo.accept(c, body);
    if (result.row.mode === "observation") await this.observe(result.row.id, c);
    return {
      syncId: result.row.id,
      status: (await this.result(result.row.id)).status,
      duplicate: result.duplicate,
      statusUrl: `/integrations/report-sync/intents/${result.row.id}`,
    };
  }
  async baseline(raw: unknown) {
    const parsed = baselineSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnprocessableEntityException("baseline_invalid");
    if (Date.parse(parsed.data.cutoverAt) > Date.now())
      throw new UnprocessableEntityException("future_cutover");
    const c = this.config();
    this.scope(c, parsed.data);
    await this.validateBindings(c);
    return this.repo.baseline(c, parsed.data);
  }
  private async resolve(id: string, c: SyncConfig) {
    const row = await this.repo.db.reportSyncIntent.findFirst({
      where: {
        id,
        sourceId: c.sourceId,
        workspaceId: c.workspaceId,
        tenantId: c.tenantId,
      },
    });
    if (!row) throw new NotFoundException("intent_not_found");
    const body = this.repo.decode(row),
      binding = c.bindings.find(
        (b) => b.instanceName === body.origin?.instanceName,
      );
    if (!body.origin || !binding) throw new SyncBlocked("origin_ambiguous");
    if (!body.lead.phone || !/^\d{10,15}$/.test(body.lead.phone))
      throw new SyncBlocked("phone_unresolved");
    const phone = body.lead.phone;
    // A bare @lid is not a phone identity. Provider readback must prove a PN mapping.
    if (
      !body.origin.waChatId.endsWith("@lid") &&
      body.origin.waChatId !== `${phone}@s.whatsapp.net` &&
      body.origin.waChatId !== phone
    )
      throw new SyncBlocked("identity_conflict");
    const lead = await this.repo.db.lead.findUnique({
      where: {
        workspaceId_phoneHash: {
          workspaceId: c.workspaceId,
          phoneHash: hashPhoneIdentity(phone)!,
        },
      },
    });
    if (!lead || !lead.adId || !lead.ctwaClid)
      throw new SyncBlocked("lead_not_attributed");
    if (
      lead.whatsappInstanceId !== binding.whatsappInstanceId ||
      lead.adId !== body.lead.adId ||
      lead.ctwaClid !== body.lead.ctwaClid
    )
      throw new SyncBlocked("attribution_origin_conflict");
    return { row, body, binding, phone, lead };
  }
  private async observe(id: string, c: SyncConfig) {
    try {
      const context = await this.resolve(id, c);
      // Observation is read-only: resolve identity and inspect actual labels.
      const labels = await this.labels.readChatLabels(
        c.workspaceId,
        context.binding.whatsappInstanceId,
        context.phone,
        async () => {
          const wait = await this.repo.reserve(
            context.binding.whatsappInstanceId,
          );
          if (wait > 10000) throw new SyncBlocked("observation_rate_limited");
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        },
      );
      if (labels.phone !== context.phone)
        throw new SyncBlocked("provider_identity_conflict");
      if (
        context.body.origin!.waChatId.endsWith("@lid") &&
        (!("lid" in labels) || labels.lid !== context.body.origin!.waChatId)
      )
        throw new SyncBlocked("lid_mapping_required");
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: {
          status: "observed",
          reasonCode: "observation_verified",
          whatsappInstanceId: context.binding.whatsappInstanceId,
          contactKey: hashPhoneIdentity(context.phone),
        },
      });
    } catch (e) {
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: {
          status: "observed",
          reasonCode:
            e instanceof SyncBlocked ? e.code : "observation_unavailable",
        },
      });
    }
  }
  async process(id: string) {
    const c = this.config();
    const current = await this.repo.db.reportSyncIntent.findFirst({
      where: { id, sourceId: c.sourceId, workspaceId: c.workspaceId },
    });
    if (
      !current ||
      current.mode === "observation" ||
      ["succeeded", "partial", "observed"].includes(current.status)
    )
      return;
    if (["blocked", "failed"].includes(current.status)) {
      await this.result(id);
      return;
    }
    if (current.finalLabelVerified) {
      await this.result(id);
      return;
    }
    if (c.mode !== "production") {
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: { status: "paused" },
      });
      return;
    }
    await this.repo.db.$transaction((tx) => this.repo.assertSource(tx, c));
    let context: Awaited<ReturnType<ReportSyncService["resolve"]>>;
    try {
      context = await this.resolve(id, c);
    } catch (e) {
      if (!(e instanceof SyncBlocked)) throw e;
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: { status: "blocked", reasonCode: e.code },
      });
      return;
    }
    const { row, body, binding, phone } = context;
    const lease = await this.repo.acquire(
      `${c.workspaceId}:${binding.whatsappInstanceId}:${hashPhoneIdentity(phone)}`,
    );
    if (!lease) return;
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      const wait = await this.repo.reserve(binding.whatsappInstanceId);
      if (wait > 30000)
        throw new UazapiLabelOperationError(
          "instance_rate_backlog",
          null,
          wait,
          true,
        );
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (this.config().mode !== "production")
        throw new SyncBlocked("pilot_paused");
      await this.repo.fence(lease);
      return operation();
    };
    try {
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: {
          status: "processing",
          reasonCode: null,
          attempts: { increment: 1 },
          whatsappInstanceId: binding.whatsappInstanceId,
          contactKey: hashPhoneIdentity(phone),
        },
      });
      const bindings = await this.repo.db.reportSyncBinding.findMany({
        where: {
          sourceId: c.sourceId,
          workspaceId: c.workspaceId,
          whatsappInstanceId: binding.whatsappInstanceId,
        },
      });
      if (
        bindings.length !== 3 ||
        new Set(bindings.map((b) => b.stage)).size !== 3
      )
        throw new SyncBlocked("rules_not_configured");
      for (const bindingRule of bindings) {
        const rule = await this.repo.db.providerConversionRuleConfig.findFirst({
          where: { id: bindingRule.providerRuleId, workspaceId: c.workspaceId },
          include: {
            conversionRule: true,
            channels: { include: { channel: true } },
          },
        });
        if (
          !rule ||
          !publishedRuleMatches(bindingRule.stage, rule) ||
          !rule.channels.some(
            (ch) =>
              ch.channel.whatsappInstanceId === binding.whatsappInstanceId,
          )
        )
          throw new SyncBlocked("published_rule_mapping_changed");
      }
      const instance = await this.repo.db.whatsappInstance.findUniqueOrThrow({
        where: { id: binding.whatsappInstanceId },
      });
      const read = async () => {
        const state = await this.labels.readChatLabels(
          c.workspaceId,
          binding.whatsappInstanceId,
          phone,
          () => call(async () => undefined),
        );
        if (state.phone !== phone)
          throw new SyncBlocked("provider_identity_conflict");
        if (
          body.origin!.waChatId.endsWith("@lid") &&
          (!("lid" in state) || state.lid !== body.origin!.waChatId)
        )
          throw new SyncBlocked("lid_mapping_required");
        return state;
      };
      let state = await read();
      for (const transition of body.transitions) {
        const stage = await this.repo.db.reportSyncStage.findUniqueOrThrow({
          where: { id: stageKey(c, body.lead.id, transition.stage) },
        });
        if (
          (stage.whatsappInstanceId &&
            stage.whatsappInstanceId !== binding.whatsappInstanceId) ||
          (stage.contactKey && stage.contactKey !== hashPhoneIdentity(phone))
        )
          throw new SyncBlocked("stage_identity_immutable");
        if (["baseline", "delivered", "ineligible"].includes(stage.status))
          continue;
        if (
          stage.executionId &&
          ["awaiting_meta", "decision_recorded"].includes(stage.status)
        )
          continue;
        if (
          !stage.occurredAt ||
          stage.occurredAt.toISOString() !==
            new Date(transition.occurredAt).toISOString()
        )
          throw new SyncBlocked("original_timestamp_conflict");
        if (
          stage.occurredAt > new Date() ||
          Date.now() - stage.occurredAt.getTime() > 7 * 86400000 ||
          stage.occurredAt <= new Date(c.cutoverAt!)
        ) {
          await this.repo.db.reportSyncStage.update({
            where: { id: stage.id },
            data: {
              status: "ineligible",
              reasonCode: "original_event_outside_window",
            },
          });
          continue;
        }
        const configured = bindings.find((b) => b.stage === transition.stage)!;
        await this.repo.db.reportSyncStage.update({
          where: { id: stage.id },
          data: {
            intentId: stage.intentId ?? row.id,
            whatsappInstanceId: binding.whatsappInstanceId,
            contactKey: hashPhoneIdentity(phone),
            labelId: configured.labelId,
            providerRuleId: configured.providerRuleId,
          },
        });
        if (!state.labelIds.includes(configured.labelId))
          await call(() =>
            this.labels.addChatLabel(
              c.workspaceId,
              binding.whatsappInstanceId,
              phone,
              configured.labelId,
            ),
          );
        state = await read();
        if (!state.labelIds.includes(configured.labelId))
          throw new Error("label_readback_mismatch");
        await this.repo.db.reportSyncStage.update({
          where: { id: stage.id },
          data: { status: "label_verified" },
        });
        await this.repo.fence(lease);
        await this.conversions.evaluateLabels({
          workspaceId: c.workspaceId,
          instance,
          phone,
          labelIds: state.labelIds,
          waChatId: state.chatId,
          reportStageId: stage.id,
          beforeLabelRequest: () => call(async () => undefined),
        });
        const execution =
          await this.repo.db.providerConversionRuleExecution.findFirst({
            where: {
              workspaceId: c.workspaceId,
              providerRuleId: configured.providerRuleId,
              providerDecision: { occurrenceKey: `report-sync:${stage.id}` },
            },
          });
        if (
          !execution ||
          !["eligible", "materialized", "duplicate"].includes(execution.status)
        )
          throw new SyncBlocked("conversion_decision_blocked");
        await this.repo.db.reportSyncStage.update({
          where: { id: stage.id },
          data: {
            status: "awaiting_meta",
            executionId: execution.id,
            conversionEventId: execution.conversionEventLogId,
          },
        });
      }
      const latest = await this.repo.db.reportSyncIntent.findFirst({
        where: {
          sourceId: c.sourceId,
          sourceLeadId: body.lead.id,
          mode: "production",
          whatsappInstanceId: binding.whatsappInstanceId,
          contactKey: hashPhoneIdentity(phone),
          status: { notIn: ["observed", "blocked", "failed"] },
        },
        orderBy: { publicationVersion: "desc" },
      });
      // Older jobs may finish their transitions but never replace a newer final stage.
      const finalBody = latest ? this.repo.decode(latest) : body;
      const desired = bindings.find(
        (b) => b.stage === finalBody.finalStage,
      )?.labelId;
      if (desired && !state.labelIds.includes(desired))
        await call(() =>
          this.labels.addChatLabel(
            c.workspaceId,
            binding.whatsappInstanceId,
            phone,
            desired,
          ),
        );
      for (const managed of bindings)
        if (
          managed.labelId !== desired &&
          state.labelIds.includes(managed.labelId)
        )
          await call(() =>
            this.labels.removeChatLabel(
              c.workspaceId,
              binding.whatsappInstanceId,
              phone,
              managed.labelId,
            ),
          );
      state = await read();
      if (
        (desired && !state.labelIds.includes(desired)) ||
        bindings.some(
          (b) => b.labelId !== desired && state.labelIds.includes(b.labelId),
        )
      )
        throw new Error("final_label_readback_mismatch");
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: {
          finalLabelVerified: true,
          status: "pending",
          nextAttemptAt: new Date(Date.now() + 30000),
        },
      });
      await this.result(id);
    } catch (e) {
      const retry =
        e instanceof UazapiLabelOperationError
          ? e.retryable
          : !(e instanceof SyncBlocked);
      const delay =
        e instanceof UazapiLabelOperationError
          ? (e.retryAfterMs ?? 30000)
          : 30000;
      const pendingStages = await this.repo.db.reportSyncStage.findMany({
        where: {
          sourceId: c.sourceId,
          sourceLeadId: body.lead.id,
          status: { in: ["awaiting_meta", "decision_recorded"] },
        },
      });
      const inFlight = pendingStages.some((s) => Boolean(s.executionId));
      if (e instanceof UazapiLabelOperationError && e.httpStatus === 429)
        await this.repo.reserve(
          binding.whatsappInstanceId,
          Math.max(1000, delay),
        );
      await this.repo.db.reportSyncIntent.update({
        where: { id },
        data: {
          status: retry
            ? "pending"
            : e instanceof SyncBlocked && e.code === "pilot_paused"
              ? "paused"
              : "blocked",
          reasonCode:
            e instanceof SyncBlocked
              ? e.code
              : e instanceof UazapiLabelOperationError
                ? e.code
                : "processing_failed",
          nextAttemptAt:
            retry || inFlight ? new Date(Date.now() + delay) : null,
        },
      });
    } finally {
      await this.repo.release(lease);
    }
  }
  async result(id: string) {
    const c = this.config();
    const row = await this.repo.db.reportSyncIntent.findFirst({
      where: {
        id,
        sourceId: c.sourceId,
        workspaceId: c.workspaceId,
        tenantId: c.tenantId,
      },
    });
    if (!row) throw new NotFoundException("intent_not_found");
    const body = this.repo.decode(row);
    const transitions = [];
    for (const t of body.transitions) {
      let stage =
        row.mode === "observation"
          ? null
          : await this.repo.db.reportSyncStage.findUnique({
              where: { id: stageKey(c, body.lead.id, t.stage) },
            });
      if (
        stage?.executionId &&
        stage.status !== "ineligible" &&
        stage.status !== "baseline"
      ) {
        const execution =
          await this.repo.db.providerConversionRuleExecution.findUnique({
            where: { id: stage.executionId },
          });
        const technical = execution?.normalizedResult as {
          technicalDelivery?: { state?: string; retryable?: boolean };
        } | null;
        if (
          execution &&
          !execution.conversionEventLogId &&
          (execution.status === "blocked" ||
            execution.status === "duplicate" ||
            (execution.status === "failed" &&
              (technical?.technicalDelivery?.retryable === false ||
                execution.attemptCount >= 3)))
        ) {
          stage = await this.repo.db.reportSyncStage.update({
            where: { id: stage.id },
            data: {
              status:
                execution.status === "duplicate"
                  ? "ineligible"
                  : execution.status === "blocked"
                    ? "blocked"
                    : "failed",
              reasonCode:
                execution.reasonCode ?? `execution_${execution.status}`,
            },
          });
        }
        if (
          execution &&
          (execution.status === "eligible" ||
            (execution.status === "failed" &&
              technical?.technicalDelivery?.retryable === true &&
              execution.attemptCount < 3)) &&
          stage.status === "awaiting_meta"
        )
          await this.conversions.resumeReportExecution(stage.id);
        const event = execution?.conversionEventLogId
          ? await this.repo.db.conversionEventLog.findUnique({
              where: { id: execution.conversionEventLogId },
            })
          : null;
        if (
          event &&
          (event.status === "ready_to_send" ||
            (event.status === "error" &&
              event.errorCode === "MetaCapiNetworkError")) &&
          stage.deliveryAttempts < 3 &&
          c.mode === "production" &&
          this.deliveryQueue &&
          !(await this.deliveryQueue.getJob(
            createBullJobId("conversion-send", event.id),
          ))
        ) {
          await new ConversionEventsQueueService(
            this.deliveryQueue,
          ).enqueueSend(event.id, c.workspaceId);
        }
        const acknowledgement = event?.providerResponseSummary as {
          events_received?: unknown;
        } | null;
        if (
          event?.status === "sent" &&
          event.sentAt &&
          typeof acknowledgement?.events_received === "number" &&
          acknowledgement.events_received >= 1
        )
          stage = await this.repo.db.reportSyncStage.update({
            where: { id: stage.id },
            data: {
              status: "delivered",
              metaAcceptedAt: event.sentAt,
              conversionEventId: event.id,
              reasonCode: null,
            },
          });
        else if (event?.status === "sent")
          stage = await this.repo.db.reportSyncStage.update({
            where: { id: stage.id },
            data: {
              status: "awaiting_meta",
              reasonCode: "meta_acknowledgement_missing",
              conversionEventId: event.id,
            },
          });
        else if (
          event &&
          ["error", "failed", "not_configured"].includes(event.status)
        ) {
          const normalized = execution?.normalizedResult as {
            technicalDelivery?: { state?: string };
          } | null;
          const job = this.deliveryQueue
            ? await this.deliveryQueue.getJob(
                createBullJobId("conversion-send", event.id),
              )
            : null;
          const exhausted =
            job &&
            (await job.getState()) === "failed" &&
            job.attemptsMade >= (job.opts.attempts ?? 1);
          const permanent =
            normalized?.technicalDelivery?.state === "failed_permanent";
          stage = await this.repo.db.reportSyncStage.update({
            where: { id: stage.id },
            data: {
              status:
                permanent || exhausted || stage.deliveryAttempts >= 3
                  ? "failed"
                  : "awaiting_meta",
              reasonCode: event.errorCode ?? "meta_delivery_unconfirmed",
              conversionEventId: event.id,
            },
          });
        }
      }
      transitions.push({
        stage: t.stage,
        occurredAt: stage?.occurredAt ?? t.occurredAt,
        status: stage?.status ?? "pending",
        reasonCode: stage?.reasonCode ?? null,
        executionId: stage?.executionId ?? null,
        conversionEventId: stage?.conversionEventId ?? null,
        metaAcceptedAt: stage?.metaAcceptedAt ?? null,
      });
    }
    let status = row.status;
    const inFlight = transitions.some(
      (t) =>
        t.executionId &&
        ["awaiting_meta", "decision_recorded", "label_verified"].includes(
          t.status,
        ),
    );
    if (["blocked", "failed"].includes(row.status)) {
      if (inFlight) status = "pending";
      else if (transitions.some((t) => t.status === "delivered")) {
        status = "partial";
        await this.repo.db.reportSyncIntent.update({
          where: { id },
          data: { status, nextAttemptAt: null },
        });
      } else if (row.nextAttemptAt)
        await this.repo.db.reportSyncIntent.update({
          where: { id },
          data: { nextAttemptAt: null },
        });
    }
    if (
      row.finalLabelVerified &&
      transitions.every((t) =>
        ["delivered", "baseline", "ineligible", "failed", "blocked"].includes(
          t.status,
        ),
      )
    ) {
      status = transitions.some((t) =>
        ["ineligible", "failed", "blocked"].includes(t.status),
      )
        ? "partial"
        : "succeeded";
      if (status !== row.status)
        await this.repo.db.reportSyncIntent.update({
          where: { id },
          data: { status, nextAttemptAt: null },
        });
    }
    return {
      syncId: id,
      publicationId: row.publicationId,
      sourceLeadId: row.sourceLeadId,
      status,
      reasonCode: row.reasonCode,
      nextAttemptAt: row.nextAttemptAt,
      updatedAt: row.updatedAt,
      finalLabelVerified: row.finalLabelVerified,
      transitions,
    };
  }
}
