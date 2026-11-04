// One-click setup for the marketing opt-in lists:
//  1. Ensure the "Email Offers" and "Text Club (SMS opt-in)" SendGrid lists exist
//     and save their IDs (KV), so check-in form opt-ins sync automatically.
//  2. Backfill eligible people:
//     - Email Offers: past guests (Lodgify), every internal form, the popup and
//       every website form list, de-duplicated and screened by
//       lib/contact-quality.js (bots, relay/disposable/invalid addresses).
//     - Text Club: check-in form SMS opt-ins + every popup contact with a usable
//       phone (the popup required a text opt-in; see collectSmsContacts).
// Unsubscribes/suppressions are still enforced by SendGrid at send time.

import { getAllBookings } from "@/lib/lodgify";
import { lodgifyBookingStatus } from "@/lib/access-code-messages";
import {
  createContactList,
  getContactIdentifiersByEmails,
  fetchImportErrors,
  getImportJobStatus,
  getContactsFromListDetailed,
  listAllContactLists,
  listCustomFieldDefinitions,
  upsertContactsToList,
} from "@/lib/sendgrid";
import { extractLocalFormContact, listLocalFormSubmissions } from "@/lib/local-forms";
import { getMarketingOptInLists, setMarketingOptInLists } from "@/lib/kv";
import { PROMOTION_CONTACT_LISTS } from "@/lib/promotion-lists";
import { contactRejectReason } from "@/lib/contact-quality";

export const EMAIL_LIST_NAME = "Email Offers (past guests + opt-ins)";
export const SMS_LIST_NAME = "Text Club (SMS opt-in)";
const CHECKIN_FORM_SLUGS = ["welcome-to-zenfulcove"];

