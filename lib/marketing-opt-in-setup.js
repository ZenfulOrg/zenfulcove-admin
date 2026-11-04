// One-click setup for the marketing opt-in lists:
//  1. Ensure the "Email Offers" and "Text Club (SMS opt-in)" SendGrid lists exist
//     and save their IDs (KV), so check-in form opt-ins sync automatically.
//  2. Backfill eligible people:
//     - Email Offers: every past guest (non-cancelled Lodgify stays that have
//       started; Lodgify Historic + Current) + everyone who completed the check-in form, excluding OTA relay
//       addresses (Airbnb/Booking.com/Vrbo/etc. forbid marketing to those).
//     - Text Club: ONLY people with a recorded SMS opt-in (check-in form opt-ins
//       and popup contacts whose sms_consent field is "yes").
// Unsubscribes/suppressions are still enforced by SendGrid at send time.

import { getAllBookings } from "@/lib/lodgify";
import { lodgifyBookingStatus } from "@/lib/access-code-messages";
import {
  createContactList,
  getContactsFromListDetailed,
  listAllContactLists,
  listCustomFieldDefinitions,
  upsertContactsToList,
} from "@/lib/sendgrid";
import { extractLocalFormContact, listLocalFormSubmissions } from "@/lib/local-forms";
import { getMarketingOptInLists, setMarketingOptInLists } from "@/lib/kv";
import { PROMOTION_CONTACT_LISTS } from "@/lib/promotion-lists";

export const EMAIL_LIST_NAME = "Email Offers (past guests + opt-ins)";
export const SMS_LIST_NAME = "Text Club (SMS opt-in)";
const CHECKIN_FORM_SLUGS = ["welcome-to-zenfulcove"];

