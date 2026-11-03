import { getConfig } from "@/lib/kv";
import { getBookingById, sendBookingMessage } from "@/lib/lodgify";
import { accessWindowOverrideFor } from "@/lib/jervis";
import {
  findLodgifyThreadGuid,
  lodgifyRouteRequiredForContext,
  verifyLodgifyMessageDelivery,
} from "@/lib/lodgify-message-delivery";
import {
  getAccessCodeRelease,
  markAccessCodeReleaseBlocked,
  markAccessCodeReleaseFailed,
  markAccessCodeReleaseSent,
  resolveAccessCodeForBooking,
} from "@/lib/access-code-releases";
import {
  extractLocalFormContact,
  findLocalFormSubmissionForBooking,
  localFormSlugCandidates,
} from "@/lib/local-forms";

const COMPANY_DISPLAY_NAME = "Zenfulcove Glamping";
const CANONICAL_APP_BASE_URL = "https://stay.zenfulcove.com";
const DEFAULT_PROPERTY_DISPLAY_NAME = `your ${COMPANY_DISPLAY_NAME} stay`;
const DEFAULT_GOOGLE_MAPS_ADDRESS = "103 potato smith rd, unit c, elgin texas 78621";
const DEFAULT_GOOGLE_MAPS_URL = "https://maps.app.goo.gl/QowaHLFH3anBavuv6?g_st=ic";
const KNOWN_LODGIFY_PROPERTY_NAMES = {
  608952: "Fairy House",
  608953: "Desert Rose",
  608954: "Sky Castle",
  608955: "Bird House",
  754651: "Doodle House",
};

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return "";
}

function statusText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return firstNonEmpty([
      value.name,
      value.label,
      value.value,
      value.status,
      value.statusName,
      value.status_name,
      value.text,
    ]);
  }
  return clean(value);
}

export function lodgifyBookingStatus(booking = {}, fallback = {}) {
  return firstNonEmpty([
    statusText(booking.status),
    statusText(booking.booking_status),
    statusText(booking.bookingStatus),
    statusText(booking.bookingState),
    statusText(booking.reservationStatus),
    statusText(booking.reservation_status),
    statusText(booking.reservation_state),
    statusText(booking.state),
    statusText(booking.stateName),
    statusText(booking.reservation?.status),
    statusText(booking.reservation?.state),
    statusText(fallback.bookingStatus),
    statusText(fallback.status),
  ]);
}

export function isBookedLodgifyStatus(status) {
  const normalized = clean(status).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return false;
  return (
    normalized.includes("booked") ||
    normalized.includes("confirmed") ||
    normalized === "reserved"
  );
}

export function ineligibleBookingStatusMessage(bookingId, status, sourceLabel = "") {
  const label = clean(status) || "unknown";
  const source = clean(sourceLabel);
  return `Skipped booking ${bookingId}: Lodgify status is "${label}" (only Booked/Confirmed/Reserved reservations are eligible)${source ? ` | source: ${source}` : ""}`;
}

function lodgifyPropertyId(booking = {}, fallback = {}) {
  return clean(
    booking.property_id ??
      booking.propertyId ??
      booking.property?.id ??
      booking.property?.uid ??
      booking.rental?.id ??
      booking.listing?.id ??
      fallback.propertyId
  );
}

export function lodgifyPropertyName(booking = {}, fallback = {}) {
  const propertyId = lodgifyPropertyId(booking, fallback);
  return firstNonEmpty([
    booking.property_name,
    booking.propertyName,
    booking.property?.name,
    booking.property?.title,
    booking.property?.internal_name,
    booking.rental?.name,
    booking.rental?.title,
    booking.listing?.name,
    booking.listing?.title,
    booking.unit?.name,
    booking.room_type?.name,
    KNOWN_LODGIFY_PROPERTY_NAMES[propertyId],
    fallback.propertyName,
  ]);
}

const LODGIFY_SOURCE_LABELS = {
  AirbnbIntegration: "Airbnb",
  BookingCom: "Booking.com",
  Expedia: "Expedia",
  HomeAway: "Vrbo",
  Manual: "Manual",
  OH: "Direct",
  PublicApi: "Public API",
};
const DEFAULT_LODGIFY_PLAIN_TEXT_SOURCES = ["BookingCom"];
const DEFAULT_LODGIFY_MASKED_LINK_SOURCES = [];
const DEFAULT_LODGIFY_EMAIL_FALLBACK_SOURCES = ["GlampingHub", "Glamping Hub"];
const MASKED_URL_NOTE =
  "If the address above is not clickable, type it into your browser and replace [.] with a period.";

function sourceValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return firstNonEmpty([
      value.name,
      value.label,
      value.value,
      value.source,
      value.channel,
      value.text,
    ]);
  }
  return clean(value);
}

function sourceLabelFor(source, sourceText) {
  const normalizedSource = clean(source);
  const normalizedSourceText = clean(sourceText);
  if (normalizedSource === "PublicApi" && normalizedSourceText) {
    return normalizedSourceText;
  }
  if (normalizedSource === "OH" && normalizedSourceText) {
    return normalizedSourceText;
  }
  return firstNonEmpty([
    LODGIFY_SOURCE_LABELS[normalizedSource],
    normalizedSourceText,
    normalizedSource,
  ]);
}

export function lodgifyBookingSource(booking = {}, fallback = {}) {
  const source = firstNonEmpty([
    sourceValue(booking.source),
    sourceValue(booking.source_name),
    sourceValue(booking.sourceName),
    sourceValue(booking.booking_source),
    sourceValue(booking.bookingSource),
    sourceValue(booking.channel),
    sourceValue(booking.channel_name),
    sourceValue(booking.channelName),
    sourceValue(booking.external_source),
    sourceValue(booking.externalSource),
    sourceValue(fallback.bookingSource),
    sourceValue(fallback.source),
  ]);
  const sourceText = firstNonEmpty([
    sourceValue(booking.source_text),
    sourceValue(booking.sourceText),
    sourceValue(booking.channel_text),
    sourceValue(booking.channelText),
    sourceValue(fallback.bookingSourceText),
    sourceValue(fallback.sourceText),
  ]);
  return {
    source,
    sourceText,
    label: sourceLabelFor(source, sourceText),
  };
}

function splitName(fullName) {
  const parts = clean(fullName).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function todayCentral() {
  return centralDateFor(new Date());
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

function centralDateFor(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function toDateOnly(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? "" : parsed.toISOString().split("T")[0];
}

function publicAppBaseUrl() {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_DASHBOARD_URL ||
    process.env.APP_URL;

  if (configured) return clean(configured).replace(/\/+$/, "");
  if (process.env.VERCEL_ENV === "production") return CANONICAL_APP_BASE_URL;
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, "");
  }
  return CANONICAL_APP_BASE_URL;
}

export function localFormUrl(slug) {
  try {
    return new URL(`/forms/${slug}`, publicAppBaseUrl()).toString();
  } catch {
    return `${CANONICAL_APP_BASE_URL}/forms/${slug}`;
  }
}

export function jotformFormUrl(formId) {
  const normalized = clean(formId);
  if (!normalized) return "";
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `https://form.jotform.com/${normalized}`;
}

function normalizeLocalFormSlug(value) {
  return clean(value).replace(/^\/?forms\//, "");
}

export function waiverReminderFormSource(waiverConfig = {}) {
  const source = clean(
    waiverConfig.formSource ||
      waiverConfig.formMode ||
      waiverConfig.formType ||
      waiverConfig.source
  ).toLowerCase();

  if (["internal", "local", "local-form", "local_form"].includes(source)) {
    return "internal";
  }

  return "jotform";
}

function waiverJotformFormId(automationConfig = {}, reminder = {}) {
  const releaseConfig = automationConfig.accessCodeRelease || {};
  const waiverConfig = automationConfig.waiverReminders || {};
  return firstNonEmpty([
    releaseConfig.jotformFormId,
    waiverConfig.jotformFormId,
    reminder.jotformFormId,
    waiverConfig.emails?.[0]?.jotformFormId,
    waiverConfig.reminders?.[0]?.jotformFormId,
  ]);
}

function selectedWaiverFormUrl(automationConfig = {}, accessConfig = {}) {
  const waiverConfig = automationConfig.waiverReminders || {};
  if (waiverReminderFormSource(waiverConfig) === "internal") {
    const slug = normalizeLocalFormSlug(
      accessConfig.localFormSlug ||
        waiverConfig.localFormSlug ||
        waiverConfig.formSlug ||
        "welcome-to-zenfulcove"
    );
    return localFormUrl(slug || "welcome-to-zenfulcove");
  }

  return (
    jotformFormUrl(waiverJotformFormId(automationConfig)) ||
    localFormUrl("welcome-to-zenfulcove")
  );
}

function payloadValue(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && clean(value)) return value;
  }
  return "";
}

