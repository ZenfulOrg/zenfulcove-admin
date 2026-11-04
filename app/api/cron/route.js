import { NextResponse } from "next/server";
import { CRON_SECRET } from "@/config/keys";
import { notifyAutomationFailure } from "@/lib/automation-alerts";
import { sendSms, validateTwilioConfig } from "@/lib/twilio";
import {
  getConfig,
  getMarketingOptInLists,
  getEventPopupContactState,
  setEventPopupContactState,
  getEventPopupSmsSent,
  setEventPopupSmsSent,
  getPopupFollowupSent,
  setPopupFollowupSent,
  getSalesmateFormSyncState,
  setSalesmateFormSyncState,
} from "@/lib/kv";
import {
  getProperties,
  getAvailability,
  getBookings,
  getAllBookings,
  getAllBookingsInStayWindow,
  getBookingById,
} from "@/lib/lodgify";
import {
  getFormSubmissions,
  bookingHasWaiver,
  extractBookingCode,
  extractClientContact,
  submissionToLocalFormPayload,
} from "@/lib/jotform";
import {
  bookingHasLocalFormSubmission,
  extractLocalFormContact,
  getLocalFormBySlug,
  listLocalFormSubmissions,
  markLocalFormSubmissionsSynced,
  upsertImportedLocalFormSubmission,
} from "@/lib/local-forms";
import {
  getAccessCodeRelease,
  listJervisAccessCodeReleaseRetries,
} from "@/lib/access-code-releases";
import {
  ineligibleBookingStatusMessage,
  isDelayedAccessCodeBooking,
  isBookedLodgifyStatus,
  lodgifyBookingSource,
  lodgifyBookingStatus,
  lodgifyPropertyName,
  sendAccessCodeForBooking,
  sendCheckinInfoForBooking,
  sendWaiverReminderForBooking,
  waiverReminderFormSource,
} from "@/lib/access-code-messages";
import { hasSupabaseAdminEnv } from "@/lib/supabaseEnv";
import { appendLogs, writeLastRunStatus } from "@/lib/activity-log";
import {
  createSalesmateContact,
  upsertSalesmateContact,
  validateSalesmateConfig,
} from "@/lib/salesmate";
import {
  sendTemplateEmail,
  getContactsFromList,
  getContactsFromListDetailed,
  getContactByEmailDetailed,
  updateContactCustomFields,
  upsertContactsToList,
  listAllContactLists,
  validateContactCustomFieldKeys,
  getContactIdentifiersByEmails,
} from "@/lib/sendgrid";
import { contactRejectReason } from "@/lib/contact-quality";

const DRY_RUN_ENV = process.env.CRON_DRY_RUN === "true";
const DELIVERY_LOG_KEYS = [
  "deliveryFallback",
  "lodgifyDeliveryChecked",
  "lodgifyRouteRequired",
  "lodgifyExpectedRoute",
  "lodgifyThreadGuidPresent",
  "lodgifyMessageId",
  "lodgifyProviderMessageId",
  "lodgifyMessageStatus",
  "lodgifyMessageRoute",
  "lodgifyMessageImported",
  "lodgifyMessageCreatedAt",
  "lodgifyThreadErrorTitle",
  "lodgifyThreadErrorMessage",
  "channelRouted",
  "lodgifyDeliveryIssue",
  "lodgifyPosted",
  "lodgifyFallbackReason",
];

function deliveryResultLogFields(result = {}) {
  return Object.fromEntries(
    DELIVERY_LOG_KEYS
      .filter((key) => {
        const value = result[key];
        return value !== undefined && value !== null && value !== "";
      })
      .map((key) => [key, result[key]])
  );
}

function today() {
  return new Date().toISOString().split("T")[0];
}

/** Today's date in America/Chicago — use for waiver logic so "0 days before" matches the business day. */
function todayCentral() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function centralClock() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    hour: Number(byType.hour || 0) % 24,
    minute: Number(byType.minute || 0),
  };
}

function centralClockHasReached(hour, minute) {
  const clock = centralClock();
  const currentMinutes = clock.hour * 60 + clock.minute;
  const releaseMinutes = Number(hour || 0) * 60 + Number(minute || 0);
  return {
    reached: currentMinutes >= releaseMinutes,
    clock,
  };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

/** Normalize any date-like value to YYYY-MM-DD for comparison. */
function toDateOnly(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.slice(0, 10);
  const d = new Date(val);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function parseCentralDateField(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const parsed = new Date(millis);
    if (isNaN(parsed.getTime())) return "";
    return parsed.toISOString().split("T")[0];
  }

  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const millis = raw.length > 10 ? numeric : numeric * 1000;
      const parsed = new Date(millis);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split("T")[0];
      }
    }
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [month, day, year] = raw.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return "";
  return parsed.toISOString().split("T")[0];
}

function mergeClientContact(existing, incoming) {
  return {
    email: incoming.email || existing.email,
    firstName: existing.firstName || incoming.firstName || "",
    lastName: existing.lastName || incoming.lastName || "",
    phone: existing.phone || incoming.phone || "",
    submissionIds: Array.from(new Set([...(existing.submissionIds || []), ...(incoming.submissionIds || [])])),
    formIds: Array.from(new Set([...(existing.formIds || []), ...(incoming.formIds || [])])),
    bookingIds: Array.from(new Set([...(existing.bookingIds || []), ...(incoming.bookingIds || [])])),
    bookingStatuses: Array.from(new Set([...(existing.bookingStatuses || []), ...(incoming.bookingStatuses || [])])),
    propertyNames: Array.from(new Set([...(existing.propertyNames || []), ...(incoming.propertyNames || [])])),
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function splitName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function getFirstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function extractLodgifyContact(booking) {
  const guest = booking?.guest || {};
  const customer = booking?.customer || {};
  const traveler = booking?.traveler || {};
  const primaryPhoneObject = guest?.phone || customer?.phone || traveler?.phone || {};

  const email = normalizeEmail(
    getFirstNonEmpty([
      guest?.email,
      customer?.email,
      traveler?.email,
      booking?.guestEmail,
      booking?.email,
      booking?.customerEmail,
    ])
  );

  const fullName = getFirstNonEmpty([
    guest?.name,
    booking?.guestName,
    customer?.name,
    traveler?.name,
    `${guest?.firstName || guest?.first_name || ""} ${guest?.lastName || guest?.last_name || ""}`,
    `${customer?.firstName || customer?.first_name || ""} ${customer?.lastName || customer?.last_name || ""}`,
  ]);

  const derivedNames = splitName(fullName);

  const firstName = getFirstNonEmpty([
    guest?.firstName,
    guest?.first_name,
    customer?.firstName,
    customer?.first_name,
    traveler?.firstName,
    traveler?.first_name,
    derivedNames.firstName,
  ]);

  const lastName = getFirstNonEmpty([
    guest?.lastName,
    guest?.last_name,
    customer?.lastName,
    customer?.last_name,
    traveler?.lastName,
    traveler?.last_name,
    derivedNames.lastName,
  ]);

  const phone = normalizePhoneNumber(
    getFirstNonEmpty([
      typeof primaryPhoneObject === "string" ? primaryPhoneObject : "",
      primaryPhoneObject?.fullNumber,
      primaryPhoneObject?.phone,
      primaryPhoneObject?.number,
      primaryPhoneObject?.e164Phone,
      guest?.phoneNumber,
      guest?.mobilePhone,
      customer?.phoneNumber,
      customer?.mobilePhone,
      traveler?.phoneNumber,
      traveler?.mobilePhone,
      booking?.phone,
      booking?.phoneNumber,
      booking?.guestPhone,
    ])
  );

  const bookingId = String(
    booking?.id ||
      booking?.bookingId ||
      booking?.reservationId ||
      booking?.reservation_id ||
      ""
  ).trim();

  const bookingStatus = lodgifyBookingStatus(booking);

  const propertyName = lodgifyPropertyName(booking);

  return {
    email,
    firstName,
    lastName,
    phone,
    bookingId,
    bookingStatus,
    propertyName,
  };
}

function findMatchingLocalFormSubmission(bookingId, submissions = []) {
  return (
    (submissions || []).find((submission) =>
      bookingHasLocalFormSubmission(bookingId, [submission])
    ) || null
  );
}

function accessCodeReleaseFallback({
  booking,
  bookingId,
  contact = {},
  propertyName = "",
  submission = null,
}) {
  const formContact = submission ? extractLocalFormContact(submission) : {};
  return {
    bookingId,
    contact: {
      email: formContact.email || contact.email || "",
      firstName: formContact.firstName || contact.firstName || "",
      lastName: formContact.lastName || contact.lastName || "",
      phone: formContact.phone || contact.phone || "",
      bookingCode: bookingId,
    },
    stayDetails: {
      bookingId,
      propertyName: propertyName || contact.propertyName || "",
      checkinDate: toDateOnly(
        booking?.arrival ||
          booking?.start_date ||
          booking?.checkIn ||
          booking?.check_in ||
          booking?.checkin_date
      ),
      checkoutDate: toDateOnly(
        booking?.departure ||
          booking?.end_date ||
          booking?.checkOut ||
          booking?.check_out ||
          booking?.checkout_date
      ),
    },
  };
}

function isCancelledBooking(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return (
    normalized.includes("cancel") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled")
  );
}

function parseSelectedAutomations(request) {
  const raw =
    request.headers.get("x-automation") ||
    request.nextUrl?.searchParams?.get("automation") ||
    "";

  const items = String(raw)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const aliases = {
    vacancy: "vacancy",
    "vacancy-emails": "vacancy",
    waiver: "waiver",
    "waiver-reminders": "waiver",
    codes: "access-code-release",
    "code-release": "access-code-release",
    "access-code": "access-code-release",
    "access-codes": "access-code-release",
    "access-code-release": "access-code-release",
    "access-code-retry": "access-code-retry",
    "access-code-retries": "access-code-retry",
    "jervis-code-retry": "access-code-retry",
    "jervis-code-retries": "access-code-retry",
    "access-code-day-of": "access-code-day-of",
    "day-of-code": "access-code-day-of",
    "day-of-access-code": "access-code-day-of",
    "code-only": "access-code-day-of",
    popup: "popup",
    "popup-followups": "popup",
    "popup-follow-ups": "popup",
    "event-popup": "event-popup",
    "event-popup-sms": "event-popup",
    "salesmate-popup": "event-popup",
    "salesmate-popup-sms": "event-popup",
    jotform: "jotform-sync",
    "jotform-sync": "jotform-sync",
    "jotform-client-sync": "jotform-sync",
    forms: "local-form-sync",
    "local-forms": "local-form-sync",
    "local-form": "local-form-sync",
    "local-form-sync": "local-form-sync",
    "local-form-client-sync": "local-form-sync",
    "jotform-import": "jotform-local-import",
    "jotform-local-import": "jotform-local-import",
    "jotform-to-local": "jotform-local-import",
    "jotform-local-form-import": "jotform-local-import",
    lodgify: "lodgify-sync",
    "lodgify-sync": "lodgify-sync",
    "lodgify-client-sync": "lodgify-sync",
    syncs: "syncs",
    clients: "syncs",
    "client-sync": "syncs",
    "salesmate-sync": "salesmate-sync",
    "salesmate-form-sync": "salesmate-sync",
  };

  const normalized = items
    .map((item) => aliases[item] || "")
    .filter(Boolean);

  return new Set(normalized);
}

function parsePopupChannelOverride(request) {
  const raw =
    request.headers.get("x-popup-channel") ||
    request.nextUrl?.searchParams?.get("popupChannel") ||
    request.nextUrl?.searchParams?.get("popup_channel") ||
    "";

  const value = String(raw || "").trim().toLowerCase();
  if (["email", "sms", "both"].includes(value)) {
    return value;
  }

  return "";
}

function normalizeChannelMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["email", "sms", "both"].includes(normalized) ? normalized : "email";
}

function parseSentKeys(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringifySentKeys(items) {
  return Array.from(
    new Set(items.map((item) => String(item || "").trim()).filter(Boolean))
  ).join(",");
}

function formatSentKeysLabel(items) {
  return items.length > 0 ? items.join(",") : "(none)";
}

function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return "+1" + cleaned;
  return cleaned;
}

// ─── Automation 1: Vacancy Promo Emails ─────────────────────────────────────

function formatPropertyList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function formatPromoExpiration(window, checkinDate) {
  const daysBeforeCheckin = Math.max(
    0,
    Number(window?.expiresDaysBeforeCheckin ?? 1) || 0
  );
  const date = addDays(checkinDate, -daysBeforeCheckin);
  const time = String(window?.expiresAtLocalTime || "11:59 PM").trim();
  const timezone = String(
    window?.expirationTimezone || "America/Chicago"
  ).trim();
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));

  return {
    date,
    dateLabel,
    time,
    timezone,
    label: `${dateLabel} at ${time} (${timezone})`,
  };
}