// Every SendGrid list a past guest or form lead may be on, with trust level.
// Trusted sources skip bot-pattern checks (guests paid; popup required phone +
// opt-in). The website newsletter form had bot signups, so it is untrusted.
const EMAIL_SOURCE_LISTS = [
  { label: "Popup", listId: "44b5b3f5-d03d-4552-997f-8715a906d5b8", trusted: true },
  { label: "Lodgify Booked Guests", listId: "65075b7e-7fd3-4357-9953-6ff3ce2ff59b", trusted: true },
  { label: "All Clients", listId: "e46aa43e-3f91-4965-8bbb-fcae8f9c3124", trusted: false },
  { label: "Website Newsletter", listId: "f1ca741d-2698-49d7-8055-ba09df67a318", trusted: false },
  { label: "Website Contact Us", listId: "69c6cbc7-13a5-4d7d-a9a1-3eea31a81d65", trusted: false },
  { label: "Website Corporate Wellness", listId: "bc1dbf1c-a1b1-4e41-9e49-2c0b28759629", trusted: false },
  { label: "Website Special Requests", listId: "d6b3a05d-7674-4c3a-b750-8c8bb1621008", trusted: false },
  { label: "Events list", listId: "dc7aeb0a-c70c-4c6e-a1cd-b0c8c2b93cb8", trusted: false },
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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

function sendgridContactFields(contact) {
  return {
    email: contact.email || contact.EMAIL,
    firstName: contact.first_name || contact.FIRST_NAME || "",
    lastName: contact.last_name || contact.LAST_NAME || "",
    phone: contact.phone_number || contact.PHONE_NUMBER || "",
  };
}

async function collectEmailContacts(notes, rejectedOut) {
  const candidates = new Map();
  const sourceCounts = {};
  const today = todayCentral();

  function addCandidate(contact, source, trusted) {
    const email = normalizeEmail(contact.email);
    if (!email) return;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    const existing = candidates.get(email) || {
      contact: { email, firstName: "", lastName: "", phone: "" },
      sources: new Set(),
      trusted: false,
    };
    existing.contact = {
      email,
      firstName: existing.contact.firstName || contact.firstName || "",
      lastName: existing.contact.lastName || contact.lastName || "",
      phone: existing.contact.phone || contact.phone || "",
    };
    existing.sources.add(source);
    existing.trusted = existing.trusted || trusted;
    candidates.set(email, existing);
  }

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
  let cancelledSkipped = 0;
  for (const booking of bookingsById.values()) {
    const status = String(lodgifyBookingStatus(booking) || "").toLowerCase();
    if (status.includes("cancel") || status.includes("declined")) {
      cancelledSkipped += 1;
      continue;
    }
    const arrival = toDateOnly(booking?.arrival || booking?.checkIn || booking?.start_date);
    if (arrival && arrival > today) continue;
    addCandidate(bookingContact(booking), "Lodgify stays", true);
  }
  notes.push(`Lodgify: ${bookingsById.size} past/current booking(s); ${cancelledSkipped} cancelled skipped.`);

  const submissions = await listLocalFormSubmissions({ limit: 10000 });
  for (const submission of submissions) {
    if (submission?.payload?.__staffPreview) continue;
    const contact = extractLocalFormContact(submission);
    const isCheckin = CHECKIN_FORM_SLUGS.includes(String(submission.form_slug || ""));
    addCandidate(contact, isCheckin ? "Check-in form" : `Form: ${submission.form_slug}`, isCheckin);
  }

  for (const source of EMAIL_SOURCE_LISTS) {
    try {
      const contacts = await getContactsFromListDetailed(source.listId);
      for (const contact of contacts) {
        addCandidate(sendgridContactFields(contact), source.label, source.trusted);
      }
    } catch (err) {
      notes.push(`${source.label}: could not load (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  const kept = [];
  const rejectedByReason = {};
  for (const candidate of candidates.values()) {
    const reason = contactRejectReason(candidate.contact, { trusted: candidate.trusted });
    if (reason) {
      rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
      rejectedOut.push({
        email: maskEmail(candidate.contact.email),
        name: `${candidate.contact.firstName} ${candidate.contact.lastName}`.trim().slice(0, 40),
        reason,
        sources: Array.from(candidate.sources).join(", "),
      });
      continue;
    }
    kept.push(candidate.contact);
  }

  notes.push(
    `Sources (entries before de-dup): ${Object.entries(sourceCounts)
      .map(([source, count]) => `${source} ${count}`)
      .join(" · ")}.`
  );
  notes.push(
    `Unique people: ${candidates.size}; kept ${kept.length}; filtered ${candidates.size - kept.length}${
      Object.keys(rejectedByReason).length
        ? ` (${Object.entries(rejectedByReason)
            .map(([reason, count]) => `${reason} ${count}`)
            .join(", ")})`
        : ""
    }.`
  );
  return kept;
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

  // Owner decision (2026-11-04): the popup required a phone number and a text
  // opt-in to get the code, so every popup contact with a usable phone joins
  // the Text Club. Older (Wix-era) signups have no saved consent record, so
  // they're counted separately below. STOP replies are blocked by Twilio.
  const popupList = PROMOTION_CONTACT_LISTS.find((list) => list.key === "popup-drip");
  let popupRecorded = 0;
  let popupUnrecorded = 0;
  let popupNoPhone = 0;
  let popupJunk = 0;
  let popupTotal = 0;
  if (popupList) {
    const fields = await listCustomFieldDefinitions().catch(() => []);
    const consentField = fields.find((field) => field.name === "sms_consent");
    const popupContacts = await getContactsFromListDetailed(popupList.listId);
    popupTotal = popupContacts.length;
    for (const contact of popupContacts) {
      const person = sendgridContactFields(contact);
      const digits = String(person.phone || "").replace(/\D/g, "");
      if (digits.length < 10 || /^(\d)\1+$/.test(digits)) {
        popupNoPhone += 1;
        continue;
      }
      if (contactRejectReason(person, { trusted: true })) {
        popupJunk += 1;
        continue;
      }
      const recorded =
        consentField && contactFieldValue(contact, consentField.name, consentField.id) === "yes";
      if (recorded) popupRecorded += 1;
      else popupUnrecorded += 1;
      addContact(contacts, person);
    }
  }

  notes.push(
    `Text Club: ${formOptIns} check-in form opt-in(s); popup ${popupTotal} contact(s): ${popupRecorded} with saved consent + ${popupUnrecorded} without a saved record added; ${popupNoPhone} skipped (no usable phone), ${popupJunk} skipped (invalid email).`
  );
  return Array.from(contacts.values());
}

function jobIdsFrom(results) {
  return (results || []).map((item) => String(item?.id || "")).filter(Boolean);
}

function maskEmailsInText(text) {
  return String(text || "").replace(
    /([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    "$1***@$2"
  );
}

// Status of the SendGrid import jobs started by the last backfill, with the
// rejected rows (emails masked) so failures can be diagnosed.
export async function getLastBackfillImportResults() {
  const saved = await getMarketingOptInLists();
  const jobs = saved.lastBackfill?.jobs || {};
  const out = { at: saved.lastBackfill?.at || null, email: [], sms: [] };
  for (const channel of ["email", "sms"]) {
    for (const jobId of jobs[channel] || []) {
      try {
        const status = await getImportJobStatus(jobId);
        const errorsUrl = status?.errors_url || status?.results?.errors_url || "";
        out[channel].push({
          jobId,
          status: status?.status || "unknown",
          results: status?.results || {},
          errors: errorsUrl ? maskEmailsInText(await fetchImportErrors(errorsUrl)) : "",
        });
      } catch (err) {
        out[channel].push({ jobId, status: "lookup_failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

export async function runMarketingOptInSetup({ dryRun = true } = {}) {
  const notes = [];
  const lists = await ensureLists({ dryRun });
  const rejected = [];
  const emailContacts = await collectEmailContacts(notes, rejected);
  const smsContacts = await collectSmsContacts(notes);

  const result = {
    dryRun,
    lists,
    email: { eligible: emailContacts.length, sample: emailContacts.slice(0, 5).map((c) => maskEmail(c.email)) },
    sms: { eligible: smsContacts.length, sample: smsContacts.slice(0, 5).map((c) => maskEmail(c.email)) },
    notes,
    rejected: rejected.slice(0, 300),
    rejectedTotal: rejected.length,
  };

  if (!dryRun) {
    const identifiers = await getContactIdentifiersByEmails([
      ...emailContacts.map((contact) => contact.email),
      ...smsContacts.map((contact) => contact.email),
    ]);
    const withIdentifiers = (contact) => ({
      ...contact,
      ...(identifiers.get(contact.email) || {}),
    });
    emailContacts.splice(0, emailContacts.length, ...emailContacts.map(withIdentifiers));
    smsContacts.splice(0, smsContacts.length, ...smsContacts.map(withIdentifiers));
    notes.push(`${identifiers.size} existing SendGrid contact(s) needed extra identifiers (phone/external ID).`);

    if (lists.emailListId && emailContacts.length) {
      const emailResults = await upsertContactsToList({
        listId: lists.emailListId,
        contacts: emailContacts,
        wait: false,
      });
      result.email.jobs = jobIdsFrom(emailResults);
    }
    if (lists.smsListId && smsContacts.length) {
      const smsResults = await upsertContactsToList({
        listId: lists.smsListId,
        contacts: smsContacts,
        wait: false,
      });
      result.sms.jobs = jobIdsFrom(smsResults);
    }
    await setMarketingOptInLists({
      lastBackfill: {
        at: new Date().toISOString(),
        email: result.email.eligible,
        sms: result.sms.eligible,
        jobs: { email: result.email.jobs || [], sms: result.sms.jobs || [] },
      },
    });
  }

  return result;
}
