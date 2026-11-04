import { LODGIFY_API_KEY } from "@/config/keys";
import { bookingCodeLookupVariants } from "@/lib/booking-code";

const BASE_URL = "https://api.lodgify.com";

export class LodgifyApiError extends Error {
  constructor(status, statusText, url, body = "") {
    super(
      `Lodgify API error: ${status} ${statusText} | URL: ${url}${body ? ` | Body: ${body.slice(0, 200)}` : ""}`
    );
    this.name = "LodgifyApiError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }
}

async function lodgifyFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const urlStr = url.toString();

  const res = await fetch(urlStr, {
    headers: {
      "X-ApiKey": LODGIFY_API_KEY,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LodgifyApiError(res.status, res.statusText, urlStr, body);
  }

  return res.json();
}

function normalizeBookingParams(paramsOrStartDate, endDate) {
  if (typeof paramsOrStartDate === "object" && paramsOrStartDate !== null) {
    return {
      page: 1,
      size: 100,
      includeCount: false,
      includeTransactions: false,
      includeExternal: false,
      includeQuoteDetails: false,
      ...paramsOrStartDate,
    };
  }

  return {
    page: 1,
    size: 100,
    includeCount: false,
    includeTransactions: false,
    includeExternal: false,
    includeQuoteDetails: false,
    stayFrom: paramsOrStartDate,
    stayTo: endDate,
  };
}

/** Get all properties */
export async function getProperties() {
  return lodgifyFetch("/v2/properties");
}

/**
 * Get availability for a property within a date range.
 * @param {number} propertyId
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
export async function getAvailability(propertyId, startDate, endDate) {
  return lodgifyFetch(`/v2/availability/${propertyId}`, {
    startDate,
    endDate,
  });
}

/**
 * Get bookings with check-in on a specific date.
 * Uses Lodgify GET /v2/reservations/bookings with stayFrom/stayTo to filter by arrival.
 * @param {string} startDate  YYYY-MM-DD (check-in date)
 * @param {string} endDate    YYYY-MM-DD
 */
export async function getBookings(paramsOrStartDate, endDate) {
  const data = await lodgifyFetch(
    "/v2/reservations/bookings",
    normalizeBookingParams(paramsOrStartDate, endDate)
  );
  return Array.isArray(data?.items) ? data.items : data ?? [];
}

export async function getBookingById(bookingId) {
  const variants = bookingCodeLookupVariants(bookingId);
  if (!variants.length) return null;

  for (const variant of variants) {
    const id = encodeURIComponent(variant);
    const candidatePaths = [
      `/v2/reservations/bookings/${id}`,
      `/v1/reservation/booking/${id}`,
      `/v1/reservation/${id}`,
    ];

    for (const path of candidatePaths) {
      try {
        return await lodgifyFetch(path);
      } catch (err) {
        if (
          err instanceof LodgifyApiError &&
          (err.status === 400 || err.status === 404)
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  return null;
}

/**
 * Get the raw v1 booking model. Unlike getBookingById (which prefers v2),
 * this always returns the v1 shape whose `note` field is the admin
 * "Booking Notes" panel that PUT /v1/reservation/booking/{id} writes.
 */
export async function getBookingV1(bookingId) {
  const variants = bookingCodeLookupVariants(bookingId);
  for (const variant of variants) {
    try {
      return await lodgifyFetch(
        `/v1/reservation/booking/${encodeURIComponent(variant)}`
      );
    } catch (err) {
      if (
        err instanceof LodgifyApiError &&
        (err.status === 400 || err.status === 404)
      ) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Overwrite the admin "Booking Notes" field on a Lodgify booking.
 * Sends only { note } so no other booking fields are touched (verified in
 * production 2026-07-28: no other field changes on this partial PUT).
 * Caveat: Lodgify ignores empty/blank note values on this endpoint, so the
 * note can be replaced but not cleared to "" from here.
 * Callers that need to preserve existing notes should use appendBookingNote.
 */
export async function setBookingNote(bookingId, note) {
  const id = encodeURIComponent(String(bookingId || "").trim());
  if (!id) throw new Error("Missing Lodgify booking ID.");

  const url = `${BASE_URL}/v1/reservation/booking/${id}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-ApiKey": LODGIFY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ note: String(note ?? "") }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new LodgifyApiError(res.status, res.statusText, url, body);
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Append a block of text to the booking's admin notes (read-modify-write,
 * existing notes are preserved). When `marker` is provided and already
 * appears in the current notes the append is skipped, so retries can't
 * duplicate the block.
 */
export async function appendBookingNote(bookingId, block, { marker } = {}) {
  const normalizedBlock = String(block || "").trim();
  if (!normalizedBlock) throw new Error("Missing booking note text.");

  const booking = await getBookingV1(bookingId);
  if (!booking?.id) {
    throw new Error(`Lodgify booking ${bookingId} not found.`);
  }

  const existing = String(booking.note || "").trim();
  if (marker && existing.includes(marker)) {
    return {
      appended: false,
      reason: "already in booking notes",
      bookingId: booking.id,
      previousNote: existing,
    };
  }

  const nextNote = existing
    ? `${existing}\n\n${normalizedBlock}`
    : normalizedBlock;
  await setBookingNote(booking.id, nextNote);
  return { appended: true, bookingId: booking.id, previousNote: existing };
}

export async function sendBookingMessage(
  bookingId,
  {
    subject,
    message,
    type = "Owner",
    sendNotification = true,
  } = {}
) {
  const id = encodeURIComponent(String(bookingId || "").trim());
  const normalizedMessage = String(message || "").trim();
  if (!id) throw new Error("Missing Lodgify booking ID.");
  if (!normalizedMessage) throw new Error("Missing Lodgify message body.");

  const url = `${BASE_URL}/v1/reservation/booking/${id}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-ApiKey": LODGIFY_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        subject: String(subject || "Zenfulcove Glamping stay details").trim(),
        message: normalizedMessage,
        type,
        send_notification: Boolean(sendNotification),
      },
    ]),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new LodgifyApiError(res.status, res.statusText, url, body);
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export async function getMessageThread(threadGuid) {
  const guid = encodeURIComponent(String(threadGuid || "").trim());
  if (!guid) return null;
  return lodgifyFetch(`/v2/messaging/${guid}`);
}

export async function getAllBookings(paramsOrStartDate, endDate) {
  const baseParams = normalizeBookingParams(paramsOrStartDate, endDate);
  const pageSize = Math.max(1, Number(baseParams.size) || 100);
  const items = [];
  let page = Number(baseParams.page) || 1;

  while (true) {
    const batch = await getBookings({
      ...baseParams,
      page,
      size: pageSize,
    });

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    items.push(...batch);

    if (batch.length < pageSize) {
      break;
    }

    page += 1;
  }

  return items;
}

function bookingDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/**
 * All bookings whose stay overlaps [startDate, endDate] (YYYY-MM-DD).
 * Lodgify v2 ignores stayFrom/stayTo and returns only upcoming stays by
 * default, so this queries the stayFilter windows that can overlap the range
 * (Historic / Current / Upcoming), de-duplicates, and filters by date.
 */
export async function getAllBookingsInStayWindow(startDate, endDate, params = {}) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const filters = [];
  if (startDate < today) filters.push("Historic");
  if (startDate <= today && endDate >= today) filters.push("Current");
  if (endDate >= today) filters.push("Upcoming");

  const byId = new Map();
  for (const stayFilter of filters) {
    const batch = await getAllBookings({
      size: 100,
      includeCount: false,
      includeTransactions: false,
      includeExternal: true,
      includeQuoteDetails: false,
      ...params,
      page: 1,
      stayFilter,
    });
    for (const booking of batch) {
      const key = String(booking?.id || booking?.bookingId || `idx-${byId.size}`);
      byId.set(key, booking);
    }
  }

  return Array.from(byId.values()).filter((booking) => {
    const arrival = bookingDateOnly(booking?.arrival || booking?.checkIn || booking?.start_date);
    const departure = bookingDateOnly(booking?.departure || booking?.checkOut || booking?.end_date) || arrival;
    if (!arrival) return true;
    return arrival <= endDate && departure >= startDate;
  });
}

/** Raw v2 booking by numeric id, with optional query params (read-only). */
export async function getBookingV2Raw(bookingId, params = {}) {
  return lodgifyFetch(`/v2/reservations/bookings/${encodeURIComponent(bookingId)}`, params);
}
