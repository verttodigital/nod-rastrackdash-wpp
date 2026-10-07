import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  NotImplementedException,
  Param,
  Post,
  Query,
  RawBody,
  UnauthorizedException,
} from "@nestjs/common";
import { safeErrorName } from "../common/errors/safe-error-name";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { ConversionRulesService } from "../conversion-rules/conversion-rules.service";
import { DiagnosticsService } from "../diagnostics/diagnostics.service";
import type {
  InboundWebhookParserResult,
  ParsedInboundWebhookEvent,
} from "../inbound-webhooks/providers/inbound-webhook-parser";
import { parseWahaV1Webhook } from "../inbound-webhooks/providers/waha/waha-v1.parser";
import { parseZapiV1Webhook } from "../inbound-webhooks/providers/zapi/zapi-v1.parser";
import { UazapiProviderConversionService } from "../inbound-webhooks/uazapi-provider-conversion.service";
import { LeadsService } from "../leads/leads.service";
import {
  parseUazapiWebhook,
  type ParsedUazapiWebhook,
} from "./uazapi-webhook-parser";
import { computeCanonicalPayloadHash } from "./webhook-payload-hash";

type WebhookBody = Record<string, unknown>;

type VerifiedUazapiContext = {
  workspaceId: string;
  whatsappInstanceId: string;
  providerInstanceId: string | null;
};

// WAHA and Z-API are wired through their standalone v1 parsers rather than
// the full inbound-webhooks automation pipeline: this per-connection
// receiver only needs a single normalized message event to log to
// WebhookLog and, when eligible, create a lead.
type WiredMessageProvider = "waha" | "zapi";

const MESSAGE_PROVIDER_PARSERS: Record<
  WiredMessageProvider,
  (payload: unknown) => InboundWebhookParserResult
> = {
  waha: parseWahaV1Webhook,
  zapi: parseZapiV1Webhook,
};

// The body field each provider uses to claim the session/instance it is
// delivering for. Both are bound against the connection's persisted
// providerInstanceId before anything is parsed, logged, or converted.
const WIRED_MESSAGE_PROVIDER_BINDING_FIELD: Record<
  WiredMessageProvider,
  "session" | "instanceId"
> = {
  waha: "session",
  zapi: "instanceId",
};

type VerifiedConnectionContext = {
  workspaceId: string;
  whatsappInstanceId: string;
};

type VerifiedMetaContext = {
  workspaceId: string;
  pageId: string;
};

