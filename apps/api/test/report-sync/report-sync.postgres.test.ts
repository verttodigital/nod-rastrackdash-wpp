import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { RUNTIME_ENV } from "../../src/common/runtime/runtime.module";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ReportSyncRepository } from "../../src/report-sync/report-sync.repository";
import { ReportSyncService } from "../../src/report-sync/report-sync.service";
import { ReportSyncController } from "../../src/report-sync/report-sync.controller";
import { ReportSyncOps } from "../../src/report-sync/report-sync-ops";
import {
  intentKey,
  type SyncIntent,
} from "../../src/report-sync/report-sync.contract";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { UazapiConversionBridgeService } from "../../src/inbound-webhooks/uazapi-conversion-bridge.service";
import { UazapiProviderConversionService } from "../../src/inbound-webhooks/uazapi-provider-conversion.service";
import { UazapiLabelOperationsService } from "../../src/integrations/whatsapp-providers/uazapi-label-operations.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionDecisionRepository } from "../../src/conversion-rules/provider-conversion-decision.repository";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";

// Explicit opt-in to a disposable database; never accepts an arbitrary production URL.
const url = process.env.REPORT_SYNC_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "report sync real PostgreSQL + HTTP + decision + CAPI tracer",
  () => {
    let db: PrismaService,
      app: INestApplication,
      service: ReportSyncService,
      repo: ReportSyncRepository,
      production: ProviderConversionProductionService,
      events: ConversionEventsService;
    let config: any, env: any, body: SyncIntent;
    const labels = new Set(["external"]);
    const chatStates = new Map<string, Set<string>>();
    const queued: any[] = [];
    const capiPayloads: any[] = [];
    let failNextMeta=false;
    const phone = "5511999999999";
    beforeAll(async () => {
      const parsed = new URL(url!);
      if (
        !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
        parsed.port !== "15439" ||
        parsed.pathname !== "/nod_pilot"
      )
        throw Error("disposable_database_required");
      db = new PrismaService({ datasources: { db: { url } } });
      await db.$connect();
      const suffix = randomUUID();
      const workspace = await db.workspace.create({
        data: {
          name: "Report sync isolated fixture",
          slug: "fixture-" + suffix,
        },
      });
      const now = Date.now(),
        cutover = new Date(now - 86400000).toISOString();
      env = {
        INBOUND_WEBHOOKS_ENABLED: "true",
        INBOUND_CONVERSION_RULES_ENABLED: "true",
        INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
        INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
        API_PUBLIC_URL: "https://api.example.com",
        INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
        REPORT_SYNC_BEARER_TOKEN: "test-only-token-".repeat(4),
      };
      const crypto = new MetaTokenEncryptionService(env);
      const payloadCrypto = new InboundWebhookPayloadEncryptionService(env);
      const providerConfig = (name: string) =>
        crypto.encrypt(
          JSON.stringify({
            provider: "uazapi_byo",
            config: { baseUrl: "https://example.com", token: name },
          }),
        );
      const instances = [];
      for (const name of ["first", "second"]) {
        const encryptedProvider = providerConfig(name);
        instances.push(
          await db.whatsappInstance.create({
            data: {
              workspaceId: workspace.id,
              name,
              provider: "uazapi_byo",
              providerInstanceId: name,
              configEncrypted: encryptedProvider.encryptedAccessToken,
              configIv: encryptedProvider.tokenIv,
              configTag: encryptedProvider.tokenTag,
            },
          }),
        );
      }
      config = {
        schemaVersion: 1,
        sourceId: "fixture-source-" + suffix,
        tenantId: "fixture-tenant",
        tenantSlug: "fixture",
        workspaceId: workspace.id,
        mode: "paused",
        cutoverAt: cutover,
        bindings: instances.map((i) => ({
          instanceName: i.name,
          whatsappInstanceId: i.id,
        })),
      };
      env.REPORT_SYNC_CONFIG_JSON = JSON.stringify(config);
      const providerFetch: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        const token = new Headers(init?.headers).get("token");
        const prefix = token === "second" ? "1" : "";
        const owner = token === "second" ? "5511777777777" : "5511666666666";
        const data = init?.body ? JSON.parse(String(init.body)) : {};
        const chatId = String(data.wa_chatid ?? data.number ?? phone)
          .replace(/^=/, "")
          .replace(/@s\.whatsapp\.net$/, "");
        const stateKey = token + ":" + chatId;
        let state = chatStates.get(stateKey);
        if (!state) {
          state =
            token === "first" && chatId === phone
              ? labels
              : new Set(["external"]);
          chatStates.set(stateKey, state);
        }
        if (path === "/labels")
          return Response.json([
            { id: owner + ":" + prefix + "1", labelid: prefix + "1", name: "N1" },
            { id: owner + ":" + prefix + "2", labelid: prefix + "2", name: "N2" },
            { id: owner + ":" + prefix + "3", labelid: prefix + "3", name: "Agendamento" },
          ]);
        if (path === "/chat/find")
          return Response.json({
            chats: [
              {
                wa_chatid: `${chatId}@s.whatsapp.net`,
                wa_label: JSON.stringify([...state].map((id) => /^[0-9]+$/.test(id) ? owner + ":" + id : id)),
              },
            ],
            pagination: { totalRecords: 1 },
          });
        if (path === "/chat/labels") {
          if (data.add_labelid) state.add(data.add_labelid);
          if (data.remove_labelid) state.delete(data.remove_labelid);
          return Response.json({ success: true });
        }
        throw Error("unexpected_provider_request");
      };
      const labelService = new UazapiLabelOperationsService(
        db,
        crypto,
        providerFetch,
      );
      repo = new ReportSyncRepository(db, payloadCrypto);
      const bridge = new UazapiConversionBridgeService(db);
      await new ReportSyncOps(repo, env, bridge, labelService).provision({
        apply: true,
        expectedRules: 6,
      });
      await repo.baseline(config, {
        schemaVersion: 1,
        sourceId: config.sourceId,
        tenantId: config.tenantId,
        baselineId: "baseline",
        cutoverAt: cutover,
        part: 0,
        final: true,
        manifest: {
          entryCount: 0,
          sha256: createHash("sha256").update("[]").digest("hex"),
        },
        entries: [],
      });
      await db.inboundWebhookConnection.updateMany({
        where: { workspaceId: workspace.id },
        data: { status: "production" },
      });
      await db.inboundWebhookChannel.updateMany({
        where: { workspaceId: workspace.id },
        data: { status: "active", productionActivatedAt: new Date(cutover) },
      });
      await db.providerConversionRuleConfig.updateMany({
        where: { workspaceId: workspace.id },
        data: { mode: "production", productionActivatedAt: new Date(cutover) },
      });
      config.mode = "production";
      env.REPORT_SYNC_CONFIG_JSON = JSON.stringify(config);
      await db.lead.create({
        data: {
          workspaceId: workspace.id,
          whatsappInstanceId: instances[0]!.id,
          phoneHash: hashPhoneIdentity(phone)!,
          adId: "fixture-ad",
          ctwaClid: "fixture-click",
        },
      });
      const encrypted = crypto.encrypt("fixture-meta-token");
      const credential = await db.metaCredential.create({
        data: {
          workspaceId: workspace.id,
          source: "manual",
          label: "Fixture",
          ...encrypted,
          fingerprint: suffix,
          tokenLast4: "test",
          scopes: [],
          status: "active",
        },
      });
      const destination = await db.metaConversionDestination.create({
        data: {
          workspaceId: workspace.id,
          pixelId: "fixture-pixel",
          pixelName: "Fixture",
          pageId: "fixture-page",
          pageName: "Fixture",
        },
      });
      const connection = await db.metaBusinessConnection.create({
        data: {
          workspaceId: workspace.id,
          credentialId: credential.id,
          businessManagerId: "fixture-business",
          businessManagerName: "Fixture",
          status: "active",
          defaultConversionDestinationId: destination.id,
        },
      });
      await db.metaReportingAccount.create({
        data: {
          workspaceId: workspace.id,
          businessId: "fixture-business",
          businessName: "Fixture",
          adAccountId: "fixture-account",
          adAccountName: "Fixture",
          businessConnectionId: connection.id,
          conversionDestinationId: destination.id,
        },
      });
      await db.metaAd.create({
        data: {
          workspaceId: workspace.id,
          adAccountId: "fixture-account",
          campaignId: "fixture-campaign",
          adSetId: "fixture-set",
          adId: "fixture-ad",
          name: "Fixture",
        },
      });
      await db.metaIntegration.create({
        data: {
          workspaceId: workspace.id,
          ...encrypted,
          scopes: [],
          selectedPixelId: "fixture-pixel",
          selectedAdAccountId: "fixture-account",
        },
      });
      const capi = new MetaCapiAdapter({}, async (_input, init) => {
        capiPayloads.push(JSON.parse(String(init?.body)));
        if(failNextMeta){failNextMeta=false;throw new Error('simulated network timeout');}
        return Response.json({
          events_received: 1,
          fbtrace_id: "fixture-trace",
        });
      });
      events = new ConversionEventsService(db, capi, crypto, undefined, env);
      production = new ProviderConversionProductionService(
        db,
        payloadCrypto,
        {} as any,
        {} as any,
        new InboundWebhookMetaRouteReaderService(db),
        events,
        { enqueueSend: vi.fn(async () => ({})) } as any,
        env,
      );
      const conversions = new UazapiProviderConversionService(
        db,
        env,
        bridge,
        new ProviderConversionDecisionEngine(),
        new ProviderConversionDecisionRepository(db),
        new ProviderConversionOrchestrator(db),
        new ProviderConversionPaidLeadResolver(db),
        {
          enqueueProviderConversion: vi.fn(async (input) => {
            queued.push(input);
            return { jobId: "fixture", status: "queued" };
          }),
        } as any,
        {} as any,
        crypto,
        labelService,
        payloadCrypto,
      );
      service = new ReportSyncService(repo, env, labelService, conversions);
      const module = await Test.createTestingModule({
        controllers: [ReportSyncController],
        providers: [
          { provide: ReportSyncService, useValue: service },
          { provide: RUNTIME_ENV, useValue: env },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.init();
      body = {
        schemaVersion: 1,
        sourceId: config.sourceId,
        tenantId: config.tenantId,
        mode: "production",
        publication: {
          id: "publication",
          version: 1,
          publishedAt: new Date(now - 1000).toISOString(),
        },
        lead: {
          id: "source-lead",
          phone,
          adId: "fixture-ad",
          ctwaClid: "fixture-click",
        },
        origin: {
          instanceName: "first",
          waChatId: `${phone}@s.whatsapp.net`,
          evidenceMessageId: "fixture-message",
        },
        finalStage: "n1",
        transitions: [
          {
            id: "transition",
            stage: "n1",
            occurredAt: new Date(now - 60000).toISOString(),
          },
        ],
      };
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
    });
    it("HTTP freezes an intention, real SQL decision/execution/event survives duplicate delivery, only CAPI ack completes", async () => {
      const key = intentKey(body);
      const auth = "Bearer " + env.REPORT_SYNC_BEARER_TOKEN;
      await request(app.getHttpServer())
        .post("/integrations/report-sync/intents")
        .set("authorization", "Bearer wrong")
        .set("idempotency-key", key)
        .send(body)
        .expect(401);
      const accepted = await request(app.getHttpServer())
        .post("/integrations/report-sync/intents")
        .set("authorization", auth)
        .set("idempotency-key", key)
        .send(body)
        .expect(202);
      const repeats = await Promise.all(
        [1, 2].map(() =>
          request(app.getHttpServer())
            .post("/integrations/report-sync/intents")
            .set("authorization", auth)
            .set("idempotency-key", key)
            .send(body)
            .expect(200),
        ),
      );
      expect(repeats.every((r) => r.body.syncId === accepted.body.syncId)).toBe(
        true,
      );
      await service.process(key);
      const before = await service.result(key);
      expect(before.status).toBe("pending");
      expect(before.transitions[0]!.status).toBe("awaiting_meta");
      expect(labels).toEqual(new Set(["external", "1"]));
      expect(
        new Set(queued.map((q) => q.providerConversionExecutionId)).size,
      ).toBe(1);
      const stage = await db.reportSyncStage.findFirstOrThrow({
        where: { intentId: key },
      });
      expect(stage.occurredAt!.toISOString()).toBe(
        body.transitions[0]!.occurredAt,
      );
      await production.processExecution(queued[0]);
      const execution =
        await db.providerConversionRuleExecution.findUniqueOrThrow({
          where: { id: stage.executionId! },
        });
      expect(execution.conversionEventLogId).toBeTruthy();
      expect(await service.result(key)).toMatchObject({ status: "pending" });
      config.mode='paused';env.REPORT_SYNC_CONFIG_JSON=JSON.stringify(config);
      expect((await events.sendReadyEvent(execution.conversionEventLogId!,{workspaceId:config.workspaceId})).status).toBe('skipped');
      expect((await db.conversionEventLog.findUniqueOrThrow({where:{id:execution.conversionEventLogId!}})).status).toBe('ready_to_send');
      expect((await db.reportSyncStage.findUniqueOrThrow({where:{id:stage.id}})).deliveryAttempts).toBe(0);
      config.mode='production';env.REPORT_SYNC_CONFIG_JSON=JSON.stringify(config);failNextMeta=true;
      expect((await events.sendReadyEvent(execution.conversionEventLogId!,{workspaceId:config.workspaceId})).status).toBe('error');
      expect((await service.result(key)).status).toBe('pending');
      await events.sendReadyEvent(execution.conversionEventLogId!, {
        workspaceId: config.workspaceId,
      });
      const final = await request(app.getHttpServer())
        .get("/integrations/report-sync/intents/" + key)
        .set("authorization", auth)
        .expect(200);
      expect(final.body.status).toBe("succeeded");
      expect(final.body.transitions[0].metaAcceptedAt).toBeTruthy();
      expect(capiPayloads[0].data[0].event_name).toBe("ViewContent");
      expect(capiPayloads[0].data[0].event_time).toBe(
        Math.floor(Date.parse(body.transitions[0]!.occurredAt) / 1000),
      );
      await service.process(key);
      expect(
        await db.conversionEventLog.count({
          where: { workspaceId: config.workspaceId },
        }),
      ).toBe(1);
      expect(capiPayloads).toHaveLength(2);
      expect(capiPayloads[0].data[0].event_id).toBe(capiPayloads[1].data[0].event_id);
      expect(capiPayloads[0].data[0].event_time).toBe(capiPayloads[1].data[0].event_time);
      expect((await db.reportSyncStage.findUniqueOrThrow({where:{id:stage.id}})).deliveryAttempts).toBe(2);
    }, 60000);
    it("SQL leases serialize contenders and fence a replaced owner", async () => {
      const key = "fixture-lease-" + randomUUID();
      const [one, two] = await Promise.all([
        repo.acquire(key),
        repo.acquire(key),
      ]);
      expect([one, two].filter(Boolean)).toHaveLength(1);
      const lease = one ?? two;
      await repo.fence(lease!);
      await repo.release(lease!);
      await expect(repo.fence(lease!)).rejects.toThrow(
        "conversation_lease_lost",
      );
    });
    it("second number processes the three-stage jump with its distinct label IDs and original dates", async () => {
      const otherPhone = "5511888888888",
        now = Date.now();
      await db.lead.create({
        data: {
          workspaceId: config.workspaceId,
          whatsappInstanceId: config.bindings[1].whatsappInstanceId,
          phoneHash: hashPhoneIdentity(otherPhone)!,
          adId: "fixture-ad",
          ctwaClid: "fixture-other-click",
        },
      });
      const jump: SyncIntent = {
        ...body,
        publication: {
          id: "publication-jump",
          version: 2,
          publishedAt: new Date(now - 1000).toISOString(),
        },
        lead: {
          id: "other-source-lead",
          phone: otherPhone,
          adId: "fixture-ad",
          ctwaClid: "fixture-other-click",
        },
        origin: {
          instanceName: "second",
          waChatId: `${otherPhone}@s.whatsapp.net`,
          evidenceMessageId: "other-message",
        },
        finalStage: "agendamento",
        transitions: [
          {
            id: "j1",
            stage: "n1",
            occurredAt: new Date(now - 180000).toISOString(),
          },
          {
            id: "j2",
            stage: "n2",
            occurredAt: new Date(now - 120000).toISOString(),
          },
          {
            id: "j3",
            stage: "agendamento",
            occurredAt: new Date(now - 60000).toISOString(),
          },
        ],
      };
      const key = intentKey(jump);
      await request(app.getHttpServer())
        .post("/integrations/report-sync/intents")
        .set("authorization", "Bearer " + env.REPORT_SYNC_BEARER_TOKEN)
        .set("idempotency-key", key)
        .send(jump)
        .expect(202);
      await service.process(key);
      const stages = await db.reportSyncStage.findMany({
        where: { intentId: key },
        orderBy: { occurredAt: "asc" },
      });
      expect(stages).toHaveLength(3);
      expect(stages.map((s) => s.labelId)).toEqual(["11", "12", "13"]);
      expect(stages.map((s) => s.occurredAt!.toISOString())).toEqual(
        jump.transitions.map((t) => t.occurredAt),
      );
      expect(chatStates.get("second:" + otherPhone)).toEqual(
        new Set(["external", "13"]),
      );
      for (const stage of stages) {
        await production.processExecution({
          workspaceId: config.workspaceId,
          providerConversionExecutionId: stage.executionId!,
        });
        const execution =
          await db.providerConversionRuleExecution.findUniqueOrThrow({
            where: { id: stage.executionId! },
          });
        await events.sendReadyEvent(execution.conversionEventLogId!, {
          workspaceId: config.workspaceId,
        });
      }
      expect((await service.result(key)).status).toBe("succeeded");
      const logs = await db.conversionEventLog.findMany({
        where: {
          workspaceId: config.workspaceId,
          ctwaClid: "fixture-other-click",
        },
        orderBy: { eventOccurredAt: "asc" },
      });
      expect(logs.map((e) => e.eventName)).toEqual([
        "ViewContent",
        "QualifiedLead",
        "InitiateCheckout",
      ]);
      expect(logs.map((e) => e.valueCents)).toEqual([null, null, 10000]);
      expect(logs[2]).toMatchObject({
        currency: "BRL",
        valueSource: "configured_average",
      });
      expect(logs.map((e) => e.eventOccurredAt.toISOString())).toEqual(
        jump.transitions.map((t) => t.occurredAt),
      );
      await service.process(key);
      expect(
        await db.conversionEventLog.count({
          where: {
            workspaceId: config.workspaceId,
            ctwaClid: "fixture-other-click",
          },
        }),
      ).toBe(3);
    }, 120000);
    it('blocks attribution changed after decision but before materialization',async()=>{
      const changedPhone='5511777777777',now=Date.now();const lead=await db.lead.create({data:{workspaceId:config.workspaceId,whatsappInstanceId:config.bindings[0].whatsappInstanceId,phoneHash:hashPhoneIdentity(changedPhone)!,adId:'fixture-ad',ctwaClid:'fixture-stale-click'}});
      const stale:SyncIntent={...body,publication:{id:'publication-stale',version:3,publishedAt:new Date(now-1000).toISOString()},lead:{id:'stale-lead',phone:changedPhone,adId:'fixture-ad',ctwaClid:'fixture-stale-click'},origin:{instanceName:'first',waChatId:`${changedPhone}@s.whatsapp.net`,evidenceMessageId:'stale-message'},transitions:[{id:'stale-stage',stage:'n1',occurredAt:new Date(now-60000).toISOString()}]};
      const key=intentKey(stale);await service.accept(stale,key);await service.process(key);const stage=await db.reportSyncStage.findFirstOrThrow({where:{intentId:key}});expect(stage.executionId).toBeTruthy();
      await db.lead.update({where:{id:lead.id},data:{adId:'different-ad',ctwaClid:'different-click'}});
      expect(await production.processExecution({workspaceId:config.workspaceId,providerConversionExecutionId:stage.executionId!})).toEqual({status:'unchanged'});
      const execution=await db.providerConversionRuleExecution.findUniqueOrThrow({where:{id:stage.executionId!}});expect(execution.status).toBe('blocked');expect(execution.conversionEventLogId).toBeNull();expect((await service.result(key)).status).toBe('partial');
    },60000);
  },
);
