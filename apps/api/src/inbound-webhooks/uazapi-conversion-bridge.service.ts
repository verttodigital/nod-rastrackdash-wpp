import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

const PARSER_VERSION = "v1";

export type UazapiBridgeInstance = {
  id: string;
  provider?: string;
  workspaceId: string;
  name: string;
  providerInstanceId: string | null;
  connectedPhone?: string | null;
  providerTokenEncrypted?: string | null;
  providerTokenIv?: string | null;
  providerTokenTag?: string | null;
};

export type UazapiBridgeResult = {
  connectionId: string;
  channelId: string;
};

/**
 * U2c: bridges a UAZAPI/NOD WhatsappInstance into an InboundWebhookConnection +
 * InboundWebhookChannel pair so it shows up in the same "Gatilhos" builder
 * (Settings) that Umbler/Gupshup use, and so message_phrase provider-conversion
 * rules can be scoped to it via ProviderConversionRuleConfig.channels.
 *
 * One instance <-> one connection <-> one channel (InboundWebhookChannel.
 * whatsappInstanceId is unique). Idempotent: safe to call on every webhook and
 * on every Settings load.
 */
@Injectable()
export class UazapiConversionBridgeService {
  private readonly logger = new Logger(UazapiConversionBridgeService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async ensureBridge(
    instance: UazapiBridgeInstance,
  ): Promise<UazapiBridgeResult> {
    const existing = await this.findExisting(instance);
    if (existing) return existing;

    return this.prisma.$transaction(async (transaction) => {
      // Re-check inside the transaction: two concurrent webhooks for the same
      // instance must not create two connections.
      const current = await transaction.inboundWebhookChannel.findUnique({
        where: { whatsappInstanceId: instance.id },
        select: { id: true, connectionId: true, workspaceId: true },
      });
      if (current && current.workspaceId === instance.workspaceId) {
        return { connectionId: current.connectionId, channelId: current.id };
      }

      const release = await transaction.inboundWebhookParserRelease.upsert({
        where: {
          provider_version: {
            provider: "uazapi",
            version: PARSER_VERSION,
          },
        },
        create: {
          provider: "uazapi",
          version: PARSER_VERSION,
          // UAZAPI messages are evaluated straight off the decision engine
          // (no reparse step), so there is no separate parser certification
          // workflow to gate on here.
          status: "certified",
          certifiedAt: new Date(),
        },
        update: {},
      });

      const connection = await transaction.inboundWebhookConnection.create({
        data: {
          workspaceId: instance.workspaceId,
          provider: "uazapi",
          displayName: instance.name?.trim() || "UAZAPI",
          parserReleaseId: release.id,
          status: "observation",
        },
        select: { id: true },
      });

      const channel = await transaction.inboundWebhookChannel.create({
        data: {
          workspaceId: instance.workspaceId,
          connectionId: connection.id,
          organizationId: instance.id,
          providerChannelId: instance.providerInstanceId || instance.id,
          // A connection test can provide the business's actual WhatsApp
          // number before any inbound event arrives. Existing webhook paths
          // retain their stable fallback until they provide that identity.
          connectedPhone:
            instance.connectedPhone?.trim() ||
            instance.providerInstanceId?.trim() ||
            instance.id,
          channelName: instance.name,
          whatsappInstanceId: instance.id,
        },
        select: { id: true },
      });

      this.logger.log(
        JSON.stringify({
          event: "uazapi_conversion_bridge_provisioned",
          workspaceId: instance.workspaceId,
          whatsappInstanceId: instance.id,
          connectionId: connection.id,
          channelId: channel.id,
        }),
      );

      return { connectionId: connection.id, channelId: channel.id };
    });
  }

  private async findExisting(
    instance: UazapiBridgeInstance,
  ): Promise<UazapiBridgeResult | null> {
    const channel = await this.prisma.inboundWebhookChannel.findUnique({
      where: { whatsappInstanceId: instance.id },
      select: { id: true, connectionId: true, workspaceId: true },
    });

    return channel && channel.workspaceId === instance.workspaceId
      ? { connectionId: channel.connectionId, channelId: channel.id }
      : null;
  }
}