async function runVacancyEmails(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.vacancyEmails;
  const from = {
    email: automationConfig.sendgrid.fromEmail,
    name: automationConfig.sendgrid.fromName,
  };

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Vacancy Promo Emails",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  // Fetch recipient emails from SendGrid contact list (shared in Settings)
  let recipients = [];
  try {
    const contactListId =
      automationConfig.sendgrid?.sendgridContactListId ||
      config.sendgridContactListId;
    if (!contactListId) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Vacancy Promo Emails",
        property: "—",
        action: "No SendGrid contact list ID in Settings — skipped",
        status: "skipped",
      });
      return logs;
    }
    recipients = await getContactsFromListDetailed(contactListId);
    if (recipients.length === 0) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Vacancy Promo Emails",
        property: "—",
        action: "No contacts in SendGrid list — skipped",
        status: "skipped",
      });
      return logs;
    }
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Vacancy Promo Emails",
      property: "—",
      action: `Failed to fetch SendGrid contacts: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  try {
    const properties = await getProperties();
    const todayStr = today();
    const endDate = addDays(todayStr, 30);

    // Phase 1: Collect vacant properties grouped by (window, startDate)
    const vacanciesByWindow = new Map();

    for (const property of properties) {
      try {
        const availability = await getAvailability(
          property.id,
          todayStr,
          endDate
        );

        const vacantPeriods = Array.isArray(availability)
          ? availability.filter((period) => period.is_available)
          : [];

        for (const period of vacantPeriods) {
          const startDate = period.start_date || period.startDate;
          if (!startDate) continue;

          const daysUntil = daysBetween(todayStr, startDate);

          for (const window of config.windows) {
            if (daysUntil === window.daysBeforeCheckin) {
              const key = `${window.daysBeforeCheckin}|${window.templateId}|${startDate}`;
              if (!vacanciesByWindow.has(key)) {
                vacanciesByWindow.set(key, {
                  window,
                  startDate,
                  propertyNames: [],
                });
              }
              const entry = vacanciesByWindow.get(key);
              if (!entry.propertyNames.includes(property.name)) {
                entry.propertyNames.push(property.name);
              }
            }
          }
        }
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Vacancy Promo Emails",
          property: property.name,
          action: `Failed to fetch availability: ${err.message}`,
          status: "failed",
        });
      }
    }

    // Phase 2: One email per recipient per group, listing all vacant properties
    for (const entry of vacanciesByWindow.values()) {
      const { window, startDate, propertyNames } = entry;
      propertyNames.sort();
      const propertyNamesList = formatPropertyList(propertyNames);
      const promoExpiration = formatPromoExpiration(window, startDate);

      for (const contact of recipients) {
        const email = String(contact?.email || "").trim();
        if (!email) continue;
        const firstName = contact?.first_name || contact?.firstName || "";
        const lastName = contact?.last_name || contact?.lastName || "";
        const greetingName = firstName || "there";

        try {
          if (!isDryRun) {
            await sendTemplateEmail({
              to: email,
              templateId: window.templateId,
              from,
              unsubscribeGroupId:
                automationConfig.sendgrid?.marketingUnsubscribeGroupId,
              data: {
                first_name: firstName,
                last_name: lastName,
                email,
                greetingName,
                propertyNames,
                propertyNamesList,
                propertyCount: propertyNames.length,
                checkinDate: startDate,
                daysUntilAvailable: window.daysBeforeCheckin,
                promoEndsAt: promoExpiration.label,
                promoEndDate: promoExpiration.date,
                promoEndDateLabel: promoExpiration.dateLabel,
                promoEndTime: promoExpiration.time,
                promoTimezone: promoExpiration.timezone,
              },
            });
          }
          const propertyLabel =
            propertyNames.length === 1 ? "property" : "properties";
          logs.push({
            timestamp: new Date().toISOString(),
            automation: "Vacancy Promo Emails",
            property: propertyNamesList,
            action: isDryRun
              ? `[DRY RUN] Would have sent ${window.daysBeforeCheckin}-day promo to ${email} for ${propertyNames.length} ${propertyLabel} | expires ${promoExpiration.label}`
              : `Sent ${window.daysBeforeCheckin}-day promo to ${email} (${window.templateId}) for ${propertyNames.length} ${propertyLabel}`,
            status: "success",
          });
        } catch (err) {
          logs.push({
            timestamp: new Date().toISOString(),
            automation: "Vacancy Promo Emails",
            property: propertyNamesList,
            action: `Failed ${window.daysBeforeCheckin}-day promo to ${email}: ${err.message}`,
            status: "failed",
          });
        }
      }
    }
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Vacancy Promo Emails",
      property: "—",
      action: `Failed to fetch properties: ${err.message}`,
      status: "failed",
    });
  }

  return logs;
}

// ─── Automation 2: Form Waiver Lodgify Messages ──────────────────────────────
// Uses the configured internal form slug when present, with Jotform as a
// migration fallback. Sent only if guest hasn't submitted yet.
// When it runs is controlled by the cron schedule; reminder offsets and message
// copy are configured in the dashboard.

export async function runWaiverReminders(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.waiverReminders || {};
  const localFormSlug = String(config.localFormSlug || config.formSlug || "")
    .trim()
    .replace(/^\/?forms\//, "");
  const jotformFormId =
    config.jotformFormId ||
    config.emails?.[0]?.jotformFormId ||
    config.reminders?.[0]?.jotformFormId;
  const usesLocalForm = waiverReminderFormSource(config) === "internal";
  const automationName = usesLocalForm
    ? "Internal Form Waiver Lodgify Messages"
    : "Jotform Waiver Emails";

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (usesLocalForm && !localFormSlug) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped: no internal form slug configured",
      status: "skipped",
    });
    return logs;
  }

  if (!usesLocalForm && !jotformFormId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped: no Jotform form ID configured",
      status: "skipped",
    });
    return logs;
  }

  const rawReminders = config.emails || config.reminders || [];
  // Use whatever days are configured per waiver; dedupe by daysBeforeCheckin so we don't send twice for same window
  const reminders = rawReminders.filter(
    (r, i, arr) =>
      arr.findIndex((x) => x.daysBeforeCheckin === r.daysBeforeCheckin) === i
  );
  const todayStr = todayCentral();

  if (reminders.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped: no waiver reminder windows configured (emails/reminders empty)",
      status: "skipped",
    });
    return logs;
  }

  // Fetch waiver submissions once (avoids ~140 API calls per run)
  let waiverSubmissions = [];
  try {
    waiverSubmissions = usesLocalForm
      ? await listLocalFormSubmissions({
          formSlugs: [localFormSlug],
          limit: 10000,
        })
      : await getFormSubmissions(jotformFormId);
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: usesLocalForm
        ? `Loaded ${waiverSubmissions.length} internal waiver submission(s) for /forms/${localFormSlug}`
        : `Loaded ${waiverSubmissions.length} Jotform waiver submission(s)`,
      status: "info",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: usesLocalForm
        ? `Internal form submission lookup failed — skipping all waiver emails: ${err.message}`
        : `JotForm API failed — skipping all waiver emails: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  // DRY RUN header: explicit date breakdown for validation
  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: `═══ DRY RUN: Today is ${todayStr}. No ${usesLocalForm ? "Lodgify waiver reminder messages" : "SendGrid waiver emails"} sent. Validation: WHO would receive WHAT (compare with Lodgify + ${usesLocalForm ? "internal forms" : "Jotform"}) ═══`,
      status: "info",
    });
  }

  for (const reminder of reminders) {
    const targetDate = addDays(todayStr, reminder.daysBeforeCheckin);
    const label = reminder.label || `${reminder.daysBeforeCheckin}-day`;
    const daysLabel =
      reminder.daysBeforeCheckin === 0
        ? "today"
        : reminder.daysBeforeCheckin === 1
          ? "1 day from now"
          : `${reminder.daysBeforeCheckin} days from now`;

    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: `--- Check-ins on ${targetDate} (${daysLabel}) → would ${usesLocalForm ? "post Lodgify reminder" : "send"} "${label}" to: ---`,
      status: "info",
    });

    try {
      let bookings = await getBookings(targetDate, targetDate);

      // Filter to only bookings that CHECK IN on targetDate (Lodgify stayFrom/stayTo may return overlapping stays)
      const targetDateStr = targetDate;
      bookings = bookings.filter((b) => {
        const arrival = b.arrival || b.start_date || b.checkIn || b.checkin_date;
        return toDateOnly(arrival) === targetDateStr;
      });

      // Optional: restrict to specific property IDs (e.g. Zenfulcove Glamping only)
      const propertyIds = config.propertyIds;
      if (Array.isArray(propertyIds) && propertyIds.length > 0) {
        bookings = bookings.filter(
          (b) => propertyIds.includes(String(b.property_id ?? b.propertyId ?? ""))
        );
      }

      // Deduplicate by booking ID so we never send two waiver emails for the same booking in this run
      const seenBookingIds = new Set();
      bookings = bookings.filter((b) => {
        const id = String(b.id);
        if (seenBookingIds.has(id)) return false;
        seenBookingIds.add(id);
        return true;
      });

      for (const booking of bookings) {
        const bookingId = String(booking.id);
        const propertyName = lodgifyPropertyName(booking) || "Property";
        const bookingStatus = lodgifyBookingStatus(booking);
        const bookingSource = lodgifyBookingSource(booking);

        if (!isBookedLodgifyStatus(bookingStatus)) {
          logs.push({
            timestamp: new Date().toISOString(),
            automation: automationName,
            property: propertyName,
            action: ineligibleBookingStatusMessage(
              bookingId,
              bookingStatus,
              bookingSource.label
            ),
            status: "skipped",
            bookingId,
            bookingStatus: bookingStatus || "unknown",
            ...(bookingSource.label ? { bookingChannel: bookingSource.label } : {}),
            ...(bookingSource.source ? { bookingSource: bookingSource.source } : {}),
            ...(bookingSource.sourceText ? { bookingSourceText: bookingSource.sourceText } : {}),
          });
          continue;
        }

        try {
          const hasWaiver = usesLocalForm
            ? bookingHasLocalFormSubmission(bookingId, waiverSubmissions)
            : bookingHasWaiver(bookingId, waiverSubmissions);

          if (!hasWaiver) {
            const reminderResult = await sendWaiverReminderForBooking({
              booking,
              automationConfig,
              reminder,
              dryRun: isDryRun,
              fallback: {
                bookingId,
                propertyName,
                checkinDate: targetDate,
              },
            });
            logs.push({
              timestamp: reminderResult.timestamp || new Date().toISOString(),
              automation: automationName,
              property: propertyName,
              action:
                reminderResult.action ||
                `Processed Lodgify waiver reminder "${reminder.label || `${reminder.daysBeforeCheckin}-day`}" for booking ${bookingId}`,
              status: reminderResult.status || "info",
              ...(reminderResult.decision ? { decision: reminderResult.decision } : {}),
              ...(reminderResult.deliveryChannel ? { deliveryChannel: reminderResult.deliveryChannel } : {}),
              ...deliveryResultLogFields(reminderResult),
              ...(reminderResult.templateId ? { templateId: reminderResult.templateId } : {}),
              ...(reminderResult.bookingId ? { bookingId: reminderResult.bookingId } : {}),
              ...(reminderResult.bookingChannel ? { bookingChannel: reminderResult.bookingChannel } : {}),
              ...(reminderResult.bookingSource ? { bookingSource: reminderResult.bookingSource } : {}),
              ...(reminderResult.bookingSourceText ? { bookingSourceText: reminderResult.bookingSourceText } : {}),
              ...(reminderResult.messageFormat ? { messageFormat: reminderResult.messageFormat } : {}),
              ...(reminderResult.messageChars ? { messageChars: reminderResult.messageChars } : {}),
              ...(reminderResult.messageLinkHosts ? { messageLinkHosts: reminderResult.messageLinkHosts } : {}),
              ...(reminderResult.messageLinksMasked ? { messageLinksMasked: reminderResult.messageLinksMasked } : {}),
              ...(reminderResult.templateData ? { templateData: reminderResult.templateData } : {}),
            });
          } else {
            logs.push({
              timestamp: new Date().toISOString(),
              automation: automationName,
              property: propertyName,
              action: isDryRun
                ? `[DRY RUN] SKIP booking ${bookingId} | waiver already in ${usesLocalForm ? "internal forms" : "Jotform"} (booking ID matched)`
                : `Waiver already submitted for booking ${bookingId}`,
              status: "skipped",
            });
          }
        } catch (err) {
          const detail =
            err.response?.body?.errors?.[0]?.message || err.message;
          logs.push({
            timestamp: new Date().toISOString(),
            automation: automationName,
            property: propertyName,
            action: `Failed Lodgify waiver reminder ${reminder.label || `${reminder.daysBeforeCheckin}-day`} for booking ${bookingId}: ${detail}`,
            status: "failed",
          });
        }
      }
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: `Failed to fetch bookings for ${targetDate} (${label}): ${err.message}`,
        status: "failed",
      });
    }
  }

  return logs;
}

