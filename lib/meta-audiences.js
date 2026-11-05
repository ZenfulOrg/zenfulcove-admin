// Meta (Facebook/Instagram) customer-list export.
// Builds a CSV Meta Ads Manager accepts as a "Customer list" custom audience.
// Every identifier is normalized per Meta's rules and SHA-256 hashed here, so
// plain emails/phones never leave the server.
// https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences#hash
import { createHash } from "node:crypto";
import { getMarketingOptInLists } from "@/lib/kv";
import { getContactsFromListDetailed } from "@/lib/sendgrid";
import { getPastGuestEmails } from "@/lib/past-guests";

export const META_AUDIENCES = ["past-guests", "subscribers", "text-club", "everyone"];

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export function metaEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

// Digits only with country code, no "+" or leading zeros. Bare 10-digit
// numbers are treated as US/Canada (+1).
export function metaPhone(value) {
  let digits = String(value || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = `1${digits}`;
  if (digits.length < 11 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return "";
  return digits;
}

// Lowercase letters only (Meta strips punctuation and spaces from names).
export function metaName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
}

export function metaAudienceRows(contacts) {
  const seen = new Set();
  const rows = [];
  for (const contact of contacts || []) {
    const email = metaEmail(contact.email);
    const phone = metaPhone(contact.phone);
    if (!email && !phone) continue;
    const key = email || `p:${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fn = metaName(contact.firstName);
    const ln = metaName(contact.lastName);
    rows.push({
      email: email ? sha256(email) : "",
      phone: phone ? sha256(phone) : "",
      fn: fn ? sha256(fn) : "",
      ln: ln ? sha256(ln) : "",
      country: sha256("us"),
    });
  }
  return rows;
}

export function metaAudienceCsv(rows) {
  const header = "email,phone,fn,ln,country";
  return [header, ...rows.map((r) => [r.email, r.phone, r.fn, r.ln, r.country].join(","))].join("\n") + "\n";
}

function fromSendgrid(contact) {
  return {
    email: contact.email || contact.EMAIL || "",
    firstName: contact.first_name || contact.FIRST_NAME || "",
    lastName: contact.last_name || contact.LAST_NAME || "",
    phone: contact.phone_number || contact.PHONE_NUMBER || "",
  };
}

export function selectAudience(audience, { emailContacts, smsContacts, pastGuestEmails }) {
  const isPast = (c) => pastGuestEmails.has(String(c.email || "").trim().toLowerCase());
  switch (audience) {
    case "past-guests":
      return emailContacts.filter(isPast);
    case "subscribers":
      return emailContacts.filter((c) => !isPast(c));
    case "text-club":
      return smsContacts;
    case "everyone":
      return [...emailContacts, ...smsContacts];
    default:
      throw new Error(`Unknown audience "${audience}"`);
  }
}

export async function buildMetaAudienceCsv(audience) {
  if (!META_AUDIENCES.includes(audience)) throw new Error(`Unknown audience "${audience}"`);
  const { emailListId, smsListId } = await getMarketingOptInLists();
  if (!emailListId || !smsListId) throw new Error("Marketing lists are not set up yet");
  const [emailRaw, smsRaw, pastGuestEmails] = await Promise.all([
    getContactsFromListDetailed(emailListId),
    audience === "text-club" || audience === "everyone" ? getContactsFromListDetailed(smsListId) : [],
    audience === "past-guests" || audience === "subscribers" ? getPastGuestEmails() : new Set(),
  ]);
  const contacts = selectAudience(audience, {
    emailContacts: emailRaw.map(fromSendgrid),
    smsContacts: smsRaw.map(fromSendgrid),
    pastGuestEmails,
  });
  const rows = metaAudienceRows(contacts);
  return { csv: metaAudienceCsv(rows), count: rows.length };
}