const RELAY_DOMAINS = [
  "guest.airbnb.com",
  "airbnb.com",
  "guest.booking.com",
  "booking.com",
  "messages.homeaway.com",
  "homeaway.com",
  "vrbo.com",
  "expediapartnercentral.com",
  "glampinghub.com",
  "hipcamp.com",
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isRelayEmail(email) {
  const domain = email.split("@")[1] || "";
  return RELAY_DOMAINS.some((relay) => domain === relay || domain.endsWith(`.${relay}`));
}

function toDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function todayCentral() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

function bookingContact(booking) {
  const guest = booking?.guest || booking?.customer || {};
  const email = normalizeEmail(guest.email || booking?.guestEmail || booking?.email);
  const names = splitName(guest.name || booking?.guestName);
  const phoneObject = guest.phone || {};
  const phone =
    typeof phoneObject === "string"
      ? phoneObject
      : phoneObject.fullNumber || phoneObject.e164Phone || phoneObject.number || guest.phoneNumber || "";
  return {
    email,
    firstName: guest.firstName || guest.first_name || names.firstName,
    lastName: guest.lastName || guest.last_name || names.lastName,
    phone: String(phone || "").trim(),
  };
}

function addContact(map, contact) {
  const email = normalizeEmail(contact.email);
  if (!email) return;
  const existing = map.get(email) || { email, firstName: "", lastName: "", phone: "" };
  map.set(email, {
    email,
    firstName: existing.firstName || contact.firstName || "",
    lastName: existing.lastName || contact.lastName || "",
    phone: existing.phone || contact.phone || "",
  });
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  return `${(user || "").slice(0, 2)}***@${domain || ""}`;
}

function contactFieldValue(contact, fieldName, fieldId) {
  const custom = contact?.custom_fields || contact?.customFields || {};
  return String(
    custom?.[fieldName] ?? custom?.[fieldId] ?? contact?.[fieldName] ?? contact?.[fieldId] ?? ""
  )
    .trim()
    .toLowerCase();
}

async function ensureLists({ dryRun }) {
  const saved = await getMarketingOptInLists();
  const existing = await listAllContactLists();
  const byName = new Map(existing.map((list) => [list.name, list.id]));
  const result = { created: [], smsListId: "", emailListId: "" };

  for (const [key, name] of [
    ["emailListId", EMAIL_LIST_NAME],
    ["smsListId", SMS_LIST_NAME],
  ]) {
    const savedId = saved[key];
    if (savedId && existing.some((list) => list.id === savedId)) {
      result[key] = savedId;
    } else if (byName.has(name)) {
      result[key] = byName.get(name);
    } else if (!dryRun) {
      const list = await createContactList(name);
      result[key] = list.id;
      result.created.push(name);
    } else {
      result.created.push(`${name} (would create)`);
    }
  }

  if (!dryRun) {
    await setMarketingOptInLists({ smsListId: result.smsListId, emailListId: result.emailListId });
  }
  return result;
}

async function collectEmailContacts(notes) {
  const contacts = new Map();
  const today = todayCentral();
  let relaySkipped = 0;
  let cancelledSkipped = 0;
  let futureSkipped = 0;

  // Lodgify v2 ignores stayFrom/stayTo; stayFilter selects the window.
  // Historic = departed stays, Current = guests on site now.
  const bookingsById = new Map();
  for (const stayFilter of ["Historic", "Current"]) {
    const batch = await getAllBookings({
      stayFilter,
      page: 1,
      size: 100,
      includeCount: false,
      includeTransactions: false,
      includeExternal: true,
      includeQuoteDetails: false,
    });
    for (const booking of batch) {
      const key = String(booking?.id || booking?.bookingId || bookingsById.size);
      bookingsById.set(key, booking);
    }
  }
  const bookings = Array.from(bookingsById.values());
  for (const booking of bookings) {
    const status = String(lodgifyBookingStatus(booking) || "").toLowerCase();
    if (status.includes("cancel") || status.includes("declined")) {
      cancelledSkipped += 1;
      continue;
    }
    const arrival = toDateOnly(booking?.arrival || booking?.checkIn || booking?.start_date);
    if (arrival && arrival > today) {
      futureSkipped += 1;
      continue;
    }
    const contact = bookingContact(booking);
    if (!contact.email) continue;
    if (isRelayEmail(contact.email)) {
      relaySkipped += 1;
      continue;
    }
    addContact(contacts, contact);
  }
  notes.push(
    `Lodgify: ${bookings.length} past/current booking(s); skipped ${cancelledSkipped} cancelled, ${futureSkipped} not yet started, ${relaySkipped} OTA relay address(es).`
  );

  const submissions = await listLocalFormSubmissions({ formSlugs: CHECKIN_FORM_SLUGS, limit: 10000 });
  let formRelaySkipped = 0;
  for (const submission of submissions) {
    if (submission?.payload?.__staffPreview) continue;
    const contact = extractLocalFormContact(submission);
    if (!contact.email) continue;
    if (isRelayEmail(contact.email)) {
      formRelaySkipped += 1;
      continue;
    }
    addContact(contacts, contact);
  }
  notes.push(
    `Check-in form: ${submissions.length} submission(s); skipped ${formRelaySkipped} relay address(es).`
  );

  return Array.from(contacts.values());
}

async function collectSmsContacts(notes) {
  const contacts = new Map();

  const submissions = await listLocalFormSubmissions({ formSlugs: CHECKIN_FORM_SLUGS, limit: 10000 });
  let formOptIns = 0;
  for (const submission of submissions) {
    const consent = submission?.payload?.__marketingConsent;
    if (!consent?.sms?.optedIn) continue;
    const contact = extractLocalFormContact(submission);
    if (!contact.email || !contact.phone) continue;
    formOptIns += 1;
    addContact(contacts, contact);
  }

  const popupList = PROMOTION_CONTACT_LISTS.find((list) => list.key === "popup-drip");
  let popupConsented = 0;
  let popupTotal = 0;
  if (popupList) {
    const fields = await listCustomFieldDefinitions().catch(() => []);
    const consentField = fields.find((field) => field.name === "sms_consent");
    if (!consentField) {
      notes.push(
        'Popup: no "sms_consent" custom field exists in SendGrid, so no popup consent was recorded; popup contacts were not added to the Text Club.'
      );
    } else {
      const popupContacts = await getContactsFromListDetailed(popupList.listId);
      popupTotal = popupContacts.length;
      for (const contact of popupContacts) {
        if (contactFieldValue(contact, consentField.name, consentField.id) !== "yes") continue;
        const phone = String(contact.phone_number || contact.phone || "").trim();
        if (!phone) continue;
        popupConsented += 1;
        addContact(contacts, {
          email: contact.email,
          firstName: contact.first_name,
          lastName: contact.last_name,
          phone,
        });
      }
    }
  }

  notes.push(
    `Text Club: ${formOptIns} check-in form opt-in(s); ${popupConsented} of ${popupTotal} popup contact(s) with sms_consent = yes.`
  );
  return Array.from(contacts.values());
}

function summarizeUpsert(results) {
  return results.reduce(
    (sum, item) => ({
      requested: sum.requested + Number(item?.results?.requested_count || 0),
      created: sum.created + Number(item?.results?.created_count || 0),
      updated: sum.updated + Number(item?.results?.updated_count || 0),
      errored: sum.errored + Number(item?.results?.errored_count || 0),
      pending: sum.pending + (item?.status === "pending_timeout" ? 1 : 0),
    }),
    { requested: 0, created: 0, updated: 0, errored: 0, pending: 0 }
  );
}

export async function runMarketingOptInSetup({ dryRun = true } = {}) {
  const notes = [];
  const lists = await ensureLists({ dryRun });
  const emailContacts = await collectEmailContacts(notes);
  const smsContacts = await collectSmsContacts(notes);

  const result = {
    dryRun,
    lists,
    email: { eligible: emailContacts.length, sample: emailContacts.slice(0, 5).map((c) => maskEmail(c.email)) },
    sms: { eligible: smsContacts.length, sample: smsContacts.slice(0, 5).map((c) => maskEmail(c.email)) },
    notes,
  };

  if (!dryRun) {
    if (lists.emailListId && emailContacts.length) {
      result.email.upsert = summarizeUpsert(
        await upsertContactsToList({ listId: lists.emailListId, contacts: emailContacts })
      );
    }
    if (lists.smsListId && smsContacts.length) {
      result.sms.upsert = summarizeUpsert(
        await upsertContactsToList({ listId: lists.smsListId, contacts: smsContacts })
      );
    }
    await setMarketingOptInLists({
      lastBackfill: {
        at: new Date().toISOString(),
        email: result.email.eligible,
        sms: result.sms.eligible,
      },
    });
  }

  return result;
}