// ─── Automation 2b: Access Code Release ─────────────────────────────────────
// Sends the check-in access code after the configured Central time, but only
// once the configured waiver/internal form has been submitted.

export async function runAccessCodeRelease(automationConfig, dryRunOverride, options = {}) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.accessCodeRelease || {};
  const waiverConfig = automationConfig.waiverReminders || {};
  const automationName = options.automationName || "Access Code Release";

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  const releaseHour = Math.max(
    0,
    Math.min(23, Number(options.releaseHourCentral ?? config.releaseHourCentral ?? 15))
  );
  const releaseMinute = Math.max(
    0,
    Math.min(59, Number(options.releaseMinuteCentral ?? config.releaseMinuteCentral ?? 0))
  );
  const { reached, clock } = centralClockHasReached(releaseHour, releaseMinute);
  if (!reached && options.bypassReleaseTime !== true) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: `Skipped: current Central time is ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}; release starts at ${String(releaseHour).padStart(2, "0")}:${String(releaseMinute).padStart(2, "0")}`,
      status: "skipped",
    });
    return logs;
  }

  const localFormSlug = String(
    config.localFormSlug || waiverConfig.localFormSlug || waiverConfig.formSlug || ""
  )
    .trim()
    .replace(/^\/?forms\//, "");
  const jotformFormId =
    config.jotformFormId ||
    waiverConfig.jotformFormId ||
    waiverConfig.emails?.[0]?.jotformFormId ||
    waiverConfig.reminders?.[0]?.jotformFormId;
  const usesLocalForm = waiverReminderFormSource(waiverConfig) === "internal";

  if (usesLocalForm && !localFormSlug) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped: no internal form slug configured",
      status: "skipped",
    });
    return logs;
  }

  if (!usesLocalForm && !jotformFormId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: "Skipped: no Jotform fallback form ID configured",
      status: "skipped",
    });
    return logs;
  }

  const todayStr = todayCentral();
  const targetOffsets = Array.isArray(options.targetOffsets)
    ? options.targetOffsets
    : [Number(config.releaseDaysBeforeCheckin ?? 1)];
  const targetDates = Array.from(
    new Set(
      targetOffsets
        .map((offset) => addDays(todayStr, Number(offset) || 0))
        .filter(Boolean)
    )
  ).sort();
  const targetDateSet = new Set(targetDates);
  const stayFrom = targetDates[0] || todayStr;
  const stayTo = targetDates[targetDates.length - 1] || todayStr;
  let waiverSubmissions = [];
  try {
    waiverSubmissions = usesLocalForm
      ? await listLocalFormSubmissions({
          formSlugs: [localFormSlug],
          limit: 10000,
        })
      : await getFormSubmissions(jotformFormId);
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: usesLocalForm
        ? `Loaded ${waiverSubmissions.length} internal form submission(s) for code gating`
        : `Loaded ${waiverSubmissions.length} Jotform submission(s) for code gating`,
      status: "info",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: `Failed to load form submissions for code gating: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  let bookings = [];
  try {
    bookings = await getBookings(stayFrom, stayTo);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: automationName,
      property: "—",
      action: `Failed to fetch Lodgify check-ins for ${targetDates.join(", ")}: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  bookings = bookings.filter((booking) => {
    const arrival =
      booking.arrival ||
      booking.start_date ||
      booking.checkIn ||
      booking.checkin_date;
    return targetDateSet.has(toDateOnly(arrival));
  });

  const propertyIds = Array.isArray(config.propertyIds)
    ? config.propertyIds
    : [];
  if (propertyIds.length > 0) {
    bookings = bookings.filter((booking) =>
      propertyIds.includes(
        String(booking.property_id ?? booking.propertyId ?? "")
      )
    );
  }

  const seenBookingIds = new Set();
  bookings = bookings.filter((booking) => {
    const id = String(booking.id || "").trim();
    if (!id || seenBookingIds.has(id)) return false;
    seenBookingIds.add(id);
    return true;
  });

  if (Number.isFinite(options.maxBookings)) {
    bookings = bookings.slice(0, Math.max(0, Number(options.maxBookings)));
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation: automationName,
    property: "—",
    action: `Evaluating ${bookings.length} Lodgify check-in(s) for ${targetDates.join(", ")}`,
    status: "info",
  });

  for (const booking of bookings) {
    const contact = extractLodgifyContact(booking);
    const bookingId = String(booking.id || contact.bookingId || "").trim();
    const propertyName = lodgifyPropertyName(booking, {
      propertyName: contact.propertyName,
    }) || "Property";
    const bookingSource = lodgifyBookingSource(booking);
    const delayedAccess = isDelayedAccessCodeBooking({
      booking,
      automationConfig,
      fallback: {
        bookingId,
        propertyName,
      },
    });

    if (!isBookedLodgifyStatus(contact.bookingStatus)) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: ineligibleBookingStatusMessage(
          bookingId,
          contact.bookingStatus,
          bookingSource.label
        ),
        status: "skipped",
        bookingId,
        bookingStatus: contact.bookingStatus || "unknown",
        ...(bookingSource.label ? { bookingChannel: bookingSource.label } : {}),
        ...(bookingSource.source ? { bookingSource: bookingSource.source } : {}),
        ...(bookingSource.sourceText ? { bookingSourceText: bookingSource.sourceText } : {}),
      });
      continue;
    }

    if (options.delayedOnly === true && !delayedAccess) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Skipped booking ${bookingId}: property does not use delayed day-of code release`,
        status: "skipped",
      });
      continue;
    }

    const existingRelease = await getAccessCodeRelease(bookingId);
    if (existingRelease?.sent_at || existingRelease?.status === "sent") {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Skipped booking ${bookingId}: access code already sent`,
        status: "skipped",
      });
      continue;
    }

    const matchingLocalSubmission = usesLocalForm
      ? findMatchingLocalFormSubmission(bookingId, waiverSubmissions)
      : null;
    const hasWaiver = usesLocalForm
      ? Boolean(matchingLocalSubmission)
      : bookingHasWaiver(bookingId, waiverSubmissions);
    if (!hasWaiver) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Skipped booking ${bookingId}: selected form is not submitted; 11 AM waiver reminders handle missing-form messages`,
        status: "skipped",
      });
      continue;
    }

    const releaseFallback = usesLocalForm
      ? accessCodeReleaseFallback({
          booking,
          bookingId,
          contact,
          propertyName,
          submission: matchingLocalSubmission,
        })
      : {};
    const sendResult =
      options.messageKind === "code-only"
        ? await sendAccessCodeForBooking({
            booking,
            automationConfig,
            dryRun: isDryRun,
            fallback: releaseFallback,
            persistState: options.persistState !== false,
            messagePrefix: options.messagePrefix || "",
            messageKind: "code-only",
          })
        : delayedAccess
          ? await sendCheckinInfoForBooking({
              booking,
              automationConfig,
              dryRun: isDryRun,
              fallback: releaseFallback,
              persistState: options.persistState !== false,
              messagePrefix: options.messagePrefix || "",
            })
          : await sendAccessCodeForBooking({
              booking,
              automationConfig,
              dryRun: isDryRun,
              fallback: releaseFallback,
              persistState: options.persistState !== false,
              messagePrefix: options.messagePrefix || "",
            });
    logs.push({
      timestamp: sendResult.timestamp || new Date().toISOString(),
      automation: automationName,
      property: propertyName,
      action: sendResult.action || `Processed access code for booking ${bookingId}`,
      status: sendResult.status || "info",
      ...(sendResult.decision ? { decision: sendResult.decision } : {}),
      ...(sendResult.deliveryChannel ? { deliveryChannel: sendResult.deliveryChannel } : {}),
      ...deliveryResultLogFields(sendResult),
      ...(sendResult.bookingId ? { bookingId: sendResult.bookingId } : {}),
      ...(sendResult.bookingChannel ? { bookingChannel: sendResult.bookingChannel } : {}),
      ...(sendResult.bookingSource ? { bookingSource: sendResult.bookingSource } : {}),
      ...(sendResult.bookingSourceText ? { bookingSourceText: sendResult.bookingSourceText } : {}),
      ...(sendResult.messageFormat ? { messageFormat: sendResult.messageFormat } : {}),
      ...(sendResult.messageChars ? { messageChars: sendResult.messageChars } : {}),
      ...(sendResult.messageLinkHosts ? { messageLinkHosts: sendResult.messageLinkHosts } : {}),
      ...(sendResult.messageLinksMasked ? { messageLinksMasked: sendResult.messageLinksMasked } : {}),
      ...(sendResult.templateData ? { templateData: sendResult.templateData } : {}),
    });
  }

  return logs;
}

export async function runDayOfDelayedAccessCodeRelease(
  automationConfig,
  dryRunOverride,
  options = {}
) {
  const config = automationConfig.accessCodeRelease || {};
  return runAccessCodeRelease(automationConfig, dryRunOverride, {
    ...options,
    automationName: "Day-of Access Code Release",
    targetOffsets: [0],
    releaseHourCentral: config.dayOfCodeReleaseHourCentral ?? 11,
    releaseMinuteCentral: config.dayOfCodeReleaseMinuteCentral ?? 0,
    delayedOnly: true,
    messageKind: "code-only",
  });
}

function retryBookingFromAccessCodeRelease(row = {}) {
  const nameParts = String(row.guest_name || "Guest").trim().split(/\s+/).filter(Boolean);
  const raw = row.raw_source && typeof row.raw_source === "object" ? row.raw_source : {};
  const jervisReservation =
    raw.jervisReservation && typeof raw.jervisReservation === "object"
      ? raw.jervisReservation
      : {};

  return {
    id: row.booking_id,
    status: "Booked",
    property_id: row.property_id,
    property_name: row.property_name,
    arrival: row.checkin_date || toDateOnly(jervisReservation.access_start_time),
    departure: toDateOnly(jervisReservation.access_end_time),
    guest: {
      name: row.guest_name || "Guest",
      firstName: nameParts[0] || "Guest",
      lastName: nameParts.slice(1).join(" "),
      email: row.guest_email,
    },
  };
}

export async function runJervisAccessCodeRetries(automationConfig, dryRunOverride, options = {}) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.accessCodeRelease || {};
  const waiverConfig = automationConfig.waiverReminders || {};
  const automationName = options.automationName || "Jervis Access Code Retry";

  if (!config.enabled) {
    return [
      {
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: "Skipped (disabled)",
        status: "skipped",
      },
    ];
  }

  const localFormSlug = String(
    config.localFormSlug || waiverConfig.localFormSlug || waiverConfig.formSlug || ""
  )
    .trim()
    .replace(/^\/?forms\//, "");

  if (!localFormSlug) {
    return [
      {
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: "Skipped: no internal form slug configured",
        status: "skipped",
      },
    ];
  }

  const todayStr = todayCentral();
  const releaseHour = Math.max(
    0,
    Math.min(23, Number(options.releaseHourCentral ?? config.releaseHourCentral ?? 15))
  );
  const releaseMinute = Math.max(
    0,
    Math.min(59, Number(options.releaseMinuteCentral ?? config.releaseMinuteCentral ?? 0))
  );
  const releaseDaysBeforeCheckin = Math.max(
    0,
    Number(options.releaseDaysBeforeCheckin ?? config.releaseDaysBeforeCheckin ?? 1) || 0
  );
  const { reached: releaseReached } = centralClockHasReached(
    releaseHour,
    releaseMinute
  );
  const checkinTo = releaseReached
    ? addDays(todayStr, releaseDaysBeforeCheckin)
    : todayStr;

  let rows = [];
  try {
    rows = await listJervisAccessCodeReleaseRetries({
      limit: options.limit || 50,
      checkinFrom: todayStr,
      checkinTo,
    });
  } catch (err) {
    return [
      {
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: `Failed to load Jervis retry rows: ${err.message}`,
        status: "failed",
      },
    ];
  }

  if (rows.length === 0) {
    return [
      {
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: `No pending Jervis access-code releases to retry for check-ins ${todayStr}${checkinTo !== todayStr ? ` through ${checkinTo}` : ""}`,
        status: "info",
      },
    ];
  }

  let submissions = [];
  try {
    submissions = await listLocalFormSubmissions({
      formSlugs: [localFormSlug],
      limit: 10000,
    });
  } catch (err) {
    return [
      {
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: "—",
        action: `Failed to load internal form submissions for retry gating: ${err.message}`,
        status: "failed",
      },
    ];
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation: automationName,
    property: "—",
    action: `Retrying ${rows.length} pending Jervis access-code release(s)`,
    status: "info",
  });

  for (const row of rows) {
    const bookingId = String(row.booking_id || "").trim();
    const propertyName = row.property_name || "Property";
    const matchingLocalSubmission = findMatchingLocalFormSubmission(
      bookingId,
      submissions
    );
    if (!matchingLocalSubmission) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Skipped booking ${bookingId}: selected form is not submitted`,
        status: "skipped",
        bookingId,
      });
      continue;
    }

    const fallbackBooking = retryBookingFromAccessCodeRelease(row);
    const fallbackContact = extractLodgifyContact(fallbackBooking);
    let liveBooking = null;
    try {
      liveBooking = await getBookingById(bookingId);
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Failed booking ${bookingId}: could not refresh Lodgify status before retry (${err.message})`,
        status: "failed",
        bookingId,
      });
      continue;
    }

    if (!liveBooking) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: `Skipped booking ${bookingId}: Lodgify booking was not found before retry`,
        status: "skipped",
        bookingId,
      });
      continue;
    }

    const liveStatus = lodgifyBookingStatus(liveBooking);
    const liveSource = lodgifyBookingSource(liveBooking);
    if (!isBookedLodgifyStatus(liveStatus)) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: automationName,
        property: propertyName,
        action: ineligibleBookingStatusMessage(
          bookingId,
          liveStatus,
          liveSource.label
        ),
        status: "skipped",
        bookingId,
        bookingStatus: liveStatus || "unknown",
        ...(liveSource.label ? { bookingChannel: liveSource.label } : {}),
        ...(liveSource.source ? { bookingSource: liveSource.source } : {}),
        ...(liveSource.sourceText ? { bookingSourceText: liveSource.sourceText } : {}),
      });
      continue;
    }

    const sendResult = await sendAccessCodeForBooking({
      booking: {
        ...fallbackBooking,
        ...liveBooking,
        id: liveBooking.id || fallbackBooking.id,
      },
      automationConfig,
      dryRun: isDryRun,
      fallback: accessCodeReleaseFallback({
        booking: {
          ...fallbackBooking,
          ...liveBooking,
          id: liveBooking.id || fallbackBooking.id,
        },
        bookingId,
        contact: fallbackContact,
        propertyName,
        submission: matchingLocalSubmission,
      }),
      persistState: options.persistState !== false,
      messagePrefix: options.messagePrefix || "",
    });
    logs.push({
      timestamp: sendResult.timestamp || new Date().toISOString(),
      automation: automationName,
      property: propertyName,
      action: sendResult.action || `Retried access code for booking ${bookingId}`,
      status: sendResult.status || "info",
      ...(sendResult.decision ? { decision: sendResult.decision } : {}),
      ...(sendResult.deliveryChannel ? { deliveryChannel: sendResult.deliveryChannel } : {}),
      ...deliveryResultLogFields(sendResult),
      ...(sendResult.bookingId ? { bookingId: sendResult.bookingId } : { bookingId }),
      ...(sendResult.bookingChannel ? { bookingChannel: sendResult.bookingChannel } : {}),
      ...(sendResult.bookingSource ? { bookingSource: sendResult.bookingSource } : {}),
      ...(sendResult.bookingSourceText ? { bookingSourceText: sendResult.bookingSourceText } : {}),
      ...(sendResult.messageFormat ? { messageFormat: sendResult.messageFormat } : {}),
      ...(sendResult.messageChars ? { messageChars: sendResult.messageChars } : {}),
      ...(sendResult.messageLinkHosts ? { messageLinkHosts: sendResult.messageLinkHosts } : {}),
      ...(sendResult.messageLinksMasked ? { messageLinksMasked: sendResult.messageLinksMasked } : {}),
      ...(sendResult.templateData ? { templateData: sendResult.templateData } : {}),
    });
  }

  return logs;
}

// ─── Automation 3: Popup Follow Ups ─────────────────────────────────────────

export async function runPopupFollowups(automationConfig, dryRunOverride, popupChannelOverride = "", options = {}) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.popupFollowups || {};
  const from = {
    email: automationConfig.sendgrid.fromEmail,
    name: automationConfig.sendgrid.fromName,
  };
  const effectiveChannelMode = popupChannelOverride || normalizeChannelMode(config.channelMode);
  const shouldRunEmail = effectiveChannelMode === "email" || effectiveChannelMode === "both";
  const shouldRunSms = effectiveChannelMode === "sms" || effectiveChannelMode === "both";
  const testDestination = String(options.testDestination || "").trim();
  const isOneOffTest = Boolean(testDestination);
  const shouldPersistState = options.persistState !== false && !isOneOffTest && !isDryRun;
  const maxSends = Number.isFinite(options.maxSends) ? Number(options.maxSends) : Number.POSITIVE_INFINITY;
  let sentCount = 0;

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!config.sendgridContactListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped: no SendGrid contact list ID configured",
      status: "skipped",
    });
    return logs;
  }

  if (!config.popupTriggeredFieldId || !config.popupSentTemplatesFieldId || !config.popupSentSmsFieldId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped: popup custom field keys are incomplete",
      status: "skipped",
    });
    return logs;
  }

  try {
    await validateContactCustomFieldKeys([
      config.popupTriggeredFieldId,
      config.popupSentTemplatesFieldId,
      config.popupSentSmsFieldId,
    ]);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: `Skipped: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  const configuredEmails = shouldRunEmail ? (config.emails || []).filter(Boolean) : [];
  const configuredSms = shouldRunSms
    ? (config.sms || []).filter((item) => item && item.enabled !== false)
    : [];

  if (!shouldRunEmail && !shouldRunSms) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped: popup channel mode is invalid",
      status: "skipped",
    });
    return logs;
  }

  if (shouldRunEmail && configuredEmails.length === 0 && !shouldRunSms) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped: no popup follow-up windows configured",
      status: "skipped",
    });
    return logs;
  }

  if (shouldRunSms && configuredSms.length === 0 && !shouldRunEmail) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "Skipped: no popup SMS follow-up windows configured",
      status: "skipped",
    });
    return logs;
  }

  if (shouldRunSms) {
    try {
      validateTwilioConfig();
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `Skipped: ${err.message}`,
        status: "skipped",
      });
      return logs;
    }
  }

  let contacts = [];
  try {
    contacts = await getContactsFromListDetailed(config.sendgridContactListId);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: `Failed to fetch popup contacts: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  if (contacts.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "No contacts in popup follow-up list — skipped",
      status: "skipped",
    });
    return logs;
  }

  const excludeBookedGuests = config.excludeBookedGuests !== false;
  const bookedGuestsListId = String(
    config.bookedGuestsListId || automationConfig.sendgrid?.sendgridContactListId || ""
  ).trim();
  if (excludeBookedGuests) {
    if (!bookedGuestsListId) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: "Skipped: booked-guest suppression is enabled but no booked-guests list is configured",
        status: "failed",
      });
      return logs;
    }

    try {
      const bookedGuests = await getContactsFromListDetailed(bookedGuestsListId);
      const bookedEmails = new Set(
        bookedGuests.map((contact) => normalizeEmail(contact?.email)).filter(Boolean)
      );
      const bookedPhones = new Set(
        bookedGuests
          .map((contact) => normalizePhoneNumber(contact?.phone_number || contact?.phone || ""))
          .filter(Boolean)
      );
      const beforeSuppression = contacts.length;
      contacts = contacts.filter((contact) => {
        const email = normalizeEmail(contact?.email);
        const phone = normalizePhoneNumber(contact?.phone_number || contact?.phone || "");
        return !(email && bookedEmails.has(email)) && !(phone && bookedPhones.has(phone));
      });
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `Booked-guest suppression excluded ${beforeSuppression - contacts.length} contact(s) using list ${bookedGuestsListId}`,
        status: "info",
      });
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `Stopped: booked-guest suppression list could not be loaded (${err.message})`,
        status: "failed",
      });
      return logs;
    }
  }

  const todayStr = todayCentral();
  const maxConfiguredDay = Math.max(
    0,
    ...(shouldRunEmail ? configuredEmails.map((item) => Number(item.daysAfterTrigger) || 0) : []),
    ...(shouldRunSms ? configuredSms.map((item) => Number(item.daysAfterTrigger) || 0) : [])
  );
  const contactsWithinWindow = contacts
    .map((contact) => {
      const customFields = contact?.custom_fields || {};
      const triggerDate = parseCentralDateField(customFields[config.popupTriggeredFieldId]);
      return {
        ...contact,
        _popupTriggerDate: triggerDate,
      };
    })
    .filter((contact) => {
      if (!contact._popupTriggerDate) return false;
      const daysSinceTriggered = daysBetween(contact._popupTriggerDate, todayStr);
      return daysSinceTriggered >= 0 && daysSinceTriggered <= maxConfiguredDay;
    })
    .sort((a, b) => String(b._popupTriggerDate).localeCompare(String(a._popupTriggerDate)));

  if (isDryRun) {
    const descriptor =
      shouldRunEmail && shouldRunSms
        ? "popup follow-up emails or SMS messages"
        : shouldRunSms
          ? "popup follow-up SMS messages"
          : "popup follow-up emails";
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: `═══ DRY RUN: Today is ${todayStr}. No ${descriptor} will be sent. Validation: WHO would receive WHAT. ═══`,
      status: "info",
    });
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Popup Follow Ups",
    property: "—",
    action: `Using SendGrid popup list: ${config.sendgridContactListId}`,
    status: "info",
  });

  const contactsWithPhone = contacts.filter((contact) =>
    Boolean(normalizePhoneNumber(contact?.phone_number || contact?.phone || ""))
  ).length;
  const contactsWithoutPhone = contacts.length - contactsWithPhone;

  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Popup Follow Ups",
    property: "—",
    action: `Popup list phone coverage: ${contactsWithPhone} with phone, ${contactsWithoutPhone} without phone`,
    status: "info",
  });

  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Popup Follow Ups",
    property: "—",
    action: `Loaded ${contacts.length} popup contact(s); ${contactsWithinWindow.length} in active ${maxConfiguredDay}-day follow-up window (newest first)`,
    status: "info",
  });

  if (contactsWithinWindow.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Popup Follow Ups",
      property: "—",
      action: "No popup contacts currently fall inside the active follow-up day window",
      status: "info",
    });
    return logs;
  }

  const contactHydrationCache = new Map();

  for (const contact of contactsWithinWindow) {
    const email = String(contact?.email || "").trim().toLowerCase();
    let phone = normalizePhoneNumber(contact?.phone_number || contact?.phone || "");
    const customFields = contact?.custom_fields || {};
    const rawTriggerDate = customFields[config.popupTriggeredFieldId];
    const triggerDate = contact._popupTriggerDate || parseCentralDateField(rawTriggerDate);

    if (!email) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: "Skipped contact with no email in popup list",
        status: "skipped",
      });
      continue;
    }

    if (!triggerDate) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `SKIP ${email} — missing or invalid popup trigger date`,
        status: "skipped",
      });
      continue;
    }

    const daysSinceTriggered = daysBetween(triggerDate, todayStr);
    if (daysSinceTriggered < 0) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `SKIP ${email} — popup trigger date ${triggerDate} is in the future`,
        status: "skipped",
      });
      continue;
    }

    const sentTemplateIds = new Set(
      parseSentKeys(customFields[config.popupSentTemplatesFieldId])
    );
    const sentSmsKeys = new Set(
      parseSentKeys(customFields[config.popupSentSmsFieldId])
    );

    const matchedEmails = configuredEmails.filter(
      (item) => Number(item.daysAfterTrigger) === daysSinceTriggered
    );
    const matchedSms = configuredSms.filter(
      (item) => Number(item.daysAfterTrigger) === daysSinceTriggered
    );

    const smsConsentFieldId = String(config.popupSmsConsentFieldId || "").trim();
    const consentValue = smsConsentFieldId
      ? String(customFields[smsConsentFieldId] || "").trim().toLowerCase()
      : "";
    let hasSmsConsent = ["yes", "true", "1", "opted_in", "opted-in"].includes(
      consentValue
    );
    const hasExplicitSmsOptOut = ["no", "false", "0", "opted_out", "opted-out"].includes(
      consentValue
    );

    if (
      shouldRunSms &&
      matchedSms.length > 0 &&
      email &&
      (!phone || (smsConsentFieldId && !hasSmsConsent && !hasExplicitSmsOptOut))
    ) {
      try {
        let hydrated = contactHydrationCache.get(email);
        if (hydrated === undefined) {
          hydrated = await getContactByEmailDetailed(email);
          contactHydrationCache.set(email, hydrated || null);
        }

        const hydratedPhone = normalizePhoneNumber(
          hydrated?.phone_number || hydrated?.phone || ""
        );
        if (hydratedPhone) {
          phone = hydratedPhone;
          logs.push({
            timestamp: new Date().toISOString(),
            automation: "Popup Follow Ups",
            property: "—",
            action: `Hydrated missing phone for ${email} via direct SendGrid contact lookup`,
            status: "info",
          });
        }
        if (smsConsentFieldId) {
          const hydratedConsent = String(
            hydrated?.custom_fields?.[smsConsentFieldId] || ""
          )
            .trim()
            .toLowerCase();
          hasSmsConsent = ["yes", "true", "1", "opted_in", "opted-in"].includes(
            hydratedConsent
          );
        }
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `Failed to hydrate phone for ${email}: ${err.message}`,
          status: "failed",
        });
      }
    }

    if (shouldRunEmail && matchedEmails.length === 0) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `NO SEND ${email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no email follow-up configured for today | sent: ${formatSentKeysLabel(Array.from(sentTemplateIds))}`,
        status: "info",
      });
    }

    if (shouldRunSms && matchedSms.length === 0) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Popup Follow Ups",
        property: "—",
        action: `NO SEND ${phone || email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no SMS follow-up configured for today | sent: ${formatSentKeysLabel(Array.from(sentSmsKeys))}`,
        status: "info",
      });
    }

    for (const followup of matchedEmails) {
      const label = followup.label || `${followup.daysAfterTrigger}-day`;
      const templateId = String(followup.templateId || "").trim();
      const sentTemplatesLabel = formatSentKeysLabel(Array.from(sentTemplateIds));
      const emailDestination = isOneOffTest ? testDestination : email;
      const emailLedgerKey = templateId ? `email:${templateId}` : "";

      if (!templateId) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no template ID configured for "${label}" | sent: ${sentTemplatesLabel}`,
          status: "skipped",
        });
        continue;
      }

      const emailLedgerSent =
        !isDryRun && !isOneOffTest && emailLedgerKey
          ? await getPopupFollowupSent(email, emailLedgerKey)
          : null;
      if (sentTemplateIds.has(templateId) || emailLedgerSent) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | template already sent: ${templateId}${emailLedgerSent && !sentTemplateIds.has(templateId) ? " (KV ledger)" : ""} | sent: ${sentTemplatesLabel}`,
          status: "skipped",
        });
        continue;
      }

      try {
        if (!isDryRun) {
          await sendTemplateEmail({
            to: emailDestination,
            templateId,
            from,
            unsubscribeGroupId:
              automationConfig.sendgrid?.marketingUnsubscribeGroupId,
            data: {
              first_name: contact?.first_name || contact?.firstName || "",
              last_name: contact?.last_name || contact?.lastName || "",
              email,
              popup_triggered_at: triggerDate,
              days_since_trigger: followup.daysAfterTrigger,
              followup_label: label,
            },
          });

          if (shouldPersistState) {
            sentTemplateIds.add(templateId);
            await setPopupFollowupSent(email, emailLedgerKey, {
              channel: "email",
              templateId,
              label,
              sentAt: new Date().toISOString(),
            }).catch((err) => {
              logs.push({
                timestamp: new Date().toISOString(),
                automation: "Popup Follow Ups",
                property: "—",
                action: `Email "${label}" sent to ${email}, but KV sent-ledger update failed: ${err.message}`,
                status: "failed",
              });
            });
            await updateContactCustomFields({
              email,
              customFields: {
                [config.popupTriggeredFieldId]: rawTriggerDate,
                [config.popupSentTemplatesFieldId]: stringifySentKeys(
                  Array.from(sentTemplateIds)
                ),
                [config.popupSentSmsFieldId]: stringifySentKeys(
                  Array.from(sentSmsKeys)
                ),
              },
            });
          }
        }

        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: isDryRun
            ? `[DRY RUN] Would send "${label}" to ${email} (${templateId}) | triggered ${triggerDate} | ${followup.daysAfterTrigger} days since popup | sent: ${sentTemplatesLabel}`
            : isOneOffTest
              ? `[TEST SEND] Routed email "${label}" originally for ${email} to ${emailDestination} (${templateId})`
              : `Sent "${label}" to ${email} (${templateId}) | triggered ${triggerDate} | sent before update: ${sentTemplatesLabel}`,
          status: "success",
        });

        if (!isDryRun) {
          sentCount += 1;
          if (sentCount >= maxSends) {
            return logs;
          }
        }
      } catch (err) {
        const detail = err.response?.body?.errors?.[0]?.message || err.message;
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `Failed "${label}" for ${email}: ${detail}`,
          status: "failed",
        });
      }
    }

    for (const smsFollowup of matchedSms) {
      const label =
        smsFollowup.label || `${smsFollowup.daysAfterTrigger}-day SMS`;
      const messageKey = String(smsFollowup.messageKey || "").trim();
      const messageBody = String(smsFollowup.messageBody || "").trim();
      const sentSmsLabel = formatSentKeysLabel(Array.from(sentSmsKeys));
      const sendTo = isOneOffTest ? normalizePhoneNumber(testDestination) : phone;
      const isTestSend = !isDryRun && isOneOffTest;
      const smsLedgerKey = messageKey ? `sms:${messageKey}` : "";

      if (!isOneOffTest && (!smsConsentFieldId || !hasSmsConsent)) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${phone || email} | no explicit SMS consent${smsConsentFieldId ? ` in ${smsConsentFieldId}` : " field configured"}`,
          status: "skipped",
        });
        continue;
      }

      if (!messageKey) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${phone || email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no SMS key configured for "${label}" | sent: ${sentSmsLabel}`,
          status: "skipped",
        });
        continue;
      }

      if (!messageBody) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${phone || email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no message body configured for "${label}" | sent: ${sentSmsLabel}`,
          status: "skipped",
        });
        continue;
      }

      if (!phone) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${email} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | no phone number | sent: ${sentSmsLabel}`,
          status: "skipped",
        });
        continue;
      }

      const smsLedgerSent =
        !isDryRun && !isOneOffTest && smsLedgerKey
          ? await getPopupFollowupSent(email, smsLedgerKey)
          : null;
      if (sentSmsKeys.has(messageKey) || smsLedgerSent) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `SKIP ${phone} | triggered ${triggerDate} | ${daysSinceTriggered} days since popup | SMS already sent: ${messageKey}${smsLedgerSent && !sentSmsKeys.has(messageKey) ? " (KV ledger)" : ""} | sent: ${sentSmsLabel}`,
          status: "skipped",
        });
        continue;
      }

      try {
        let smsResult = null;
        if (!isDryRun) {
          smsResult = await sendSms({
            to: sendTo,
            body: messageBody,
                      });

          if (shouldPersistState) {
            sentSmsKeys.add(messageKey);
            await setPopupFollowupSent(email, smsLedgerKey, {
              channel: "sms",
              messageKey,
              label,
              twilioSid: smsResult?.sid || "",
              sentAt: new Date().toISOString(),
            }).catch((err) => {
              logs.push({
                timestamp: new Date().toISOString(),
                automation: "Popup Follow Ups",
                property: "—",
                action: `SMS "${label}" sent to ${phone}, but KV sent-ledger update failed: ${err.message}`,
                status: "failed",
              });
            });
            await updateContactCustomFields({
              email,
              customFields: {
                [config.popupTriggeredFieldId]: rawTriggerDate,
                [config.popupSentTemplatesFieldId]: stringifySentKeys(
                  Array.from(sentTemplateIds)
                ),
                [config.popupSentSmsFieldId]: stringifySentKeys(
                  Array.from(sentSmsKeys)
                ),
              },
            });
          }
        }

        const sidSuffix = smsResult?.sid ? ` | sid: ${smsResult.sid}` : "";
        const action = isDryRun
          ? `[DRY RUN] Would send SMS "${label}" to ${phone} (${messageKey}) | triggered ${triggerDate} | ${smsFollowup.daysAfterTrigger} days since popup | sent: ${sentSmsLabel}`
          : isTestSend
            ? `[TEST SEND] Routed SMS "${label}" originally for ${phone} to ${sendTo} (${messageKey})${sidSuffix}`
            : `Sent SMS "${label}" to ${phone} (${messageKey})${sidSuffix}`;

        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action,
          status: "success",
        });

        if (!isDryRun) {
          sentCount += 1;
          if (sentCount >= maxSends) {
            return logs;
          }
        }
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Popup Follow Ups",
          property: "—",
          action: `Failed SMS "${label}" for ${phone}: ${err.message}`,
          status: "failed",
        });
      }
    }
  }

  return logs;
}

// ─── Automation 4: Event Popup Salesmate + SMS ─────────────────────────────

function getSendGridCreatedDate(contact) {
  return parseCentralDateField(
    contact?.created_at ||
      contact?.createdAt ||
      contact?.created ||
      contact?.createdAtTimestamp ||
      ""
  );
}

function maxDateString(...dates) {
  return dates
    .map((date) => parseCentralDateField(date))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function eventPopupContactKey(contact, phone) {
  const email = normalizeEmail(contact?.email);
  if (email) return `email:${email}`;
  const normalizedPhone = normalizePhoneNumber(phone || contact?.phone_number || contact?.phone || "");
  if (normalizedPhone) return `phone:${normalizedPhone}`;
  return "";
}

function getEventPopupFollowupId(followup, index) {
  const explicitId = String(followup?.id || "").trim();
  if (explicitId) return explicitId;
  const days = Number(followup?.daysAfterTrigger) || 0;
  return `event_popup_sms_${index + 1}_day_${days}`;
}

export async function runEventPopupSalesmateSms(automationConfig, dryRunOverride, options = {}) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.eventPopupSalesmateSms || {};
  const todayStr = todayCentral();
  const testDestination = normalizePhoneNumber(options.testDestination || "");
  const isOneOffTest = Boolean(testDestination);
  const shouldPersistState = options.persistState !== false && !isOneOffTest && !isDryRun;
  const maxSends = Number.isFinite(options.maxSends) ? Number(options.maxSends) : Number.POSITIVE_INFINITY;
  let sentCount = 0;
  const smsFollowups = (config.sms || [])
    .map((followup, index) => ({
      ...followup,
      id: getEventPopupFollowupId(followup, index),
      daysAfterTrigger: Number(followup?.daysAfterTrigger) || 0,
    }))
    .filter((followup) => followup && followup.enabled !== false);
  const syncToSalesmate = config.syncToSalesmate !== false && !isOneOffTest;
  const fromNumber = String(config.twilioFromNumber || "").trim();

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!config.sendgridContactListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: "Skipped: no SendGrid event popup contact list ID configured",
      status: "skipped",
    });
    return logs;
  }

  if (smsFollowups.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: "Skipped: no enabled event popup SMS follow-ups configured",
      status: "skipped",
    });
    return logs;
  }

  try {
    validateTwilioConfig(fromNumber || undefined);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: `Skipped: ${err.message}`,
      status: "skipped",
    });
    return logs;
  }

  let salesmateReady = false;
  if (syncToSalesmate) {
    try {
      validateSalesmateConfig();
      salesmateReady = true;
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Event Popup Salesmate SMS",
        property: "—",
        action: `Salesmate sync disabled for this run: ${err.message}`,
        status: "skipped",
      });
    }
  }

  let contacts = [];
  try {
    contacts = await getContactsFromListDetailed(config.sendgridContactListId);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: `Failed to fetch event popup contacts: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: `═══ DRY RUN: Today is ${todayStr}. No Salesmate contacts or SMS messages will be created. ═══`,
      status: "info",
    });
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Event Popup Salesmate SMS",
    property: "—",
    action: `Using SendGrid event popup list: ${config.sendgridContactListId}; loaded ${contacts.length} contact(s)`,
    status: "info",
  });

  if (contacts.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Event Popup Salesmate SMS",
      property: "—",
      action: "No contacts in event popup list — skipped",
      status: "skipped",
    });
    return logs;
  }

  const contactHydrationCache = new Map();
  const maxConfiguredDay = Math.max(0, ...smsFollowups.map((item) => item.daysAfterTrigger));
  let eligibleCount = 0;

  for (const contact of contacts) {
    const email = normalizeEmail(contact?.email);
    let phone = normalizePhoneNumber(contact?.phone_number || contact?.phone || "");

    if (!phone && email) {
      try {
        let hydrated = contactHydrationCache.get(email);
        if (hydrated === undefined) {
          hydrated = await getContactByEmailDetailed(email);
          contactHydrationCache.set(email, hydrated || null);
        }
        phone = normalizePhoneNumber(hydrated?.phone_number || hydrated?.phone || "");
        if (phone) {
          logs.push({
            timestamp: new Date().toISOString(),
            automation: "Event Popup Salesmate SMS",
            property: "—",
            action: `Hydrated missing phone for ${email} via direct SendGrid contact lookup`,
            status: "info",
          });
        }
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `Failed to hydrate phone for ${email}: ${err.message}`,
          status: "failed",
        });
      }
    }

    const contactKey = eventPopupContactKey(contact, phone);
    if (!contactKey) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Event Popup Salesmate SMS",
        property: "—",
        action: "Skipped contact with no email or phone in event popup list",
        status: "skipped",
      });
      continue;
    }

    const existingState = isDryRun ? null : await getEventPopupContactState(contactKey);
    const firstSeenDate = existingState?.firstSeenDate || todayStr;
    const sendGridCreatedDate = getSendGridCreatedDate(contact);
    const triggerDate = maxDateString(sendGridCreatedDate, firstSeenDate, todayStr === firstSeenDate ? todayStr : "");
    const daysSinceTriggered = daysBetween(triggerDate, todayStr);

    if (shouldPersistState && !existingState) {
      await setEventPopupContactState(contactKey, {
        firstSeenDate,
        sendGridCreatedDate,
        salesmateContactId: "",
        lastSeenAt: new Date().toISOString(),
      });
    }

    let salesmateContactId = existingState?.salesmateContactId || "";
    const alreadySyncedToSalesmate = Boolean(existingState?.salesmateSynced || salesmateContactId);
    if (syncToSalesmate && salesmateReady && !alreadySyncedToSalesmate) {
      try {
        if (!isDryRun) {
          const result = await createSalesmateContact({
            contact: {
              ...contact,
              email,
              phone,
            },
            leadSource: config.salesmateLeadSource || "Website",
            tags: config.salesmateTags || [],
          });
          salesmateContactId = result.id || "";
          if (shouldPersistState) {
            await setEventPopupContactState(contactKey, {
              ...(existingState || {}),
              firstSeenDate,
              sendGridCreatedDate,
              salesmateContactId,
              salesmateSynced: true,
              lastSyncedToSalesmateAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            });
          }
        }

        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: isDryRun
            ? `[DRY RUN] Would create Salesmate contact for ${email || phone} with tags ${(config.salesmateTags || []).join(", ")}`
            : `Created Salesmate contact for ${email || phone}${salesmateContactId ? ` | id: ${salesmateContactId}` : ""}`,
          status: "success",
        });
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `Failed to create Salesmate contact for ${email || phone}: ${err.message}`,
          status: "failed",
        });
      }
    }

    if (daysSinceTriggered < 0 || daysSinceTriggered > maxConfiguredDay) {
      continue;
    }

    eligibleCount += 1;

    const matchedSms = smsFollowups.filter(
      (item) => item.daysAfterTrigger === daysSinceTriggered
    );

    if (matchedSms.length === 0) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Event Popup Salesmate SMS",
        property: "—",
        action: `NO SEND ${phone || email} | triggered ${triggerDate} | ${daysSinceTriggered} days since event popup | no SMS configured for today`,
        status: "info",
      });
      continue;
    }

    for (const smsFollowup of matchedSms) {
      const messageBody = String(smsFollowup.messageBody || "").trim();
      const label = `${smsFollowup.daysAfterTrigger}-day event popup SMS`;
      const alreadySent = isDryRun || isOneOffTest ? null : await getEventPopupSmsSent(contactKey, smsFollowup.id);
      const sendTo = isOneOffTest ? testDestination : phone;

      if (!messageBody) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `SKIP ${phone || email} | triggered ${triggerDate} | ${daysSinceTriggered} days since event popup | no message body configured for ${label}`,
          status: "skipped",
        });
        continue;
      }

      if (!phone) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `SKIP ${email || contactKey} | triggered ${triggerDate} | ${daysSinceTriggered} days since event popup | no phone number`,
          status: "skipped",
        });
        continue;
      }

      if (alreadySent) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `SKIP ${phone} | ${label} already sent at ${alreadySent.sentAt || "(unknown)"}`,
          status: "skipped",
        });
        continue;
      }

      try {
        let smsResult = null;
        if (!isDryRun) {
          smsResult = await sendSms({
            to: sendTo,
            body: messageBody,
            from: fromNumber || undefined,
          });
          if (shouldPersistState) {
            await setEventPopupSmsSent(contactKey, smsFollowup.id, {
              sentAt: new Date().toISOString(),
              to: phone,
              from: fromNumber || "",
              followupId: smsFollowup.id,
              daysAfterTrigger: smsFollowup.daysAfterTrigger,
              twilioSid: smsResult?.sid || "",
            });
          }
        }

        const sidSuffix = smsResult?.sid ? ` | sid: ${smsResult.sid}` : "";
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: isDryRun
            ? `[DRY RUN] Would send ${label} to ${phone} | triggered ${triggerDate}`
            : isOneOffTest
              ? `[TEST SEND] Routed ${label} originally for ${phone} to ${sendTo}${sidSuffix}`
              : `Sent ${label} to ${phone}${sidSuffix}`,
          status: "success",
        });
        if (!isDryRun) {
          sentCount += 1;
          if (sentCount >= maxSends) {
            return logs;
          }
        }
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Event Popup Salesmate SMS",
          property: "—",
          action: `Failed ${label} for ${phone}: ${err.message}`,
          status: "failed",
        });
      }
    }
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Event Popup Salesmate SMS",
    property: "—",
    action: `Evaluated ${contacts.length} contact(s); ${eligibleCount} inside active ${maxConfiguredDay}-day SMS window`,
    status: "info",
  });

  return logs;
}

