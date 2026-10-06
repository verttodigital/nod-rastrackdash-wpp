import { hashPhoneIdentity } from "../common/phone/phone-identity";

export type UazapiWebhookBody = Record<string, unknown>;

export type ParsedUazapiWebhook = {
  eventType: string;
  externalEventId?: string;
  leadId?: string;
  phone?: string;
  waChatId?: string;
  phoneHash?: string;
  contactName?: string;
  messageText?: string;
  labels: string[];
  waLabelIds: string[];
  waLabelState: "valid" | "absent" | "invalid";
  labelEventKind: "chat_labels" | "labels_catalog" | "other";
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  ctwaSourceUrl?: string;
  providerInstanceId?: string;
  isGroupChat?: boolean;
};

export function parseUazapiWebhook(
  body: UazapiWebhookBody,
): ParsedUazapiWebhook {
  const message = recordValue(body.message);
  const context = recordValue(body.context);
  const bodyReferral = recordValue(body.referral);
  const messageReferral = recordValue(message?.referral);
  const contextReferral = recordValue(context?.referral);
  const referral = bodyReferral ?? messageReferral ?? contextReferral;
  const referralCandidates = [bodyReferral, messageReferral, contextReferral];
  const adsContext =
    recordValue(body.ads_context_data) ??
    recordValue(body.adsContextData) ??
    recordValue(referral?.ads_context_data) ??
    recordValue(referral?.adsContextData);
  const externalAdReply = getExternalAdReply(body, message);
  const phone = getPhone(body, message);
  const membership = parseUazapiLabelMembership(
    recordValue(body.chat)?.wa_label,
  );

  return {
    eventType:
      firstString(body.EventType) ??
      firstString(body.event) ??
      firstString(body.type) ??
      "uazapi.webhook",
    labelEventKind: getLabelEventKind(body),
    externalEventId:
      firstString(body.id) ??
      firstString(body.eventId) ??
      firstString(body.externalEventId) ??
      firstString(message?.id),
    leadId: firstString(body.leadId),
    phone,
    waChatId: firstString(recordValue(body.chat)?.wa_chatid),
    phoneHash: firstString(body.phoneHash) ?? hashPhoneIdentity(phone),
    contactName: getContactName(body),
    messageText: getMessageText(body),
    labels: getLabels(body),
    waLabelIds: membership.labelIds,
    waLabelState: membership.state,
    campaignId:
      firstString(body.campaignId) ??
      firstString(body.campaign_id) ??
      firstString(body.utm_campaign) ??
      firstString(referral?.campaignId) ??
      firstString(referral?.campaign_id) ??
      firstString(adsContext?.campaignId) ??
      firstString(adsContext?.campaign_id),
    adSetId:
      firstString(body.adSetId) ??
      firstString(body.adsetId) ??
      firstString(body.ad_set_id) ??
      firstString(body.adset_id) ??
      firstString(body.utm_adset) ??
      firstString(referral?.adSetId) ??
      firstString(referral?.adsetId) ??
      firstString(referral?.ad_set_id) ??
      firstString(referral?.adset_id) ??
      firstString(adsContext?.adSetId) ??
      firstString(adsContext?.adsetId) ??
      firstString(adsContext?.ad_set_id) ??
      firstString(adsContext?.adset_id),
    adId:
      firstString(body.adId) ??
      firstString(body.ad_id) ??
      firstString(body.sourceId) ??
      firstString(body.source_id) ??
      firstString(referral?.adId) ??
      firstString(referral?.ad_id) ??
      firstString(referral?.sourceId) ??
      firstString(referral?.source_id) ??
      firstString(adsContext?.adId) ??
      firstString(adsContext?.ad_id) ??
      firstString(externalAdReply?.sourceID),
    ctwaClid:
      firstString(body.ctwa_clid) ??
      firstString(body.ctwaClid) ??
      firstStringFromRecords(referralCandidates, ["ctwa_clid", "ctwaClid"]) ??
      firstString(externalAdReply?.ctwaClid),
    ctwaSourceUrl:
      firstString(body.ctwaSourceUrl) ??
      firstString(body.source_url) ??
      firstStringFromRecords(referralCandidates, ["source_url", "sourceUrl"]) ??
      firstString(externalAdReply?.sourceUrl),
    providerInstanceId: getProviderInstanceId(body),
    isGroupChat: getIsGroupChat(body),
  };
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringFromRecords(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[],
): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }

    for (const key of keys) {
      const value = firstString(record[key]);

      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function getMessageText(body: UazapiWebhookBody): string | undefined {
  const message = body.message;

  if (typeof message === "string") {
    return firstString(message);
  }

  if (message && typeof message === "object" && !Array.isArray(message)) {
    const messageObject = message as Record<string, unknown>;
    return (
      firstString(messageObject.text) ??
      firstString(messageObject.body) ??
      firstString(messageObject.message) ??
      firstString(messageObject.conversation)
    );
  }

  return (
    firstString(body.text) ??
    firstString(body.body) ??
    firstString(body.messageText)
  );
}

function getLabels(body: UazapiWebhookBody): string[] {
  const chat = recordValue(body.chat);
  const rawLabels = body.labels ?? chat?.labels ?? chat?.wa_label ?? body.label;

  if (!rawLabels) {
    return [];
  }

  const list = Array.isArray(rawLabels) ? rawLabels : [rawLabels];

  return list
    .map((label) => labelToString(label))
    .filter((label): label is string => Boolean(label));
}

/** Missing or malformed membership must never clear a previously known state. */
export function parseUazapiLabelMembership(value: unknown): {
  state: "valid" | "absent" | "invalid";
  labelIds: string[];
} {
  if (value === undefined) return { state: "absent", labelIds: [] };
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { state: "invalid", labelIds: [] };
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((id) => typeof id !== "string" || !id.trim())
  ) {
    return { state: "invalid", labelIds: [] };
  }
  return {
    state: "valid",
    labelIds: [...new Set(parsed.map((id) => (id as string).trim()))],
  };
}

