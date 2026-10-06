import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  conversionEventCarriesValue,
  conversionEventDedupeMode,
  conversionEventMetaEventIdPrefix,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  providerConversionDecisionSchema,
  type ConversionEventNameDto,
  type ProviderConversionDecisionDto,
  type ProviderConversionTechnicalDeliveryStateDto,
  type StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
// rastrackdash sanitize (rewrite_rules.external-channel-billing-access-stub):
// billing/ is stripped in this edition; ExternalChannelBillingAccessService
// was a REQUIRED (non-@Optional) constructor dependency here, so removing
// just the import isn't enough — this local always-allow stand-in matches
// ExternalChannelBillingAccessService.isEnforced() === false once
// PackageBillingConfiguration is gone, and keeps
// ExternalChannelBillingAccessError as a real class so the existing
// instanceof error-code narrowing below still compiles (it is now
// unreachable, since assertProductionAccess() never throws).
class ExternalChannelBillingAccessError extends Error {
  constructor(readonly code: string) {
    super("External WhatsApp channel billing access denied");
    this.name = "ExternalChannelBillingAccessError";
  }
}
class ExternalChannelBillingAccessStub {
  async assertProductionAccess(
    _workspaceId: string,
    _channelId: string,
  ): Promise<void> {
    // no-op: external-channel billing enforcement is always disabled once
    // billing/ is removed.
  }
}
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import type { SyncIntent } from '../report-sync/report-sync.contract';
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { ProviderConversionProductionJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  readSyncConfig,
  publishedRuleMatches,
} from "../report-sync/report-sync.contract";
import { ConversionCatalogService } from "../conversion-rules/conversion-catalog.service";
import {
  matchProviderMessageTrigger,
  providerMessageAuthorAllowed,
} from "../conversion-rules/structured-catalog-message.parser";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import {
  parseUmblerAutomationV1,
  type ParsedUmblerAutomationV1,
  UMBLER_AUTOMATION_V1_PARSER_VERSION,
} from "../inbound-webhooks/providers/umbler/umbler-automation-v1.parser";

const PURCHASE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const terminalStatuses = new Set(["materialized", "duplicate", "blocked"]);
const executionInclude = {
  providerRule: {
    include: {
      conversionRule: true,
      parserRelease: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      channels: true,
      catalog: {
        include: {
          variants: true,
        },
      },
    },
  },
  sourceDelivery: true,
  channel: true,
  purchaseReview: {
    include: {
      items: { orderBy: { position: "asc" } },
    },
  },
  providerDecision: true,
} satisfies Prisma.ProviderConversionRuleExecutionInclude;

type ExecutionRecord = Prisma.ProviderConversionRuleExecutionGetPayload<{
  include: typeof executionInclude;
}>;
type EligibleProviderConversionDecision = Extract<
  ProviderConversionDecisionDto,
  { decisionCode: "eligible" }
>;

export class ProviderConversionProductionFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super("Provider conversion production failed");
    this.name = "ProviderConversionProductionFailure";
  }
}

@Injectable()
export class ProviderConversionProductionService {
  private readonly billingAccess = new ExternalChannelBillingAccessStub();