async function runJotformClientSync(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.jotformClientSync || {};
  const formIds = (config.jotformFormIds || []).map((id) => String(id || "").trim()).filter(Boolean);

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!config.sendgridContactListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: "Skipped: no SendGrid master list ID configured",
      status: "skipped",
    });
    return logs;
  }

  if (formIds.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: "Skipped: no Jotform form IDs configured",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: "═══ DRY RUN: No SendGrid contacts will be written. Validation: WHICH client records would be synced. ═══",
      status: "info",
    });
  }

  const dedupedContacts = new Map();
  let totalSubmissions = 0;
  let missingEmailCount = 0;

  for (const formId of formIds) {
    let submissions = [];
    try {
      submissions = await getFormSubmissions(formId);
      totalSubmissions += submissions.length;
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Client Sync",
        property: "—",
        action: `Loaded ${submissions.length} submission(s) from Jotform form ${formId}`,
        status: "info",
      });
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Client Sync",
        property: "—",
        action: `Failed to fetch Jotform form ${formId}: ${err.message}`,
        status: "failed",
      });
      continue;
    }

    for (const submission of submissions) {
      const contact = extractClientContact(submission);
      if (!contact.email) {
        missingEmailCount += 1;
        continue;
      }

      const merged = mergeClientContact(
        dedupedContacts.get(contact.email) || {
          email: contact.email,
          firstName: "",
          lastName: "",
          phone: "",
          submissionIds: [],
          formIds: [],
        },
        {
          ...contact,
          submissionIds: contact.submissionId ? [contact.submissionId] : [],
          formIds: [formId],
        }
      );
      dedupedContacts.set(contact.email, merged);
    }
  }

  const contactsToSync = Array.from(dedupedContacts.values());
  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Jotform Client Sync",
    property: "—",
    action: `Prepared ${contactsToSync.length} unique contact(s) from ${totalSubmissions} Jotform submission(s); skipped ${missingEmailCount} submission(s) with no email`,
    status: "info",
  });

  if (contactsToSync.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: "No eligible contacts found to sync",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    contactsToSync.forEach((contact) => {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Client Sync",
        property: "—",
        action: `[DRY RUN] Would sync ${contact.email} | first: ${contact.firstName || "(blank)"} | last: ${contact.lastName || "(blank)"} | phone: ${contact.phone || "(blank)"} | forms: ${contact.formIds.join(",")} | submissions: ${contact.submissionIds.join(",") || "(unknown)"}`,
        status: "success",
      });
    });
    return logs;
  }

  try {
    const results = await upsertContactsToList({
      listId: config.sendgridContactListId,
      contacts: contactsToSync,
    });
    const requestedCount = results.reduce((sum, item) => sum + Number(item?.results?.requested_count || 0), 0);
    const createdCount = results.reduce((sum, item) => sum + Number(item?.results?.created_count || 0), 0);
    const updatedCount = results.reduce((sum, item) => sum + Number(item?.results?.updated_count || 0), 0);
    const erroredCount = results.reduce((sum, item) => sum + Number(item?.results?.errored_count || 0), 0);
    const pendingCount = results.filter((item) => item?.status === "pending_timeout").length;

    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: pendingCount > 0
        ? `SendGrid accepted ${contactsToSync.length} contact(s) for sync to list ${config.sendgridContactListId}, but ${pendingCount} batch job(s) were still pending after the wait window | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`
        : `Synced ${contactsToSync.length} contact(s) to SendGrid list ${config.sendgridContactListId} | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`,
      status: erroredCount > 0 ? "failed" : pendingCount > 0 ? "info" : "success",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Client Sync",
      property: "—",
      action: `Failed to sync contacts to SendGrid: ${err.message}`,
      status: "failed",
    });
  }

  return logs;
}

