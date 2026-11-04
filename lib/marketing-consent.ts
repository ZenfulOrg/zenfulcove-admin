// Optional marketing opt-ins shown on the guest check-in (reservation) form.
//
// These boxes are never required: guests get their access code whether or not
// they tick them. The exact wording shown is versioned here and stored with
// each submission as proof of consent, so change WORDING_VERSION whenever the
// text changes.

export const MARKETING_CONSENT_WORDING_VERSION = "2026-11-04";

export const SMS_OPT_IN_FIELD = "marketingSmsOptIn";
export const EMAIL_OPT_IN_FIELD = "marketingEmailOptIn";

export const SMS_OPT_IN_TEXT =
  "Text me exclusive deals, open-date alerts and booking help from Zenfulcove. Up to 4 msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required for your stay.";

export const EMAIL_OPT_IN_TEXT =
  "Email me special offers and first access to new experiences. Unsubscribe anytime.";

// Forms that show the opt-ins by default. A form schema can also opt in or out
// explicitly with `marketingConsent: true | false`.
const DEFAULT_CONSENT_FORM_SLUGS = ["welcome-to-zenfulcove"];

export function formShowsMarketingConsent(
  slug: string,
  schema?: { marketingConsent?: unknown } | null
) {
  if (schema && typeof schema.marketingConsent === "boolean") {
    return schema.marketingConsent;
  }
  return DEFAULT_CONSENT_FORM_SLUGS.includes(String(slug || "").trim());
}

export type MarketingConsentRecord = {
  wordingVersion: string;
  recordedAt: string;
  sms: { optedIn: boolean; text: string; phone: string };
  email: { optedIn: boolean; text: string; email: string };
  ip: string;
  userAgent: string;
};

export function buildMarketingConsentRecord({
  payload,
  contact,
  recordedAt,
  ip,
  userAgent,
}: {
  payload: Record<string, unknown>;
  contact: { email?: string; phone?: string };
  recordedAt: string;
  ip: string;
  userAgent: string;
}): MarketingConsentRecord {
  const smsOptedIn = payload[SMS_OPT_IN_FIELD] === true && Boolean(contact.phone);
  const emailOptedIn = payload[EMAIL_OPT_IN_FIELD] === true && Boolean(contact.email);
  return {
    wordingVersion: MARKETING_CONSENT_WORDING_VERSION,
    recordedAt,
    sms: {
      optedIn: smsOptedIn,
      text: SMS_OPT_IN_TEXT,
      phone: smsOptedIn ? String(contact.phone || "") : "",
    },
    email: {
      optedIn: emailOptedIn,
      text: EMAIL_OPT_IN_TEXT,
      email: emailOptedIn ? String(contact.email || "") : "",
    },
    ip: String(ip || "").slice(0, 64),
    userAgent: String(userAgent || "").slice(0, 300),
  };
}