function payloadRange(payload) {
  const direct = payloadValue(payload, [
    "stayDates",
    "dateRange",
    "dates",
    "reservationDates",
    "reservation_dates",
  ]);
  if (direct && typeof direct === "object") return direct;

  for (const value of Object.values(payload || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if ("checkIn" in value || "checkOut" in value) return value;
    if ("check_in" in value || "check_out" in value) return value;
    if ("arrival" in value || "departure" in value) return value;
  }

  return {};
}

export function extractStayDetailsFromPayload(payload = {}) {
  const range = payloadRange(payload);
  return {
    bookingId: firstNonEmpty([
      payloadValue(payload, [
        "bookingCode",
        "booking_code",
        "bookingConfirmationId",
        "booking_confirmation_id",
        "confirmationId",
        "confirmation_id",
        "reservationId",
        "reservation_id",
      ]),
    ]),
    propertyName: firstNonEmpty([
      payloadValue(payload, [
        "stayUnit",
        "unit",
        "unitName",
        "propertyName",
        "property_name",
        "rental",
        "rentalName",
      ]),
    ]),
    checkinDate: toDateOnly(
      firstNonEmpty([
        range.checkIn,
        range.check_in,
        range.arrival,
        payloadValue(payload, [
          "checkIn",
          "check_in",
          "checkinDate",
          "checkin_date",
          "arrival",
          "arrivalDate",
        ]),
      ])
    ),
    checkoutDate: toDateOnly(
      firstNonEmpty([
        range.checkOut,
        range.check_out,
        range.departure,
        payloadValue(payload, [
          "checkOut",
          "check_out",
          "checkoutDate",
          "checkout_date",
          "departure",
          "departureDate",
        ]),
      ])
    ),
  };
}

function bookingContact(booking = {}, fallback = {}) {
  const guest = booking.guest || {};
  const customer = booking.customer || {};
  const traveler = booking.traveler || {};
  const fallbackContact = fallback.contact || {};
  const primaryPhoneObject = guest.phone || customer.phone || traveler.phone || {};
  const fullName = firstNonEmpty([
    guest.name,
    booking.guestName,
    customer.name,
    traveler.name,
    fallbackContact.fullName,
    `${fallbackContact.firstName || ""} ${fallbackContact.lastName || ""}`,
    `${guest.firstName || guest.first_name || ""} ${guest.lastName || guest.last_name || ""}`,
    `${customer.firstName || customer.first_name || ""} ${customer.lastName || customer.last_name || ""}`,
  ]);
  const derived = splitName(fullName);

  return {
    email: normalizeEmail(
      firstNonEmpty([
        guest.email,
        guest.email_address,
        guest.emailAddress,
        customer.email,
        customer.email_address,
        customer.emailAddress,
        traveler.email,
        traveler.email_address,
        traveler.emailAddress,
        booking.guestEmail,
        booking.guest_email,
        booking.email,
        booking.customerEmail,
        booking.customer_email,
        booking.travelerEmail,
        booking.traveler_email,
        fallbackContact.email,
        fallbackContact.email_address,
        fallbackContact.emailAddress,
      ])
    ),
    firstName: firstNonEmpty([
      guest.firstName,
      guest.first_name,
      customer.firstName,
      customer.first_name,
      traveler.firstName,
      traveler.first_name,
      fallbackContact.firstName,
      derived.firstName,
    ]),
    lastName: firstNonEmpty([
      guest.lastName,
      guest.last_name,
      customer.lastName,
      customer.last_name,
      traveler.lastName,
      traveler.last_name,
      fallbackContact.lastName,
      derived.lastName,
    ]),
    phone: firstNonEmpty([
      typeof primaryPhoneObject === "string" ? primaryPhoneObject : "",
      primaryPhoneObject.fullNumber,
      primaryPhoneObject.phone,
      primaryPhoneObject.number,
      primaryPhoneObject.e164Phone,
      guest.phoneNumber,
      guest.mobilePhone,
      customer.phoneNumber,
      customer.mobilePhone,
      traveler.phoneNumber,
      traveler.mobilePhone,
      booking.phone,
      booking.phoneNumber,
      booking.guestPhone,
      fallbackContact.phone,
    ]),
    fullName: fullName || "Guest",
  };
}

function bookingContext(booking = {}, fallback = {}) {
  const stayDetails = fallback.stayDetails || {};
  const contact = bookingContact(booking, fallback);
  const source = lodgifyBookingSource(booking, fallback);
  const bookingId = clean(
    booking.id ||
      booking.bookingId ||
      booking.reservationId ||
      booking.reservation_id ||
      stayDetails.bookingId ||
      fallback.bookingId
  );

  return {
    bookingId,
    propertyId: lodgifyPropertyId(booking, fallback),
    propertyName: firstNonEmpty([
      lodgifyPropertyName(booking, fallback),
      stayDetails.propertyName,
    ]),
    guestEmail: contact.email,
    guestFirstName: contact.firstName || "Guest",
    guestLastName: contact.lastName,
    guestName: contact.fullName || "Guest",
    guestPhone: contact.phone,
    bookingStatus: lodgifyBookingStatus(booking, fallback),
    bookingSource: source.source,
    bookingSourceText: source.sourceText,
    bookingChannel: source.label,
    checkinDate: toDateOnly(
      firstNonEmpty([
        booking.arrival,
        booking.start_date,
        booking.checkIn,
        booking.checkin_date,
        stayDetails.checkinDate,
        fallback.checkinDate,
      ])
    ),
    checkoutDate: toDateOnly(
      firstNonEmpty([
        booking.departure,
        booking.end_date,
        booking.checkOut,
        booking.checkout_date,
        stayDetails.checkoutDate,
        fallback.checkoutDate,
      ])
    ),
  };
}

function normalizeLookupKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES = ["Doodle House", "Desert Rose"];

function configuredObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function parseJsonObject(value) {
  const raw = clean(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return configuredObject(parsed);
  } catch {
    return {};
  }
}

function propertyMessageDataFor(context, config = {}) {
  const map = {
    ...configuredObject(config.propertyMessageData),
    ...parseJsonObject(config.propertyMessageJson),
  };
  const candidates = [
    context.propertyId,
    context.propertyName,
    normalizeLookupKey(context.propertyId),
    normalizeLookupKey(context.propertyName),
  ].filter(Boolean);

  for (const key of candidates) {
    if (map[key] && typeof map[key] === "object") return map[key];
  }

  for (const [key, value] of Object.entries(map)) {
    const normalizedKey = normalizeLookupKey(key);
    if (
      candidates.some(
        (candidate) =>
          candidate === normalizedKey ||
          candidate.includes(normalizedKey) ||
          normalizedKey.includes(candidate)
      ) &&
      typeof value === "object"
    ) {
      return value;
    }
  }

  return {};
}

function configuredList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const raw = clean(value);
  if (!raw) return fallback;
  return raw.split(",").map(clean).filter(Boolean);
}

function delayedAccessPropertyNames(config = {}) {
  return configuredList(
    config.delayedAccessCodePropertyNames,
    DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES
  );
}

function propertyUsesDelayedAccess(context, config = {}, propertyData = {}) {
  if (propertyData.delayAccessCodeUntilCheckinDay === true) return true;
  if (propertyData.delayAccessCodeUntilCheckinDay === false) return false;

  const propertyIds = configuredList(config.delayedAccessCodePropertyIds);
  if (propertyIds.includes(clean(context.propertyId))) return true;

  const delayedNames = delayedAccessPropertyNames(config).map(normalizeLookupKey);
  const candidates = [
    context.propertyName,
    propertyData.displayName,
    propertyData.propertyDisplayName,
    propertyData.directionsName,
  ]
    .map(normalizeLookupKey)
    .filter(Boolean);

  return candidates.some((candidate) =>
    delayedNames.some(
      (delayed) =>
        candidate === delayed ||
        candidate.includes(delayed) ||
        delayed.includes(candidate)
    )
  );
}

export function isDelayedAccessCodeBooking({
  booking,
  automationConfig,
  fallback = {},
}) {
  const config = releaseConfig(automationConfig);
  const context = bookingContext(booking, fallback);
  const propertyData = {
    ...templateDefaults(config),
    ...propertyMessageDataFor(context, config),
  };
  return propertyUsesDelayedAccess(context, config, propertyData);
}