  private readonly logger = new Logger(
    ProviderConversionProductionService.name,
  );

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(ConversionCatalogService)
    private readonly catalogs: ConversionCatalogService,
    @Inject(InboundWebhookMetaRouteReaderService)
    private readonly routes: InboundWebhookMetaRouteReaderService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async processExecution(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): Promise<{ status: "materialized" | "duplicate" | "unchanged" }> {
    this.assertInput(input);
    if (!this.productionEnabled()) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_disabled",
      );
    }

    const execution = await this.loadExecution(input);
    if (!execution) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_execution_not_found",
      );
    }
    if (execution.providerRule.requiresReportContext) {
      const config = readSyncConfig(this.env);
      const stage = await this.prisma.reportSyncStage.findFirst({
        where: {
          workspaceId: execution.workspaceId,
          providerRuleId: execution.providerRuleId,
          executionId: execution.id,
        },
      });
      if (
        !config ||
        config.mode !== "production" ||
        config.workspaceId !== execution.workspaceId ||
        !stage ||
        !publishedRuleMatches(stage.stage, execution.providerRule) ||
        stage.sourceId !== config.sourceId ||
        !stage.occurredAt ||
        stage.occurredAt.getTime() !== execution.occurredAt.getTime() ||
        !config.cutoverAt ||
        stage.occurredAt <= new Date(config.cutoverAt)
      ) {
        throw new ProviderConversionProductionFailure(
          "report_context_not_active",
          true,
        );
      }
      const intent=stage.intentId?await this.prisma.reportSyncIntent.findUnique({where:{id:stage.intentId}}):null;
      let published:SyncIntent|null=null;
      try {if(intent)published=JSON.parse(this.payloadEncryption.decrypt(intent,{workspaceId:intent.workspaceId,connectionId:intent.sourceId,deliveryId:intent.id}).toString('utf8')) as SyncIntent;}catch{/* fail closed below */}
      const currentLead=execution.leadId?await this.prisma.lead.findFirst({where:{id:execution.leadId,workspaceId:execution.workspaceId}}):null;
      if(!published || !currentLead || currentLead.adId!==published.lead.adId || currentLead.ctwaClid!==published.lead.ctwaClid || currentLead.whatsappInstanceId!==stage.whatsappInstanceId || currentLead.phoneHash!==stage.contactKey) {
        await this.prisma.providerConversionRuleExecution.update({where:{id:execution.id},data:{status:'blocked',reasonCode:'report_attribution_changed'}});
        await this.prisma.reportSyncStage.update({where:{id:stage.id},data:{status:'blocked',reasonCode:'report_attribution_changed'}});
        return {status:'unchanged'};
      }
    }
    if (execution.status === "materialized") {
      await this.enqueueMaterialized(execution);
      return { status: "unchanged" };
    }
    if (terminalStatuses.has(execution.status)) {
      return { status: "unchanged" };
    }
    if (!["eligible", "failed"].includes(execution.status)) {
      return { status: "unchanged" };
    }
    if (
      execution.status === "failed" &&
      execution.providerDecision &&
      !this.retryableTechnicalFailure(execution.normalizedResult)
    ) {
      return { status: "unchanged" };
    }

    await this.prisma.providerConversionRuleExecution.update({
      where: { id: execution.id },
      data: {
        attemptCount: { increment: 1 },
        lastAttemptedAt: new Date(),
        reasonCode: null,
        ...(execution.providerDecision
          ? {
              normalizedResult: this.withTechnicalDelivery(
                execution.normalizedResult,
                {
                  state: "queued",
                  retryable: false,
                  reasonCode: null,
                },
              ),
            }
          : {}),
      },
    });

    try {
      const materialized = await this.materialize(execution);
      if (materialized.status === "duplicate") {
        return materialized;
      }

      if (materialized.queueRequired) {
        await this.conversionQueue.enqueueSend(
          materialized.conversionEventLogId,
          execution.workspaceId,
        );
      }
      return { status: "materialized" };
    } catch (error) {
      const code = this.errorCode(error);
      const failure = this.failureSummary(error, code);
      const disposition = this.failureDisposition(code);
      await this.prisma.providerConversionRuleExecution.updateMany({
        where: {
          id: execution.id,
          workspaceId: execution.workspaceId,
          status: { in: ["eligible", "failed"] },
        },
        data: {
          status: disposition.executionStatus,
          reasonCode: code,
          processedAt: new Date(),
          normalizedResult: this.withProductionFailure(
            execution.normalizedResult,
            failure,
            disposition,
          ),
        },
      });
      await this.prisma.purchaseReview.updateMany({
        where: {
          providerExecutionId: execution.id,
          workspaceId: execution.workspaceId,
          status: { in: ["recognized", "approved", "failed"] },
        },
        data: {
          status: "failed",
          reasonCode: code,
          version: { increment: 1 },
        },
      });
      if (code === "provider_conversion_production_unexpected") {
        this.logger.error(
          `Provider conversion ${execution.id} failed with ${code}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw new ProviderConversionProductionFailure(
        code,
        disposition.retryable,
      );
    }
  }

  private async materialize(execution: ExecutionRecord): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
      }
  > {
    if (!execution.channelId) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }

    await this.billingAccess.assertProductionAccess(
      execution.workspaceId,
      execution.channelId,
    );

    if (execution.providerDecision) {
      return this.materializeFrozenDecision(
        execution,
        this.frozenDecision(execution),
      );
    }

    if (
      execution.providerRule.conversionRule.triggerType ===
      "provider_automation"
    ) {
      return this.materializeAutomation(execution);
    }

    this.assertProductionContext(execution);
    const parsedEvent = this.reparseEvent(execution);
    const match = await this.matchExecution(execution, parsedEvent);
    const manualOverride = execution.purchaseReview?.status === "approved";
    const purchase = manualOverride
      ? this.reviewPurchase(execution)
      : this.matchedPurchase(match);

    if (
      !purchase ||
      (!manualOverride && !this.matchConsistent(execution, match))
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_catalog_mismatch",
      );
    }
    if (!execution.contactIdentityHash) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_identity_missing",
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: {
        workspaceId: execution.workspaceId,
        phoneHash: execution.contactIdentityHash,
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });
    if (!lead?.adId || !lead.ctwaClid) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_paid_lead_missing",
      );
    }

    const route = await this.routes.previewRoute({
      workspaceId: execution.workspaceId,
      adId: lead.adId,
    });
    if (
      route.status !== "resolved" ||
      !route.reportingAccountId ||
      !route.adAccountId ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const lock = this.lockKeys(
      execution.workspaceId,
      lead.phoneHash,
      "Purchase",
    );
    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: { status: true },
        });
      if (current?.status === "materialized") {
        return {
          status: "materialized" as const,
          conversionEventLogId: execution.conversionEventLogId!,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const duplicate =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: { not: execution.id },
            workspaceId: execution.workspaceId,
            contactIdentityHash: lead.phoneHash,
            status: "materialized",
            occurredAt: {
              gt: new Date(
                execution.occurredAt.getTime() - PURCHASE_DEDUPE_WINDOW_MS,
              ),
              lt: new Date(
                execution.occurredAt.getTime() + PURCHASE_DEDUPE_WINDOW_MS,
              ),
            },
            providerRule: {
              conversionRule: { eventName: "Purchase" },
            },
          },
          select: { id: true },
        });

      if (duplicate) {
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode: "purchase_within_24h",
            leadId: lead.id,
            processedAt: new Date(),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode: "purchase_within_24h",
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId: parsedEvent.externalMessageId,
          sourceTrigger: `inbound_webhook:umbler:${execution.providerRule.conversionRule.triggerType}`,
          eventName: "Purchase",
          eventId: this.metaEventId(execution.id, "Purchase"),
          dedupeKey: `provider-conversion:${execution.id}`,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents: purchase.valueCents,
          valueSource: "actual",
          currency: purchase.currency,
          contentName: purchase.contentName,
          eventOccurredAt: execution.occurredAt,
          sourcePayload: {
            provider: "umbler",
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            catalogVariantId: match.catalogVariantId,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            items: purchase.items,
            manualReviewOverride: manualOverride,
            processingMode: "live_provider_conversion",
          },
        },
        transaction,
      );

      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          processedAt: new Date(),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: purchase.valueCents,
            currency: purchase.currency,
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired: conversion.deliveryStatus === "ready_to_send",
      };
    });

    return result;
  }

  private async materializeFrozenDecision(
    execution: ExecutionRecord,
    decision: EligibleProviderConversionDecision,
  ): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
      }
  > {
    const lead = decision.leadResolution.lead;
    const occurrence = decision.occurrence;
    const eventName = this.supportedEventName(occurrence.eventName);
    // The catalog decides whether the event may travel with a value at all;
    // only "required" events are refused when the frozen decision has none.
    const requiresValue = conversionEventRequiresValue(eventName);
    const carriesValue = conversionEventCarriesValue(eventName);
    const valueCents = carriesValue ? decision.conversion.valueCents : null;
    const currency = carriesValue ? decision.conversion.currency : null;

    if (
      (requiresValue && (!valueCents || !currency)) ||
      !occurrence.businessDedupePolicy
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_frozen_decision_invalid",
      );
    }

    const route = await this.routes.previewRoute({
      workspaceId: execution.workspaceId,
      adId: lead.adId,
    });
    if (
      route.status !== "resolved" ||
      !route.reportingAccountId ||
      !route.adAccountId ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const dedupePolicy = occurrence.businessDedupePolicy;
    const lock = this.lockKeys(
      execution.workspaceId,
      dedupePolicy.scopeKey,
      eventName,
    );
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: {
            status: true,
            conversionEventLogId: true,
          },
        });
      if (current?.status === "materialized") {
        if (!current.conversionEventLogId) {
          throw new ProviderConversionProductionFailure(
            "provider_conversion_materialized_event_missing",
          );
        }
        return {
          status: "materialized" as const,
          conversionEventLogId: current.conversionEventLogId,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const occurredAt = new Date(occurrence.occurredAt);
      const duplicateWhere: Prisma.ProviderConversionRuleExecutionWhereInput = {
        id: { not: execution.id },
        workspaceId: execution.workspaceId,
        status: "materialized",
        OR: [
          {
            providerDecision: {
              is: {
                businessDedupeScopeKey: dedupePolicy.scopeKey,
              },
            },
          },
          {
            providerDecisionId: null,
            contactIdentityHash: lead.phoneHash,
            providerRule: {
              conversionRule: { eventName },
            },
          },
        ],
        ...(dedupePolicy.mode === "rolling_window"
          ? {
              occurredAt: {
                gt: new Date(
                  occurredAt.getTime() - dedupePolicy.windowSeconds * 1_000,
                ),
                lt: new Date(
                  occurredAt.getTime() + dedupePolicy.windowSeconds * 1_000,
                ),
              },
            }
          : {}),
      };
      const duplicate =
        await transaction.providerConversionRuleExecution.findFirst({
          where: duplicateWhere,
          select: { id: true },
        });

      if (duplicate) {
        const reasonCode =
          dedupePolicy.mode === "rolling_window"
            ? "purchase_within_24h"
            : "qualified_lead_already_materialized";
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode,
            leadId: lead.id,
            processedAt: new Date(),
            normalizedResult: this.withTechnicalDelivery(
              execution.normalizedResult,
              {
                state: "sent",
                retryable: false,
                reasonCode,
              },
            ),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode,
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const sourceEventId =
        occurrence.externalMessageId ??
        occurrence.externalEventId ??
        occurrence.occurrenceKey;
      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId,
          sourceTrigger: `inbound_webhook:${occurrence.provider}:${decision.rule.triggerType}`,
          eventName,
          eventId: this.metaEventId(execution.id, eventName),
          dedupeKey: `provider-conversion:${execution.id}`,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents,
          valueSource: valueCents ? this.decisionValueSource(decision) : null,
          currency,
          contentName: carriesValue ? decision.conversion.contentName : null,
          eventOccurredAt: occurredAt,
          sourcePayload: {
            provider: occurrence.provider,
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            providerConversionDecisionId: execution.providerDecisionId,
            providerConversionDecisionVersion:
              execution.providerDecision?.decisionVersion ?? null,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            occurrenceKey: occurrence.occurrenceKey,
            parserVersion: decision.parserVersion,
            decisionEngineVersion: decision.engineVersion,
            triggerType: decision.rule.triggerType,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            items: decision.conversion.items,
            observedPaymentValueCents:
              decision.conversion.observedPaymentValueCents,
            processingMode: "frozen_provider_conversion",
          },
        },
        transaction,
      );

      const queueRequired = conversion.deliveryStatus === "ready_to_send";
      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          processedAt: new Date(),
          normalizedResult: this.withTechnicalDelivery(
            execution.normalizedResult,
            {
              state: queueRequired ? "queued" : "sent",
              retryable: false,
              reasonCode: null,
            },
          ),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: valueCents,
            currency: currency ?? "BRL",
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired,
      };
    });
  }

  private async materializeAutomation(execution: ExecutionRecord): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
      }
  > {
    this.assertAutomationProductionContext(execution);
    const parsed = this.reparseAutomation(execution);
    const rule = execution.providerRule.conversionRule;
    const contactIdentityHash = hashPhoneIdentity(parsed.phone);

    if (
      parsed.externalExecutionKey !== execution.externalExecutionKey ||
      parsed.eventName !== rule.eventName ||
      !contactIdentityHash ||
      contactIdentityHash !== execution.contactIdentityHash
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_source_event_mismatch",
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: {
        workspaceId: execution.workspaceId,
        phoneHash: contactIdentityHash,
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });
    if (!lead?.adId || !lead.ctwaClid) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_paid_lead_missing",
      );
    }

    const route = await this.routes.previewRoute({
      workspaceId: execution.workspaceId,
      adId: lead.adId,
    });
    if (
      route.status !== "resolved" ||
      !route.reportingAccountId ||
      !route.adAccountId ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const eventName = this.supportedEventName(parsed.eventName);
    const carriesValue = conversionEventCarriesValue(eventName);
    const valueCents = carriesValue ? rule.defaultValueCents : null;
    const currency = carriesValue ? rule.defaultCurrency : null;
    if (conversionEventRequiresValue(eventName) && (!valueCents || !currency)) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_value_missing",
      );
    }
    // Events that only make sense once per lead (QualifiedLead, LeadSubmitted)
    // dedupe for a lifetime; the rest keeps the 24h rolling window.
    const rollingWindow = conversionEventDedupeMode(eventName) !== "lifetime";

    const lock = this.lockKeys(
      execution.workspaceId,
      lead.phoneHash,
      parsed.eventName,
    );
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: { status: true },
        });
      if (current?.status === "materialized") {
        return {
          status: "materialized" as const,
          conversionEventLogId: execution.conversionEventLogId!,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const duplicate =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: { not: execution.id },
            workspaceId: execution.workspaceId,
            contactIdentityHash: lead.phoneHash,
            status: "materialized",
            ...(rollingWindow
              ? {
                  occurredAt: {
                    gt: new Date(
                      execution.occurredAt.getTime() -
                        PURCHASE_DEDUPE_WINDOW_MS,
                    ),
                    lt: new Date(
                      execution.occurredAt.getTime() +
                        PURCHASE_DEDUPE_WINDOW_MS,
                    ),
                  },
                }
              : {}),
            providerRule: {
              conversionRule: { eventName: parsed.eventName },
            },
          },
          select: { id: true },
        });

      if (duplicate) {
        const reasonCode = rollingWindow
          ? "purchase_within_24h"
          : "qualified_lead_already_materialized";
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode,
            leadId: lead.id,
            processedAt: new Date(),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode,
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId: parsed.externalExecutionKey,
          sourceTrigger: "inbound_webhook:umbler:provider_automation",
          eventName: parsed.eventName,
          eventId: this.metaEventId(execution.id, parsed.eventName),
          dedupeKey: `provider-conversion:${execution.id}`,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents,
          valueSource: valueCents ? "configured_average" : null,
          currency,
          contentName: carriesValue ? rule.defaultContentName : null,
          eventOccurredAt: execution.occurredAt,
          sourcePayload: {
            provider: "umbler",
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            automation: parsed.automation,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            processingMode: "live_provider_automation",
          },
        },
        transaction,
      );

      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          processedAt: new Date(),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: valueCents,
            currency: currency ?? "BRL",
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired: conversion.deliveryStatus === "ready_to_send",
      };
    });
  }

  private async matchExecution(
    execution: ExecutionRecord,
    event: ParsedInboundWebhookEvent,
  ): Promise<StructuredCatalogTestMessageResultDto> {
    if (
      execution.providerRule.conversionRule.triggerType === "structured_catalog"
    ) {
      return this.catalogs.matchRuleMessage(
        execution.workspaceId,
        execution.providerRuleId,
        event.message.text!,
      );
    }

    const rule = execution.providerRule;
    const matchedTriggerPhrase = matchProviderMessageTrigger(
      event.message.text!,
      rule.messageTriggerPhrases,
    );
    const valueCents = rule.conversionRule.defaultValueCents;
    const currency = rule.conversionRule.defaultCurrency;
    const matched = Boolean(matchedTriggerPhrase && valueCents && currency);

    return {
      matched,
      reasonCode: matched ? "matched" : "trigger_missing",
      classification: matched ? "recognized" : "ignored",
      matchedTriggerPhrase,
      parsedAttributes: [],
      items: [],
      parsedValueCents: matched ? valueCents : null,
      calculatedValueCents: matched ? valueCents : null,
      observedPaymentValueCents: null,
      catalogVariantId: null,
      contentName: rule.conversionRule.defaultContentName,
      currency,
    };
  }

  private matchConsistent(
    execution: ExecutionRecord,
    match: StructuredCatalogTestMessageResultDto,
  ): boolean {
    if (
      !match.matched ||
      match.calculatedValueCents !== execution.valueCents ||
      match.currency !== execution.currency
    ) {
      return false;
    }

    const normalized = this.jsonObject(execution.normalizedResult);
    return this.jsonEquals(normalized?.items, match.items);
  }

  private matchedPurchase(match: StructuredCatalogTestMessageResultDto): {
    valueCents: number;
    currency: string;
    contentName: string | null;
    items: unknown[];
  } | null {
    if (!match.matched || !match.calculatedValueCents || !match.currency) {
      return null;
    }

    return {
      valueCents: match.calculatedValueCents,
      currency: match.currency,
      contentName: match.contentName,
      items: match.items,
    };
  }

  private reviewPurchase(execution: ExecutionRecord): {
    valueCents: number;
    currency: string;
    contentName: string | null;
    items: unknown[];
  } | null {
    const review = execution.purchaseReview;
    const catalogPurchase =
      execution.providerRule.conversionRule.triggerType ===
      "structured_catalog";
    if (
      !review?.effectiveValueCents ||
      (catalogPurchase && review.items.length === 0)
    ) {
      return null;
    }

    const items = review.items.map((item) => ({
      catalogVariantId: item.catalogVariantId,
      attributeValues: this.stringArray(item.attributeValues),
      quantity: item.quantity,
      unitValueCents: item.unitValueCents,
      subtotalValueCents: item.subtotalValueCents,
      contentName: item.contentName,
    }));
    if (
      catalogPurchase &&
      items.some(
        (item) =>
          !item.catalogVariantId ||
          !item.unitValueCents ||
          !item.subtotalValueCents,
      )
    ) {
      return null;
    }

    const names = [
      ...new Set(
        items
          .map((item) => item.contentName)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    return {
      valueCents: review.effectiveValueCents,
      currency: review.currency,
      contentName:
        names.length === 1
          ? names[0]
          : execution.providerRule.conversionRule.defaultContentName,
      items,
    };
  }

  private frozenDecision(
    execution: ExecutionRecord,
  ): EligibleProviderConversionDecision {
    const audit = execution.providerDecision;
    const parsed = providerConversionDecisionSchema.safeParse(
      audit?.decisionJson,
    );
    if (
      !audit ||
      !parsed.success ||
      parsed.data.decisionCode !== "eligible" ||
      audit.id !== execution.providerDecisionId ||
      audit.workspaceId !== execution.workspaceId ||
      audit.providerRuleId !== execution.providerRuleId ||
      audit.sourceDeliveryId !== execution.sourceDeliveryId ||
      audit.decisionCode !== "eligible" ||
      audit.occurrenceKey !== execution.externalExecutionKey ||
      audit.eventName !== parsed.data.occurrence.eventName ||
      audit.occurredAt.getTime() !==
        new Date(parsed.data.occurrence.occurredAt).getTime() ||
      parsed.data.occurrence.workspaceId !== execution.workspaceId ||
      parsed.data.occurrence.occurrenceKey !== execution.externalExecutionKey ||
      parsed.data.rule.providerRuleId !== execution.providerRuleId ||
      parsed.data.leadResolution.lead.id !== audit.leadId ||
      (execution.leadId !== null &&
        execution.leadId !== parsed.data.leadResolution.lead.id)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_frozen_decision_mismatch",
      );
    }

    return parsed.data;
  }

  private jsonObject(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private withTechnicalDelivery(
    value: Prisma.JsonValue | null,
    technicalDelivery: {
      state: ProviderConversionTechnicalDeliveryStateDto;
      retryable: boolean;
      reasonCode: string | null;
    },
  ): Prisma.InputJsonValue {
    return {
      ...(this.jsonObject(value) ?? {}),
      technicalDelivery: {
        ...technicalDelivery,
        updatedAt: new Date().toISOString(),
      },
    } as Prisma.InputJsonValue;
  }

  private withProductionFailure(
    value: Prisma.JsonValue | null,
    failure: Prisma.InputJsonValue,
    disposition: {
      executionStatus: "blocked" | "failed";
      state: "blocked_configuration" | "failed_retryable" | "failed_permanent";
      retryable: boolean;
    },
  ): Prisma.InputJsonValue {
    const withTechnicalDelivery = this.withTechnicalDelivery(value, {
      state: disposition.state,
      retryable: disposition.retryable,
      reasonCode:
        this.jsonObject(failure as Prisma.JsonValue)?.code?.toString() ?? null,
    });

    return {
      ...(this.jsonObject(withTechnicalDelivery as Prisma.JsonValue) ?? {}),
      lastProductionFailure: failure,
    } as Prisma.InputJsonValue;
  }

  private retryableTechnicalFailure(value: Prisma.JsonValue | null): boolean {
    const normalized = this.jsonObject(value);
    const technicalDelivery = this.jsonObject(
      (normalized?.technicalDelivery ?? null) as Prisma.JsonValue | null,
    );

    return (
      technicalDelivery?.state === "failed_retryable" &&
      technicalDelivery.retryable === true
    );
  }

  private failureDisposition(code: string): {
    executionStatus: "blocked" | "failed";
    state: "blocked_configuration" | "failed_retryable" | "failed_permanent";
    retryable: boolean;
  } {
    if (code.startsWith("external_channel_billing_")) {
      return {
        executionStatus: "failed",
        state: "failed_retryable",
        retryable: true,
      };
    }

    if (
      code === "provider_conversion_production_context_invalid" ||
      code.startsWith("provider_conversion_route_")
    ) {
      return {
        executionStatus: "blocked",
        state: "blocked_configuration",
        retryable: false,
      };
    }
    if (code === "provider_conversion_production_unexpected") {
      return {
        executionStatus: "failed",
        state: "failed_retryable",
        retryable: true,
      };
    }

    return {
      executionStatus: "failed",
      state: "failed_permanent",
      retryable: false,
    };
  }

  private jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  private automationManualReplayApproved(execution: ExecutionRecord): boolean {
    const normalized = this.jsonObject(execution.normalizedResult);
    const approval = this.jsonObject(
      (normalized?.manualReplayApproval ?? null) as Prisma.JsonValue | null,
    );
    const approvedAt = approval?.approvedAt ?? approval?.attemptedAt;

    return (
      approval?.approved === true &&
      this.identifier(approval.actorUserId) &&
      typeof approvedAt === "string"
    );
  }

  private stringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private assertProductionContext(execution: ExecutionRecord): void {
    const rule = execution.providerRule;
    const delivery = execution.sourceDelivery;
    const channel = execution.channel;
    const manuallyApproved = execution.purchaseReview?.status === "approved";
    const channelScoped = rule.channels.some(
      (scope) => scope.channelId === execution.channelId,
    );

    if (
      rule.removedAt ||
      !rule.conversionRule.active ||
      !["structured_catalog", "message_phrase"].includes(
        rule.conversionRule.triggerType,
      ) ||
      // Legacy path only: executions without a frozen decision are reparsed
      // and always materialized as Purchase, so no other event may enter here.
      rule.conversionRule.eventName !== "Purchase" ||
      (!manuallyApproved && rule.mode !== "production") ||
      (!manuallyApproved && !rule.productionActivatedAt) ||
      rule.parserRelease.status !== "certified" ||
      rule.connection.removedAt ||
      rule.connection.status !== "production" ||
      rule.connection.parserRelease.status !== "certified" ||
      rule.connectionId !== delivery.connectionId ||
      rule.parserReleaseId !== rule.connection.parserReleaseId ||
      rule.connection.parserRelease.version !== delivery.parserVersion ||
      !channel ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      !channelScoped ||
      (!manuallyApproved &&
        rule.productionActivatedAt !== null &&
        delivery.firstReceivedAt < rule.productionActivatedAt) ||
      delivery.firstReceivedAt < channel.productionActivatedAt
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
  }

  private assertAutomationProductionContext(execution: ExecutionRecord): void {
    const rule = execution.providerRule;
    const delivery = execution.sourceDelivery;
    const channel = execution.channel;
    const manuallyApproved = this.automationManualReplayApproved(execution);
    const channelScoped = rule.channels.some(
      (scope) => scope.channelId === execution.channelId,
    );

    if (
      rule.removedAt ||
      !rule.conversionRule.active ||
      rule.conversionRule.triggerType !== "provider_automation" ||
      rule.mode !== "production" ||
      !rule.productionActivatedAt ||
      rule.parserRelease.status !== "certified" ||
      rule.parserRelease.version !== UMBLER_AUTOMATION_V1_PARSER_VERSION ||
      rule.connection.removedAt ||
      rule.connection.status !== "production" ||
      rule.connection.parserRelease.status !== "certified" ||
      rule.connectionId !== delivery.connectionId ||
      delivery.parserVersion !== UMBLER_AUTOMATION_V1_PARSER_VERSION ||
      delivery.purpose !== "conversion_automation" ||
      delivery.providerRuleEndpointId === null ||
      !channel ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      !channelScoped ||
      (!manuallyApproved &&
        delivery.firstReceivedAt < rule.productionActivatedAt) ||
      (!manuallyApproved &&
        delivery.firstReceivedAt < channel.productionActivatedAt)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
  }

  private reparseAutomation(
    execution: ExecutionRecord,
  ): ParsedUmblerAutomationV1 {
    const parsed = parseUmblerAutomationV1(this.decryptedPayload(execution));
    if (!parsed.ok) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_invalid",
      );
    }
    return parsed.value;
  }

  private reparseEvent(execution: ExecutionRecord): ParsedInboundWebhookEvent {
    const payload = this.decryptedPayload(execution);

    const rule = execution.providerRule;
    const parser = this.parserRegistry.resolve({
      provider: rule.connection.provider,
      parserVersion: rule.connection.parserRelease.version,
      parserReleaseStatus: rule.connection.parserRelease.status,
    });
    const result = parser.parse(
      payload,
      inboundWebhookParserContext(execution.workspaceId),
    );
    const parsedEvent = result.events.find(
      (event) => event.dedupeKey === execution.externalExecutionKey,
    );

    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== "umbler" ||
      !providerMessageAuthorAllowed(
        rule.messageAuthorScope ?? "team",
        parsedEvent.message.authorType,
      ) ||
      parsedEvent.message.isPrivate ||
      !parsedEvent.message.text
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_source_event_mismatch",
      );
    }

    return parsedEvent;
  }

  private decryptedPayload(execution: ExecutionRecord): unknown {
    const delivery = execution.sourceDelivery;
    if (
      delivery.payloadExpiresAt <= new Date() ||
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      delivery.encryptionKeyVersion === null
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_unavailable",
      );
    }

    const decrypted = this.payloadEncryption.decrypt(
      {
        encryptedPayload: delivery.encryptedPayload,
        payloadIv: delivery.payloadIv,
        payloadTag: delivery.payloadTag,
        encryptionKeyVersion: delivery.encryptionKeyVersion,
      },
      {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      },
    );
    try {
      return JSON.parse(decrypted.toString("utf8")) as unknown;
    } catch {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_invalid",
      );
    }
  }

  private loadExecution(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): Promise<ExecutionRecord | null> {
    return this.prisma.providerConversionRuleExecution.findFirst({
      where: {
        id: input.providerConversionExecutionId,
        workspaceId: input.workspaceId,
      },
      include: executionInclude,
    });
  }

  private async enqueueMaterialized(execution: ExecutionRecord): Promise<void> {
    if (!execution.conversionEventLogId) return;
    const conversion = await this.prisma.conversionEventLog.findFirst({
      where: {
        id: execution.conversionEventLogId,
        workspaceId: execution.workspaceId,
      },
      select: { status: true },
    });
    if (conversion?.status === "ready_to_send") {
      await this.conversionQueue.enqueueSend(
        execution.conversionEventLogId,
        execution.workspaceId,
      );
    }
  }

  private lockKeys(
    workspaceId: string,
    phoneHash: string,
    eventName: string,
  ): {
    first: number;
    second: number;
  } {
    const digest = createHash("sha256")
      .update(`${workspaceId}\0${phoneHash}\0${eventName}`, "utf8")
      .digest();

    return {
      first: digest.readInt32BE(0),
      second: digest.readInt32BE(4),
    };
  }

  /**
   * "actual" whenever the value came from the message itself: a catalog match,
   * or a message_phrase rule that extracted the amount. A configured average
   * (fixed mode, or the extracted-mode fallback) stays "configured_average".
   */
  private decisionValueSource(
    decision: ProviderConversionDecisionDto,
  ): "actual" | "configured_average" {
    if (decision.rule.triggerType === "structured_catalog") return "actual";

    return decision.rule.triggerType === "message_phrase" &&
      decision.conversion.observedPaymentValueCents !== null
      ? "actual"
      : "configured_average";
  }

  /**
   * Fail closed on an event the catalog does not know: an unsupported name
   * must never reach Meta.
   */
  private supportedEventName(eventName: string): ConversionEventNameDto {
    const parsed = conversionEventNameSchema.safeParse(eventName);
    if (!parsed.success) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_event_unsupported",
      );
    }
    return parsed.data;
  }

  /**
   * Purchase/QualifiedLead/InitiateCheckout carry legacy prefixes in the
   * catalog: changing them would break deduplication of events already sent
   * to Meta.
   */
  private metaEventId(
    executionId: string,
    eventName: ConversionEventNameDto,
  ): string {
    const digest = createHash("sha256").update(executionId).digest("hex");
    return `umbler_${conversionEventMetaEventIdPrefix(eventName)}_${digest}`;
  }

  private productionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);
    return (
      config.enabled &&
      config.productionEnabled &&
      config.conversionRulesEnabled &&
      config.conversionProductionEnabled
    );
  }

  private assertInput(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.providerConversionExecutionId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
  }

  private identifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !value.includes("\0")
    );
  }

  private errorCode(error: unknown): string {
    if (
      (error instanceof ProviderConversionProductionFailure ||
        error instanceof ExternalChannelBillingAccessError) &&
      /^[a-z0-9_]{1,160}$/u.test(error.code)
    ) {
      return error.code;
    }

    return "provider_conversion_production_unexpected";
  }

  private failureSummary(error: unknown, code: string): Prisma.InputJsonValue {
    const prismaCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;

    return {
      code,
      prismaCode,
      failedAt: new Date().toISOString(),
    };
  }
}