async function runLocalFormClientSync(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.localFormClientSync || {};
  const formSlugs = (config.formSlugs || [])
    .map((slug) => String(slug || "").trim())
    .filter(Boolean);

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!config.sendgridContactListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: "Skipped: no SendGrid master list ID configured",
      status: "skipped",
    });
    return logs;
  }

  if (!hasSupabaseAdminEnv()) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: "Skipped: Supabase URL/service-role key is not configured",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: "═══ DRY RUN: No SendGrid contacts will be written. Validation: WHICH local form records would be synced. ═══",
      status: "info",
    });
  }

  let submissions = [];
  try {
    submissions = await listLocalFormSubmissions({
      formSlugs,
      onlyUnsynced: config.onlyUnsynced === true,
      limit: config.limit || 5000,
    });
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: `Loaded ${submissions.length} local form submission(s)${
        formSlugs.length ? ` for ${formSlugs.join(", ")}` : ""
      }`,
      status: "info",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: `Failed to load local form submissions: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  const dedupedContacts = new Map();
  let missingEmailCount = 0;

  for (const submission of submissions) {
    const contact = extractLocalFormContact(submission);
    if (!contact.email) {
      missingEmailCount += 1;
      continue;
    }

    const merged = mergeClientContact(
      dedupedContacts.get(contact.email) || {
        email: contact.email,
        firstName: "",
        lastName: "",
        phone: "",
        submissionIds: [],
        formIds: [],
      },
      {
        ...contact,
        submissionIds: contact.submissionId ? [contact.submissionId] : [],
        formIds: contact.formSlug ? [contact.formSlug] : [],
      }
    );
    dedupedContacts.set(contact.email, merged);
  }

  const contactsToSync = Array.from(dedupedContacts.values());
  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Local Form Client Sync",
    property: "—",
    action: `Prepared ${contactsToSync.length} unique contact(s) from ${submissions.length} local form submission(s); skipped ${missingEmailCount} submission(s) with no email`,
    status: "info",
  });

  if (contactsToSync.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: "No eligible local form contacts found to sync",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    contactsToSync.forEach((contact) => {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Local Form Client Sync",
        property: "—",
        action: `[DRY RUN] Would sync ${contact.email} | first: ${contact.firstName || "(blank)"} | last: ${contact.lastName || "(blank)"} | phone: ${contact.phone || "(blank)"} | forms: ${contact.formIds.join(",") || "(unknown)"} | submissions: ${contact.submissionIds.join(",") || "(unknown)"}`,
        status: "success",
      });
    });
    return logs;
  }

  try {
    const results = await upsertContactsToList({
      listId: config.sendgridContactListId,
      contacts: contactsToSync,
    });
    const requestedCount = results.reduce((sum, item) => sum + Number(item?.results?.requested_count || 0), 0);
    const createdCount = results.reduce((sum, item) => sum + Number(item?.results?.created_count || 0), 0);
    const updatedCount = results.reduce((sum, item) => sum + Number(item?.results?.updated_count || 0), 0);
    const erroredCount = results.reduce((sum, item) => sum + Number(item?.results?.errored_count || 0), 0);
    const pendingCount = results.filter((item) => item?.status === "pending_timeout").length;

    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: pendingCount > 0
        ? `SendGrid accepted ${contactsToSync.length} local form contact(s) for sync to list ${config.sendgridContactListId}, but ${pendingCount} batch job(s) were still pending after the wait window | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`
        : `Synced ${contactsToSync.length} local form contact(s) to SendGrid list ${config.sendgridContactListId} | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`,
      status: erroredCount > 0 ? "failed" : pendingCount > 0 ? "info" : "success",
    });

    if (erroredCount === 0 && pendingCount === 0) {
      const syncedSubmissionIds = contactsToSync.flatMap((contact) => contact.submissionIds || []);
      await markLocalFormSubmissionsSynced(syncedSubmissionIds);
    }
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Local Form Client Sync",
      property: "—",
      action: `Failed to sync local form contacts to SendGrid: ${err.message}`,
      status: "failed",
    });
  }

  return logs;
}

async function runJotformLocalFormImport(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.jotformLocalFormImport || {};
  const mappings = Array.isArray(config.mappings)
    ? config.mappings
        .map((mapping) => ({
          jotformFormId: String(mapping?.jotformFormId || "").trim(),
          localFormSlug: String(mapping?.localFormSlug || "").trim(),
        }))
        .filter((mapping) => mapping.jotformFormId && mapping.localFormSlug)
    : [];

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Local Form Import",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!hasSupabaseAdminEnv()) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Local Form Import",
      property: "—",
      action: "Skipped: Supabase URL/service-role key is not configured",
      status: "skipped",
    });
    return logs;
  }

  if (mappings.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Local Form Import",
      property: "—",
      action: "Skipped: no Jotform-to-local form mappings configured",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Local Form Import",
      property: "—",
      action: "═══ DRY RUN: No local form submissions will be written. Validation: WHICH Jotform submissions would be imported. ═══",
      status: "info",
    });
  }

  const limit = Math.max(1, Math.min(Number(config.limit) || 1000, 1000));

  for (const mapping of mappings) {
    const form = await getLocalFormBySlug(mapping.localFormSlug).catch((err) => {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Local Form Import",
        property: mapping.localFormSlug,
        action: `Failed to load local form /forms/${mapping.localFormSlug}: ${err.message}`,
        status: "failed",
      });
      return null;
    });

    if (!form) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Local Form Import",
        property: mapping.localFormSlug,
        action: `Skipped Jotform form ${mapping.jotformFormId}: local form /forms/${mapping.localFormSlug} was not found`,
        status: "skipped",
      });
      continue;
    }

    let submissions = [];
    try {
      submissions = await getFormSubmissions(mapping.jotformFormId, { limit });
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Local Form Import",
        property: mapping.localFormSlug,
        action: `Loaded ${submissions.length} Jotform submission(s) from form ${mapping.jotformFormId}`,
        status: "info",
      });
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Jotform Local Form Import",
        property: mapping.localFormSlug,
        action: `Failed to fetch Jotform form ${mapping.jotformFormId}: ${err.message}`,
        status: "failed",
      });
      continue;
    }

    let importedCount = 0;
    let missingIdCount = 0;
    for (const submission of submissions) {
      const submissionId = String(
        submission?.id || submission?.submissionID || ""
      ).trim();
      if (!submissionId) {
        missingIdCount += 1;
        continue;
      }

      const contact = {
        ...extractClientContact(submission),
        bookingCode: extractBookingCode(submission),
      };
      const payload = submissionToLocalFormPayload(
        submission,
        mapping.jotformFormId
      );
      const submittedAtRaw =
        submission?.created_at ||
        submission?.createdAt ||
        submission?.submissionTime ||
        "";
      const parsedSubmittedAt = submittedAtRaw
        ? new Date(submittedAtRaw)
        : null;
      const submittedAt =
        parsedSubmittedAt && !isNaN(parsedSubmittedAt.getTime())
          ? parsedSubmittedAt.toISOString()
          : null;

      if (isDryRun) {
        importedCount += 1;
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Jotform Local Form Import",
          property: mapping.localFormSlug,
          action: `[DRY RUN] Would import Jotform submission ${submissionId} to /forms/${mapping.localFormSlug} | email ${contact.email || "(missing)"} | booking ${contact.bookingCode || "(missing)"}`,
          status: "success",
        });
        continue;
      }

      try {
        await upsertImportedLocalFormSubmission({
          form,
          formSlug: mapping.localFormSlug,
          contact,
          payload,
          externalSource: "jotform",
          externalFormId: mapping.jotformFormId,
          externalSubmissionId: submissionId,
          submittedAt,
        });
        importedCount += 1;
      } catch (err) {
        logs.push({
          timestamp: new Date().toISOString(),
          automation: "Jotform Local Form Import",
          property: mapping.localFormSlug,
          action: `Failed to import Jotform submission ${submissionId}: ${err.message}`,
          status: "failed",
        });
      }
    }

    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Jotform Local Form Import",
      property: mapping.localFormSlug,
      action: `${isDryRun ? "Prepared" : "Imported"} ${importedCount} submission(s) from Jotform form ${mapping.jotformFormId}${missingIdCount ? `; skipped ${missingIdCount} without submission IDs` : ""}`,
      status: "success",
    });
  }

  return logs;
}

async function runLodgifyClientSync(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.lodgifyClientSync || {};
  const lookbackDays = Math.max(0, Number(config.stayDateLookbackDays) || 0);
  const lookaheadDays = Math.max(0, Number(config.stayDateLookaheadDays) || 0);
  const includeCancelledBookings = config.includeCancelledBookings !== false;
  const startDate = addDays(todayCentral(), -lookbackDays);
  const endDate = addDays(todayCentral(), lookaheadDays);

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  if (!config.sendgridContactListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: "Skipped: no SendGrid master list ID configured",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `═══ DRY RUN: No SendGrid contacts will be written. Validation: WHICH Lodgify bookings would be synced for stay dates ${startDate} to ${endDate}. ═══`,
      status: "info",
    });
  }

  let bookings = [];
  try {
    bookings = await getAllBookingsInStayWindow(startDate, endDate);
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `Loaded ${bookings.length} booking(s) from Lodgify for stay dates ${startDate} to ${endDate}`,
      status: "info",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `Failed to fetch Lodgify bookings: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  const dedupedContacts = new Map();
  let skippedMissingEmailCount = 0;
  let skippedCancelledCount = 0;

  for (const booking of bookings) {
    const contact = extractLodgifyContact(booking);

    if (isCancelledBooking(contact.bookingStatus) && !includeCancelledBookings) {
      skippedCancelledCount += 1;
      continue;
    }

    if (!contact.email) {
      skippedMissingEmailCount += 1;
      continue;
    }

    const merged = mergeClientContact(
      dedupedContacts.get(contact.email) || {
        email: contact.email,
        firstName: "",
        lastName: "",
        phone: "",
        submissionIds: [],
        formIds: [],
        bookingIds: [],
        bookingStatuses: [],
        propertyNames: [],
      },
      {
        ...contact,
        bookingIds: contact.bookingId ? [contact.bookingId] : [],
        bookingStatuses: contact.bookingStatus ? [contact.bookingStatus] : [],
        propertyNames: contact.propertyName ? [contact.propertyName] : [],
      }
    );

    const arrival = toDateOnly(booking?.arrival || booking?.checkIn || booking?.start_date);
    const cancelled = isCancelledBooking(contact.bookingStatus);
    merged.stayStarted =
      Boolean(dedupedContacts.get(contact.email)?.stayStarted) ||
      (!cancelled && Boolean(arrival) && arrival <= todayCentral());
    dedupedContacts.set(contact.email, merged);
  }

  const contactsToSync = Array.from(dedupedContacts.values());
  logs.push({
    timestamp: new Date().toISOString(),
    automation: "Lodgify Client Sync",
    property: "—",
    action: `Prepared ${contactsToSync.length} unique contact(s) from ${bookings.length} Lodgify booking(s); skipped ${skippedMissingEmailCount} booking(s) with no email${includeCancelledBookings ? "" : `; skipped ${skippedCancelledCount} cancelled booking(s)`}`,
    status: "info",
  });

  if (contactsToSync.length === 0) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: "No eligible Lodgify contacts found to sync",
      status: "skipped",
    });
    return logs;
  }

  if (isDryRun) {
    contactsToSync.forEach((contact) => {
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Lodgify Client Sync",
        property: contact.propertyNames?.join(", ") || "—",
        action: `[DRY RUN] Would sync ${contact.email} | first: ${contact.firstName || "(blank)"} | last: ${contact.lastName || "(blank)"} | phone: ${contact.phone || "(blank)"} | bookings: ${contact.bookingIds.join(",") || "(unknown)"} | statuses: ${contact.bookingStatuses.join(",") || "(unknown)"}`,
        status: "success",
      });
    });
    return logs;
  }

  // SendGrid rejects email-only updates for contacts that also carry a
  // phone_number_id / external_id, so send every existing identifier.
  try {
    const identifiers = await getContactIdentifiersByEmails(contactsToSync.map((contact) => contact.email));
    for (const contact of contactsToSync) Object.assign(contact, identifiers.get(contact.email) || {});
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `Could not look up existing SendGrid identifiers (continuing): ${err.message}`,
      status: "info",
    });
  }

  // Guests whose (non-cancelled) stay has started also go to the Email Offers
  // marketing list, with the same address rules as the Marketing Opt-ins
  // backfill (no OTA relay / invalid / disposable addresses).
  try {
    const { emailListId } = await getMarketingOptInLists();
    const pastGuests = contactsToSync.filter(
      (contact) => contact.stayStarted && !contactRejectReason(contact, { trusted: true })
    );
    if (emailListId && pastGuests.length > 0) {
      await upsertContactsToList({ listId: emailListId, contacts: pastGuests, wait: false });
      logs.push({
        timestamp: new Date().toISOString(),
        automation: "Lodgify Client Sync",
        property: "—",
        action: `Queued ${pastGuests.length} past guest(s) for the Email Offers list`,
        status: "success",
      });
    }
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `Failed to add past guests to Email Offers: ${err.message}`,
      status: "failed",
    });
  }

  try {
    const results = await upsertContactsToList({
      listId: config.sendgridContactListId,
      contacts: contactsToSync,
    });
    const requestedCount = results.reduce((sum, item) => sum + Number(item?.results?.requested_count || 0), 0);
    const createdCount = results.reduce((sum, item) => sum + Number(item?.results?.created_count || 0), 0);
    const updatedCount = results.reduce((sum, item) => sum + Number(item?.results?.updated_count || 0), 0);
    const erroredCount = results.reduce((sum, item) => sum + Number(item?.results?.errored_count || 0), 0);
    const pendingCount = results.filter((item) => item?.status === "pending_timeout").length;

    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: pendingCount > 0
        ? `SendGrid accepted ${contactsToSync.length} Lodgify contact(s) for sync to list ${config.sendgridContactListId}, but ${pendingCount} batch job(s) were still pending after the wait window | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`
        : `Synced ${contactsToSync.length} Lodgify contact(s) to SendGrid list ${config.sendgridContactListId} | requested: ${requestedCount} | created: ${createdCount} | updated: ${updatedCount} | errored: ${erroredCount}`,
      status: erroredCount > 0 ? "failed" : pendingCount > 0 ? "info" : "success",
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation: "Lodgify Client Sync",
      property: "—",
      action: `Failed to sync Lodgify contacts to SendGrid: ${err.message}`,
      status: "failed",
    });
  }

  return logs;
}