function templateDefaults(config = {}) {
  return {
    siteName: COMPANY_DISPLAY_NAME,
    address: DEFAULT_GOOGLE_MAPS_ADDRESS,
    googleMapsAddress: DEFAULT_GOOGLE_MAPS_ADDRESS,
    googleMapsUrl: DEFAULT_GOOGLE_MAPS_URL,
    checkinTime: "3:00 p.m.",
    checkoutTime: "11:00 a.m.",
    hostName: "Norma",
    urgentPhone: "512-273-7962",
    kayakRentalSingleRate: "$50/day",
    kayakRentalTandemRate: "$65/day",
    kayakRentalFormText: "Kayak Rental Inquiry Form",
    ...configuredObject(config.templateDefaults),
  };
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function messageText(data, includeAccessCode) {
  const accessLine = includeAccessCode
    ? `Access Code: ${data.KeyCode || ""}`
    : `Reservation Form: ${data.reservationFormUrl}`;
  const codeNote = includeAccessCode
    ? "If the code was not provided in the message or if there is a \"-\" where the code should be, please wait a few minutes and the code should be sent shortly.\n\n(Please note that the code will only work during your reservation time.)"
    : "Access codes are only released once the form is submitted.";

  return [
    `Greetings ${data.GuestFirstName},`,
    "",
    `We are excited to welcome you to the ${data.propertyDisplayName} at ${data.siteName}.`,
    "To help you get started, we have provided some important information below:",
    "",
    "Please remember to complete the Reservation Form with our Terms & Conditions before check-in.",
    "",
    "If you have already done so, you are all set. Access codes are only activated once the form is submitted.",
    "",
    "Your booking details:",
    "",
    `You can check in any time after ${data.checkinTime}.`,
    "",
    `Check-out time is ${data.checkoutTime}.`,
    "",
    `Check-in Date: ${data.Arrival}`,
    "",
    `Check-out Date: ${data.Departure}`,
    "",
    "Directions to the property:",
    "",
    data.address,
    data.googleMapsUrl ? `Google Maps: ${data.googleMapsUrl}` : null,
    "",
    data.unitDirections,
    "",
    data.parkingInstructions,
    "",
    `${data.propertyDisplayName} Wifi Access:`,
    "",
    `Wifi: ${data.wifiName}`,
    "",
    `Password: ${data.wifiPassword}`,
    "",
    accessLine,
    "",
    codeNote,
    "",
    "Kayaks:",
    "",
    data.dedicatedKayakText,
    "",
    data.additionalKayakText,
    "",
    data.lifeJacketText,
    "",
    data.amenitiesText,
    "",
    data.additionalRulesText,
    "",
    "Best,",
    data.hostName,
    data.siteName,
    "",
    `For urgent matters, you can text or call ${data.urgentPhone}`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

function sanitizeMessageHtml(value) {
  const safeTags = new Set([
    "a",
    "br",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "strong",
    "b",
    "u",
    "ul",
  ]);
  return String(value || "").replace(
    /<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (tag, rawName, rawAttrs = "") => {
      const name = rawName.toLowerCase();
      if (!safeTags.has(name)) return escapeHtml(tag);
      if (tag.startsWith("</")) return `</${name}>`;
      if (name === "br") return "<br>";
      if (name !== "a") return `<${name}>`;

      const hrefMatch = rawAttrs.match(/\shref=(["'])(.*?)\1/i);
      const href = hrefMatch?.[2]?.trim() || "";
      const isSafeHref = /^(https?:|mailto:|tel:|\/)/i.test(href);
      return isSafeHref
        ? `<a href="${escapeHtml(href)}" style="text-decoration: underline;">`
        : "<a>";
    }
  );
}

function preserveMessageBreaks(html) {
  return String(html || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(<(?:ul|ol)>)[ \t]*\n+/gi, "$1")
    .replace(/\n+[ \t]*(<li>)/gi, "$1")
    .replace(/(<\/li>)[ \t]*\n+/gi, "$1")
    .replace(/\n+[ \t]*(<\/(?:ul|ol)>)/gi, "$1")
    .replace(/\n/g, "<br>");
}

function linkifyEscapedUrls(value) {
  return String(value || "").replace(/\bhttps?:\/\/[^\s<]+/g, (match) => {
    const trailingMatch = match.match(/[),.!?:;]+$/);
    const trailing = trailingMatch?.[0] || "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `<a href="${url}" style="text-decoration: underline;">${url}</a>${trailing}`;
  });
}

function decodeMessageEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function textFromAnchor(label, href) {
  const text = messageToPlainText(label);
  const url = decodeMessageEntities(clean(href));
  if (!url) return text;
  if (!text || text === url) return url;
  return `${text}: ${url}`;
}

function messageToPlainText(text, { trim = true } = {}) {
  const raw = trim ? clean(text) : String(text || "");
  if (!raw.trim()) return "";
  return decodeMessageEntities(
    raw
      .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (tag, attrs = "", label = "") => {
        const hrefMatch = attrs.match(/\shref=(["'])(.*?)\1/i);
        return textFromAnchor(label, hrefMatch?.[2] || "");
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|h[1-6])>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n")
      .replace(/<\/?[^>]+>/g, "")
  )
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageToLodgifyHtml(text, { trim = true } = {}) {
  const raw = trim ? clean(text) : String(text || "");
  if (!raw.trim()) return "";
  const hasHtml = /<\/?(a|br|em|i|li|ol|p|strong|b|u|ul)\b/i.test(raw);
  const safe = hasHtml
    ? sanitizeMessageHtml(raw)
    : linkifyEscapedUrls(escapeHtml(raw));
  return preserveMessageBreaks(safe);
}

function withLodgifyPrefix(prefix, messageHtml) {
  return `${messageToLodgifyHtml(prefix, { trim: false })}${messageHtml || ""}`;
}

function normalizeChannelKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function contextChannelKeys(context = {}) {
  return [
    context.bookingSource,
    context.bookingChannel,
    context.bookingSourceText,
  ]
    .map(normalizeChannelKey)
    .filter(Boolean);
}

function configuredChannelKeys(value, fallback = []) {
  const values = Array.isArray(value)
    ? value
    : clean(value)
      ? clean(value).split(",")
      : fallback;
  return values.map(normalizeChannelKey).filter(Boolean);
}

function channelMatches(context, channelKeys = []) {
  const targets = new Set(channelKeys);
  if (targets.size === 0) return false;
  return contextChannelKeys(context).some((key) => targets.has(key));
}

function extractMessageUrls(text) {
  const seen = new Set();
  const urls = [];
  String(text || "").replace(/\bhttps?:\/\/[^\s<>"']+/gi, (match) => {
    const url = match.replace(/[),.!?:;]+$/g, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    return match;
  });
  return urls;
}

function displayAddressForUrl(rawUrl) {
  const value = clean(rawUrl);
  try {
    const url = new URL(value);
    const host = url.hostname.split(".").join("[.]");
    return `${host}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/\./g, "[.]");
  }
}

function maskPlainTextUrls(text) {
  let maskedAny = false;
  const masked = String(text || "").replace(/\bhttps?:\/\/[^\s<>"']+/gi, (match) => {
    const trailingMatch = match.match(/[),.!?:;]+$/);
    const trailing = trailingMatch?.[0] || "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    maskedAny = true;
    return `${displayAddressForUrl(url)}${trailing}`;
  });

  if (!maskedAny) return { text: masked, masked: false };
  if (masked.toLowerCase().includes("replace [.] with a period")) {
    return { text: masked, masked: true };
  }
  return {
    text: `${masked}\n\n${MASKED_URL_NOTE}`,
    masked: true,
  };
}

function messageUrlHosts(urls = []) {
  return urls
    .map((url) => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })
    .filter((host, index, hosts) => host && hosts.indexOf(host) === index);
}

function preparedMessageDetails(message, format, { linkSource = message, linksMasked = false } = {}) {
  const urls = extractMessageUrls(linkSource);
  const hosts = messageUrlHosts(urls);
  return {
    messageFormat: format,
    messageChars: message.length,
    ...(hosts.length ? { messageLinkHosts: hosts } : {}),
    ...(linksMasked ? { messageLinksMasked: true } : {}),
  };
}

function lodgifyMessageFormatting(context, config = {}) {
  const plainTextKeys = configuredChannelKeys(
    config.lodgifyPlainTextSources,
    DEFAULT_LODGIFY_PLAIN_TEXT_SOURCES
  );
  const maskedLinkKeys = configuredChannelKeys(
    config.lodgifyMaskedLinkSources,
    DEFAULT_LODGIFY_MASKED_LINK_SOURCES
  );
  const maskLinks = channelMatches(context, maskedLinkKeys);
  return {
    maskLinks,
    plainText: maskLinks || channelMatches(context, plainTextKeys),
  };
}

function shouldUseEmailFallback(context, config = {}) {
  const fallbackKeys = configuredChannelKeys(
    config.lodgifyEmailFallbackSources,
    DEFAULT_LODGIFY_EMAIL_FALLBACK_SOURCES
  );
  return channelMatches(context, fallbackKeys);
}

function emailFallbackMessage(context, messageName) {
  const channel = context.bookingChannel || "this booking channel";
  return `${channel} does not expose a Lodgify message thread for ${messageName}; using guest email fallback`;
}

function missingEmailFallbackResult(context, messageName, details = {}) {
  const channel = context.bookingChannel || "this booking channel";
  return result(
    "failed",
    `Cannot send ${messageName} for booking ${context.bookingId}: ${channel} does not receive Lodgify messages and no guest email is available`,
    {
      bookingId: context.bookingId,
      deliveryChannel: "sendgrid",
      deliveryFallback: "lodgify-channel-email",
      ...details,
      ...bookingSourceDetails(context),
    }
  );
}

function configuredLocalFormSlug(automationConfig = {}, config = {}) {
  const waiverConfig = automationConfig.waiverReminders || {};
  return clean(
    config.localFormSlug || waiverConfig.localFormSlug || waiverConfig.formSlug || ""
  ).replace(/^\/?forms\//, "");
}

async function contextWithFormFallbackEmail(context, automationConfig, config = {}) {
  if (context.guestEmail || !context.bookingId) {
    return { context, details: {} };
  }

  const formSlug = configuredLocalFormSlug(automationConfig, config);
  if (!formSlug) {
    return {
      context,
      details: { emailFallbackLookup: "missing-local-form-slug" },
    };
  }

  try {
    const submission = await findLocalFormSubmissionForBooking({
      formSlug,
      bookingId: context.bookingId,
    });
    if (!submission) {
      return {
        context,
        details: { emailFallbackLookup: "local-form-not-found" },
      };
    }

    const formContact = extractLocalFormContact(submission);
    if (!formContact.email) {
      return {
        context,
        details: { emailFallbackLookup: "local-form-email-missing" },
      };
    }

    const fallbackName = [formContact.firstName, formContact.lastName]
      .filter(Boolean)
      .join(" ");
    return {
      context: {
        ...context,
        guestEmail: formContact.email,
        guestFirstName:
          context.guestFirstName && context.guestFirstName !== "Guest"
            ? context.guestFirstName
            : formContact.firstName || context.guestFirstName,
        guestLastName: context.guestLastName || formContact.lastName,
        guestName:
          context.guestName && context.guestName !== "Guest"
            ? context.guestName
            : fallbackName || context.guestName,
        guestPhone: context.guestPhone || formContact.phone,
      },
      details: {
        emailFallbackLookup: "local-form",
        emailFallbackFormSlug: formSlug,
      },
    };
  } catch (err) {
    return {
      context,
      details: {
        emailFallbackLookup: "local-form-error",
        emailFallbackError: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function sendEmailFallbackMessage({
  context,
  automationConfig,
  subject,
  text,
  messageName,
}) {
  if (!context.guestEmail) {
    throw new Error(
      `${context.bookingChannel || "This booking channel"} requires email fallback, but the booking has no guest email.`
    );
  }

  const { sendPlainEmail } = await import("@/lib/sendgrid");
  await sendPlainEmail({
    to: context.guestEmail,
    subject,
    text: messageToPlainText(text),
    from: {
      email: automationConfig.sendgrid?.fromEmail,
      name: automationConfig.sendgrid?.fromName,
    },
  });

  return emailFallbackMessage(context, messageName);
}

async function sendEmailFallbackForContext({
  context,
  automationConfig,
  config,
  subject,
  text,
  messageName,
}) {
  const fallback = await contextWithFormFallbackEmail(
    context,
    automationConfig,
    config
  );
  await sendEmailFallbackMessage({
    context: fallback.context,
    automationConfig,
    subject,
    text,
    messageName,
  });
  return fallback;
}

function compactDeliveryDetails(details = {}) {
  return Object.fromEntries(
    Object.entries(details).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
  );
}

async function sendGuestMessageWithVerifiedDelivery({
  context,
  booking,
  automationConfig,
  subject,
  preparedMessage,
  emailText,
  messageName,
  config = {},
}) {
  const useEmailFallback = shouldUseEmailFallback(context, config);
  const threadGuid = findLodgifyThreadGuid(booking);
  // Channels in lodgifyEmailFallbackSources (e.g. Glamping Hub) do not reliably
  // deliver Lodgify thread messages to the guest — the relayed link is often
  // unusable — so they are delivered by a single guest email. Do NOT also post
  // to the Lodgify thread: doing so both double-sends and, if a later step
  // throws, leaves the release unmarked so the access-code-retry cron re-posts
  // it every run (the "Glamping Hub spam" the guests reported).
  if (useEmailFallback) {
    const fallback = await sendEmailFallbackForContext({
      context,
      automationConfig,
      config,
      subject,
      text: emailText,
      messageName,
    });
    return {
      deliveryChannel: "sendgrid",
      deliveryFallback: "lodgify-channel-email",
      details: fallback.details,
    };
  }

  const sentAt = Date.now();
  try {
    await sendBookingMessage(context.bookingId, {
      subject,
      message: preparedMessage.message,
      type: config.lodgifyMessageType || "Owner",
      sendNotification: config.lodgifySendNotification !== false,
    });
  } catch (err) {
    const fallback = await contextWithFormFallbackEmail(
      context,
      automationConfig,
      config
    );
    if (!fallback.context.guestEmail) {
      if (!useEmailFallback) throw err;
      throw new Error(
        `${context.bookingChannel || "This booking channel"} requires email fallback, but the booking has no guest email.`
      );
    }

    await sendEmailFallbackMessage({
      context: fallback.context,
      automationConfig,
      subject,
      text: emailText,
      messageName,
    });
    return {
      deliveryChannel: "sendgrid",
      deliveryFallback: "lodgify-post-failed-email",
      details: {
        ...fallback.details,
        lodgifyThreadGuidPresent: Boolean(threadGuid),
        lodgifyPosted: false,
        lodgifyFallbackReason: "lodgify-post-failed",
        lodgifyPostError: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // The Lodgify post above already succeeded. Verification is a follow-up read
  // (a Lodgify getMessageThread call) that can fail transiently. It must not be
  // allowed to throw: if it did, sendAccessCodeForBooking would mark the release
  // failed with sent_at NULL even though the guest already got the message, and
  // the access-code-retry cron (runs every ~10 min) would re-post it every run.
  // On a verification error, treat the post as delivered for channels that do
  // not require channel routing, and fall back to email for route-required
  // channels (Airbnb / Booking.com) exactly as an unverified post would.
  let verification;
  try {
    verification = await verifyLodgifyMessageDelivery({
      booking,
      context,
      subject,
      message: preparedMessage.message,
      sentAt,
      config,
    });
  } catch (verifyErr) {
    const routeRequired = lodgifyRouteRequiredForContext(context, config);
    verification = {
      lodgifyDeliveryChecked: false,
      lodgifyRouteRequired: routeRequired,
      lodgifyThreadGuidPresent: Boolean(threadGuid),
      channelRouted: !routeRequired,
      lodgifyDeliveryIssue: routeRequired ? "verification-error" : "",
      lodgifyVerificationError:
        verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
    };
  }
  const details = compactDeliveryDetails(verification);
  const routeFallbackNeeded =
    verification.lodgifyRouteRequired && !verification.channelRouted;

  // Route-required channels (Airbnb / Booking.com): Lodgify accepted the post
  // but it did not route to the guest channel, so deliver a guest email backup.
  if (routeFallbackNeeded) {
    const expectedRoute =
      verification.lodgifyExpectedRoute || context.bookingChannel || "guest channel";
    const fallback = await contextWithFormFallbackEmail(
      context,
      automationConfig,
      config
    );
    if (!fallback.context.guestEmail) {
      throw new Error(
        `Lodgify accepted ${messageName}, but it did not route to ${expectedRoute} and no guest email fallback is available.`
      );
    }

    await sendEmailFallbackMessage({
      context: fallback.context,
      automationConfig,
      subject,
      text: emailText,
      messageName,
    });

    return {
      deliveryChannel: "sendgrid",
      deliveryFallback: "lodgify-unrouted-email",
      details: {
        ...details,
        ...fallback.details,
        lodgifyPosted: true,
        lodgifyFallbackReason:
          verification.lodgifyDeliveryIssue || "missing-channel-route",
      },
    };
  }

  return {
    deliveryChannel: "lodgify",
    deliveryFallback: "",
    details,
  };
}

async function alreadySubmittedInternalFormResult({
  bookingId,
  formSlug,
  decision,
  messageName,
  context,
}) {
  if (!bookingId || !formSlug) return null;

  let submission = null;
  try {
    submission = await findLocalFormSubmissionForBooking({
      formSlug,
      bookingId,
    });
  } catch (err) {
    return result(
      "failed",
      `Failed to verify internal form before ${messageName} for booking ${bookingId}: ${err.message}`,
      {
        bookingId,
        decision,
        formSlug,
        ...bookingSourceDetails(context),
      }
    );
  }

  if (!submission) return null;

  return result(
    "skipped",
    `Skipped booking ${bookingId}: internal form already submitted; no ${messageName} sent`,
    {
      bookingId,
      decision,
      formSlug,
      formSubmissionId: submission.id,
      formSubmittedAt: submission.submitted_at,
      ...bookingSourceDetails(context),
    }
  );
}

function deliveryLogDetails(delivery = {}) {
  return {
    deliveryChannel: delivery.deliveryChannel || "lodgify",
    ...(delivery.deliveryFallback
      ? { deliveryFallback: delivery.deliveryFallback }
      : {}),
    ...compactDeliveryDetails(delivery.details),
  };
}

function deliveredAction(delivery, { lodgify, email, unrouted }) {
  if (delivery?.deliveryFallback === "lodgify-unrouted-email") {
    return unrouted;
  }
  if (delivery?.deliveryFallback === "lodgify-post-failed-email") {
    return `${email} after Lodgify post failed`;
  }
  if (delivery?.deliveryChannel === "sendgrid") {
    return email;
  }
  return lodgify;
}

function lodgifyMessageForContext(
  context,
  { prefix = "", text = "", html = "", config = {} } = {}
) {
  const formatting = lodgifyMessageFormatting(context, config);

  if (formatting.plainText) {
    const plain = messageToPlainText(`${prefix || ""}${text || ""}`);
    const masked = formatting.maskLinks
      ? maskPlainTextUrls(plain)
      : { text: plain, masked: false };
    return {
      message: masked.text,
      details: preparedMessageDetails(
        masked.text,
        masked.masked ? "plain-text-masked-links" : "plain-text",
        { linkSource: plain, linksMasked: masked.masked }
      ),
    };
  }

  const message = withLodgifyPrefix(prefix, html || messageToLodgifyHtml(text));
  return {
    message,
    details: preparedMessageDetails(message, "lodgify-html"),
  };
}

function renderMessageTemplate(template, data = {}) {
  const raw = String(template || "");
  if (!raw.trim()) return "";

  return raw.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const direct = data[key];
    if (direct !== undefined && direct !== null) return String(direct);

    const normalizedKey = clean(key).toLowerCase();
    const match = Object.entries(data).find(
      ([dataKey]) => clean(dataKey).toLowerCase() === normalizedKey
    );
    const value = match?.[1];
    return value === undefined || value === null ? "" : String(value);
  });
}

function defaultSubject(data, includeAccessCode) {
  return includeAccessCode
    ? `Access Code for ${data.propertyDisplayName || data.propertyName || COMPANY_DISPLAY_NAME}`
    : `Reservation form needed for ${data.propertyDisplayName || data.propertyName || COMPANY_DISPLAY_NAME}`;
}

function defaultMessageSubject(data, messageKind, includeAccessCode) {
  if (messageKind === "checkin-info") {
    return `Check-in information for ${data.propertyDisplayName || data.propertyName || COMPANY_DISPLAY_NAME}`;
  }
  if (messageKind === "code-only") {
    return `Access code for ${data.propertyDisplayName || data.propertyName || COMPANY_DISPLAY_NAME}`;
  }
  return defaultSubject(data, includeAccessCode);
}

function bookingSourceDetails(context = {}) {
  return {
    ...(context.bookingChannel ? { bookingChannel: context.bookingChannel } : {}),
    ...(context.bookingSource ? { bookingSource: context.bookingSource } : {}),
    ...(context.bookingSourceText ? { bookingSourceText: context.bookingSourceText } : {}),
  };
}

function bookingSourceSuffix(context = {}) {
  return context.bookingChannel ? ` | source: ${context.bookingChannel}` : "";
}

function codeOnlyMessageText(data) {
  return [
    `Greetings ${data.GuestFirstName},`,
    "",
    `Your access code for ${data.propertyDisplayName || data.propertyName || "your stay"} is ready.`,
    "",
    `Access Code: ${data.KeyCode || ""}`,
    "",
    "(Please note that the code will only work during your reservation time.)",
  ].join("\n");
}

function checkinInfoMessageText(data) {
  return [
    `Greetings ${data.GuestFirstName},`,
    "",
    `We are excited to welcome you to the ${data.propertyDisplayName} at ${data.siteName}.`,
    "To help you get started, we have provided some important information below:",
    "",
    "Your booking details:",
    "",
    `You can check in any time after ${data.checkinTime}.`,
    "",
    `Check-out time is ${data.checkoutTime}.`,
    "",
    `Check-in Date: ${data.Arrival}`,
    "",
    `Check-out Date: ${data.Departure}`,
    "",
    "Directions to the property:",
    "",
    data.address,
    data.googleMapsUrl ? `Google Maps: ${data.googleMapsUrl}` : null,
    "",
    data.unitDirections,
    "",
    data.parkingInstructions,
    "",
    `${data.propertyDisplayName} Wifi Access:`,
    "",
    `Wifi: ${data.wifiName}`,
    "",
    `Password: ${data.wifiPassword}`,
    "",
    "Your access code will be sent on the morning of check-in.",
    "",
    "Kayaks:",
    "",
    data.dedicatedKayakText,
    "",
    data.additionalKayakText,
    "",
    data.lifeJacketText,
    "",
    data.amenitiesText,
    "",
    data.additionalRulesText,
    "",
    "Best,",
    data.hostName,
    data.siteName,
    "",
    `For urgent matters, you can text or call ${data.urgentPhone}`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

function defaultWaiverReminderSubject(data, reminder = {}) {
  return (
    renderMessageTemplate(reminder.subjectTemplate || reminder.subject || "", data) ||
    `Reservation form needed for ${data.propertyDisplayName || data.propertyName || COMPANY_DISPLAY_NAME}`
  );
}

function defaultWaiverReminderText(data, reminder = {}) {
  const timingLine =
    Number(reminder.daysBeforeCheckin) === 0
      ? "Your check-in is today."
      : Number(reminder.daysBeforeCheckin) === 1
        ? "Your check-in is tomorrow."
        : `Your check-in is in ${Number(reminder.daysBeforeCheckin)} days.`;

  return (
    renderMessageTemplate(reminder.messageTemplate || reminder.messageBody || "", data) ||
    [
      `Greetings ${data.GuestFirstName},`,
      "",
      `${timingLine} Please complete the ${COMPANY_DISPLAY_NAME} reservation form before arrival so we can release your access information.`,
      "",
      data.propertyDisplayName ? `Stay: ${data.propertyDisplayName}` : "",
      data.Arrival ? `Check-in Date: ${data.Arrival}` : "",
      data.Departure ? `Check-out Date: ${data.Departure}` : "",
      "",
      `Reservation Form: ${data.reservationFormUrl}`,
      "",
      "Access codes are only released once the form is submitted.",
      "",
      "Best,",
      data.hostName || COMPANY_DISPLAY_NAME,
    ]
      .filter((line) => line !== null && line !== undefined)
      .join("\n")
  );
}

export function buildAccessCodeTemplateData({
  booking,
  automationConfig,
  accessCode = "",
  fallback = {},
  includeAccessCode = true,
  messageKind,
}) {
  const config = automationConfig.accessCodeRelease || {};
  const context = bookingContext(booking, fallback);
  const defaults = templateDefaults(config);
  const windowOverride = accessWindowOverrideFor(context.checkinDate, config);
  const propertyData = {
    ...defaults,
    ...propertyMessageDataFor(context, config),
    ...(windowOverride?.checkinTimeLabel
      ? { checkinTime: windowOverride.checkinTimeLabel }
      : {}),
  };
  const propertyDisplayName = firstNonEmpty([
    propertyData.displayName,
    propertyData.propertyDisplayName,
    context.propertyName,
    DEFAULT_PROPERTY_DISPLAY_NAME,
  ]);
  const directionsName = firstNonEmpty([
    propertyData.directionsName,
    propertyData.signName,
    propertyDisplayName,
  ]);
  const unitDirections = firstNonEmpty([
    propertyData.unitDirections,
    `Once you are at ${propertyData.siteName}, follow the signs to the "${directionsName.toUpperCase()}"`,
  ]);
  const parkingInstructions = firstNonEmpty([
    propertyData.parkingInstructions,
    propertyData.parking,
    "Parking - please park in front of your unit on the white gravel driveway.",
  ]);
  const dedicatedKayakText = firstNonEmpty([
    propertyData.dedicatedKayakText,
    propertyData.kayakText,
    propertyData.kayakLockCode
      ? `There is one dedicated kayak for ${directionsName} guests. The kayak lock code is ${propertyData.kayakLockCode}.`
      : "",
  ]);
  const additionalKayakText = firstNonEmpty([
    propertyData.additionalKayakText,
    `We have additional kayaks available and a Tandem (two seater) kayak for rent. These kayaks are available for rent for ${propertyData.kayakRentalSingleRate} each single kayak and ${propertyData.kayakRentalTandemRate} for the double seater kayak.`,
  ]);
  const lifeJacketText = firstNonEmpty([
    propertyData.lifeJacketText,
    "Please use the provided life jackets when boarding. If children are in the pond area or rowing in the water, it is required to have an adult supervising.",
  ]);
  const amenitiesText = firstNonEmpty([
    propertyData.amenitiesText,
    propertyData.amenities,
    "If you have any questions, please let me know. I have left a journal in the unit as a gift to you.",
  ]);
  const goodToKnowText = firstNonEmpty([
    propertyData.goodToKnowText,
    propertyData.goodToKnow,
    propertyData.additionalRulesText,
    "I have left additional rules in the unit. If there is anything else I can do to make your stay enjoyable, please let me know in this thread.",
  ]);
  const goodToKnowItems = [
    { label: "Good to know", text: goodToKnowText },
  ].filter((item) => clean(item.text));

  const data = {
    guestName: context.guestName,
    guestFirstName: context.guestFirstName,
    guestLastName: context.guestLastName,
    guestPhone: context.guestPhone,
    GuestName: context.guestName,
    GuestFirstName: context.guestFirstName,
    GuestLastName: context.guestLastName,
    bookingId: context.bookingId,
    bookingChannel: context.bookingChannel,
    bookingSource: context.bookingSource,
    bookingSourceText: context.bookingSourceText,
    propertyId: context.propertyId,
    propertyName: context.propertyName || propertyDisplayName,
    PropertyName: context.propertyName || propertyDisplayName,
    propertyDisplayName,
    PropertyDisplayName: propertyDisplayName,
    unitName: context.propertyName || propertyDisplayName,
    UnitName: context.propertyName || propertyDisplayName,
    stayName: propertyDisplayName,
    StayName: propertyDisplayName,
    siteName: propertyData.siteName,
    address: propertyData.address,
    googleMapsAddress: firstNonEmpty([
      propertyData.googleMapsAddress,
      propertyData.mapsAddress,
      propertyData.address,
    ]),
    GoogleMapsAddress: firstNonEmpty([
      propertyData.googleMapsAddress,
      propertyData.mapsAddress,
      propertyData.address,
    ]),
    googleMapsUrl: firstNonEmpty([
      propertyData.googleMapsUrl,
      propertyData.googleMapsURL,
      propertyData.mapsUrl,
      propertyData.mapsURL,
    ]),
    googleMapsURL: firstNonEmpty([
      propertyData.googleMapsUrl,
      propertyData.googleMapsURL,
      propertyData.mapsUrl,
      propertyData.mapsURL,
    ]),
    GoogleMapsUrl: firstNonEmpty([
      propertyData.googleMapsUrl,
      propertyData.googleMapsURL,
      propertyData.mapsUrl,
      propertyData.mapsURL,
    ]),
    GoogleMapsURL: firstNonEmpty([
      propertyData.googleMapsUrl,
      propertyData.googleMapsURL,
      propertyData.mapsUrl,
      propertyData.mapsURL,
    ]),
    unitDirections,
    parkingInstructions,
    wifiName: firstNonEmpty([propertyData.wifiName, propertyData.wifi, ""]),
    wifiPassword: firstNonEmpty([
      propertyData.wifiPassword,
      propertyData.password,
      "",
    ]),
    checkinTime: propertyData.checkinTime,
    checkoutTime: propertyData.checkoutTime,
    checkinDate: context.checkinDate,
    checkoutDate: context.checkoutDate,
    checkInDate: context.checkinDate,
    checkOutDate: context.checkoutDate,
    Arrival: context.checkinDate,
    Departure: context.checkoutDate,
    accessCode,
    code: accessCode,
    KeyCode: accessCode,
    hasAccessCode: Boolean(accessCode),
    reservationFormUrl: selectedWaiverFormUrl(automationConfig, config),
    reservationFormURL: selectedWaiverFormUrl(automationConfig, config),
    waiverUrl: selectedWaiverFormUrl(automationConfig, config),
    waiverURL: selectedWaiverFormUrl(automationConfig, config),
    dedicatedKayakText,
    additionalKayakText,
    lifeJacketText,
    amenitiesText,
    goodToKnowText,
    additionalRulesText: goodToKnowText,
    goodToKnowItems,
    hostName: propertyData.hostName,
    urgentPhone: propertyData.urgentPhone,
  };

  const resolvedMessageKind =
    messageKind || (includeAccessCode ? "access" : "missing-form");
  const configuredTemplate =
    resolvedMessageKind === "code-only"
      ? propertyData.codeOnlyMessageTemplate ||
        propertyData.accessCodeMessageTemplate ||
        propertyData.accessMessageTemplate ||
        config.codeOnlyMessageTemplate ||
        config.accessCodeMessageTemplate
      : resolvedMessageKind === "checkin-info"
        ? propertyData.checkinInfoMessageTemplate ||
          propertyData.accessCodeMessageTemplate ||
          propertyData.accessMessageTemplate ||
          config.checkinInfoMessageTemplate ||
          config.accessCodeMessageTemplate
        : includeAccessCode
          ? propertyData.accessCodeMessageTemplate ||
            propertyData.accessMessageTemplate ||
            config.accessCodeMessageTemplate
          : propertyData.missingFormMessageTemplate ||
            propertyData.finalReminderMessageTemplate ||
            config.missingFormMessageTemplate ||
            config.finalReminderMessageTemplate;
  const text =
    renderMessageTemplate(configuredTemplate, data) ||
    (resolvedMessageKind === "code-only"
      ? codeOnlyMessageText(data)
      : resolvedMessageKind === "checkin-info"
        ? checkinInfoMessageText(data)
      : messageText(data, includeAccessCode));
  const subjectTemplate =
    resolvedMessageKind === "code-only"
      ? propertyData.codeOnlySubjectTemplate ||
        propertyData.accessCodeSubjectTemplate ||
        propertyData.accessSubjectTemplate ||
        config.codeOnlySubjectTemplate ||
        config.accessCodeSubjectTemplate
      : resolvedMessageKind === "checkin-info"
        ? propertyData.checkinInfoSubjectTemplate ||
          propertyData.accessCodeSubjectTemplate ||
          propertyData.accessSubjectTemplate ||
          config.checkinInfoSubjectTemplate ||
          config.accessCodeSubjectTemplate
        : includeAccessCode
          ? propertyData.accessCodeSubjectTemplate ||
            propertyData.accessSubjectTemplate ||
            config.accessCodeSubjectTemplate
          : propertyData.missingFormSubjectTemplate ||
            propertyData.finalReminderSubjectTemplate ||
            config.missingFormSubjectTemplate ||
            config.finalReminderSubjectTemplate;
  const subject =
    renderMessageTemplate(subjectTemplate, data) ||
    defaultMessageSubject(data, resolvedMessageKind, includeAccessCode);
  const lodgifyMessageHtml = messageToLodgifyHtml(text);
  return {
    ...data,
    accessMessageText: text,
    accessMessageHtml: lodgifyMessageHtml,
    lodgifyMessageSubject: subject,
    lodgifyMessageText: text,
    lodgifyMessageHtml,
    messageKind: resolvedMessageKind,
  };
}

function result(status, action, details = {}) {
  return {
    status,
    action,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function releaseConfig(automationConfig) {
  return automationConfig.accessCodeRelease || {};
}

function allowedByPropertyFilter(context, config) {
  const propertyIds = Array.isArray(config.propertyIds) ? config.propertyIds : [];
  if (propertyIds.length === 0) return true;
  return propertyIds.includes(clean(context.propertyId));
}

function allowedByBookingStatus(context) {
  if (isBookedLodgifyStatus(context.bookingStatus)) return null;
  return result(
    "skipped",
    ineligibleBookingStatusMessage(
      context.bookingId,
      context.bookingStatus,
      context.bookingChannel
    ),
    {
      bookingId: context.bookingId,
      bookingStatus: context.bookingStatus || "unknown",
      ...bookingSourceDetails(context),
    }
  );
}

export async function sendAccessCodeForBooking({
  booking,
  automationConfig,
  dryRun = false,
  fallback = {},
  persistState = true,
  messagePrefix = "",
  messageKind = "access",
}) {
  const config = releaseConfig(automationConfig);
  if (!config.enabled) return result("skipped", "Access code release disabled");
  const requestedMessageKind = messageKind === "code-only" ? "code-only" : "access";

  const context = bookingContext(booking, fallback);
  if (!context.bookingId) return result("skipped", "No booking ID available");
  const statusSkip = allowedByBookingStatus(context);
  if (statusSkip) return statusSkip;
  if (!allowedByPropertyFilter(context, config)) {
    return result("skipped", `Skipped booking ${context.bookingId}: property is not enabled`);
  }

  const existing = await getAccessCodeRelease(context.bookingId);
  if (persistState !== false && (existing?.sent_at || existing?.status === "sent")) {
    return result("skipped", `Skipped booking ${context.bookingId}: access code already sent`);
  }

  const resolvedMessageKind =
    requestedMessageKind === "code-only" && !checkinInfoAlreadySent(existing)
      ? "access"
      : requestedMessageKind;
  const decision =
    resolvedMessageKind === "code-only" ? "code-only" : "access-code";
  const messageName =
    resolvedMessageKind === "code-only" ? "day-of code" : "access code";
  const templateId =
    resolvedMessageKind === "code-only" ? "lodgify:code-only" : "lodgify:access-code";

  if (dryRun) {
    const templateData = buildAccessCodeTemplateData({
      booking,
      automationConfig,
      accessCode: "DRY-RUN-CODE",
      fallback,
      includeAccessCode: true,
      messageKind: resolvedMessageKind,
    });
    const preparedMessage = lodgifyMessageForContext(context, {
      prefix: messagePrefix,
      text: templateData.lodgifyMessageText,
      html: templateData.lodgifyMessageHtml,
      config,
    });
    const useEmailFallback = shouldUseEmailFallback(context, config);
    if (useEmailFallback && !context.guestEmail) {
      return missingEmailFallbackResult(context, messageName, {
        decision,
        ...preparedMessage.details,
      });
    }
    return result(
      "success",
      useEmailFallback
        ? `[DRY RUN] Would send ${messageName} by guest email fallback to ${context.guestEmail} for booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}${bookingSourceSuffix(context)}`
        : `[DRY RUN] Would post Lodgify ${resolvedMessageKind === "code-only" ? "code-only" : "access-code"} message to booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}${bookingSourceSuffix(context)}`,
      {
        templateData,
        bookingId: context.bookingId,
        deliveryChannel: useEmailFallback ? "sendgrid" : "lodgify",
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision,
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }

  let resolved;
  try {
    resolved = await resolveAccessCodeForBooking(
      {
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        guestFirstName: context.guestFirstName,
        guestLastName: context.guestLastName,
        guestPhone: context.guestPhone,
        checkinDate: context.checkinDate,
        checkoutDate: context.checkoutDate,
        lodgifyBooking: booking,
      },
      config
    );
  } catch (err) {
    if (persistState !== false) {
      await markAccessCodeReleaseFailed({
        bookingId: context.bookingId,
        error: err.message,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        source: "access-code-lookup",
        channel: "lodgify",
        raw: {
          reason: "access-code-lookup-failed",
          ...bookingSourceDetails(context),
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      `Failed booking ${context.bookingId}: access code lookup failed (${err.message})`
    );
  }

  if (!resolved?.code) {
    if (persistState !== false) {
      await markAccessCodeReleaseFailed({
        bookingId: context.bookingId,
        error:
          "No access code available from stored codes, static property codes, Lodgify booking payload, or Jervis API",
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        source: "access-code-lookup",
        channel: "lodgify",
        raw: {
          reason: "access-code-missing",
          ...bookingSourceDetails(context),
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      `Failed booking ${context.bookingId}: no access code available from stored codes, static property codes, Lodgify booking payload, or Jervis API`
    );
  }

  const templateData = buildAccessCodeTemplateData({
    booking,
    automationConfig,
    accessCode: resolved.code,
    fallback,
    includeAccessCode: true,
    messageKind: resolvedMessageKind,
  });
  const preparedMessage = lodgifyMessageForContext(context, {
    prefix: messagePrefix,
    text: templateData.lodgifyMessageText,
    html: templateData.lodgifyMessageHtml,
    config,
  });
  const useEmailFallback = shouldUseEmailFallback(context, config);

  try {
    const delivery = await sendGuestMessageWithVerifiedDelivery({
      context,
      booking,
      automationConfig,
      subject: templateData.lodgifyMessageSubject,
      preparedMessage,
      emailText: `${messagePrefix || ""}${templateData.lodgifyMessageText || ""}`,
      messageName,
      config,
    });
    const deliveryChannel = delivery.deliveryChannel;
    if (persistState !== false) {
      await markAccessCodeReleaseSent({
        bookingId: context.bookingId,
        templateId:
          deliveryChannel === "sendgrid" ? `sendgrid:plain-${decision}` : templateId,
        channel: deliveryChannel,
        raw: {
          reason:
            deliveryChannel === "sendgrid"
              ? `${decision}-email-fallback`
              : `${decision}-lodgify-message`,
          ...deliveryLogDetails(delivery),
        },
      });
    }
    return result(
      "success",
      deliveredAction(delivery, {
        email: `Sent ${messageName} by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}`,
        lodgify: `Posted ${messageName} to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}`,
        unrouted: `Posted ${messageName} to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}, but Lodgify did not route it to the guest channel; sent guest email fallback`,
      }),
      {
        bookingId: context.bookingId,
        decision,
        ...preparedMessage.details,
        ...deliveryLogDetails(delivery),
        ...bookingSourceDetails(context),
      }
    );
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    if (persistState !== false) {
      await markAccessCodeReleaseFailed({
        bookingId: context.bookingId,
        error: detail,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        source: resolved?.source || "access-code-delivery",
        channel: useEmailFallback ? "sendgrid" : "lodgify",
        templateId:
          useEmailFallback ? `sendgrid:plain-${decision}` : templateId,
        raw: {
          reason: useEmailFallback
            ? `${decision}-email-fallback-failed`
            : `${decision}-lodgify-message-failed`,
          ...bookingSourceDetails(context),
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      useEmailFallback
        ? `Failed to send ${messageName} by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`
        : `Failed to post access code to Lodgify booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`,
      {
        bookingId: context.bookingId,
        deliveryChannel: useEmailFallback ? "sendgrid" : "lodgify",
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision,
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }
}

function checkinInfoAlreadySent(existing) {
  if (!existing) return false;
  const raw = existing.raw_source && typeof existing.raw_source === "object"
    ? existing.raw_source
    : {};
  return (
    Boolean(raw.checkinInfoSentAt) ||
    clean(existing.sendgrid_template_id) === "lodgify:checkin-info"
  );
}

export async function sendCheckinInfoForBooking({
  booking,
  automationConfig,
  dryRun = false,
  fallback = {},
  persistState = true,
  messagePrefix = "",
}) {
  const config = releaseConfig(automationConfig);
  const templateId = "lodgify:checkin-info";
  if (!config.enabled) return result("skipped", "Access code release disabled");

  const context = bookingContext(booking, fallback);
  if (!context.bookingId) return result("skipped", "No booking ID available");
  const statusSkip = allowedByBookingStatus(context);
  if (statusSkip) return statusSkip;
  if (!allowedByPropertyFilter(context, config)) {
    return result("skipped", `Skipped booking ${context.bookingId}: property is not enabled`);
  }

  const existing = await getAccessCodeRelease(context.bookingId);
  if (persistState !== false && (existing?.sent_at || existing?.status === "sent")) {
    return result("skipped", `Skipped booking ${context.bookingId}: access code already sent`);
  }
  if (persistState !== false && checkinInfoAlreadySent(existing)) {
    return result(
      "skipped",
      `Skipped booking ${context.bookingId}: check-in information already sent`
    );
  }

  const templateData = buildAccessCodeTemplateData({
    booking,
    automationConfig,
    accessCode: "",
    fallback,
    includeAccessCode: false,
    messageKind: "checkin-info",
  });
  const preparedMessage = lodgifyMessageForContext(context, {
    prefix: messagePrefix,
    text: templateData.lodgifyMessageText,
    html: templateData.lodgifyMessageHtml,
    config,
  });
  const useEmailFallback = shouldUseEmailFallback(context, config);
  const plannedDeliveryChannel = useEmailFallback ? "sendgrid" : "lodgify";

  if (dryRun) {
    if (useEmailFallback && !context.guestEmail) {
      return missingEmailFallbackResult(context, "check-in information", {
        decision: "checkin-info",
        ...preparedMessage.details,
      });
    }
    return result(
      "success",
      useEmailFallback
        ? `[DRY RUN] Would send check-in information by guest email fallback to ${context.guestEmail} for booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}${bookingSourceSuffix(context)}`
        : `[DRY RUN] Would post Lodgify no-code check-in message to booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}${bookingSourceSuffix(context)}`,
      {
        templateData,
        bookingId: context.bookingId,
        deliveryChannel: plannedDeliveryChannel,
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "checkin-info",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }

  try {
    const delivery = await sendGuestMessageWithVerifiedDelivery({
      context,
      booking,
      automationConfig,
      subject: templateData.lodgifyMessageSubject,
      preparedMessage,
      emailText: `${messagePrefix || ""}${templateData.lodgifyMessageText || ""}`,
      messageName: "check-in information",
      config,
    });
    const deliveryChannel = delivery.deliveryChannel;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId:
          deliveryChannel === "sendgrid"
            ? "sendgrid:plain-checkin-info"
            : templateId,
        channel: deliveryChannel,
        error: deliveryChannel === "sendgrid"
          ? "Check-in information sent by email fallback; access code delayed until check-in day."
          : "Check-in information sent; access code delayed until check-in day.",
        raw: {
          reason: deliveryChannel === "sendgrid"
            ? "checkin-info-email-fallback"
            : "checkin-info-lodgify-message",
          checkinInfoSentAt: new Date().toISOString(),
          ...deliveryLogDetails(delivery),
        },
      });
    }
    return result(
      "success",
      deliveredAction(delivery, {
        email: `Sent check-in information by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}`,
        lodgify: `Posted no-code check-in information to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}`,
        unrouted: `Posted no-code check-in information to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}, but Lodgify did not route it to the guest channel; sent guest email fallback`,
      }),
      {
        bookingId: context.bookingId,
        decision: "checkin-info",
        ...preparedMessage.details,
        ...deliveryLogDetails(delivery),
        ...bookingSourceDetails(context),
      }
    );
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId: useEmailFallback ? "sendgrid:plain-checkin-info" : templateId,
        channel: useEmailFallback ? "sendgrid" : "lodgify",
        error: detail,
        raw: {
          reason: useEmailFallback
            ? "checkin-info-email-fallback-failed"
            : "checkin-info-lodgify-message-failed",
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      useEmailFallback
        ? `Failed to send check-in information by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`
        : `Failed to post no-code check-in information to Lodgify booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`,
      {
        bookingId: context.bookingId,
        deliveryChannel: useEmailFallback ? "sendgrid" : "lodgify",
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "checkin-info",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }
}

function blockedAttemptWasToday(existing, templateId) {
  if (!existing?.last_attempt_at) return false;
  if (existing.status !== "blocked") return false;
  if (clean(existing.sendgrid_template_id) !== clean(templateId)) return false;
  return centralDateFor(existing.last_attempt_at) === todayCentral();
}

export async function sendMissingFormEmailForBooking({
  booking,
  automationConfig,
  dryRun = false,
  fallback = {},
  persistState = true,
  messagePrefix = "",
}) {
  const config = releaseConfig(automationConfig);
  const templateId = "lodgify:missing-form";
  const waiverConfig = automationConfig.waiverReminders || {};

  if (waiverReminderFormSource(waiverConfig) !== "internal") {
    return result(
      "skipped",
      "Skipped missing-form Lodgify message: legacy Jotform is selected"
    );
  }

  const context = bookingContext(booking, fallback);
  if (!context.bookingId) return result("skipped", "No booking ID available");
  const statusSkip = allowedByBookingStatus(context);
  if (statusSkip) return statusSkip;
  if (!allowedByPropertyFilter(context, config)) {
    return result("skipped", `Skipped booking ${context.bookingId}: property is not enabled`);
  }

  const localFormSlug = configuredLocalFormSlug(automationConfig, config);
  const submittedFormResult = await alreadySubmittedInternalFormResult({
    bookingId: context.bookingId,
    formSlug: localFormSlug,
    decision: "missing-form",
    messageName: "missing-form reminder",
    context,
  });
  if (submittedFormResult) return submittedFormResult;

  const existing = await getAccessCodeRelease(context.bookingId);
  if (persistState !== false && (existing?.sent_at || existing?.status === "sent")) {
    return result("skipped", `Skipped booking ${context.bookingId}: access code already sent`);
  }
  if (persistState !== false && blockedAttemptWasToday(existing, templateId)) {
    return result(
      "skipped",
      `Skipped booking ${context.bookingId}: missing-form Lodgify message already sent today`
    );
  }

  const templateData = buildAccessCodeTemplateData({
    booking,
    automationConfig,
    accessCode: "",
    fallback,
    includeAccessCode: false,
  });
  const preparedMessage = lodgifyMessageForContext(context, {
    prefix: messagePrefix,
    text: templateData.lodgifyMessageText,
    html: templateData.lodgifyMessageHtml,
    config,
  });
  const useEmailFallback = shouldUseEmailFallback(context, config);
  const plannedDeliveryChannel = useEmailFallback ? "sendgrid" : "lodgify";

  if (dryRun) {
    if (useEmailFallback && !context.guestEmail) {
      return missingEmailFallbackResult(context, "missing-form reminder", {
        decision: "missing-form",
        ...preparedMessage.details,
      });
    }
    return result(
      "success",
      useEmailFallback
        ? `[DRY RUN] Would send missing-form reminder by guest email fallback to ${context.guestEmail} for booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}${bookingSourceSuffix(context)}`
        : `[DRY RUN] Would post missing-form Lodgify message to booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || "Property"} | arrival ${templateData.Arrival || "unknown"}`,
      {
        templateData,
        bookingId: context.bookingId,
        deliveryChannel: plannedDeliveryChannel,
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "missing-form",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }

  try {
    const delivery = await sendGuestMessageWithVerifiedDelivery({
      context,
      booking,
      automationConfig,
      subject: templateData.lodgifyMessageSubject,
      preparedMessage,
      emailText: `${messagePrefix || ""}${templateData.lodgifyMessageText || ""}`,
      messageName: "missing-form reminder",
      config,
    });
    const deliveryChannel = delivery.deliveryChannel;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId:
          deliveryChannel === "sendgrid"
            ? "sendgrid:plain-missing-form"
            : templateId,
        channel: deliveryChannel,
        error: deliveryChannel === "sendgrid"
          ? "Form not submitted yet; missing-form email fallback sent."
          : "Form not submitted yet; missing-form Lodgify message sent.",
        raw: {
          reason: deliveryChannel === "sendgrid"
            ? "missing-form-email-fallback"
            : "missing-form-lodgify-message",
          ...deliveryLogDetails(delivery),
        },
      });
    }
    return result(
      "success",
      deliveredAction(delivery, {
        email: `Sent missing-form reminder by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}`,
        lodgify: `Posted missing-form reminder to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}`,
        unrouted: `Posted missing-form reminder to Lodgify booking thread ${context.bookingId}${bookingSourceSuffix(context)}, but Lodgify did not route it to the guest channel; sent guest email fallback`,
      }),
      {
        bookingId: context.bookingId,
        decision: "missing-form",
        ...preparedMessage.details,
        ...deliveryLogDetails(delivery),
        ...bookingSourceDetails(context),
      }
    );
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId: useEmailFallback ? "sendgrid:plain-missing-form" : templateId,
        channel: plannedDeliveryChannel,
        error: detail,
        raw: {
          reason: useEmailFallback
            ? "missing-form-email-fallback-failed"
            : "missing-form-lodgify-message-failed",
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      useEmailFallback
        ? `Failed to send missing-form reminder by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`
        : `Failed to post missing-form Lodgify message for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`,
      {
        bookingId: context.bookingId,
        deliveryChannel: plannedDeliveryChannel,
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "missing-form",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }
}

export async function sendWaiverReminderForBooking({
  booking,
  automationConfig,
  reminder = {},
  dryRun = false,
  fallback = {},
  persistState = true,
  messagePrefix = "",
}) {
  const config = releaseConfig(automationConfig);
  const waiverConfig = automationConfig.waiverReminders || {};
  const context = bookingContext(booking, fallback);
  const reminderDay = Number(reminder.daysBeforeCheckin ?? 0) || 0;
  const label = reminder.label || `${reminderDay}-day reminder`;
  const formSource = waiverReminderFormSource(waiverConfig);

  if (!waiverConfig.enabled) return result("skipped", "Waiver reminders disabled");
  if (!context.bookingId) return result("skipped", "No booking ID available");
  const statusSkip = allowedByBookingStatus(context);
  if (statusSkip) return statusSkip;
  if (!allowedByPropertyFilter(context, waiverConfig)) {
    return result("skipped", `Skipped booking ${context.bookingId}: property is not enabled for waiver reminders`);
  }

  if (formSource !== "internal") {
    const templateId = clean(reminder.templateId || reminder.sendgridTemplateId);
    const jotformUrl = jotformFormUrl(waiverJotformFormId(automationConfig, reminder));
    const templateData = {
      ...buildAccessCodeTemplateData({
        booking,
        automationConfig,
        accessCode: "",
        fallback,
        includeAccessCode: false,
        messageKind: "missing-form",
      }),
      reservationFormUrl: jotformUrl,
      reservationFormURL: jotformUrl,
      waiverUrl: jotformUrl,
      waiverURL: jotformUrl,
    };

    if (!context.guestEmail) {
      return result(
        "skipped",
        dryRun
          ? `[DRY RUN] SKIP booking ${context.bookingId} | no guest email`
          : `No email for booking ${context.bookingId} — skipped (${reminderDay}-day)`,
        {
          bookingId: context.bookingId,
          deliveryChannel: "sendgrid",
          decision: "legacy-jotform-reminder",
          templateData,
          ...bookingSourceDetails(context),
        }
      );
    }

    if (!templateId) {
      return result(
        "skipped",
        `SKIP booking ${context.bookingId} — no SendGrid template ID for "${reminder.label || `${reminderDay}-day`}"`,
        {
          bookingId: context.bookingId,
          deliveryChannel: "sendgrid",
          decision: "legacy-jotform-reminder",
          templateData,
          ...bookingSourceDetails(context),
        }
      );
    }

    if (dryRun) {
      return result(
        "success",
        `[DRY RUN] Would send "${label}" to ${context.guestEmail} | booking ${context.bookingId} | ${templateData.propertyDisplayName || context.propertyName || DEFAULT_PROPERTY_DISPLAY_NAME} | no Jotform waiver for booking ${context.bookingId}${bookingSourceSuffix(context)}`,
        {
          templateId,
          templateData,
          bookingId: context.bookingId,
          deliveryChannel: "sendgrid",
          decision: "legacy-jotform-reminder",
          ...bookingSourceDetails(context),
        }
      );
    }

    try {
      const { sendTemplateEmail } = await import("@/lib/sendgrid");
      await sendTemplateEmail({
        to: context.guestEmail,
        templateId,
        from: {
          email: automationConfig.sendgrid?.fromEmail,
          name: automationConfig.sendgrid?.fromName,
        },
        data: templateData,
      });
      return result(
        "success",
        `Sent ${label} to ${context.guestEmail} (booking ${context.bookingId})${bookingSourceSuffix(context)}`,
        {
          templateId,
          bookingId: context.bookingId,
          deliveryChannel: "sendgrid",
          decision: "legacy-jotform-reminder",
          ...bookingSourceDetails(context),
        }
      );
    } catch (err) {
      const detail = err.response?.body?.errors?.[0]?.message || err.message;
      return result(
        "failed",
        `Failed ${label} for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`,
        {
          templateId,
          bookingId: context.bookingId,
          deliveryChannel: "sendgrid",
          decision: "legacy-jotform-reminder",
          ...bookingSourceDetails(context),
        }
      );
    }
  }

  const localFormSlug = normalizeLocalFormSlug(
    waiverConfig.localFormSlug || waiverConfig.formSlug
  );
  if (!localFormSlug) {
    return result("skipped", "Skipped: no internal form slug configured");
  }

  const submittedFormResult = await alreadySubmittedInternalFormResult({
    bookingId: context.bookingId,
    formSlug: localFormSlug,
    decision: "waiver-reminder",
    messageName: `waiver reminder "${label}"`,
    context,
  });
  if (submittedFormResult) return submittedFormResult;

  const templateId = `lodgify:waiver-reminder:${reminderDay}`;
  const existing = await getAccessCodeRelease(context.bookingId);
  if (persistState !== false && (existing?.sent_at || existing?.status === "sent")) {
    return result("skipped", `Skipped booking ${context.bookingId}: access code already sent`);
  }
  if (persistState !== false && blockedAttemptWasToday(existing, templateId)) {
    return result(
      "skipped",
      `Skipped booking ${context.bookingId}: "${reminder.label || `${reminderDay}-day reminder`}" already sent today`
    );
  }

  const templateData = buildAccessCodeTemplateData({
    booking,
    automationConfig,
    accessCode: "",
    fallback,
    includeAccessCode: false,
    messageKind: "missing-form",
  });
  const text =
    renderMessageTemplate(reminder.messageTemplate || reminder.messageBody || "", templateData) ||
    templateData.lodgifyMessageText ||
    defaultWaiverReminderText(templateData, reminder);
  const subject =
    renderMessageTemplate(reminder.subjectTemplate || reminder.subject || "", templateData) ||
    templateData.lodgifyMessageSubject ||
    defaultWaiverReminderSubject(templateData, reminder);
  const lodgifyMessageHtml = messageToLodgifyHtml(text);
  const data = {
    ...templateData,
    lodgifyMessageSubject: subject,
    lodgifyMessageText: text,
    lodgifyMessageHtml,
    accessMessageText: text,
    accessMessageHtml: lodgifyMessageHtml,
  };
  const preparedMessage = lodgifyMessageForContext(context, {
    prefix: messagePrefix,
    text,
    html: lodgifyMessageHtml,
    config,
  });
  const useEmailFallback = shouldUseEmailFallback(context, config);
  const plannedDeliveryChannel = useEmailFallback ? "sendgrid" : "lodgify";

  if (dryRun) {
    if (useEmailFallback && !context.guestEmail) {
      return missingEmailFallbackResult(context, `waiver reminder "${label}"`, {
        decision: "waiver-reminder",
        ...preparedMessage.details,
      });
    }
    return result(
      "success",
      useEmailFallback
        ? `[DRY RUN] Would send waiver reminder "${label}" by guest email fallback to ${context.guestEmail} for booking ${context.bookingId} | ${data.propertyDisplayName || context.propertyName || "Property"} | arrival ${data.Arrival || "unknown"}${bookingSourceSuffix(context)}`
        : `[DRY RUN] Would post Lodgify waiver reminder "${label}" to booking ${context.bookingId} | ${data.propertyDisplayName || context.propertyName || "Property"} | arrival ${data.Arrival || "unknown"}${bookingSourceSuffix(context)}`,
      {
        templateData: data,
        bookingId: context.bookingId,
        deliveryChannel: plannedDeliveryChannel,
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "waiver-reminder",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }

  try {
    const delivery = await sendGuestMessageWithVerifiedDelivery({
      context,
      booking,
      automationConfig,
      subject,
      preparedMessage,
      emailText: `${messagePrefix || ""}${text || ""}`,
      messageName: `waiver reminder "${label}"`,
      config,
    });
    const deliveryChannel = delivery.deliveryChannel;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId:
          deliveryChannel === "sendgrid"
            ? `sendgrid:plain-waiver-reminder:${reminderDay}`
            : templateId,
        channel: deliveryChannel,
        error: deliveryChannel === "sendgrid"
          ? `Waiver reminder "${label}" email fallback sent.`
          : `Waiver reminder "${label}" Lodgify message sent.`,
        raw: {
          reason: deliveryChannel === "sendgrid"
            ? "waiver-reminder-email-fallback"
            : "waiver-reminder-lodgify-message",
          reminderDay,
          label,
          ...deliveryLogDetails(delivery),
        },
      });
    }
    return result(
      "success",
      deliveredAction(delivery, {
        email: `Sent waiver reminder "${label}" by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}`,
        lodgify: `Posted Lodgify waiver reminder "${label}" to booking thread ${context.bookingId}${bookingSourceSuffix(context)}`,
        unrouted: `Posted Lodgify waiver reminder "${label}" to booking thread ${context.bookingId}${bookingSourceSuffix(context)}, but Lodgify did not route it to the guest channel; sent guest email fallback`,
      }),
      {
        bookingId: context.bookingId,
        decision: "waiver-reminder",
        ...preparedMessage.details,
        ...deliveryLogDetails(delivery),
        ...bookingSourceDetails(context),
      }
    );
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    if (persistState !== false) {
      await markAccessCodeReleaseBlocked({
        bookingId: context.bookingId,
        propertyId: context.propertyId,
        propertyName: context.propertyName,
        guestEmail: context.guestEmail,
        guestName: context.guestName,
        checkinDate: context.checkinDate,
        templateId: useEmailFallback
          ? `sendgrid:plain-waiver-reminder:${reminderDay}`
          : templateId,
        channel: plannedDeliveryChannel,
        error: detail,
        raw: {
          reason: useEmailFallback
            ? "waiver-reminder-email-fallback-failed"
            : "waiver-reminder-lodgify-message-failed",
          reminderDay,
          label,
        },
      }).catch(() => {});
    }
    return result(
      "failed",
      useEmailFallback
        ? `Failed to send waiver reminder "${label}" by guest email fallback for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`
        : `Failed to post Lodgify waiver reminder "${label}" for booking ${context.bookingId}${bookingSourceSuffix(context)}: ${detail}`,
      {
        bookingId: context.bookingId,
        deliveryChannel: plannedDeliveryChannel,
        ...(useEmailFallback ? { deliveryFallback: "lodgify-channel-email" } : {}),
        decision: "waiver-reminder",
        ...preparedMessage.details,
        ...bookingSourceDetails(context),
      }
    );
  }
}

function dateOnlyTime(value) {
  const normalized = toDateOnly(value);
  if (!normalized) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return isNaN(date.getTime()) ? null : date.getTime();
}

function daysUntilCentral(dateOnly) {
  const target = dateOnlyTime(dateOnly);
  const today = dateOnlyTime(todayCentral());
  if (target == null || today == null) return null;
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

export async function maybeSendSameDayAccessCodeForSubmission({
  formSlug,
  payload,
  contact,
}) {
  const automationConfig = await getConfig();
  const config = releaseConfig(automationConfig);
  const waiverConfig = automationConfig.waiverReminders || {};
  const configuredSlug = clean(
    config.localFormSlug || waiverConfig.localFormSlug || ""
  ).replace(/^\/?forms\//, "");

  if (!config.enabled) return result("skipped", "Access code release disabled");
  if (waiverReminderFormSource(waiverConfig) !== "internal") {
    return result("skipped", "Internal form is not the selected reservation form source");
  }
  const submittedSlugCandidates = localFormSlugCandidates(formSlug);
  if (configuredSlug && !submittedSlugCandidates.includes(configuredSlug)) {
    return result("skipped", "Submitted form is not the configured access form");
  }

  const stayDetails = extractStayDetailsFromPayload(payload);
  const bookingId = clean(contact?.bookingCode || stayDetails.bookingId);
  if (!bookingId) {
    return result("skipped", "No booking ID available from the form submission");
  }

  let booking = null;
  try {
    booking = await getBookingById(bookingId);
  } catch (err) {
    booking = null;
  }

  if (!booking) {
    booking = {
      id: bookingId,
      property_name: stayDetails.propertyName,
      arrival: stayDetails.checkinDate,
      departure: stayDetails.checkoutDate,
      guest: {
        email: contact?.email,
        name: [contact?.firstName, contact?.lastName].filter(Boolean).join(" "),
      },
    };
  }

  const releaseFallback = { contact, stayDetails, bookingId };
  // Prefer the Lodgify reservation dates over the guest-entered form dates so
  // the release window matches the real stay (booking 24081117's form and
  // Lodgify disagreed on the check-in day).
  const stayContext = bookingContext(booking, releaseFallback);
  const checkinDate = stayContext.checkinDate || stayDetails.checkinDate;
  const daysUntilStay = daysUntilCentral(checkinDate);
  const daysUntilCheckout = daysUntilCentral(
    stayContext.checkoutDate || stayDetails.checkoutDate
  );
  const releaseHour = Math.max(
    0,
    Math.min(23, Number(config.releaseHourCentral ?? 15))
  );
  const releaseMinute = Math.max(
    0,
    Math.min(59, Number(config.releaseMinuteCentral ?? 0))
  );
  const { reached, clock } = centralClockHasReached(releaseHour, releaseMinute);
  const dayOfReleaseHour = Math.max(
    0,
    Math.min(23, Number(config.dayOfCodeReleaseHourCentral ?? 11))
  );
  const dayOfReleaseMinute = Math.max(
    0,
    Math.min(59, Number(config.dayOfCodeReleaseMinuteCentral ?? 0))
  );
  const dayOfRelease = centralClockHasReached(dayOfReleaseHour, dayOfReleaseMinute);
  const [checkoutHour, checkoutMinute] = clean(config.jervisAccessEndTime || "11:00")
    .split(":")
    .map((part) => Number(part) || 0);
  const checkoutReached = centralClockHasReached(checkoutHour, checkoutMinute).reached;

  // Late arrivals: a guest who submits after midnight (booking 24081117 came in
  // at 1:09 AM) is past the check-in date but still mid-stay. Every release
  // window below only looks at today-or-later check-ins, so without this the
  // code is never sent. Release immediately until check-out time.
  const isMidStay =
    daysUntilStay !== null &&
    daysUntilStay < 0 &&
    daysUntilCheckout !== null &&
    (daysUntilCheckout > 0 || (daysUntilCheckout === 0 && !checkoutReached));

  if (isMidStay) {
    return sendAccessCodeForBooking({
      booking,
      automationConfig,
      fallback: releaseFallback,
      messageKind: "code-only",
    });
  }

  // Dynamic/Jervis codes: release as soon as the guest submits inside the
  // configured 24-hour window (day before at check-in time, or any time day-of).
  const isInsideImmediateWindow =
    daysUntilStay === 0 || (daysUntilStay === 1 && reached);

  if (daysUntilStay === 1 && !reached) {
    return result(
      "skipped",
      `Submitted stay starts tomorrow; access code release opens at ${String(releaseHour).padStart(2, "0")}:${String(releaseMinute).padStart(2, "0")} Central. Current Central time is ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}.`
    );
  }

  if (daysUntilStay === null || daysUntilStay < 0 || !isInsideImmediateWindow) {
    return result(
      "skipped",
      `Submitted stay starts ${checkinDate || "on an unknown date"}, outside the immediate release window`
    );
  }

  if (isDelayedAccessCodeBooking({ booking, automationConfig, fallback: releaseFallback })) {
    // Static-code properties wait until the day-of release time. If the form
    // comes in after that time, release immediately instead of waiting for cron.
    if (daysUntilStay === 0 && dayOfRelease.reached) {
      return sendAccessCodeForBooking({
        booking,
        automationConfig,
        fallback: {
          contact,
          stayDetails,
          bookingId,
        },
        messageKind: "code-only",
      });
    }

    return sendCheckinInfoForBooking({
      booking,
      automationConfig,
      fallback: {
        contact,
        stayDetails,
        bookingId,
      },
    });
  }

  return sendAccessCodeForBooking({
    booking,
    automationConfig,
    fallback: {
      contact,
      stayDetails,
      bookingId,
    },
  });
}
