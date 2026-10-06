import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ProviderConversionDecisionDto,
  ProviderConversionDecisionRuleSnapshotDto,
} from "@wpptrack/shared";
import {
  conversionEventNameSchema,
  readMessagePhraseConfig,
  type ConversionEventNameDto,
} from "@wpptrack/shared";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
  parseInboundWebhooksConfig,
} from "../config/deployment-config";
import { ProviderConversionDecisionEngine } from "../conversion-rules/provider-conversion-decision.engine";
import type { ProviderConversionDecisionInput } from "../conversion-rules/provider-conversion-decision.types";
import {
  ProviderConversionDecisionPersistenceError,
  ProviderConversionDecisionRepository,
  type PersistedProviderConversionDecision,
} from "../conversion-rules/provider-conversion-decision.repository";
import {
  ProviderConversionOrchestrator,
  type ProviderConversionOrchestrationResult,
  type ProviderConversionTechnicalDisposition,
} from "../conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../conversion-rules/provider-conversion-paid-lead-resolver.service";
import { InboundWebhookProductionQueueService } from "./inbound-webhook-production-queue.service";
import {
  UazapiConversionBridgeService,
  type UazapiBridgeInstance,
} from "./uazapi-conversion-bridge.service";
import { WhatsappProviderRegistry } from "../integrations/whatsapp-providers/whatsapp-provider.registry";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { UazapiLabelOperationsService } from "../integrations/whatsapp-providers/uazapi-label-operations.service";
import {
  readSyncConfig,
  publishedRuleMatches,
} from "../report-sync/report-sync.contract";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import type { SyncIntent } from "../report-sync/report-sync.contract";

const PARSER_VERSION = "v1";

const ruleInclude = {
  conversionRule: true,
  connection: {
    include: {
      parserRelease: true,
    },
  },
  parserRelease: true,
} satisfies Prisma.ProviderConversionRuleConfigInclude;

type Rule = Prisma.ProviderConversionRuleConfigGetPayload<{
  include: typeof ruleInclude;
}>;

export type UazapiTeamMessageInput = {
  workspaceId: string;
  instance: UazapiBridgeInstance;
  phone: string;
  messageText: string;
  externalMessageId?: string | null;
  occurredAt?: Date;
};

export type UazapiTeamMessageResult = {
  /** True once at least one active message_phrase rule matched the event. */
  evaluated: boolean;
  eligibleExecutionId: string | null;
};

export type UazapiDecisionRecoveryResult = {
  mode: "dry-run" | "execute";
  decisionId: string;
  workspaceId: string;
  providerRuleId: string;
  occurrenceKey: string;
  decisionCode: string;
  reasonCode: string;
  ruleMode: string;
  eventName: string;
  valueCents: number | null;
  leadId: string | null;
  disposition: ProviderConversionTechnicalDisposition;
  executionId: string | null;
  eligibleExecutionId: string | null;
  reviewId: string | null;
  enqueued: boolean;
};

export type UazapiLabelInput = {
  workspaceId: string;
  instance: UazapiBridgeInstance;
  phone: string;
  labelIds: string[];
  waChatId?: string;
  externalEventId?: string | null;
  occurredAt?: Date;
  /** Internal only: persisted, scoped publication stage, never read from webhook input. */
  reportStageId?: string;
};

/**
 * U2c: evaluates message_phrase conversion rules for `fromMe=true` (team)
 * messages on a UAZAPI/NOD WhatsApp instance, reusing the same decision
 * engine + orchestrator + production pipeline as the Umbler provider
 * conversion flow (see ProviderConversionObservationService). Paid-lead-only,
 * fail-closed: no resolved lead (adId + ctwaClid) means no CAPI, ever.
 */
@Injectable()
export class UazapiProviderConversionService {
  private readonly logger = new Logger(UazapiProviderConversionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(UazapiConversionBridgeService)
    private readonly bridge: UazapiConversionBridgeService,
    @Inject(ProviderConversionDecisionEngine)
    private readonly decisionEngine: ProviderConversionDecisionEngine,
    @Inject(ProviderConversionDecisionRepository)
    private readonly decisions: ProviderConversionDecisionRepository,
    @Inject(ProviderConversionOrchestrator)
    private readonly orchestrator: ProviderConversionOrchestrator,
    @Inject(ProviderConversionPaidLeadResolver)
    private readonly paidLeads: ProviderConversionPaidLeadResolver,
    @Inject(InboundWebhookProductionQueueService)
    private readonly productionQueue: InboundWebhookProductionQueueService,
    @Inject(WhatsappProviderRegistry)
    private readonly whatsappProviders: WhatsappProviderRegistry,
    @Inject(MetaTokenEncryptionService)
    private readonly tokenEncryption: MetaTokenEncryptionService,
    @Optional()
    @Inject(UazapiLabelOperationsService)
    private readonly labelOperations?: UazapiLabelOperationsService,
    @Optional()
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly reportPayloadEncryption?: InboundWebhookPayloadEncryptionService,
  ) {}