function getLabelEventKind(
  body: UazapiWebhookBody,
): ParsedUazapiWebhook["labelEventKind"] {
  const eventType = (
    firstString(body.EventType) ??
    firstString(body.event) ??
    firstString(body.type) ??
    ""
  ).toLocaleLowerCase("en-US");
  if (eventType === "chat_labels") return "chat_labels";
  if (
    eventType === "labels" ||
    (firstString(body.type) ?? "").toLocaleLowerCase("en-US") === "labeledit"
  ) {
    return "labels_catalog";
  }
  return "other";
}

function getPhone(
  body: UazapiWebhookBody,
  message?: Record<string, unknown>,
): string | undefined {
  const contact = recordValue(body.contact);
  const chat = recordValue(body.chat);

  return (
    firstString(body.phone) ??
    firstString(body.from) ??
    firstString(body.sender) ??
    firstString(contact?.phone) ??
    firstString(chat?.phone) ??
    firstString(message?.chatid) ??
    firstString(chat?.wa_chatid)
  );
}

function getContactName(body: UazapiWebhookBody): string | undefined {
  const contact = recordValue(body.contact);
  const chat = recordValue(body.chat);

  return (
    firstString(body.name) ??
    firstString(body.contactName) ??
    firstString(body.pushName) ??
    firstString(contact?.name) ??
    firstString(chat?.wa_name) ??
    firstString(chat?.name)
  );
}

function getIsGroupChat(body: UazapiWebhookBody): boolean | undefined {
  const chat = recordValue(body.chat);

  return typeof chat?.wa_isGroup === "boolean" ? chat.wa_isGroup : undefined;
}

function getExternalAdReply(
  body: UazapiWebhookBody,
  message?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const content = recordValue(message?.content);
  const contentContext = recordValue(content?.contextInfo);
  const messageContext = recordValue(message?.contextInfo);
  const bodyContext = recordValue(body.contextInfo);

  return (
    recordValue(contentContext?.externalAdReply) ??
    recordValue(messageContext?.externalAdReply) ??
    recordValue(bodyContext?.externalAdReply)
  );
}

function getProviderInstanceId(body: UazapiWebhookBody): string | undefined {
  const instance = body.instance;
  const whatsappInstance = body.whatsappInstance;

  return (
    firstString(body.providerInstanceId) ??
    firstString(body.instanceId) ??
    firstString(body.instance_id) ??
    (instance && typeof instance === "object" && !Array.isArray(instance)
      ? (firstString((instance as Record<string, unknown>).id) ??
        firstString((instance as Record<string, unknown>).instanceId) ??
        firstString((instance as Record<string, unknown>).instance_id))
      : undefined) ??
    (whatsappInstance &&
    typeof whatsappInstance === "object" &&
    !Array.isArray(whatsappInstance)
      ? (firstString(
          (whatsappInstance as Record<string, unknown>).providerInstanceId,
        ) ?? firstString((whatsappInstance as Record<string, unknown>).id))
      : undefined)
  );
}

function labelToString(label: unknown): string | undefined {
  if (typeof label === "string") {
    return firstString(label);
  }

  if (label && typeof label === "object" && !Array.isArray(label)) {
    const labelObject = label as Record<string, unknown>;
    return (
      firstString(labelObject.name) ??
      firstString(labelObject.title) ??
      firstString(labelObject.label)
    );
  }

  return undefined;
}
