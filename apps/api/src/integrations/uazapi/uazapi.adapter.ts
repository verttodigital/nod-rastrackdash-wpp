import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import type {
  IntegrationAdapter,
  IntegrationEnv,
  IntegrationHealthDto,
} from "../integration.types";
import type { WhatsappLabelDto } from "@wpptrack/shared";
import { INTEGRATION_ENV } from "../integration.types";
import {
  fetchProviderUrl,
  normalizeProviderBaseUrl,
  providerRequestFailureMessage,
} from "../whatsapp-providers/whatsapp-provider-http";

export type UazapiConnectionResult = {
  providerInstanceId: string | null;
  connectionStatus:
    | "not_configured"
    | "pending"
    | "qr_required"
    | "connected"
    | "disconnected"
    | "error";
  qrCode: string | null;
  connectedPhone: string | null;
  message: string | null;
};

export type UazapiLabelListResult = {
  status: "success" | "not_configured" | "error";
  message: string | null;
  labels: WhatsappLabelDto[];
};

export type UazapiWebhookConfigurationResult = {
  status: "configured" | "not_configured" | "error";
  message: string | null;
};

export type UazapiCreateInstanceInput = {
  name: string;
  localInstanceId: string;
  workspaceId: string;
};

export type UazapiCreateInstanceResult = {
  status: "created" | "not_configured" | "error";
  providerInstanceId: string | null;
  instanceToken: string | null;
  message: string | null;
};

export type UazapiDeleteInstanceResult = {
  status: "deleted" | "not_configured" | "error";
  alreadyMissing: boolean;
  message: string | null;
};

@Injectable()
export class UazapiAdapter implements IntegrationAdapter {
  readonly provider = "uazapi" as const;

  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(): Promise<IntegrationHealthDto> {
    const hasCredentials = Boolean(
      this.env.UAZAPI_BASE_URL && this.env.UAZAPI_TOKEN,
    );

    const hasValidBaseUrl =
      !this.env.UAZAPI_BASE_URL ||
      Boolean(normalizeProviderBaseUrl(this.env.UAZAPI_BASE_URL));

    return {
      provider: this.provider,
      status:
        hasCredentials && hasValidBaseUrl
          ? "connected"
          : hasCredentials
            ? "error"
            : "disconnected",
      checkedAt: new Date().toISOString(),
      message: hasCredentials
        ? hasValidBaseUrl
          ? undefined
          : "Invalid UAZAPI_BASE_URL"
        : "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
    };
  }

  async createInstance(
    input: UazapiCreateInstanceInput,
  ): Promise<UazapiCreateInstanceResult> {
    // F3.2 rastrackdash sanitize (rewrite_rules.uazapi-byo-only): fleet
    // admin instance provisioning removed for the BYO single-instance
    // student edition. No callers remain once billing/package-uazapi-
    // provisioning.service.ts is stripped; kept as a stub so this class
    // still satisfies IntegrationAdapter.
    void input;
    return {
      status: "not_configured",
      providerInstanceId: null,
      instanceToken: null,
      message:
        "Instance provisioning is not available in the BYO edition; connect your own Uazapi instance via UAZAPI_BASE_URL/UAZAPI_TOKEN.",
    };
  }

