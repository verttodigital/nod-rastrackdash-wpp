import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ReportSyncRepository } from "./report-sync.repository";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { UazapiConversionBridgeService } from "../inbound-webhooks/uazapi-conversion-bridge.service";
import {
  UazapiLabelOperationsService,
  UazapiLabelOperationError,
} from "../integrations/whatsapp-providers/uazapi-label-operations.service";
import { mapping, stages, readSyncConfig } from "./report-sync.contract";

/** Explicit operator setup; never called by observation or incoming publications. */
@Injectable()
export class ReportSyncOps {
  constructor(
    @Inject(ReportSyncRepository) private readonly repo: ReportSyncRepository,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(UazapiConversionBridgeService)
    private readonly bridge: UazapiConversionBridgeService,
    @Inject(UazapiLabelOperationsService)
    private readonly labels: UazapiLabelOperationsService,
  ) {}
  async provision(options: { apply?: boolean; expectedRules?: number } = {}) {
    const config = readSyncConfig(this.env);
    if (!config) throw new ConflictException("integration_disabled");
    if (config.mode === "production")
      throw new ConflictException("setup_requires_paused_or_observation");
    const instances = await this.repo.db.whatsappInstance.findMany({
      where: {
        workspaceId: config.workspaceId,
        id: { in: config.bindings.map((b) => b.whatsappInstanceId) },
        provider: "uazapi_byo",
      },
    });
    if (instances.length !== 2 || instances.some((i) => !i.configEncrypted))
      throw new ConflictException("connection_scope_invalid");
    const existing = await this.repo.db.reportSyncBinding.findMany({
      where: { sourceId: config.sourceId, workspaceId: config.workspaceId },
    });
    if (!options.apply)
      return {
        dryRun: true,
        instanceCount: instances.length,
        expectedRules: 6,
        existingRules: existing.length,
        stages: stages.map((stage) => ({ stage, ...mapping[stage] })),
      };
    if (options.expectedRules !== 6)
      throw new ConflictException("expected_rule_count_required");
    await this.repo.db.$transaction((tx) => this.repo.assertSource(tx, config));
    for (const instance of instances) {
      const lease = await this.repo.acquire(
        `report-setup:${config.workspaceId}:${instance.id}`,
      );
      if (!lease) throw new ConflictException("setup_instance_busy");
      try {
        const beforeRequest = async () => {
          let wait = await this.repo.reserve(instance.id, 1000);
          while (wait > 0) {
            await this.repo.fence(lease);
            const interval = Math.min(wait, 30000);
            await new Promise((resolve) => setTimeout(resolve, interval));
            wait -= interval;
          }
          await this.repo.fence(lease);
        };
        const bridged = await this.bridge.ensureBridge(instance);
        const connection =
          await this.repo.db.inboundWebhookConnection.findUniqueOrThrow({
            where: { id: bridged.connectionId },
          });
        for (const stage of stages) {
          const previous = existing.find(
            (b) => b.whatsappInstanceId === instance.id && b.stage === stage,
          );
          if (previous) continue;
          const label = await this.labels.ensureCatalogLabel(
            config.workspaceId,
            instance.id,
            mapping[stage].label,
            beforeRequest,
          );
          await this.repo.db.$transaction(async (tx) => {
            await this.repo.sourceLock(tx, config.sourceId);
            if (
              await tx.reportSyncBinding.findUnique({
                where: {
                  sourceId_whatsappInstanceId_stage: {
                    sourceId: config.sourceId,
                    whatsappInstanceId: instance.id,
                    stage,
                  },
                },
              })
            )
              return;
            const conversion = await tx.conversionRule.create({
              data: {
                workspaceId: config.workspaceId,
                name: `Published report: ${mapping[stage].label}`,
                triggerType: "provider_automation",
                triggerValue: label.name,
                matchMode: "exact",
                eventName: mapping[stage].eventName,
                defaultValueCents: mapping[stage].valueCents,
                defaultCurrency: mapping[stage].valueCents ? "BRL" : null,
                defaultItems: {
                  uazapiLabels: [{ name: label.name, matchKeys: [label.id] }],
                },
                active: true,
              },
            });
            const rule = await tx.providerConversionRuleConfig.create({
              data: {
                workspaceId: config.workspaceId,
                conversionRuleId: conversion.id,
                connectionId: connection.id,
                parserReleaseId: connection.parserReleaseId,
                mode: "observation",
                messageTriggerPhrases: [label.name],
                requiresReportContext: true,
                channels: { create: { channelId: bridged.channelId } },
              },
            });
            await tx.reportSyncBinding.create({
              data: {
                id: randomUUID(),
                sourceId: config.sourceId,
                workspaceId: config.workspaceId,
                whatsappInstanceId: instance.id,
                stage,
                labelId: label.id,
                providerRuleId: rule.id,
              },
            });
          });
        }
      } catch (error) {
        if (
          error instanceof UazapiLabelOperationError &&
          error.httpStatus === 429
        ) {
          await this.repo.reserve(
            instance.id,
            Math.max(1000, error.retryAfterMs ?? 30000),
          );
        }
        throw error;
      } finally {
        await this.repo.release(lease);
      }
    }
    const result = await this.repo.db.reportSyncBinding.findMany({
      where: { sourceId: config.sourceId, workspaceId: config.workspaceId },
    });
    if (result.length !== 6)
      throw new ConflictException("setup_rule_count_mismatch");
    return {
      dryRun: false,
      ruleCount: result.length,
      productionEnabled: false,
    };
  }
}
