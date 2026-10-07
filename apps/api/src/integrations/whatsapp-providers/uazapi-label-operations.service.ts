import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import { MetaTokenEncryptionService } from "../meta/meta-token-encryption.service";
import {
  fetchProviderUrl,
  normalizeProviderBaseUrl,
} from "./whatsapp-provider-http";
import { parseUazapiLabelMembership } from "../../webhooks/uazapi-webhook-parser";

export class UazapiLabelOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterMs: number | null = null,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "UazapiLabelOperationError";
  }
}

type Label = { id: string; name: string };
type CatalogLabel = Label & { membershipId?: string };
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());
const normalizedName = (name: string) =>
  name.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");

/** No globals, provider response bodies, or credentials escape this service. */
@Injectable()
export class UazapiLabelOperationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaTokenEncryptionService)
    private readonly encryption: MetaTokenEncryptionService,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async listCatalog(
    workspaceId: string,
    whatsappInstanceId: string,
  ): Promise<Label[]> {
    return (await this.readCatalog(workspaceId, whatsappInstanceId)).map(
      ({ id, name }) => ({ id, name }),
    );
  }

  private async readCatalog(
    workspaceId: string,
    whatsappInstanceId: string,
    beforeRequest?: () => Promise<void>,
  ): Promise<CatalogLabel[]> {
    const payload = await this.request(
      workspaceId,
      whatsappInstanceId,
      "/labels",
      "GET",
      undefined,
      beforeRequest,
    );
    if (!Array.isArray(payload))
      throw new UazapiLabelOperationError("label_catalog_invalid");
    const labels = payload.map((value) => {
      const row = object(value);
      const id = row && (nonempty(row.labelid) ? row.labelid : row.id);
      if (!row || !nonempty(id) || !nonempty(row.name))
        throw new UazapiLabelOperationError("label_catalog_invalid");
      const canonicalId = id.trim();
      const membershipId =
        nonempty(row.id) &&
        row.id.includes(":") &&
        row.id.endsWith(`:${canonicalId}`)
          ? row.id.trim()
          : undefined;
      return { id: canonicalId, name: row.name, membershipId };
    });
    if (new Set(labels.map((label) => label.id)).size !== labels.length)
      throw new UazapiLabelOperationError("label_catalog_ambiguous");
    return labels;
  }

  async normalizeLabelIds(
    workspaceId: string,
    whatsappInstanceId: string,
    labelIds: string[],
    beforeRequest?: () => Promise<void>,
  ): Promise<string[]> {
    const ids = [...new Set(labelIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.some((id) => id.includes(":"))) return ids;
    // The authenticated connection's catalog is the authority for an alias.
    // Never strip arbitrary prefixes: another instance may reuse the short ID.
    const catalog = await this.readCatalog(
      workspaceId,
      whatsappInstanceId,
      beforeRequest,
    );
    const aliases = new Map(
      catalog
        .filter((label) => label.membershipId)
        .map((label) => [label.membershipId!, label.id]),
    );
    return [...new Set(ids.map((id) => aliases.get(id) ?? id))];
  }

  async ensureCatalogLabel(
    workspaceId: string,
    whatsappInstanceId: string,
    name: string,
    beforeRequest?: () => Promise<void>,
  ): Promise<Label> {
    if (!nonempty(name) || name.length > 100)
      throw new UazapiLabelOperationError("label_name_invalid");
    const find = (labels: Label[]) => {
      const matches = labels.filter(
        (label) => normalizedName(label.name) === normalizedName(name),
      );
      if (matches.length > 1)
        throw new UazapiLabelOperationError("label_name_ambiguous");
      return matches[0]
        ? { id: matches[0].id, name: matches[0].name }
        : undefined;
    };
    const existing = find(
      await this.readCatalog(workspaceId, whatsappInstanceId, beforeRequest),
    );
    if (existing) return existing;
    await this.request(
      workspaceId,
      whatsappInstanceId,
      "/label/edit",
      "POST",
      {
        labelid: "new",
        name: name.trim(),
        color: 0,
        delete: false,
      },
      beforeRequest,
    );
    const created = find(
      await this.readCatalog(workspaceId, whatsappInstanceId, beforeRequest),
    );
    if (!created)
      throw new UazapiLabelOperationError(
        "label_creation_unconfirmed",
        null,
        null,
        true,
      );
    return created;
  }

  async readChatLabels(
    workspaceId: string,
    whatsappInstanceId: string,
    number: string,
    beforeRequest?: () => Promise<void>,
  ): Promise<{
    chatId: string;
    phone: string | null;
    labelIds: string[];
    lid: string | null;
  }> {
    const identity = this.identity(number);
    const payload = object(
      await this.request(
        workspaceId,
        whatsappInstanceId,
        "/chat/find",
        "POST",
        {
          wa_chatid: `=${identity.chatId}`,
          operator: "AND",
          limit: 2,
          offset: 0,
          compact: true,
        },
        beforeRequest,
      ),
    );
    if (!payload || !Array.isArray(payload.chats))
      throw new UazapiLabelOperationError("chat_readback_invalid");
    const pagination = object(payload.pagination);
    if (
      payload.chats.length !== 1 ||
      pagination?.hasMore === true ||
      (typeof pagination?.totalRecords === "number" &&
        pagination.totalRecords !== 1)
    ) {
      throw new UazapiLabelOperationError(
        payload.chats.length === 0
          ? "chat_not_found"
          : "chat_identity_ambiguous",
      );
    }
    const chat = object(payload.chats[0]);
    if (!chat || chat.wa_chatid !== identity.chatId || chat.wa_isGroup === true)
      throw new UazapiLabelOperationError("chat_identity_mismatch");
    const membership = parseUazapiLabelMembership(chat.wa_label);
    if (membership.state !== "valid")
      throw new UazapiLabelOperationError("chat_labels_unverifiable");
    const lid =
      typeof chat.wa_chatlid === "string" &&
      /^[1-9]\d{0,29}@lid$/u.test(chat.wa_chatlid)
        ? chat.wa_chatlid
        : null;
    return {
      ...identity,
      labelIds: await this.normalizeLabelIds(
        workspaceId,
        whatsappInstanceId,
        membership.labelIds,
        beforeRequest,
      ),
      lid,
    };
  }

  async addChatLabel(
    workspaceId: string,
    whatsappInstanceId: string,
    number: string,
    labelId: string,
  ): Promise<void> {
    await this.mutateLabel(
      workspaceId,
      whatsappInstanceId,
      number,
      labelId,
      "add_labelid",
    );
  }

  async removeChatLabel(
    workspaceId: string,
    whatsappInstanceId: string,
    number: string,
    labelId: string,
  ): Promise<void> {
    await this.mutateLabel(
      workspaceId,
      whatsappInstanceId,
      number,
      labelId,
      "remove_labelid",
    );
  }

  private identity(number: string): { chatId: string; phone: string } {
    // LIDs need an independently proven phone mapping before entering this API.
    const match =
      typeof number === "string" &&
      /^([1-9]\d{7,14})(?:@s\.whatsapp\.net)?$/u.exec(number);
    if (!match) throw new UazapiLabelOperationError("chat_identity_invalid");
    return { chatId: `${match[1]}@s.whatsapp.net`, phone: match[1] };
  }

  private async mutateLabel(
    workspaceId: string,
    whatsappInstanceId: string,
    number: string,
    labelId: string,
    operation: "add_labelid" | "remove_labelid",
  ): Promise<void> {
    this.identity(number);
    if (!nonempty(labelId) || labelId.length > 128)
      throw new UazapiLabelOperationError("label_id_invalid");
    await this.request(
      workspaceId,
      whatsappInstanceId,
      "/chat/labels",
      "POST",
      { number, [operation]: labelId },
    );
  }

  private async request(
    workspaceId: string,
    whatsappInstanceId: string,
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    beforeRequest?: () => Promise<void>,
  ): Promise<unknown> {
    const connection = await this.prisma.whatsappInstance.findFirst({
      where: { id: whatsappInstanceId, workspaceId, provider: "uazapi_byo" },
      select: {
        provider: true,
        configEncrypted: true,
        configIv: true,
        configTag: true,
      },
    });
    if (
      !connection?.configEncrypted ||
      !connection.configIv ||
      !connection.configTag
    )
      throw new UazapiLabelOperationError("connection_config_missing");
    let baseUrl: string | null = null;
    let token = "";
    try {
      const config = object(
        JSON.parse(
          this.encryption.decrypt({
            encryptedAccessToken: connection.configEncrypted,
            tokenIv: connection.configIv,
            tokenTag: connection.configTag,
          }),
        ),
      );
      const credentials = object(config?.config);
      if (
        config?.provider === "uazapi_byo" &&
        nonempty(credentials?.baseUrl) &&
        nonempty(credentials?.token)
      ) {
        baseUrl = normalizeProviderBaseUrl(credentials.baseUrl);
        token = credentials.token.trim();
      }
    } catch {
      throw new UazapiLabelOperationError("connection_config_invalid");
    }
    if (!baseUrl || !token)
      throw new UazapiLabelOperationError("connection_config_invalid");
    // Run after credential lookup so pacing/fencing is directly adjacent to HTTP.
    await beforeRequest?.();
    let response: Response;
    try {
      response = await fetchProviderUrl(this.fetchImpl, `${baseUrl}${path}`, {
        method,
        headers: { token, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new UazapiLabelOperationError(
        "provider_request_failed",
        null,
        null,
        true,
      );
    }
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      const seconds =
        retry && /^\d+(?:\.\d+)?$/u.test(retry.trim()) ? Number(retry) : null;
      const date = retry ? Date.parse(retry) : NaN;
      const retryAfterMs =
        seconds !== null
          ? Math.ceil(seconds * 1000)
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : null;
      throw new UazapiLabelOperationError(
        "provider_http_error",
        response.status,
        retryAfterMs,
        response.status === 429 ||
          response.status >= 500 ||
          response.status === 408,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new UazapiLabelOperationError("provider_response_invalid");
    }
  }
}