  async getInstanceStatus(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<UazapiConnectionResult> {
    return this.requestInstance(
      "GET",
      "/instance/status",
      instanceRef,
      instanceToken,
    );
  }

  /**
   * Checks a saved BYO connection without falling back to process env.
   * Health responses intentionally contain only stable, non-sensitive
   * failure messages: a provider may echo its request URL or token in an
   * error payload.
   */
  async getInstanceStatusForConnection(
    baseUrl: string,
    token: string,
  ): Promise<UazapiConnectionResult> {
    return this.requestInstance("GET", "/instance/status", "", token, {
      baseUrl,
      redactFailureMessage: true,
    });
  }

  async connectInstance(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<UazapiConnectionResult> {
    return this.requestInstance(
      "POST",
      "/instance/connect",
      instanceRef,
      instanceToken,
    );
  }

  async getQr(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<UazapiConnectionResult> {
    return this.getInstanceStatus(instanceRef, instanceToken);
  }

  async deleteInstance(
    instanceToken?: string | null,
  ): Promise<UazapiDeleteInstanceResult> {
    const token = this.getInstanceToken(instanceToken);

    const configuredBaseUrl = this.env.UAZAPI_BASE_URL?.trim();
    const baseUrl = configuredBaseUrl
      ? normalizeProviderBaseUrl(configuredBaseUrl)
      : null;

    if (!baseUrl || !token) {
      return {
        status: configuredBaseUrl && !baseUrl ? "error" : "not_configured",
        alreadyMissing: false,
        message:
          configuredBaseUrl && !baseUrl
            ? "Invalid UAZAPI_BASE_URL"
            : "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
      };
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${baseUrl}/instance`,
        {
          method: "DELETE",
          headers: {
            token,
            "Content-Type": "application/json",
          },
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      void payload;

      if (response.status === 404) {
        return {
          status: "deleted",
          alreadyMissing: true,
          message: "Instancia ja removida na Uazapi",
        };
      }

      if (!response.ok) {
        return {
          status: "error",
          alreadyMissing: false,
          message: `Uazapi HTTP ${response.status}`,
        };
      }

      return {
        status: "deleted",
        alreadyMissing: false,
        message: null,
      };
    } catch (error) {
      return {
        status: "error",
        alreadyMissing: false,
        message: providerRequestFailureMessage(error),
      };
    }
  }

  async configureInstanceWebhook(input: {
    instanceToken: string | null;
    webhookUrl: string | null;
  }): Promise<UazapiWebhookConfigurationResult> {
    const configuredBaseUrl = this.env.UAZAPI_BASE_URL?.trim();
    const baseUrl = configuredBaseUrl
      ? normalizeProviderBaseUrl(configuredBaseUrl)
      : null;

    if (!baseUrl || !input.instanceToken || !input.webhookUrl) {
      return {
        status: configuredBaseUrl && !baseUrl ? "error" : "not_configured",
        message:
          configuredBaseUrl && !baseUrl
            ? "Invalid UAZAPI_BASE_URL"
            : "Missing UAZAPI_BASE_URL, instance token or webhook URL",
      };
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${baseUrl}/webhook`,
        {
          method: "POST",
          headers: {
            token: input.instanceToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            enabled: true,
            url: input.webhookUrl,
            events: [
              "messages",
              "messages_update",
              "labels",
              "chat_labels",
              "connection",
            ],
            excludeMessages: ["wasSentByApi"],
            addUrlEvents: false,
            addUrlTypesMessages: false,
          }),
        },
      );
      if (!response.ok) {
        return {
          status: "error",
          message: `Uazapi HTTP ${response.status}`,
        };
      }

      return {
        status: "configured",
        message: null,
      };
    } catch (error) {
      return {
        status: "error",
        message: providerRequestFailureMessage(error),
      };
    }
  }

  async listLabels(
    _instanceRef: string,
    instanceToken?: string | null,
    connection?: { baseUrl: string },
  ): Promise<UazapiLabelListResult> {
    // Explicit connection config is authoritative, including missing values.
    const token = connection
      ? instanceToken?.trim()
      : this.getInstanceToken(instanceToken);

    const configuredBaseUrl = (
      connection ? connection.baseUrl : this.env.UAZAPI_BASE_URL
    )?.trim();
    const baseUrl = configuredBaseUrl
      ? normalizeProviderBaseUrl(configuredBaseUrl)
      : null;

    if (!baseUrl || !token) {
      return {
        status: configuredBaseUrl && !baseUrl ? "error" : "not_configured",
        message:
          configuredBaseUrl && !baseUrl
            ? "Invalid UAZAPI_BASE_URL"
            : "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
        labels: [],
      };
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${baseUrl}/labels`,
        {
          method: "GET",
          headers: {
            token,
            "Content-Type": "application/json",
          },
        },
      );
      const payload = (await response.json().catch(() => [])) as unknown;

      if (!response.ok) {
        return {
          status: "error",
          message: `Uazapi HTTP ${response.status}`,
          labels: [],
        };
      }

      return {
        status: "success",
        message: null,
        labels: this.toLabels(payload),
      };
    } catch (error) {
      return {
        status: "error",
        message: providerRequestFailureMessage(error),
        labels: [],
      };
    }
  }

  private async requestInstance(
    method: "GET" | "POST",
    path: string,
    instanceRef: string,
    instanceToken?: string | null,
    options?: {
      baseUrl?: string;
      redactFailureMessage?: boolean;
    },
  ): Promise<UazapiConnectionResult> {
    const token = this.getInstanceToken(instanceToken);
    const configuredBaseUrl = (
      options?.baseUrl ?? this.env.UAZAPI_BASE_URL
    )?.trim();
    const baseUrl = configuredBaseUrl
      ? normalizeProviderBaseUrl(configuredBaseUrl)
      : null;

    if (!baseUrl || !token) {
      return {
        providerInstanceId: instanceRef,
        connectionStatus:
          configuredBaseUrl && !baseUrl ? "error" : "not_configured",
        qrCode: null,
        connectedPhone: null,
        message:
          configuredBaseUrl && !baseUrl
            ? "Invalid UAZAPI_BASE_URL"
            : "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
      };
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            token,
            "Content-Type": "application/json",
          },
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (!response.ok) {
        return {
          providerInstanceId: instanceRef,
          connectionStatus: "error",
          qrCode: null,
          connectedPhone: null,
          message: options?.redactFailureMessage
            ? `Uazapi status API HTTP ${response.status}`
            : `Uazapi HTTP ${response.status}`,
        };
      }

      return this.toConnectionResult(payload, instanceRef);
    } catch (error) {
      return {
        providerInstanceId: instanceRef,
        connectionStatus: "error",
        qrCode: null,
        connectedPhone: null,
        message: options?.redactFailureMessage
          ? "Uazapi status API request failed"
          : providerRequestFailureMessage(error),
      };
    }
  }

  private toConnectionResult(
    payload: Record<string, unknown>,
    fallbackInstanceId: string,
  ): UazapiConnectionResult {
    const instance = this.asRecord(payload.instance);
    const status = this.asRecord(payload.status);
    const statusJid = this.asRecord(status?.jid);
    const instanceStatus =
      this.asString(instance?.status) ?? this.asString(payload.status);
    const qrCode =
      this.asString(instance?.qrcode) ??
      this.asString(instance?.qrCode) ??
      this.asString(payload.qrcode) ??
      this.asString(payload.qrCode) ??
      this.asString(payload.qr) ??
      null;

    return {
      providerInstanceId:
        this.asString(instance?.id) ??
        this.asString(instance?.instanceId) ??
        this.asString(payload.instanceId) ??
        this.asString(payload.instance_id) ??
        fallbackInstanceId,
      connectionStatus: this.normalizeStatus(instanceStatus, status, qrCode),
      qrCode,
      connectedPhone: this.firstNormalizedPhone(
        instance?.owner,
        instance?.phone,
        instance?.phoneNumber,
        status?.owner,
        status?.phone,
        status?.phoneNumber,
        status?.jid,
        statusJid?.user,
        statusJid?.id,
        payload.owner,
        payload.phone,
        payload.phoneNumber,
      ),
      // Successful status payloads can still contain provider diagnostics;
      // callers receive the structured status/QR/phone fields instead.
      message: null,
    };
  }

  private normalizeStatus(
    value: unknown,
    status: Record<string, unknown> | null,
    qrCode: string | null,
  ): UazapiConnectionResult["connectionStatus"] {
    if (status?.connected === true || status?.loggedIn === true) {
      return "connected";
    }

    const statusText = this.asString(value)?.toLowerCase();

    if (!statusText) {
      return "pending";
    }

    if (["connected", "open", "online", "authenticated"].includes(statusText)) {
      return "connected";
    }

    if (
      ["qr", "qrcode", "qr_required", "scan_qr"].includes(statusText) ||
      (statusText === "connecting" && qrCode)
    ) {
      return "qr_required";
    }

    if (
      ["disconnected", "closed", "offline", "hibernated"].includes(statusText)
    ) {
      return "disconnected";
    }

    if (["error", "failed"].includes(statusText)) {
      return "error";
    }

    return "pending";
  }

  private firstNormalizedPhone(...values: unknown[]): string | null {
    for (const value of values) {
      const phone = this.normalizePhone(value);
      if (phone) {
        return phone;
      }
    }

    return null;
  }

  private normalizePhone(value: unknown): string | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;

      return this.firstNormalizedPhone(
        record.user,
        record.phone,
        record.phoneNumber,
        record.number,
        record.id,
      );
    }

    if (typeof value !== "string") {
      return null;
    }

    const address = value.trim().split("@")[0]?.split(":")[0] ?? "";
    const digits = address.replace(/\D/gu, "");

    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private toLabels(payload: unknown): WhatsappLabelDto[] {
    const items = Array.isArray(payload) ? payload : [];

    return items.flatMap((item) => {
      const label = this.asRecord(item);
      const id = this.asString(label?.id) ?? this.asString(label?.labelid);
      const name = this.asString(label?.name);

      if (!id || !name) {
        return [];
      }

      return [
        {
          id,
          name,
          colorHex: this.asString(label?.colorHex),
          labelId: this.asString(label?.labelid),
        },
      ];
    });
  }

  private getInstanceToken(instanceToken?: string | null): string | undefined {
    return instanceToken ?? this.env.UAZAPI_TOKEN;
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
  }
}