// ─── Automation: Salesmate Form Sync ────────────────────────────────────────
// Always-on. Mirrors a SINGLE master SendGrid list into Salesmate. For each
// contact in that source list, derives Salesmate tags from the *other*
// SendGrid lists the contact also belongs to. Contact exports do not reliably
// include `list_ids`, so membership is indexed from each non-empty tag list.
// One Salesmate write per contact carries every form-source tag at once.
// Re-syncs only when the derived tag set changes for a given contact.

function salesmateSyncContactKey(contact) {
  const email = normalizeEmail(contact?.email);
  if (email) return `email:${email}`;
  const phone = normalizePhoneNumber(contact?.phone_number || contact?.phone || "");
  if (phone) return `phone:${phone}`;
  return "";
}

function tagsSignature(tags) {
  return [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))]
    .sort()
    .join("|");
}

export async function runSalesmateFormSync(automationConfig, dryRunOverride) {
  const isDryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN_ENV;
  const logs = [];
  const config = automationConfig.salesmateFormSync || {};
  const automation = "Salesmate Form Sync";

  if (!config.enabled) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: "—",
      action: "Skipped (disabled)",
      status: "skipped",
    });
    return logs;
  }

  try {
    validateSalesmateConfig();
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: "—",
      action: `Skipped: ${err.message}`,
      status: "skipped",
    });
    return logs;
  }

  const sourceListId = String(config.sourceListId || "").trim();
  if (!sourceListId) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: "—",
      action: "Skipped: no source SendGrid list configured (set sourceListId)",
      status: "skipped",
    });
    return logs;
  }

  const leadSource = String(config.leadSource || "Website").trim();

  let allLists = [];
  try {
    allLists = await listAllContactLists();
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: "—",
      action: `Failed to fetch SendGrid lists: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  const listIndex = new Map(allLists.map((list) => [list.id, list]));
  const sourceList = listIndex.get(sourceListId);

  if (!sourceList) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: sourceListId,
      action: `Skipped: source list ${sourceListId} not found in SendGrid`,
      status: "failed",
    });
    return logs;
  }

  let contacts = [];
  try {
    contacts = await getContactsFromListDetailed(sourceListId);
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: sourceList.name || sourceListId,
      action: `Failed to load contacts for source list: ${err.message}`,
      status: "failed",
    });
    return logs;
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation,
    property: sourceList.name || sourceListId,
    action: `Source list ${sourceListId} (${sourceList.name}) — ${contacts.length} contact(s)${isDryRun ? " | DRY RUN" : ""}`,
    status: "info",
  });

  const tagLists = allLists.filter(
    (list) =>
      list.id !== sourceListId &&
      String(list.name || "").trim() &&
      Number(list.contactCount || 0) > 0
  );
  const tagsByContactKey = new Map();

  for (const list of tagLists) {
    let members = [];
    try {
      members = await getContactsFromListDetailed(list.id);
    } catch (err) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation,
        property: list.name || list.id,
        action: `Failed to load SendGrid tag-list membership: ${err.message}`,
        status: "failed",
      });
      return logs;
    }

    for (const member of members) {
      const memberKey = salesmateSyncContactKey(member);
      if (!memberKey) continue;
      const memberTags = tagsByContactKey.get(memberKey) || new Set();
      memberTags.add(String(list.name).trim());
      tagsByContactKey.set(memberKey, memberTags);
    }

    logs.push({
      timestamp: new Date().toISOString(),
      automation,
      property: list.name,
      action: `Loaded ${members.length} contact membership(s) from SendGrid tag list ${list.name}`,
      status: "info",
    });
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let skippedNoIdentity = 0;
  let skippedNoTags = 0;

  for (const contact of contacts) {
    const contactKey = salesmateSyncContactKey(contact);
    if (!contactKey) {
      skippedNoIdentity += 1;
      continue;
    }

    const memberListIds = Array.isArray(contact?.list_ids) ? contact.list_ids : [];
    const embeddedTags = memberListIds
      .filter((id) => id && id !== sourceListId)
      .map((id) => String(listIndex.get(id)?.name || "").trim())
      .filter(Boolean);
    const indexedTags = Array.from(tagsByContactKey.get(contactKey) || []);
    const uniqueTags = [...new Set([...embeddedTags, ...indexedTags])];
    const signature = tagsSignature(uniqueTags);

    if (uniqueTags.length === 0) {
      skippedNoTags += 1;
      continue;
    }

    const email = normalizeEmail(contact?.email);
    const phone = normalizePhoneNumber(contact?.phone_number || contact?.phone || "");

    const existing = await getSalesmateFormSyncState(sourceListId, contactKey);
    if (existing?.salesmateSynced && existing?.tagsSignature === signature) {
      unchanged += 1;
      continue;
    }

    const isUpdate = Boolean(existing?.salesmateSynced);

    if (isDryRun) {
      logs.push({
        timestamp: new Date().toISOString(),
        automation,
        property: email || phone || contactKey,
        action: `[DRY RUN] Would ${isUpdate ? "update" : "create"} Salesmate contact for ${email || phone} | tags: ${uniqueTags.join(", ")}`,
        status: "success",
      });
      if (isUpdate) updated += 1;
      else created += 1;
      continue;
    }

    try {
      const result = await upsertSalesmateContact({
        contact: {
          email,
          phone,
          firstName: contact?.first_name || contact?.firstName || "",
          lastName: contact?.last_name || contact?.lastName || "",
        },
        leadSource,
        tags: uniqueTags,
        contactId: existing?.salesmateContactId || "",
      });
      await setSalesmateFormSyncState(sourceListId, contactKey, {
        salesmateContactId: result.id || existing?.salesmateContactId || "",
        salesmateSynced: true,
        tags: uniqueTags,
        tagsSignature: signature,
        syncedAt: new Date().toISOString(),
      });
      const didUpdate = result.action === "updated";
      if (didUpdate) updated += 1;
      else created += 1;
      logs.push({
        timestamp: new Date().toISOString(),
        automation,
        property: email || phone || contactKey,
        action: `${didUpdate ? "Updated" : "Created"} Salesmate contact for ${email || phone} | tags: ${uniqueTags.join(", ")}${result.id ? ` | id: ${result.id}` : ""}`,
        status: "success",
      });
    } catch (err) {
      failed += 1;
      logs.push({
        timestamp: new Date().toISOString(),
        automation,
        property: email || phone || contactKey,
        action: `Failed Salesmate sync for ${email || phone}: ${err.message}`,
        status: "failed",
      });
    }
  }

  logs.push({
    timestamp: new Date().toISOString(),
    automation,
    property: "—",
    action: `Done | created: ${created} | updated: ${updated} | unchanged: ${unchanged} | no-tags: ${skippedNoTags} | no-identity: ${skippedNoIdentity} | failed: ${failed}`,
    status: failed > 0 ? "failed" : "info",
  });

  return logs;
}

// ─── POST handler ───────────────────────────────────────────────────────────

export async function POST(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read live config from KV (reflects dashboard edits)
  const automationConfig = await getConfig();

  const forceDryRun = request.headers.get("x-dry-run") === "true";
  const isDryRun = DRY_RUN_ENV || forceDryRun;
  const selectedAutomations = parseSelectedAutomations(request);
  const popupChannelOverride = parsePopupChannelOverride(request);
  const runAllAutomations = selectedAutomations.size === 0;
  const centralHourParam = request.nextUrl?.searchParams?.get("centralHour");
  const centralHourGate =
    centralHourParam === null || centralHourParam === undefined || centralHourParam === ""
      ? null
      : Number(centralHourParam);

  if (
    !isDryRun &&
    centralHourGate !== null &&
    Number.isFinite(centralHourGate)
  ) {
    const clock = centralClock();
    if (clock.hour !== centralHourGate) {
      const logs = [
        {
          timestamp: new Date().toISOString(),
          automation: "Cron Window",
          property: "—",
          action: `Skipped: current Central hour is ${String(clock.hour).padStart(2, "0")}; this cron is gated to ${String(centralHourGate).padStart(2, "0")}:00 Central`,
          status: "skipped",
        },
      ];
      await appendLogs(logs);
      await writeLastRunStatus("SUCCESS");
      return NextResponse.json({
        status: "SUCCESS",
        timestamp: new Date().toISOString(),
        logsCount: logs.length,
        logs,
      });
    }
  }

  if (isDryRun) {
    const todayStr = today();
    console.log(`[cron] DRY RUN — no emails will be sent. Today: ${todayStr}. Validation: WHO would receive WHAT.`);
  }

  const allLogs = [];

  if (runAllAutomations || selectedAutomations.has("vacancy")) {
    const vacancyLogs = await runVacancyEmails(automationConfig, isDryRun);
    allLogs.push(...vacancyLogs);
  }

  if (runAllAutomations || selectedAutomations.has("waiver")) {
    const waiverLogs = await runWaiverReminders(automationConfig, isDryRun);
    allLogs.push(...waiverLogs);
  }

  if (runAllAutomations || selectedAutomations.has("access-code-release")) {
    const accessCodeLogs = await runAccessCodeRelease(automationConfig, isDryRun);
    allLogs.push(...accessCodeLogs);
  }

  if (runAllAutomations || selectedAutomations.has("access-code-day-of")) {
    const dayOfAccessCodeLogs = await runDayOfDelayedAccessCodeRelease(
      automationConfig,
      isDryRun
    );
    allLogs.push(...dayOfAccessCodeLogs);
  }

  if (runAllAutomations || selectedAutomations.has("access-code-retry")) {
    const jervisRetryLogs = await runJervisAccessCodeRetries(
      automationConfig,
      isDryRun
    );
    allLogs.push(...jervisRetryLogs);
  }

  if (runAllAutomations || selectedAutomations.has("popup")) {
    const popupLogs = await runPopupFollowups(automationConfig, isDryRun, popupChannelOverride);
    allLogs.push(...popupLogs);
  }

  if (runAllAutomations || selectedAutomations.has("event-popup")) {
    const eventPopupLogs = await runEventPopupSalesmateSms(automationConfig, isDryRun);
    allLogs.push(...eventPopupLogs);
  }

  if (
    runAllAutomations ||
    selectedAutomations.has("jotform-sync") ||
    selectedAutomations.has("syncs")
  ) {
    const jotformSyncLogs = await runJotformClientSync(automationConfig, isDryRun);
    allLogs.push(...jotformSyncLogs);
  }

  if (
    runAllAutomations ||
    selectedAutomations.has("local-form-sync") ||
    selectedAutomations.has("syncs")
  ) {
    const localFormSyncLogs = await runLocalFormClientSync(automationConfig, isDryRun);
    allLogs.push(...localFormSyncLogs);
  }

  if (
    runAllAutomations ||
    selectedAutomations.has("jotform-local-import") ||
    selectedAutomations.has("syncs")
  ) {
    const importLogs = await runJotformLocalFormImport(automationConfig, isDryRun);
    allLogs.push(...importLogs);
  }

  if (
    runAllAutomations ||
    selectedAutomations.has("lodgify-sync") ||
    selectedAutomations.has("syncs")
  ) {
    const lodgifySyncLogs = await runLodgifyClientSync(automationConfig, isDryRun);
    allLogs.push(...lodgifySyncLogs);
  }

  if (
    runAllAutomations ||
    selectedAutomations.has("salesmate-sync") ||
    selectedAutomations.has("syncs")
  ) {
    const salesmateSyncLogs = await runSalesmateFormSync(automationConfig, isDryRun);
    allLogs.push(...salesmateSyncLogs);
  }

  await appendLogs(allLogs);

  const hasFailed = allLogs.some((log) => log.status === "failed");
  if (hasFailed && !isDryRun) {
    const failedLogs = allLogs.filter((log) => log.status === "failed");
    try {
      const alertResult = await notifyAutomationFailure({
        config: automationConfig,
        title: "Scheduled automation failure",
        logs: failedLogs,
        context: {
          path: `${request.nextUrl?.pathname || "/api/cron"}${request.nextUrl?.search || ""}`,
          automations: runAllAutomations
            ? "all"
            : Array.from(selectedAutomations).join(", "),
        },
      });
      allLogs.push({
        timestamp: new Date().toISOString(),
        automation: "Automation Failure Alert",
        property: "—",
        action: alertResult.sent
          ? `Sent failure alert email to ${alertResult.recipients} recipient(s)`
          : `Failure alert email skipped: ${alertResult.reason || "not configured"}`,
        status: alertResult.sent || alertResult.skipped ? "info" : "failed",
      });
    } catch (err) {
      allLogs.push({
        timestamp: new Date().toISOString(),
        automation: "Automation Failure Alert",
        property: "—",
        action: `Failed to send failure alert email: ${err.message}`,
        status: "failed",
      });
    }
    await appendLogs(allLogs.slice(-1)).catch(() => {});
  }
  await writeLastRunStatus(hasFailed ? "FAILED" : "SUCCESS");

  // Log to terminal for quick debugging (dev server stdout)
  const icon = (s) => (s === "success" ? "✓" : s === "failed" ? "✗" : s === "info" ? "→" : "○");
  allLogs.forEach((l) =>
    console.log(`[cron] ${icon(l.status)} [${l.automation}] ${l.action}`)
  );

  return NextResponse.json({
    status: hasFailed ? "FAILED" : "SUCCESS",
    timestamp: new Date().toISOString(),
    logsCount: allLogs.length,
    logs: allLogs,
  });
}

// Also support GET for Vercel Cron (Vercel crons use GET by default)
export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return POST(request);
}