@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(DiagnosticsService)
    private readonly diagnosticsService: DiagnosticsService,
    @Inject(ConversionRulesService)
    private readonly conversionRulesService: ConversionRulesService,
    @Inject(ConversionEventsService)
    private readonly conversionEventsService: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionEventsQueueService: ConversionEventsQueueService,
    @Inject(LeadsService)
    private readonly leadsService: LeadsService,
    @Inject(UazapiProviderConversionService)
    private readonly uazapiProviderConversion: UazapiProviderConversionService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  @Get("meta")
  verifyMetaWebhook(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") verifyToken?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (
      !expectedToken ||
      mode !== "subscribe" ||
      verifyToken !== expectedToken ||
      !challenge
    ) {
      throw new UnauthorizedException("Meta webhook token invalido");
    }

    return challenge;
  }

  @Post("uazapi")
  @HttpCode(202)
  recordUazapi(
    @Body() body: WebhookBody,
    @Headers("x-workspace-id") workspaceId?: string,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    this.assertUazapiWebhookToken(
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken,
    );

    return this.recordUazapiWebhook(body, undefined, workspaceId);
  }

  @Post("uazapi/instances/:instanceId")
  @HttpCode(202)
  async recordUazapiInstance(
    @Param("instanceId") instanceId: string,
    @Body() body: WebhookBody,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: {
        id: instanceId,
        provider: "uazapi",
      },
      select: {
        id: true,
        workspaceId: true,
        providerInstanceId: true,
        webhookTokenHash: true,
      },
    });
    const receivedToken =
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken;

    if (
      !instance?.webhookTokenHash ||
      !receivedToken ||
      this.hashToken(receivedToken) !== instance.webhookTokenHash
    ) {
      throw new UnauthorizedException("Webhook Uazapi nao autorizado");
    }

    return this.recordUazapiWebhook(body, {
      workspaceId: instance.workspaceId,
      whatsappInstanceId: instance.id,
      providerInstanceId: instance.providerInstanceId,
    });
  }

  /**
   * Per-connection receiver used by provider onboarding. The endpoint never
   * trusts a workspace supplied in the payload: the active instance owns the
   * workspace context and its stored SHA-256 token hash authenticates the
   * request. Providers without a wired ingestion path must fail rather than
   * acknowledging and discarding a delivery.
   */
  @Post("whatsapp/:id")
  @HttpCode(202)
  async recordWhatsappConnection(
    @Param("id") id: string,
    @Body() body: WebhookBody,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        providerInstanceId: true,
        webhookTokenHash: true,
        status: true,
      },
    });
    // Uazapi BYO only supports a webhook URL field, so accept its one-time
    // token from the query string as a final fallback. Dedicated headers keep
    // precedence for providers that support them.
    const receivedToken =
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken;

    if (
      !instance ||
      instance.status !== "active" ||
      !instance.webhookTokenHash ||
      !receivedToken ||
      !this.matchesTokenHash(receivedToken, instance.webhookTokenHash)
    ) {
      throw new UnauthorizedException("Webhook WhatsApp nao autorizado");
    }

    const payloadWorkspaceId = this.firstString(body.workspaceId);
    const payloadConnectionId = this.firstString(body.whatsappInstanceId);
    if (
      (payloadWorkspaceId && payloadWorkspaceId !== instance.workspaceId) ||
      (payloadConnectionId && payloadConnectionId !== instance.id)
    ) {
      throw new UnauthorizedException("Webhook WhatsApp nao autorizado");
    }

    if (instance.provider === "uazapi_byo") {
      return this.recordUazapiWebhook(body, {
        workspaceId: instance.workspaceId,
        whatsappInstanceId: instance.id,
        providerInstanceId: instance.providerInstanceId,
      });
    }

    if (this.isWiredMessageProvider(instance.provider)) {
      this.assertProviderInstanceBinding(
        instance.provider,
        body,
        instance.providerInstanceId,
      );

      return this.recordProviderMessageWebhook(instance.provider, body, {
        workspaceId: instance.workspaceId,
        whatsappInstanceId: instance.id,
      });
    }

    throw new NotImplementedException(
      `Receiver inbound para ${instance.provider} ainda nao esta disponivel`,
    );
  }

  private isWiredMessageProvider(
    provider: string,
  ): provider is WiredMessageProvider {
    return provider === "waha" || provider === "zapi";
  }

  /**
   * WAHA (`payload.session`) and Z-API (`body.instanceId`) deliveries must
   * bind to the connection's persisted providerInstanceId before anything
   * is parsed, logged, or converted. A connection whose providerInstanceId
   * has not been configured yet, or a payload that omits the field or
   * disagrees with it, is rejected outright: the webhook token alone would
   * otherwise let a delivery for one WAHA session/Z-API instance be
   * ingested under a differently-configured connection sharing the same
   * token. Fails closed in every case.
   */
  private assertProviderInstanceBinding(
    provider: WiredMessageProvider,
    body: WebhookBody,
    providerInstanceId: string | null,
  ): void {
    const claimed = this.firstString(
      body[WIRED_MESSAGE_PROVIDER_BINDING_FIELD[provider]],
    );

    if (!providerInstanceId || !claimed || claimed !== providerInstanceId) {
      throw new UnauthorizedException("Webhook WhatsApp nao autorizado");
    }
  }

  @Post("meta")
  @HttpCode(202)
  async recordMeta(
    @Body() body: WebhookBody,
    @RawBody() rawBody: Buffer | undefined,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-workspace-id") workspaceId?: string,
  ) {
    this.assertMetaWebhookSignature(rawBody, signature);
    const context = await this.resolveMetaContext(body);

    if (workspaceId && workspaceId !== context.workspaceId) {
      throw new UnauthorizedException("Webhook Meta nao autorizado");
    }

    return this.recordMetaWebhook(body, context);
  }

  private recordMetaWebhook(body: WebhookBody, context: VerifiedMetaContext) {
    const meta = this.getMetaWebhookMetadata(body);
    const externalEventId =
      meta.externalEventId ??
      this.firstString(body.id) ??
      this.firstString(body.eventId) ??
      this.firstString(body.externalEventId);

    return this.diagnosticsService.recordWebhookLog({
      workspaceId: context.workspaceId,
      source: "meta",
      eventType: meta.eventType,
      externalEventId,
      idempotencyKey: externalEventId
        ? `meta:${context.workspaceId}:${context.pageId}:${externalEventId}`
        : undefined,
      campaignId: meta.campaignId,
      adSetId: meta.adSetId,
      adId: meta.adId,
      summaryPayload: body,
    });
  }

  private getMetaWebhookMetadata(body: WebhookBody): {
    eventType: string;
    externalEventId?: string;
    campaignId?: string;
    adSetId?: string;
    adId?: string;
  } {
    const change = this.getFirstMetaChange(body);
    const value = change?.value;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const valueObject = value as Record<string, unknown>;
      const field = this.firstString(change?.field);
      const isLeadgen =
        field === "leadgen" ||
        Boolean(this.firstString(valueObject.leadgen_id));

      if (isLeadgen) {
        return {
          eventType: "meta.leadgen",
          externalEventId:
            this.firstString(valueObject.leadgen_id) ??
            this.firstString(valueObject.id),
          campaignId:
            this.firstString(valueObject.campaign_id) ??
            this.firstString(valueObject.campaignId),
          adSetId:
            this.firstString(valueObject.adset_id) ??
            this.firstString(valueObject.ad_set_id) ??
            this.firstString(valueObject.adgroup_id) ??
            this.firstString(valueObject.adSetId),
          adId:
            this.firstString(valueObject.ad_id) ??
            this.firstString(valueObject.adId),
        };
      }
    }

    return {
      eventType:
        this.firstString(body.object) ??
        this.firstString(body.event) ??
        "meta.webhook",
    };
  }

  private getFirstMetaChange(
    body: WebhookBody,
  ): Record<string, unknown> | null {
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const changes = (entry as Record<string, unknown>).changes;

      if (!Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        if (change && typeof change === "object" && !Array.isArray(change)) {
          return change as Record<string, unknown>;
        }
      }
    }

    return null;
  }

  private assertMetaWebhookSignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ) {
    const appSecret = process.env.META_APP_SECRET;
    const signatureHex = signature?.startsWith("sha256=")
      ? signature.slice("sha256=".length)
      : undefined;

    if (
      !appSecret ||
      !rawBody ||
      !signatureHex ||
      !/^[a-f0-9]{64}$/i.test(signatureHex)
    ) {
      throw new UnauthorizedException("Webhook Meta nao autorizado");
    }

    const expectedSignature = createHmac("sha256", appSecret)
      .update(rawBody)
      .digest();
    const receivedSignature = Buffer.from(signatureHex, "hex");

    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw new UnauthorizedException("Webhook Meta nao autorizado");
    }
  }

  private async resolveMetaContext(
    body: WebhookBody,
  ): Promise<VerifiedMetaContext> {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const pageIds = Array.from(
      new Set(
        entries
          .map((entry) => this.firstString(this.recordValue(entry)?.id))
          .filter((pageId): pageId is string => Boolean(pageId)),
      ),
    );

    if (pageIds.length !== 1) {
      throw new UnauthorizedException("Webhook Meta nao autorizado");
    }

    const destinations = await this.prisma.metaConversionDestination.findMany({
      where: {
        pageId: pageIds[0],
      },
      select: {
        workspaceId: true,
      },
      take: 2,
    });

    if (destinations.length !== 1) {
      throw new UnauthorizedException("Webhook Meta nao autorizado");
    }

    return {
      workspaceId: destinations[0].workspaceId,
      pageId: pageIds[0],
    };
  }

  private assertUazapiWebhookToken(receivedToken?: string) {
    const expectedToken = process.env.UAZAPI_WEBHOOK_AUTH_TOKEN;

    if (
      !expectedToken ||
      !receivedToken ||
      this.hashToken(receivedToken) !== this.hashToken(expectedToken)
    ) {
      throw new UnauthorizedException("Webhook Uazapi nao autorizado");
    }
  }

  private getBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith("Bearer ")) {
      return undefined;
    }

    return this.firstString(authorization.slice("Bearer ".length));
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private matchesTokenHash(
    receivedToken: string,
    expectedHash: string,
  ): boolean {
    const receivedHash = Buffer.from(this.hashToken(receivedToken), "utf8");
    const storedHash = Buffer.from(expectedHash, "utf8");

    return (
      receivedHash.length === storedHash.length &&
      timingSafeEqual(receivedHash, storedHash)
    );
  }

  private async recordUazapiWebhook(
    body: WebhookBody,
    verifiedContext?: VerifiedUazapiContext,
    claimedWorkspaceId?: string,
  ) {
    const parsed = parseUazapiWebhook(body);
    const resolvedContext =
      verifiedContext ??
      (await this.resolveUazapiContext(parsed.providerInstanceId));

    if (!resolvedContext) {
      throw new UnauthorizedException("Webhook Uazapi nao autorizado");
    }

    this.assertUazapiContextMatches(
      body,
      parsed.providerInstanceId,
      claimedWorkspaceId,
      resolvedContext,
    );

    const attribution = await this.resolveUazapiMetaAttribution(
      resolvedContext.workspaceId,
      {
        campaignId: parsed.campaignId,
        adSetId: parsed.adSetId,
        adId: parsed.adId,
      },
    );

    const diagnostic = await this.diagnosticsService.recordWebhookLog({
      workspaceId: resolvedContext.workspaceId,
      whatsappInstanceId: resolvedContext.whatsappInstanceId,
      source: "uazapi",
      eventType: parsed.eventType,
      externalEventId: parsed.externalEventId,
      idempotencyKey: parsed.externalEventId
        ? [
            "uazapi",
            resolvedContext.workspaceId,
            resolvedContext.whatsappInstanceId,
            parsed.externalEventId,
          ].join(":")
        : undefined,
      leadId: parsed.leadId,
      phoneHash: parsed.phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      summaryPayload: body,
    });

    if (diagnostic.status === "duplicate") {
      return {
        ...diagnostic,
        conversion: {
          created: [],
          duplicates: [],
          queued: [],
        },
      };
    }

    const message = this.recordValue(body.message);
    const isInboundMessage =
      message !== undefined &&
      message.fromMe === false &&
      parsed.isGroupChat !== true;
    const isTeamMessage =
      message !== undefined &&
      message.fromMe === true &&
      parsed.isGroupChat !== true;

    // U2c: attendant (fromMe=true) messages evaluate message_phrase
    // Checkout/Purchase conversion rules against the paid lead of the contact
    // being messaged; never creates or touches a platform lead.
    if (isTeamMessage) {
      await this.evaluateUazapiTeamMessage(resolvedContext, parsed);
    }

    // Labels can arrive on chat updates as well as inbound CTWA messages.
    // They are evaluated independently of lead creation, and the conversion
    // service fails closed unless the contact resolves to a paid lead.
    if (
      parsed.labelEventKind === "chat_labels" &&
      parsed.phone &&
      !parsed.isGroupChat
    ) {
      await this.evaluateUazapiLabels(resolvedContext, parsed);
    }

    // Product rule: Uazapi only creates platform leads for paid CTWA inbound messages.
    if (!isInboundMessage || !parsed.ctwaClid) {
      return {
        ...diagnostic,
        conversion: {
          created: [],
          duplicates: [],
          queued: [],
        },
      };
    }

    const triggerInput = {
      messageText: parsed.messageText,
      labels: parsed.labels,
    };
    const rules = await this.conversionRulesService.evaluateTriggers(
      resolvedContext.workspaceId,
      triggerInput,
    );
    const lead = await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: resolvedContext.workspaceId,
      whatsappInstanceId: resolvedContext.whatsappInstanceId,
      name: parsed.contactName,
      phone: parsed.phone,
      phoneHash: parsed.phoneHash,
      source: "uazapi",
      labels: triggerInput.labels,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: parsed.ctwaClid,
      ctwaSourceUrl: parsed.ctwaSourceUrl,
      occurredAt: new Date(),
    });
    const automatic =
      await this.conversionEventsService.recordAutomaticLeadSubmitted({
        workspaceId: resolvedContext.workspaceId,
        leadId: lead?.id ?? parsed.leadId,
        phoneHash: parsed.phoneHash,
        campaignId: attribution.campaignId,
        adSetId: attribution.adSetId,
        adId: attribution.adId,
        ctwaClid: parsed.ctwaClid,
      });
    const conversion = await this.conversionEventsService.recordRuleMatches({
      workspaceId: resolvedContext.workspaceId,
      rules,
      leadId: lead?.id ?? parsed.leadId,
      phoneHash: parsed.phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: parsed.ctwaClid,
    });
    const readyLogIds = await this.conversionEventsService.listReadyLogIds([
      ...automatic.created,
      ...conversion.created,
    ]);
    const queued = await Promise.all(
      readyLogIds.map((logId) =>
        this.conversionEventsQueueService.enqueueSend(
          logId,
          resolvedContext.workspaceId,
        ),
      ),
    );

    return {
      ...diagnostic,
      conversion: {
        ...conversion,
        automatic,
        queued,
      },
    };
  }

  /**
   * WAHA/Z-API receiver: the connection is already authenticated by
   * recordWhatsappConnection, so this only needs to parse, log to
   * WebhookLog, and (for a paid CTWA inbound message) create a lead. Unlike
   * Uazapi's shared endpoint there is no provider-instance lookup to do:
   * the workspace/connection context comes straight from the verified
   * instance.
   */
  private async recordProviderMessageWebhook(
    provider: WiredMessageProvider,
    body: WebhookBody,
    context: VerifiedConnectionContext,
  ) {
    const parsed = MESSAGE_PROVIDER_PARSERS[provider](body);
    const event = parsed.events[0] ?? null;
    const phoneHash = event
      ? hashPhoneIdentity(event.contact.phoneNumber)
      : undefined;
    const emptyConversion = { created: [], duplicates: [], queued: [] };
    // Idempotency hardening: fingerprint the payload so a same-externalId
    // replay with a genuinely different body (rather than a plain retry) is
    // quarantined instead of silently treated as a duplicate.
    const payloadHash = computeCanonicalPayloadHash(body);

    const diagnostic = await this.diagnosticsService.recordWebhookLog({
      workspaceId: context.workspaceId,
      whatsappInstanceId: context.whatsappInstanceId,
      source: provider,
      eventType: parsed.providerEventType ?? `${provider}.webhook`,
      externalEventId: parsed.externalDeliveryId ?? undefined,
      idempotencyKey: parsed.externalDeliveryId
        ? [
            provider,
            context.workspaceId,
            context.whatsappInstanceId,
            parsed.externalDeliveryId,
          ].join(":")
        : undefined,
      payloadHash,
      phoneHash,
      adId: event?.adId ?? undefined,
      summaryPayload: body,
    });

    if (diagnostic.status === "duplicate" || diagnostic.status === "conflict") {
      return { ...diagnostic, conversion: emptyConversion };
    }

    // From here on this request holds the WebhookLog claim and must settle
    // it. A downstream failure has to land as "failed" so the provider's
    // retry can reclaim and reprocess the very same delivery: left in
    // flight, every retry would be answered as a duplicate and the delivery
    // would be lost. The error still propagates, so the provider sees a
    // non-2xx and retries. Settling is never optional in either direction:
    // an unsettled delivery is answered with a non-2xx, never a success.
    let conversion: Awaited<ReturnType<typeof this.convertProviderMessage>>;

    try {
      conversion = await this.convertProviderMessage(
        provider,
        event,
        phoneHash,
        context,
      );
    } catch (error) {
      await this.settleProviderDeliveryFailed(
        provider,
        diagnostic.webhookLogId,
        context,
        error,
      );

      throw error;
    }

    // Settling is outside the try on purpose: a settlement problem is its
    // own incident, not a downstream failure to be re-recorded as one.
    await this.settleProviderDeliveryProcessed(
      provider,
      diagnostic.webhookLogId,
      context,
    );

    return { ...diagnostic, conversion };
  }

  /**
   * Downstream half of the WAHA/Z-API receiver, run while holding the
   * WebhookLog claim. Kept separate from recordProviderMessageWebhook so
   * every step of it - attribution, rules, lead, conversion, enqueue - is
   * covered by the same failure/retry accounting.
   */
  private async convertProviderMessage(
    provider: WiredMessageProvider,
    event: ParsedInboundWebhookEvent | null,
    phoneHash: string | undefined,
    context: VerifiedConnectionContext,
  ) {
    const emptyConversion = { created: [], duplicates: [], queued: [] };

    // Product rule (mirrors Uazapi): only a paid CTWA inbound message
    // creates a platform lead. Organic messages (no ctwaClid) and messages
    // sent from the connected number itself (fromMe) never do; group chats
    // never reach here because the parsers decline to emit an event for
    // them. Nothing left to do is still a processed delivery.
    if (!event || event.message.direction !== "inbound" || !event.ctwaClid) {
      return emptyConversion;
    }

    const attribution = await this.resolveUazapiMetaAttribution(
      context.workspaceId,
      { adId: event.adId ?? undefined },
    );
    const triggerInput = {
      messageText: event.message.text ?? undefined,
      labels: [] as string[],
    };
    const rules = await this.conversionRulesService.evaluateTriggers(
      context.workspaceId,
      triggerInput,
    );
    const lead = await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: context.workspaceId,
      whatsappInstanceId: context.whatsappInstanceId,
      name: event.contact.name ?? undefined,
      phone: event.contact.phoneNumber,
      phoneHash,
      source: provider,
      labels: triggerInput.labels,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: event.ctwaClid,
      ctwaSourceUrl: event.ad?.sourceUrl ?? undefined,
      occurredAt: event.occurredAt,
    });
    const automatic =
      await this.conversionEventsService.recordAutomaticLeadSubmitted({
        workspaceId: context.workspaceId,
        leadId: lead?.id,
        phoneHash,
        campaignId: attribution.campaignId,
        adSetId: attribution.adSetId,
        adId: attribution.adId,
        ctwaClid: event.ctwaClid,
      });
    const conversion = await this.conversionEventsService.recordRuleMatches({
      workspaceId: context.workspaceId,
      rules,
      leadId: lead?.id,
      phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: event.ctwaClid,
    });
    const readyLogIds = await this.conversionEventsService.listReadyLogIds([
      ...automatic.created,
      ...conversion.created,
    ]);
    const queued = await Promise.all(
      readyLogIds.map((logId) =>
        this.conversionEventsQueueService.enqueueSend(
          logId,
          context.workspaceId,
        ),
      ),
    );

    return {
      ...conversion,
      automatic,
      queued,
    };
  }

  /**
   * Settles a delivery whose downstream processing threw.
   *
   * The write is what makes the provider's retry reprocessable, so it is
   * never best-effort: if it cannot be written the row is stuck in flight
   * and every retry of this delivery will be answered as a duplicate, i.e.
   * the delivery is lost while the provider is told 2xx. That is strictly
   * worse than the downstream failure, so it is reported as its own incident
   * and raised instead of being logged away behind the original error, which
   * is kept as the cause.
   *
   * A settlement that simply matched no row (claim already taken over) is a
   * different case: nothing is stuck, the downstream error still propagates,
   * and it is only recorded.
   */
  private async settleProviderDeliveryFailed(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
    error: unknown,
  ): Promise<void> {
    let settled: boolean;

    try {
      settled = await this.diagnosticsService.markWebhookLogFailed(
        webhookLogId,
        error,
      );
    } catch (markError) {
      throw this.reportDeliveryStuckInFlight(
        provider,
        webhookLogId,
        context,
        markError,
        error,
      );
    }

    if (!settled) {
      this.logSettlementIncident("whatsapp_receiver_failure_claim_lost", {
        provider,
        webhookLogId,
        context,
      });
    }
  }

  /**
   * Settles a delivery whose downstream processing completed. The conditional
   * UPDATE is the proof this request still held the claim, so its result is
   * checked: a delivery this request did not settle must never be answered as
   * a success. Both "the claim was gone" and "the write never landed" fail
   * the request instead.
   */
  private async settleProviderDeliveryProcessed(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
  ): Promise<void> {
    let settled: boolean;

    try {
      settled =
        await this.diagnosticsService.markWebhookLogProcessed(webhookLogId);
    } catch (markError) {
      throw this.reportDeliveryStuckInFlight(
        provider,
        webhookLogId,
        context,
        markError,
      );
    }

    if (settled) {
      return;
    }

    this.logSettlementIncident("whatsapp_receiver_processed_claim_lost", {
      provider,
      webhookLogId,
      context,
    });

    throw new ConflictException(
      "Entrega de webhook nao pode ser concluida: a reivindicacao do registro foi perdida",
    );
  }

  /**
   * The row could not be settled at all, so it stays "received" and the
   * delivery is not recoverable by retry until it is settled. Reported by
   * error class only - provider and ORM errors quote payloads, phones and
   * tokens - and raised with a static message for the same reason.
   */
  private reportDeliveryStuckInFlight(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
    markError: unknown,
    downstreamError?: unknown,
  ): InternalServerErrorException {
    this.logSettlementIncident("whatsapp_receiver_delivery_stuck_in_flight", {
      provider,
      webhookLogId,
      context,
      markError,
      downstreamError,
    });

    return new InternalServerErrorException(
      "Falha ao registrar o resultado do webhook",
      { cause: markError },
    );
  }

  private logSettlementIncident(
    event: string,
    details: {
      provider: WiredMessageProvider;
      webhookLogId: string;
      context: VerifiedConnectionContext;
      markError?: unknown;
      downstreamError?: unknown;
    },
  ): void {
    this.logger.error(
      JSON.stringify({
        event,
        provider: details.provider,
        workspaceId: details.context.workspaceId,
        whatsappInstanceId: details.context.whatsappInstanceId,
        webhookLogId: details.webhookLogId,
        ...(details.markError !== undefined
          ? { errorName: safeErrorName(details.markError) }
          : {}),
        ...(details.downstreamError !== undefined
          ? { downstreamErrorName: safeErrorName(details.downstreamError) }
          : {}),
      }),
    );
  }

  private async evaluateUazapiTeamMessage(
    context: VerifiedUazapiContext,
    parsed: ParsedUazapiWebhook,
  ): Promise<void> {
    if (!parsed.phone || !parsed.messageText) {
      return;
    }

    try {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: {
          id: context.whatsappInstanceId,
          workspaceId: context.workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          providerInstanceId: true,
        },
      });

      if (!instance) {
        return;
      }

      await this.uazapiProviderConversion.evaluateTeamMessage({
        workspaceId: context.workspaceId,
        instance,
        phone: parsed.phone,
        messageText: parsed.messageText,
        externalMessageId: parsed.externalEventId,
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "uazapi_team_message_evaluation_failed",
          workspaceId: context.workspaceId,
          whatsappInstanceId: context.whatsappInstanceId,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  private async evaluateUazapiLabels(
    context: VerifiedUazapiContext,
    parsed: ParsedUazapiWebhook,
  ): Promise<void> {
    if (!parsed.phone || parsed.waLabelState !== "valid") return;

    try {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: {
          id: context.whatsappInstanceId,
          workspaceId: context.workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          providerInstanceId: true,
          providerTokenEncrypted: true,
          provider: true,
          providerTokenIv: true,
          providerTokenTag: true,
        },
      });
      if (!instance) return;

      await this.uazapiProviderConversion.evaluateLabels({
        workspaceId: context.workspaceId,
        instance,
        phone: parsed.phone,
        labelIds: parsed.waLabelIds,
        waChatId: parsed.waChatId,
        externalEventId: parsed.externalEventId,
        occurredAt: new Date(),
      });
      await this.uazapiProviderConversion.evaluatePublishedLabels({
        workspaceId: context.workspaceId,
        instance,
        phone: parsed.phone,
        labelIds: parsed.waLabelIds,
        waChatId: parsed.waChatId,
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "uazapi_label_evaluation_failed",
          workspaceId: context.workspaceId,
          whatsappInstanceId: context.whatsappInstanceId,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  private async resolveUazapiMetaAttribution(
    workspaceId: string,
    input: {
      campaignId?: string;
      adSetId?: string;
      adId?: string;
    },
  ): Promise<{
    campaignId?: string;
    adSetId?: string;
    adId?: string;
  }> {
    if (!input.adId) {
      return input;
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId,
        adId: input.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
      },
    });

    if (!ad) {
      return input;
    }

    return {
      adId: input.adId,
      campaignId: input.campaignId ?? ad.campaignId ?? undefined,
      adSetId: input.adSetId ?? ad.adSetId ?? undefined,
    };
  }

  private firstString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private assertUazapiContextMatches(
    body: WebhookBody,
    providerInstanceId: string | undefined,
    claimedWorkspaceId: string | undefined,
    context: VerifiedUazapiContext,
  ) {
    const workspace = this.recordValue(body.workspace);
    const claimedWorkspaceIds = [
      claimedWorkspaceId,
      this.firstString(body.workspaceId),
      this.firstString(body.workspace_id),
      this.firstString(workspace?.id),
      this.firstString(workspace?.workspaceId),
    ].filter((value): value is string => Boolean(value));
    const claimedLocalInstanceIds = [
      this.firstString(body.whatsappInstanceId),
      this.firstString(body.whatsapp_instance_id),
    ].filter((value): value is string => Boolean(value));

    if (
      claimedWorkspaceIds.some(
        (workspaceId) => workspaceId !== context.workspaceId,
      ) ||
      claimedLocalInstanceIds.some(
        (instanceId) => instanceId !== context.whatsappInstanceId,
      ) ||
      (providerInstanceId && providerInstanceId !== context.providerInstanceId)
    ) {
      throw new UnauthorizedException("Webhook Uazapi nao autorizado");
    }
  }

  private async resolveUazapiContext(
    providerInstanceId?: string,
  ): Promise<VerifiedUazapiContext | null> {
    if (!providerInstanceId) {
      return null;
    }

    const instances = await this.prisma.whatsappInstance.findMany({
      where: {
        provider: "uazapi",
        providerInstanceId,
      },
      select: {
        id: true,
        workspaceId: true,
        providerInstanceId: true,
      },
      take: 2,
    });

    return instances.length === 1
      ? {
          workspaceId: instances[0].workspaceId,
          whatsappInstanceId: instances[0].id,
          providerInstanceId: instances[0].providerInstanceId,
        }
      : null;
  }
}
