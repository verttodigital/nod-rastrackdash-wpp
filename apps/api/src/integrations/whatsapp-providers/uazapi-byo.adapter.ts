import { Injectable } from "@nestjs/common";
import {
  UazapiAdapter,
  type UazapiConnectionResult,
} from "../uazapi/uazapi.adapter";
import type { IntegrationStatus } from "../integration.types";
import type {
  WhatsappLabelListResult,
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
} from "./whatsapp-provider.types";

/**
 * First real WhatsApp provider adapter: thin wrapper around the existing
 * UazapiAdapter (composition, not a rewrite) that adapts it to the
 * WhatsappProviderAdapter interface. Keeps UazapiAdapter itself untouched
 * so its other call sites (inbound-webhooks, IntegrationsService) keep
 * working exactly as before.
 */
@Injectable()
export class UazapiByoAdapter implements WhatsappProviderAdapter {
  readonly id = "uazapi_byo" as const;

  constructor(private readonly uazapi: UazapiAdapter) {}

  async getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto> {
    if (config?.provider === this.id) {
      return (await this.testSavedConnection(config)).health;
    }

    const health = await this.uazapi.getHealth();

    return {
      provider: this.id,
      status: health.status,
      checkedAt: health.checkedAt,
      message: health.message,
    };
  }

  /**
   * Keeps the UAZAPI status identity available to the saved-connection test
   * flow. The shared provider-health contract deliberately remains limited to
   * health data, so other provider tests cannot provision trigger channels.
   */
  async testSavedConnection(
    config: Extract<
      WhatsappProviderConfig,
      {
        provider: "uazapi_byo";
      }
    >,
  ): Promise<{
    health: WhatsappProviderHealthDto;
    providerInstanceId: string | null;
    connectedPhone: string | null;
  }> {
    const baseUrl = config.config.baseUrl.trim();
    const token = config.config.token.trim();
    const checkedAt = new Date().toISOString();

    if (!baseUrl || !token) {
      return {
        health: {
          provider: this.id,
          status: "disconnected",
          checkedAt,
          message: "Missing Uazapi connection credentials",
        },
        providerInstanceId: null,
        connectedPhone: null,
      };
    }

    const connection = await this.uazapi.getInstanceStatusForConnection(
      baseUrl,
      token,
    );
    return {
      health: this.healthFromConnection(connection, checkedAt),
      providerInstanceId: connection.providerInstanceId,
      connectedPhone: connection.connectedPhone,
    };
  }

  private healthFromConnection(
    connection: UazapiConnectionResult,
    checkedAt: string,
  ): WhatsappProviderHealthDto {
    return {
      provider: this.id,
      status: this.mapConnectionStatus(connection.connectionStatus),
      checkedAt,
      message: this.connectionStatusMessage(connection.connectionStatus),
    };
  }

  private mapConnectionStatus(
    status:
      | "not_configured"
      | "pending"
      | "qr_required"
      | "connected"
      | "disconnected"
      | "error",
  ): IntegrationStatus {
    switch (status) {
      case "connected":
        return "connected";
      case "disconnected":
      case "not_configured":
        return "disconnected";
      case "qr_required":
        return "needs_reconnect";
      case "pending":
        return "syncing";
      case "error":
        return "error";
    }
  }

  private connectionStatusMessage(
    status:
      | "not_configured"
      | "pending"
      | "qr_required"
      | "connected"
      | "disconnected"
      | "error",
  ): string | undefined {
    return status === "connected"
      ? undefined
      : `Uazapi instance status: ${status}`;
  }

  async listLabels(
    instanceRef: string,
    instanceToken?: string | null,
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappLabelListResult> {
    if (config) {
      if (config.provider !== this.id)
        return {
          status: "error",
          message: "Invalid Uazapi connection configuration",
          labels: [],
        };
      return this.uazapi.listLabels(instanceRef, config.config.token, {
        baseUrl: config.config.baseUrl,
      });
    }
    return this.uazapi.listLabels(instanceRef, instanceToken);
  }
}