  async evaluateTeamMessage(
    input: UazapiTeamMessageInput,
  ): Promise<UazapiTeamMessageResult> {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      return { evaluated: false, eligibleExecutionId: null };
    }

    const phone = input.phone.trim();
    const messageText = input.messageText.trim();
    if (!phone || !messageText) {
      return { evaluated: false, eligibleExecutionId: null };
    }

    const bridged = await this.bridge.ensureBridge(input.instance);
    const rules = await this.loadRules(
      input.workspaceId,
      bridged.connectionId,
      bridged.channelId,
    );
    if (rules.length === 0) {
      return { evaluated: false, eligibleExecutionId: null };
    }

    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: { id: bridged.channelId, workspaceId: input.workspaceId },
      select: { status: true, productionActivatedAt: true },
    });
    if (!channel) {
      return { evaluated: false, eligibleExecutionId: null };
    }

    const leadResolution = await this.paidLeads.resolve({
      workspaceId: input.workspaceId,
      phone,
    });
    const occurredAt = input.occurredAt ?? new Date();
    const externalEventId = this.externalEventId(input, occurredAt);
    const occurrenceKey = `uazapi:${bridged.channelId}:${externalEventId}`;

    let evaluated = false;
    let eligibleExecutionId: string | null = null;

    for (const rule of rules) {
      const ruleSnapshot = this.ruleSnapshot(rule);
      const decisionInput: ProviderConversionDecisionInput = {
        parserVersion: PARSER_VERSION,
        rule: ruleSnapshot,
        catalog: null,
        leadResolution,
        contactIdentityHash: hashPhoneIdentity(phone) ?? null,
        occurrence: {
          source: "message",
          provider: "uazapi",
          workspaceId: input.workspaceId,
          connectionId: bridged.connectionId,
          channelId: bridged.channelId,
          externalDeliveryId: null,
          externalEventId,
          externalMessageId: externalEventId,
          occurrenceKey,
          eventName: ruleSnapshot.eventName,
          occurredAt: occurredAt.toISOString(),
          // fromMe=true is always the workspace's team/bot sending from the
          // connected number; contacts never reach this branch.
          authorType: "organization_member",
          messageText,
        },
      };

      const decision = this.decisionEngine.evaluate(decisionInput);
      if (!decision) continue;
      evaluated = true;

      const deliveryId = await this.ensureDelivery({
        workspaceId: input.workspaceId,
        connectionId: bridged.connectionId,
        ingressKey: occurrenceKey,
      });
      const persistedDecision = await this.resolveDecision({
        decision,
        workspaceId: input.workspaceId,
        providerRuleId: rule.id,
        occurrenceKey,
        sourceDeliveryId: deliveryId,
      });
      const orchestration = await this.orchestrate({
        persistedDecision,
        config,
        rule,
        channel,
        occurredAt,
      });

      if (orchestration.eligibleExecutionId) {
        eligibleExecutionId = orchestration.eligibleExecutionId;
        await this.productionQueue.enqueueProviderConversion({
          providerConversionExecutionId: orchestration.eligibleExecutionId,
          workspaceId: input.workspaceId,
        });
      }
    }

    return { evaluated, eligibleExecutionId };
  }

  /**
   * Re-runs the orchestrator for an already frozen decision, without ever
   * evaluating the message again. This recovers occurrences that were audited
   * but left without a linked execution (the pre-fix observation path), and it
   * is the only safe way to do so: re-evaluating would try to freeze a second
   * `initial` decision and fail with `evaluation_key_conflict` as soon as the
   * rule snapshot or the lead resolution drifted. Nothing here talks to
   * WhatsApp; the contact is never messaged again.
   */
  async recoverDecision(input: {
    decisionId: string;
    workspaceId?: string;
    execute?: boolean;
  }): Promise<UazapiDecisionRecoveryResult> {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      throw new Error(
        "Inbound webhooks / conversion rules are disabled: nothing to recover",
      );
    }

    const decisionId = input.decisionId.trim();
    const audit = await this.prisma.providerConversionDecisionAudit.findFirst({
      where: {
        id: decisionId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      select: { id: true, workspaceId: true, providerRuleId: true },
    });
    if (!audit) {
      throw new Error(`Provider conversion decision not found: ${decisionId}`);
    }

    const persistedDecision = await this.decisions.findById({
      workspaceId: audit.workspaceId,
      decisionId: audit.id,
    });
    if (!persistedDecision) {
      throw new Error(`Provider conversion decision not found: ${decisionId}`);
    }
    if (persistedDecision.decision.occurrence.provider !== "uazapi") {
      throw new Error(
        `Decision ${decisionId} belongs to provider ${persistedDecision.decision.occurrence.provider}, not uazapi`,
      );
    }

    const rule = await this.prisma.providerConversionRuleConfig.findFirst({
      where: {
        id: persistedDecision.providerRuleId,
        workspaceId: persistedDecision.workspaceId,
      },
      include: ruleInclude,
    });
    if (!rule) {
      throw new Error(
        `Provider conversion rule not found: ${persistedDecision.providerRuleId}`,
      );
    }

    const channel = persistedDecision.channelId
      ? await this.prisma.inboundWebhookChannel.findFirst({
          where: {
            id: persistedDecision.channelId,
            workspaceId: persistedDecision.workspaceId,
          },
          select: { status: true, productionActivatedAt: true },
        })
      : null;

    const decision = persistedDecision.decision;
    const plan = this.dispositionPlan({
      persistedDecision,
      config,
      rule,
      channel,
      occurredAt: persistedDecision.occurredAt,
      manualRecovery: true,
    });
    const summary = {
      decisionId: persistedDecision.id,
      workspaceId: persistedDecision.workspaceId,
      providerRuleId: persistedDecision.providerRuleId,
      occurrenceKey: persistedDecision.occurrenceKey,
      decisionCode: persistedDecision.decisionCode,
      reasonCode: persistedDecision.reasonCode,
      ruleMode: decision.rule.mode,
      eventName: persistedDecision.eventName,
      valueCents: decision.conversion.valueCents ?? null,
      leadId: persistedDecision.leadId,
      disposition: plan.disposition,
    };

    if (input.execute !== true) {
      return {
        ...summary,
        mode: "dry-run",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        enqueued: false,
      };
    }

    const orchestration = await this.orchestrator.orchestrate({
      persistedDecision,
      disposition: plan.disposition,
      recordIgnoredObservation: plan.recordIgnoredObservation,
    });

    let enqueued = false;
    if (orchestration.eligibleExecutionId) {
      await this.productionQueue.enqueueProviderConversion({
        providerConversionExecutionId: orchestration.eligibleExecutionId,
        workspaceId: persistedDecision.workspaceId,
      });
      enqueued = true;
    }
    this.logger.log(
      JSON.stringify({
        event: "uazapi_provider_conversion_decision_recovered",
        ...summary,
        disposition: plan.disposition.state,
        executionId: orchestration.executionId,
        eligibleExecutionId: orchestration.eligibleExecutionId,
        enqueued,
      }),
    );

    return {
      ...summary,
      mode: "execute",
      executionId: orchestration.executionId,
      eligibleExecutionId: orchestration.eligibleExecutionId,
      reviewId: orchestration.reviewId,
      enqueued,
    };
  }

  /**
   * A webhook can arrive twice (provider retry, manual reprocess) for the same
   * occurrenceKey. The decision for an occurrence is frozen once and only an
   * explicit reevaluation may replace it, so a second `recordInitial` throws.
   * Reuse the frozen decision instead — same contract as the Umbler
   * observation path's `reuse` evaluation mode.
   */
  private async resolveDecision(input: {
    decision: ProviderConversionDecisionDto;
    workspaceId: string;
    providerRuleId: string;
    occurrenceKey: string;
    sourceDeliveryId: string;
  }): Promise<PersistedProviderConversionDecision> {
    const existing = await this.decisions.findLatestByOccurrence({
      workspaceId: input.workspaceId,
      providerRuleId: input.providerRuleId,
      occurrenceKey: input.occurrenceKey,
    });
    if (existing) return existing;

    try {
      return await this.decisions.recordInitial({
        decision: input.decision,
        sourceDeliveryId: input.sourceDeliveryId,
      });
    } catch (error) {
      // Concurrent delivery of the same occurrence won the advisory lock.
      if (!this.isFrozenDecisionConflict(error)) throw error;

      const raced = await this.decisions.findLatestByOccurrence({
        workspaceId: input.workspaceId,
        providerRuleId: input.providerRuleId,
        occurrenceKey: input.occurrenceKey,
      });
      if (raced) return raced;
      throw error;
    }
  }

  private isFrozenDecisionConflict(error: unknown): boolean {
    return (
      error instanceof ProviderConversionDecisionPersistenceError &&
      (error.code === "evaluation_key_conflict" ||
        error.code === "implicit_reevaluation_not_allowed")
    );
  }

  /**
   * Evaluates only newly-added UAZAPI chat labels. Production remains
   * paid-lead-only; observation records a matched unpaid label as a blocked
   * execution so Settings can show the validation result.
   */
  async evaluateLabels(
    input: UazapiLabelInput,
  ): Promise<UazapiTeamMessageResult> {
    const config = parseInboundWebhooksConfig(this.env);
    const phone = input.phone.trim();
    const labelIds = [
      ...new Set(input.labelIds.map((label) => label.trim()).filter(Boolean)),
    ];
    if (!config.enabled || !config.conversionRulesEnabled || !phone) {
      return { evaluated: false, eligibleExecutionId: null };
    }
    const contactKey = input.waChatId?.trim() || hashPhoneIdentity(phone);
    if (!contactKey) return { evaluated: false, eligibleExecutionId: null };
    const previous = await this.prisma.uazapiChatLabelState.findUnique({
      where: {
        workspaceId_whatsappInstanceId_contactKey: {
          workspaceId: input.workspaceId,
          whatsappInstanceId: input.instance.id,
          contactKey,
        },
      },
      select: { labelIds: true },
    });
    const previousIds = new Set(previous?.labelIds ?? []);
    const newIds = labelIds.filter((id) => !previousIds.has(id));
    await this.prisma.uazapiChatLabelState.upsert({
      where: {
        workspaceId_whatsappInstanceId_contactKey: {
          workspaceId: input.workspaceId,
          whatsappInstanceId: input.instance.id,
          contactKey,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        whatsappInstanceId: input.instance.id,
        contactKey,
        labelIds,
      },
      update: { labelIds },
    });
    if (newIds.length === 0 && !input.reportStageId)
      return { evaluated: false, eligibleExecutionId: null };

    const bridged = await this.bridge.ensureBridge(input.instance);
    const rules = await this.loadRules(
      input.workspaceId,
      bridged.connectionId,
      bridged.channelId,
      "provider_automation",
    );
    if (rules.length === 0)
      return { evaluated: false, eligibleExecutionId: null };

    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: { id: bridged.channelId, workspaceId: input.workspaceId },
      select: { status: true, productionActivatedAt: true },
    });
    if (!channel) return { evaluated: false, eligibleExecutionId: null };

    const leadResolution = await this.paidLeads.resolve({
      workspaceId: input.workspaceId,
      phone,
    });
    const reportContext = input.reportStageId
      ? await this.validReportContext(input)
      : null;
    if (input.reportStageId && !reportContext)
      return { evaluated: false, eligibleExecutionId: null };
    if (
      reportContext &&
      (leadResolution.status !== "resolved" ||
        leadResolution.lead.adId !== reportContext.expectedAdId ||
        leadResolution.lead.ctwaClid !== reportContext.expectedCtwaClid)
    )
      return { evaluated: false, eligibleExecutionId: null };
    const occurredAt =
      reportContext?.occurredAt ?? input.occurredAt ?? new Date();
    const externalEventId =
      reportContext?.id ||
      input.externalEventId?.trim() ||
      this.labelEventId(phone, labelIds, occurredAt);
    const catalog = reportContext
      ? []
      : await this.listLabelCatalog(input.instance);
    let evaluated = false;
    let eligibleExecutionId: string | null = null;

    for (const rule of rules) {
      if (
        rule.requiresReportContext &&
        (!reportContext || reportContext.providerRuleId !== rule.id)
      )
        continue;
      if (
        reportContext &&
        (!rule.requiresReportContext ||
          reportContext.providerRuleId !== rule.id)
      )
        continue;
      if (reportContext && !publishedRuleMatches(reportContext.stage, rule))
        continue;
      const ruleSnapshot = this.ruleSnapshot(rule, "provider_automation");
      const matched = this.matchLabels(
        rule,
        reportContext ? [reportContext.labelId!] : newIds,
        catalog,
      );
      if (!matched) continue;

      const occurrenceKey = reportContext
        ? `report-sync:${reportContext.id}`
        : `uazapi:label:${bridged.channelId}:${rule.id}:${contactKey}:${matched.id}:${externalEventId}`;
      const decision = this.decisionEngine.evaluate({
        parserVersion: PARSER_VERSION,
        rule: ruleSnapshot,
        catalog: null,
        leadResolution,
        contactIdentityHash: hashPhoneIdentity(phone) ?? null,
        occurrence: {
          source: "automation",
          provider: "uazapi",
          workspaceId: input.workspaceId,
          connectionId: bridged.connectionId,
          channelId: bridged.channelId,
          externalDeliveryId: null,
          externalEventId,
          externalMessageId: null,
          occurrenceKey,
          eventName: ruleSnapshot.eventName,
          occurredAt: occurredAt.toISOString(),
          authorType: null,
          automation: "label",
          labels: matched.matchKeys,
          matchedLabel: matched.name,
        },
      });
      if (!decision) continue;
      evaluated = true;
      const deliveryId = await this.ensureDelivery({
        workspaceId: input.workspaceId,
        connectionId: bridged.connectionId,
        ingressKey: occurrenceKey,
      });
      const persistedDecision = await this.resolveDecision({
        decision,
        workspaceId: input.workspaceId,
        providerRuleId: rule.id,
        occurrenceKey,
        sourceDeliveryId: deliveryId,
      });
      const orchestration = await this.orchestrate({
        persistedDecision,
        config,
        rule,
        channel,
        occurredAt,
      });
      if (orchestration.eligibleExecutionId) {
        eligibleExecutionId = orchestration.eligibleExecutionId;
        if (reportContext)
          await this.prisma.reportSyncStage.update({
            where: { id: reportContext.id },
            data: { executionId: eligibleExecutionId, status: "awaiting_meta" },
          });
        await this.productionQueue.enqueueProviderConversion({
          providerConversionExecutionId: eligibleExecutionId,
          workspaceId: input.workspaceId,
        });
      }
    }
    return { evaluated, eligibleExecutionId };
  }

  async evaluatePublishedLabels(input: UazapiLabelInput): Promise<void> {
    const config = readSyncConfig(this.env);
    if (
      !config ||
      config.mode !== "production" ||
      config.workspaceId !== input.workspaceId ||
      !config.bindings.some((b) => b.whatsappInstanceId === input.instance.id)
    )
      return;
    const stages = await this.prisma.reportSyncStage.findMany({
      where: {
        sourceId: config.sourceId,
        workspaceId: input.workspaceId,
        whatsappInstanceId: input.instance.id,
        contactKey: hashPhoneIdentity(input.phone),
        labelId: { in: input.labelIds },
        status: {
          in: ["label_verified", "decision_recorded", "awaiting_meta"],
        },
      },
    });
    for (const stage of stages)
      await this.evaluateLabels({ ...input, reportStageId: stage.id });
  }

  async resumeReportExecution(stageId: string): Promise<void> {
    const config = readSyncConfig(this.env);
    if (!config || config.mode !== "production") return;
    const stage = await this.prisma.reportSyncStage.findUnique({
      where: { id: stageId },
    });
    if (
      !stage?.executionId ||
      stage.sourceId !== config.sourceId ||
      stage.workspaceId !== config.workspaceId ||
      stage.status !== "awaiting_meta"
    )
      return;
    await this.productionQueue.enqueueProviderConversion({
      providerConversionExecutionId: stage.executionId,
      workspaceId: stage.workspaceId,
    });
  }

  private async validReportContext(input: UazapiLabelInput) {
    const config = readSyncConfig(this.env);
    if (
      !config ||
      config.mode !== "production" ||
      config.workspaceId !== input.workspaceId
    )
      return null;
    const stage = await this.prisma.reportSyncStage.findUnique({
      where: { id: input.reportStageId! },
    });
    if (
      !stage ||
      stage.sourceId !== config.sourceId ||
      stage.tenantId !== config.tenantId ||
      stage.workspaceId !== input.workspaceId ||
      stage.whatsappInstanceId !== input.instance.id ||
      stage.contactKey !== hashPhoneIdentity(input.phone) ||
      !stage.labelId ||
      !input.labelIds.includes(stage.labelId) ||
      !stage.occurredAt ||
      !["label_verified", "decision_recorded", "awaiting_meta"].includes(
        stage.status,
      ) ||
      !config.cutoverAt ||
      stage.occurredAt <= new Date(config.cutoverAt)
    )
      return null;
    const intent = stage.intentId
      ? await this.prisma.reportSyncIntent.findUnique({
          where: { id: stage.intentId },
        })
      : null;
    const source = await this.prisma.reportSyncSource.findUnique({
      where: { id: config.sourceId },
    });
    if (
      !intent ||
      intent.mode !== "production" ||
      !source?.baselineComplete ||
      source.cutoverAt?.toISOString() !==
        new Date(config.cutoverAt).toISOString()
    )
      return null;
    if (!this.reportPayloadEncryption) return null;
    let published: SyncIntent;
    try {
      published = JSON.parse(
        this.reportPayloadEncryption
          .decrypt(intent, {
            workspaceId: intent.workspaceId,
            connectionId: intent.sourceId,
            deliveryId: intent.id,
          })
          .toString("utf8"),
      ) as SyncIntent;
    } catch {
      return null;
    }
    const lead = await this.prisma.lead.findUnique({
      where: {
        workspaceId_phoneHash: {
          workspaceId: input.workspaceId,
          phoneHash: hashPhoneIdentity(input.phone)!,
        },
      },
    });
    if (
      !lead ||
      lead.whatsappInstanceId !== input.instance.id ||
      lead.adId !== published.lead.adId ||
      lead.ctwaClid !== published.lead.ctwaClid ||
      hashPhoneIdentity(published.lead.phone ?? undefined) !==
        hashPhoneIdentity(input.phone)
    )
      return null;
    return {
      ...stage,
      expectedAdId: published.lead.adId,
      expectedCtwaClid: published.lead.ctwaClid,
    };
  }

  private async orchestrate(input: {
    persistedDecision: PersistedProviderConversionDecision;
    config: ReturnType<typeof parseInboundWebhooksConfig>;
    rule: Rule;
    channel: { status: string; productionActivatedAt: Date | null } | null;
    occurredAt: Date;
  }): Promise<ProviderConversionOrchestrationResult> {
    const plan = this.dispositionPlan(input);

    return this.orchestrator.orchestrate({
      persistedDecision: input.persistedDecision,
      disposition: plan.disposition,
      recordIgnoredObservation: plan.recordIgnoredObservation,
    });
  }

  /**
   * A match that only fails the paid-lead gate is the operator's proof that
   * the trigger works. In observation mode we keep it visible as a blocked
   * execution (Settings reads the rule's last execution) instead of dropping
   * it as audit-only; production stays fail-closed and never materializes it.
   */
  private dispositionPlan(input: {
    persistedDecision: PersistedProviderConversionDecision;
    config: ReturnType<typeof parseInboundWebhooksConfig>;
    rule: Rule;
    channel: { status: string; productionActivatedAt: Date | null } | null;
    occurredAt: Date;
    manualRecovery?: boolean;
  }): {
    disposition: ProviderConversionTechnicalDisposition;
    recordIgnoredObservation: boolean;
  } {
    const decision = input.persistedDecision.decision;
    const recordIgnoredObservation =
      decision.decisionCode === "ignored_untracked_lead" &&
      decision.rule.mode === "observation";

    return {
      recordIgnoredObservation,
      disposition: recordIgnoredObservation
        ? { state: "blocked", reasonCode: decision.reasonCode }
        : this.disposition({
            config: input.config,
            // A recovery reuses the frozen decision for its event payload and
            // paid-lead result, but its technical disposition must follow the
            // mode the operator has enabled now. Otherwise an observation
            // execution can never be promoted after Envio ativo is enabled.
            decisionMode: input.manualRecovery
              ? input.rule.mode
              : decision.rule.mode,
            reasonCode: decision.reasonCode,
            rule: input.rule,
            channel: input.channel,
            occurredAt: input.occurredAt,
            manualRecovery: input.manualRecovery === true,
          }),
    };
  }

  private async loadRules(
    workspaceId: string,
    connectionId: string,
    channelId: string,
    triggerType: "message_phrase" | "provider_automation" = "message_phrase",
  ): Promise<Rule[]> {
    return this.prisma.providerConversionRuleConfig.findMany({
      where: {
        workspaceId,
        connectionId,
        removedAt: null,
        conversionRule: {
          active: true,
          triggerType,
        },
        channels: {
          some: { channelId },
        },
      },
      include: ruleInclude,
      orderBy: { createdAt: "asc" },
    });
  }

  private async ensureDelivery(input: {
    workspaceId: string;
    connectionId: string;
    ingressKey: string;
  }): Promise<string> {
    const existing = await this.prisma.inboundWebhookDelivery.findUnique({
      where: {
        connectionId_ingressKey: {
          connectionId: input.connectionId,
          ingressKey: input.ingressKey,
        },
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const receivedAt = new Date();
    try {
      const created = await this.prisma.inboundWebhookDelivery.create({
        data: {
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          provider: "uazapi",
          ingressKey: input.ingressKey,
          parserVersion: PARSER_VERSION,
          status: "processed",
          firstReceivedAt: receivedAt,
          lastReceivedAt: receivedAt,
          processedAt: receivedAt,
          payloadExpiresAt: new Date(
            receivedAt.getTime() +
              INBOUND_WEBHOOK_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
          ),
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.inboundWebhookDelivery.findUnique({
          where: {
            connectionId_ingressKey: {
              connectionId: input.connectionId,
              ingressKey: input.ingressKey,
            },
          },
          select: { id: true },
        });
        if (raced) return raced.id;
      }
      throw error;
    }
  }

  /**
   * Mirrors ProviderConversionObservationService's disposition() for the
   * message-source case: observation config off / rule in observation mode
   * -> observed; parser/connection/channel not production-ready -> blocked;
   * production not yet activated for the rule or channel at occurredAt ->
   * observed; otherwise eligible (CAPI queued by the caller).
   *
   * `observed` is not a no-op: the orchestrator persists it as an `observed`
   * execution, which the audit UI lists and the production pipeline ignores.
   *
   * Every blocking branch reports which live gate failed. Activating a rule
   * ("Envio ativo") only sets the rule's own mode/productionActivatedAt — it
   * never promotes the connection or the channel — so the single opaque
   * `production_context_invalid` left the operator guessing what to fix.
   */
  private disposition(input: {
    config: ReturnType<typeof parseInboundWebhooksConfig>;
    decisionMode: "observation" | "production";
    reasonCode: string;
    rule: Rule;
    channel: { status: string; productionActivatedAt: Date | null } | null;
    occurredAt: Date;
    manualRecovery: boolean;
  }): ProviderConversionTechnicalDisposition {
    if (
      !input.config.conversionProductionEnabled ||
      input.decisionMode !== "production"
    ) {
      return {
        state: "observed",
        reasonCode: `${input.reasonCode}_observation`,
      };
    }
    const blockedReason = this.productionContextBlock(input);
    if (blockedReason) {
      return { state: "blocked", reasonCode: blockedReason };
    }
    // Manual recovery replays an occurrence the operator picked by id after
    // enabling production, so the "don't backfill pre-activation traffic"
    // guard does not apply to it — same carve-out as the Umbler observation
    // service. The live path keeps the full date comparison.
    if (!input.rule.productionActivatedAt) {
      return {
        state: "observed",
        reasonCode: "rule_production_not_activated",
      };
    }
    if (
      !input.manualRecovery &&
      (!input.channel?.productionActivatedAt ||
        input.occurredAt < input.rule.productionActivatedAt ||
        input.occurredAt < input.channel.productionActivatedAt)
    ) {
      return { state: "observed", reasonCode: "before_production_activation" };
    }

    return { state: "eligible", reasonCode: input.reasonCode };
  }

  /**
   * Returns the specific live gate that blocks production for this rule, or
   * null when the production context is complete. Fail-closed: any unknown
   * state falls through to a blocking reason, never to eligibility.
   */
  private productionContextBlock(input: {
    rule: Rule;
    channel: { status: string; productionActivatedAt: Date | null } | null;
  }): string | null {
    const { rule, channel } = input;
    if (rule.parserRelease.status !== "certified") {
      return "rule_parser_not_certified";
    }
    if (rule.connection.parserRelease.status !== "certified") {
      return "connection_parser_not_certified";
    }
    if (rule.parserReleaseId !== rule.connection.parserReleaseId) {
      return "parser_release_mismatch";
    }
    if (rule.connection.removedAt !== null) {
      return "connection_removed";
    }
    if (rule.connection.status !== "production") {
      return "connection_not_production";
    }
    if (!channel) {
      return "channel_unresolved";
    }
    if (channel.status !== "active") {
      return "channel_not_active";
    }
    return null;
  }

  private ruleSnapshot(
    rule: Rule,
    triggerType: "message_phrase" | "provider_automation" = "message_phrase",
  ): ProviderConversionDecisionRuleSnapshotDto {
    const eventName = this.eventName(rule);
    const messagePhrase = readMessagePhraseConfig(
      rule.conversionRule.defaultItems,
    );

    return {
      providerRuleId: rule.id,
      conversionRuleId: rule.conversionRuleId,
      triggerType,
      eventName,
      mode: rule.mode,
      active: rule.conversionRule.active && rule.removedAt === null,
      authorScope: rule.messageAuthorScope,
      triggerPhrases: [
        ...rule.messageTriggerPhrases,
        ...(triggerType === "provider_automation"
          ? this.storedLabels(rule.conversionRule.defaultItems).flatMap(
              (label) => label.matchKeys,
            )
          : []),
      ],
      defaultValueCents: rule.conversionRule.defaultValueCents,
      defaultCurrency: rule.conversionRule.defaultCurrency,
      defaultContentName: rule.conversionRule.defaultContentName,
      valueMode: messagePhrase.valueMode,
      exampleMessage: messagePhrase.exampleMessage,
      version: `rule-v1:${rule.updatedAt.getTime()}:${rule.conversionRule.updatedAt.getTime()}`,
    };
  }

  private eventName(rule: Rule): ConversionEventNameDto {
    const eventName = conversionEventNameSchema.safeParse(
      rule.conversionRule.eventName,
    );
    // Fail closed on junk in the database, but accept every catalog event.
    if (!eventName.success) {
      throw new Error(
        `Unsupported uazapi conversion event: ${rule.conversionRule.eventName}`,
      );
    }
    return eventName.data;
  }

  private externalEventId(
    input: UazapiTeamMessageInput,
    occurredAt: Date,
  ): string {
    const trimmed = input.externalMessageId?.trim();
    if (trimmed) return trimmed;

    // No stable provider message id: fall back to a coarse (minute-bucket)
    // fingerprint so identical retried webhooks still dedupe.
    return createHash("sha256")
      .update(
        `${input.phone}\u0000${input.messageText}\u0000${occurredAt
          .toISOString()
          .slice(0, 16)}`,
        "utf8",
      )
      .digest("hex");
  }

  private labelEventId(
    phone: string,
    labels: string[],
    occurredAt: Date,
  ): string {
    return createHash("sha256")
      .update(
        `${phone}\u0000${labels.join("\u0000")}\u0000${occurredAt.toISOString().slice(0, 16)}`,
        "utf8",
      )
      .digest("hex");
  }

  private async listLabelCatalog(
    instance: UazapiBridgeInstance,
  ): Promise<Array<{ name: string; keys: string[] }>> {
    if (this.labelOperations) {
      const instanceConfig = await this.prisma.whatsappInstance.findUnique({
        where: { id: instance.id },
        select: { provider: true, configEncrypted: true },
      });
      if (instanceConfig?.provider === "uazapi_byo") {
        const labels = await this.labelOperations.listCatalog(
          instance.workspaceId,
          instance.id,
        );
        return labels.map((label) => ({
          name: label.name.trim(),
          keys: this.labelKeys(label.id),
        }));
      }
    }
    const uazapiByo = this.whatsappProviders.require("uazapi_byo");
    if (!uazapiByo.listLabels) {
      throw new Error(
        'WhatsApp provider "uazapi_byo" does not implement listLabels',
      );
    }

    const result = await uazapiByo.listLabels(
      instance.providerInstanceId ?? instance.id,
      this.instanceToken(instance),
    );
    return result.labels.map((label) => ({
      name: label.name.trim(),
      keys: this.labelKeys(label.id),
    }));
  }

  private instanceToken(instance: UazapiBridgeInstance): string | undefined {
    if (
      !instance.providerTokenEncrypted ||
      !instance.providerTokenIv ||
      !instance.providerTokenTag
    )
      return undefined;
    return this.tokenEncryption.decrypt({
      encryptedAccessToken: instance.providerTokenEncrypted,
      tokenIv: instance.providerTokenIv,
      tokenTag: instance.providerTokenTag,
    });
  }

  private matchLabels(
    rule: Rule,
    newIds: string[],
    catalog: Array<{ name: string; keys: string[] }>,
  ): { id: string; name: string; matchKeys: string[] } | null {
    const stored = this.storedLabels(rule.conversionRule.defaultItems);
    for (const id of newIds) {
      const keys = this.labelKeys(id);
      const catalogName = catalog.find((label) =>
        label.keys.some((key) => keys.includes(key)),
      )?.name;
      const configured =
        stored.find((label) =>
          label.matchKeys.some((key) => keys.includes(key)),
        ) ??
        (catalogName
          ? stored.find((label) => this.sameName(label.name, catalogName))
          : undefined);
      if (
        configured ||
        (catalogName &&
          rule.messageTriggerPhrases.some((phrase) =>
            this.sameName(phrase, catalogName),
          ))
      ) {
        return {
          id,
          name: configured?.name ?? catalogName ?? id,
          matchKeys: keys,
        };
      }
    }
    return null;
  }

  private storedLabels(
    value: Prisma.JsonValue | null,
  ): Array<{ name: string; matchKeys: string[] }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const raw = (value as Record<string, unknown>).uazapiLabels;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const matchKeys = Array.isArray(value.matchKeys)
        ? value.matchKeys
            .filter((key): key is string => typeof key === "string")
            .flatMap((key) => this.labelKeys(key))
        : [];
      return name ? [{ name, matchKeys }] : [];
    });
  }

  private labelKeys(id: string): string[] {
    const normalized = id.trim();
    const localId = normalized.includes(":")
      ? normalized.split(":").pop()!
      : normalized;
    return [...new Set([normalized, localId])];
  }

  private sameName(left: string, right: string): boolean {
    return (
      left
        .replace(/\u200e/g, "")
        .trim()
        .toLocaleLowerCase("pt-BR") ===
      right
        .replace(/\u200e/g, "")
        .trim()
        .toLocaleLowerCase("pt-BR")
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}
