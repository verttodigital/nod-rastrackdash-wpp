import type { WhatsappLabelDto } from "@wpptrack/shared";
import type { IntegrationStatus } from "../integration.types";

/**
 * Identifiers for every WhatsApp connectivity provider the product plans to
 * support (F5 plan). "uazapi_byo" (F5.1), "nod_api" (F5.3b), "waha"
 * (F5.4) and "zapi" (F5.5) all have real, HTTP-backed adapters — no stubs
 * remain.
 */
export type WhatsappProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

export type UazapiByoConfig = {
  baseUrl: string;
  token: string;
  instanceId?: string;
};

/**
 * Placeholder shape for the future NOD managed-broker provider. The broker
 * URL will come from server-side env in F5.3 — this config only tracks
 * whether the provider is enabled for a workspace.
 */
export type NodApiConfig = {
  enabled: boolean;
  instanceId?: string;
  instanceToken?: string;
};

/** Config for the real "waha" adapter (F5.4, pure BYO self-host). */
export type WahaConfig = {
  baseUrl: string;
  apiKey: string;
  session?: string;
};

/** Config for the real "zapi" adapter (F5.5, pure BYO Z-API instance). */
export type ZapiConfig = {
  baseUrl: string;
  instanceId: string;
  token: string;
};

export type WhatsappProviderConfig =
  | { provider: "uazapi_byo"; config: UazapiByoConfig }
  | { provider: "nod_api"; config: NodApiConfig }
  | { provider: "waha"; config: WahaConfig }
  | { provider: "zapi"; config: ZapiConfig };

export interface WhatsappProviderHealthDto {
  provider: WhatsappProviderId;
  status: IntegrationStatus;
  checkedAt: string;
  message?: string;
}

export interface WhatsappLabelListResult {
  status: "success" | "not_configured" | "error";
  message: string | null;
  labels: WhatsappLabelDto[];
}

export interface NodApiManagedInstanceDto {
  instanceId: string;
  instanceToken: string;
  status: string;
}

export interface NodApiManagedInstanceStatusDto {
  status: string;
  qr?: string | null;
  phone?: string | null;
}

/**
 * Minimal surface the product actually calls today across
 * integrations.service.ts and inbound-webhooks. Extracted from
 * UazapiAdapter rather than invented up front — only `getHealth` and
 * `listLabels` have live call sites (see F5.1 done report); everything
 * else stays out of the interface until a real caller needs it.
 *
 * `createManagedInstance`/`getManagedInstanceStatus` (F5.3b) are optional
 * because only the "nod_api" adapter implements them today — they map to
 * the broker's `POST /nod-api/instances` and
 * `POST /nod-api/instances/status` endpoints.
 */
export interface WhatsappProviderAdapter {
  readonly id: WhatsappProviderId;
  getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto>;
  listLabels?(
    instanceRef: string,
    instanceToken?: string | null,
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappLabelListResult>;
  createManagedInstance?(name?: string): Promise<NodApiManagedInstanceDto>;
  getManagedInstanceStatus?(
    instanceId: string,
    instanceToken: string,
  ): Promise<NodApiManagedInstanceStatusDto>;
}
