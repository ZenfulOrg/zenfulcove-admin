import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";
import {
  createJervisReservation,
  extractJervisPincode,
  extractJervisReservationId,
  getJervisReservation,
  isJervisConfigured,
  jervisReservationPayload,
  resolveJervisPropertyId,
  updateJervisReservation,
} from "@/lib/jervis";

function clean(value) {
  return String(value || "").trim();
}

function normalizeBookingId(value) {
  return clean(value);
}

function normalizePropertyCodeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, code]) => [clean(key), clean(code)])
      .filter(([key, code]) => key && code)
  );
}

function normalizeLookupKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES = ["Doodle House"];

function configuredList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const raw = clean(value);
  if (!raw) return fallback;
  return raw.split(",").map(clean).filter(Boolean);
}

function configuredObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function propertyMessageDataFor(booking, config = {}) {
  const map = configuredObject(config.propertyMessageData);
  const candidates = [
    booking.propertyId,
    booking.propertyName,
    normalizeLookupKey(booking.propertyId),
    normalizeLookupKey(booking.propertyName),
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

function propertyAllowsConfiguredStaticCode(booking, config = {}) {
  const propertyData = propertyMessageDataFor(booking, config);
  if (propertyData.delayAccessCodeUntilCheckinDay === true) return true;
  if (propertyData.delayAccessCodeUntilCheckinDay === false) return false;

  const propertyIds = configuredList(config.delayedAccessCodePropertyIds);
  if (propertyIds.includes(clean(booking.propertyId))) return true;

  const delayedNames = configuredList(
    config.delayedAccessCodePropertyNames,
    DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES
  ).map(normalizeLookupKey);
  const candidates = [
    booking.propertyName,
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

function lookupPropertyCode(propertyCodes, booking) {
  const propertyId = clean(booking.propertyId);
  const propertyName = clean(booking.propertyName);
  const exact = propertyCodes[propertyId] || propertyCodes[propertyName];
  if (exact) return exact;

  const targetKeys = [propertyId, propertyName]
    .map(normalizeLookupKey)
    .filter(Boolean);
  for (const [key, code] of Object.entries(propertyCodes)) {
    const normalizedKey = normalizeLookupKey(key);
    if (
      targetKeys.some(
        (target) =>
          target === normalizedKey ||
          target.includes(normalizedKey) ||
          normalizedKey.includes(target)
      )
    ) {
      return code;
    }
  }

  return "";
}

const DIRECT_ACCESS_CODE_KEYS = new Set([
  "keycode",
  "key_code",
  "accesscode",
  "access_code",
  "doorcode",
  "door_code",
  "lockcode",
  "lock_code",
  "pincode",
  "pin_code",
]);

const CONTEXT_ACCESS_CODE_KEYS = new Set([
  "code",
  "pin",
  "value",
]);

function isUsableAccessCodeValue(value) {
  const normalized = clean(value);
  if (!normalized) return false;
  if (normalized.length < 3 || normalized.length > 30) return false;
  if (/@|https?:\/\//i.test(normalized)) return false;
  return true;
}

function normalizedObjectKey(key) {
  return clean(key).replace(/[\s-]/g, "_").toLowerCase();
}

function pathHasAccessContext(path) {
  return path.some((part) =>
    /(key|access|door|lock|pin|smart.?lock|jervis)/i.test(clean(part))
  );
}

export function extractAccessCodeFromLodgifyBooking(booking) {
  const seen = new Set();
  const queue = [{ value: booking, path: [] }];

  while (queue.length > 0) {
    const { value, path } = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => queue.push({ value: item, path: [...path, index] }));
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizedObjectKey(key);
      const childPath = [...path, key];
      const isDirectKey = DIRECT_ACCESS_CODE_KEYS.has(normalizedKey);
      const isContextualKey =
        CONTEXT_ACCESS_CODE_KEYS.has(normalizedKey) && pathHasAccessContext(path);

      if (
        (isDirectKey || isContextualKey) &&
        (typeof child === "string" || typeof child === "number") &&
        isUsableAccessCodeValue(child)
      ) {
        return {
          accessCode: clean(child),
          fieldPath: childPath.map(String).join("."),
        };
      }

      if (child && typeof child === "object") {
        queue.push({ value: child, path: childPath });
      }
    }
  }

  return null;
}

export function extractAccessCodeWebhookPayload(body = {}) {
  const bookingId = normalizeBookingId(
    body.bookingId ||
      body.booking_id ||
      body.reservationId ||
      body.reservation_id ||
      body.lodgifyReservationId ||
      body.lodgify_reservation_id
  );
  const accessCode = clean(
    body.accessCode ||
      body.access_code ||
      body.doorCode ||
      body.door_code ||
      body.lockCode ||
      body.lock_code ||
      body.code
  );

  return {
    bookingId,
    accessCode,
    propertyId: clean(body.propertyId || body.property_id),
    propertyName: clean(body.propertyName || body.property_name),
    guestEmail: clean(body.guestEmail || body.guest_email).toLowerCase(),
    guestName: clean(body.guestName || body.guest_name),
    checkinDate: clean(body.checkinDate || body.checkin_date || body.arrival),
    source: clean(body.source) || "jervis-webhook",
    raw: body && typeof body === "object" ? body : {},
  };
}

export async function getAccessCodeRelease(bookingId) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  if (!normalizedBookingId) return null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("access_code_releases")
    .select("*")
    .eq("booking_id", normalizedBookingId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load access code release: ${error.message}`);
  }

  return data || null;
}

export async function getAccessCodeReleaseByJervisReservationId(reservationId) {
  const normalizedReservationId = clean(reservationId);
  if (!normalizedReservationId) return null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("access_code_releases")
    .select("*")
    .contains("raw_source", { jervisReservationId: normalizedReservationId })
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Jervis access code release: ${error.message}`);
  }

  return data || null;
}

export async function listJervisAccessCodeReleaseRetries({
  limit = 50,
  checkinFrom = "",
  checkinTo = "",
} = {}) {
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("access_code_releases")
    .select("*")
    .is("sent_at", null)
    .in("status", ["pending", "failed"]);

  if (clean(checkinFrom)) {
    query = query.gte("checkin_date", clean(checkinFrom));
  }
  if (clean(checkinTo)) {
    query = query.lte("checkin_date", clean(checkinTo));
  }

  const { data, error } = await query
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 200)));

  if (error) {
    throw new Error(`Failed to load Jervis access code retries: ${error.message}`);
  }

  return data || [];
}

export async function upsertAccessCodeRelease({
  bookingId,
  accessCode,
  propertyId = "",
  propertyName = "",
  guestEmail = "",
  guestName = "",
  checkinDate = "",
  source = "unknown",
  raw = {},
}) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  const normalizedAccessCode = clean(accessCode);
  if (!normalizedBookingId) {
    throw new Error("Cannot save access code without a booking ID.");
  }
  if (!normalizedAccessCode) {
    throw new Error("Cannot save access code without a code value.");
  }

  const existing = await getAccessCodeRelease(normalizedBookingId);
  const supabase = createSupabaseAdminClient();
  const row = {
    booking_id: normalizedBookingId,
    property_id: clean(propertyId) || existing?.property_id || null,
    property_name: clean(propertyName) || existing?.property_name || null,
    guest_email: clean(guestEmail).toLowerCase() || existing?.guest_email || null,
    guest_name: clean(guestName) || existing?.guest_name || null,
    checkin_date: clean(checkinDate) || existing?.checkin_date || null,
    access_code: normalizedAccessCode,
    source: clean(source) || existing?.source || "unknown",
    raw_source: {
      ...(existing?.raw_source && typeof existing.raw_source === "object"
        ? existing.raw_source
        : {}),
      ...(raw && typeof raw === "object" ? raw : {}),
    },
    last_error: null,
  };

  if (!existing) {
    const { data, error } = await supabase
      .from("access_code_releases")
      .insert(row)
      .select("*")
      .single();
    if (error) {
      throw new Error(`Failed to save access code release: ${error.message}`);
    }
    return data;
  }

  const update = {
    ...row,
    status: existing.sent_at ? existing.status : "pending",
  };
  const { data, error } = await supabase
    .from("access_code_releases")
    .update(update)
    .eq("booking_id", normalizedBookingId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to update access code release: ${error.message}`);
  }

  return data;
}

async function upsertAccessCodeReleaseMetadata({
  bookingId,
  propertyId = "",
  propertyName = "",
  guestEmail = "",
  guestName = "",
  checkinDate = "",
  source = "unknown",
  raw = {},
}) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  if (!normalizedBookingId) {
    throw new Error("Cannot save access code metadata without a booking ID.");
  }

  const existing = await getAccessCodeRelease(normalizedBookingId);
  const row = {
    booking_id: normalizedBookingId,
    property_id: clean(propertyId) || existing?.property_id || null,
    property_name: clean(propertyName) || existing?.property_name || null,
    guest_email: clean(guestEmail).toLowerCase() || existing?.guest_email || null,
    guest_name: clean(guestName) || existing?.guest_name || null,
    checkin_date: clean(checkinDate) || existing?.checkin_date || null,
    access_code: existing?.access_code || null,
    source: clean(source) || existing?.source || "unknown",
    status: existing?.sent_at ? existing.status : existing?.status || "pending",
    raw_source: {
      ...(existing?.raw_source && typeof existing.raw_source === "object"
        ? existing.raw_source
        : {}),
      ...(raw && typeof raw === "object" ? raw : {}),
    },
    last_error: existing?.last_error || null,
  };

  const supabase = createSupabaseAdminClient();
  if (!existing) {
    const { data, error } = await supabase
      .from("access_code_releases")
      .insert(row)
      .select("*")
      .single();
    if (error) {
      throw new Error(`Failed to save access code metadata: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase
    .from("access_code_releases")
    .update(row)
    .eq("booking_id", normalizedBookingId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to update access code metadata: ${error.message}`);
  }

  return data;
}

async function fetchJervisAccessCode(booking, config = {}) {
  const endpoint = clean(
    config.jervisAccessCodeApiUrl || process.env.JERVIS_ACCESS_CODE_API_URL
  );
  if (!endpoint) return null;

  const token = clean(config.jervisApiToken || process.env.JERVIS_API_TOKEN);
  const body = {
    bookingId: clean(booking.bookingId),
    propertyId: clean(booking.propertyId),
    propertyName: clean(booking.propertyName),
    guestEmail: clean(booking.guestEmail).toLowerCase(),
    checkinDate: clean(booking.checkinDate),
  };
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      `Jervis code lookup failed: ${response.status} ${response.statusText} ${text.slice(0, 200)}`
    );
  }

  const parsed = extractAccessCodeWebhookPayload({
    ...data,
    bookingId: data.bookingId || data.booking_id || body.bookingId,
    propertyId: data.propertyId || data.property_id || body.propertyId,
    propertyName: data.propertyName || data.property_name || body.propertyName,
    guestEmail: data.guestEmail || data.guest_email || body.guestEmail,
    checkinDate: data.checkinDate || data.checkin_date || body.checkinDate,
    source: data.source || "jervis-api",
  });
  if (!parsed.accessCode) return null;
  return parsed;
}

function existingJervisReservationId(row) {
  const raw = row?.raw_source && typeof row.raw_source === "object" ? row.raw_source : {};
  return clean(
    raw.jervisReservationId ||
      raw.jervis_reservation_id ||
      raw.reservationId ||
      raw.jervis?.reservationId ||
      raw.jervis?.reservation_id
  );
}

// Poll schedule (cumulative ~22.75s) for reading back the Jervis pincode after
// creating a reservation. Reservations without a guest phone get a randomly
// generated pincode, which can take a little longer to appear than the old
// phone-derived code, so allow extra attempts here. A booking whose pincode is
// still not ready when this window closes is retried by the access-code-retry
// cron (its reservation id is persisted), so it self-heals on a later run.
const JERVIS_PINCODE_POLL_DELAYS_MS = [0, 750, 1500, 2500, 4000, 6000, 8000];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJervisReservationWithPincode(reservationId, config = {}) {
  let latestReservation = null;

  for (const delay of JERVIS_PINCODE_POLL_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    latestReservation = await getJervisReservation(reservationId, config);
    const pincode = extractJervisPincode(latestReservation);
    if (pincode) {
      return {
        reservation: latestReservation,
        pincode,
        attempts: JERVIS_PINCODE_POLL_DELAYS_MS.indexOf(delay) + 1,
      };
    }
  }

  return {
    reservation: latestReservation,
    pincode: "",
    attempts: JERVIS_PINCODE_POLL_DELAYS_MS.length,
  };
}

function isJervisPhoneValidationError(err) {
  return /phone number must be valid/i.test(String(err?.message || ""));
}

// Jervis validates the guest phone even when we omit it, because it merges
// guest data from its own Lodgify/OTA sync — and Expedia supplies masked
// numbers that fail its "Phone number must be valid" check (booking 21221423
// failed exactly this way). Overriding with a throwaway number passes
// validation; Jervis derives the pincode from the phone's last 4 digits, so a
// random number keeps door codes random and unknown to the guest, and Jervis
// never messages the reservation phone in our setup (delivery goes through
// Lodgify).
function randomJervisFallbackPhone() {
  let digits = "";
  while (digits.length < 7) {
    digits += Math.floor(Math.random() * 10);
  }
  return `+1512${digits}`;
}

// The PUT that re-sends reservation details is only a best-effort refresh once
// the reservation exists: Jervis can 400 it for data we don't control. The
// pincode may already be provisioned on the reservation, so an update failure
// must not abort the lookup — capture the error and let the pincode poll
// decide. Phone-validation failures get one retry with a fallback phone.
async function updateJervisReservationTolerantly(reservationId, payload, config) {
  try {
    await updateJervisReservation(reservationId, payload, config);
    return "";
  } catch (err) {
    if (isJervisPhoneValidationError(err)) {
      try {
        await updateJervisReservation(
          reservationId,
          { ...payload, phone: randomJervisFallbackPhone() },
          config
        );
        return "";
      } catch (retryErr) {
        return clean(retryErr?.message) || "Jervis reservation update failed.";
      }
    }
    return clean(err?.message) || "Jervis reservation update failed.";
  }
}

async function fetchJervisDirectAccessCode(booking, config = {}, existing = null) {
  if (!isJervisConfigured(config)) return null;

  let jervisReservationId = existingJervisReservationId(existing);
  let jervisPropertyId = clean(existing?.raw_source?.jervisPropertyId);
  let jervisPropertySource = clean(existing?.raw_source?.jervisPropertySource);
  let createResponse = null;
  let jervisUpdateError = "";

  if (!jervisReservationId) {
    const resolvedProperty = await resolveJervisPropertyId(booking, config);
    jervisPropertyId = resolvedProperty.propertyId;
    jervisPropertySource = resolvedProperty.source;
    if (!jervisPropertyId) return null;

    const payload = jervisReservationPayload(booking, config);
    if (!payload.email || !payload.start_date || !payload.end_date) {
      throw new Error(
        "Jervis reservation requires guest email, check-in date, and check-out date."
      );
    }

    // Jervis keys reservations by its OWN id (returned on create and persisted
    // in raw_source.jervisReservationId, read above). Do NOT look one up by the
    // Lodgify booking id — that is the wrong id namespace: it either re-throws a
    // non-404 Jervis error (blocking delivery) or matches an unrelated
    // reservation and skips the update below that generates the pincode, so the
    // poll returns no code. Always create, then update to provision the pincode.
    try {
      createResponse = await createJervisReservation(jervisPropertyId, payload, config);
    } catch (err) {
      if (!isJervisPhoneValidationError(err)) throw err;
      createResponse = await createJervisReservation(
        jervisPropertyId,
        { ...payload, phone: randomJervisFallbackPhone() },
        config
      );
    }
    jervisReservationId = extractJervisReservationId(createResponse);
    if (!jervisReservationId) {
      throw new Error("Jervis reservation was created but no reservation ID was returned.");
    }

    // Persist the reservation id BEFORE the update call. If the update throws
    // (e.g. Jervis rejects a phone it synced from the OTA side with
    // "Phone number must be valid"), a lost id would make every retry create a
    // brand-new Jervis reservation and fail the same way forever.
    await upsertAccessCodeReleaseMetadata({
      bookingId: booking.bookingId,
      propertyId: booking.propertyId,
      propertyName: booking.propertyName,
      guestEmail: booking.guestEmail,
      guestName: booking.guestName,
      checkinDate: booking.checkinDate,
      source: "jervis-direct-api",
      raw: {
        jervisReservationId,
        jervisPropertyId,
        jervisPropertySource,
        jervisCreateResponse: createResponse,
      },
    });

    jervisUpdateError = await updateJervisReservationTolerantly(
      jervisReservationId,
      payload,
      config
    );
  } else {
    const payload = jervisReservationPayload(booking, config);
    if (payload.email && payload.start_date && payload.end_date) {
      jervisUpdateError = await updateJervisReservationTolerantly(
        jervisReservationId,
        payload,
        config
      );
    }
  }

  const { reservation, pincode, attempts } = await getJervisReservationWithPincode(
    jervisReservationId,
    config
  );
  if (!pincode) {
    await upsertAccessCodeReleaseMetadata({
      bookingId: booking.bookingId,
      propertyId: booking.propertyId,
      propertyName: booking.propertyName,
      guestEmail: booking.guestEmail,
      guestName: booking.guestName,
      checkinDate: booking.checkinDate,
      source: "jervis-direct-api",
      raw: {
        jervisReservationId,
        jervisPropertyId,
        jervisPropertySource,
        jervisCreateResponse: createResponse || undefined,
        jervisPincodePollAttempts: attempts,
        jervisReservation: reservation,
        ...(jervisUpdateError ? { jervisUpdateError } : {}),
      },
    });
    throw new Error(
      `Jervis reservation ${jervisReservationId} did not return a pincode after ${attempts} checks.${
        jervisUpdateError ? ` Reservation update also failed: ${jervisUpdateError}` : ""
      }`
    );
  }

  return {
    bookingId: booking.bookingId,
    accessCode: pincode,
    propertyId: booking.propertyId,
    propertyName: booking.propertyName,
    guestEmail: booking.guestEmail,
    guestName: booking.guestName,
    checkinDate: booking.checkinDate,
    source: "jervis-direct-api",
    raw: {
      jervisReservationId,
      jervisPropertyId,
      jervisPropertySource,
      jervisCreateResponse: createResponse || undefined,
      jervisPincodePollAttempts: attempts,
      jervisReservation: reservation,
    },
  };
}

export async function resolveAccessCodeForBooking(booking, config = {}) {
  const bookingId = normalizeBookingId(booking.bookingId);
  if (!bookingId) return { code: "", source: "", row: null };

  const existing = await getAccessCodeRelease(bookingId);
  const staticCodeAllowed = propertyAllowsConfiguredStaticCode(booking, config);
  if (
    existing?.access_code &&
    (existing.source !== "property-code-config" || staticCodeAllowed)
  ) {
    return {
      code: existing.access_code,
      source: existing.source || "stored",
      row: existing,
    };
  }

  const propertyCodes = normalizePropertyCodeMap(
    config.propertyCodes || config.staticCodesByProperty
  );
  const propertyCode = staticCodeAllowed ? lookupPropertyCode(propertyCodes, booking) : "";
  if (propertyCode) {
    const row = await upsertAccessCodeRelease({
      bookingId,
      accessCode: propertyCode,
      propertyId: booking.propertyId,
      propertyName: booking.propertyName,
      guestEmail: booking.guestEmail,
      guestName: booking.guestName,
      checkinDate: booking.checkinDate,
      source: "property-code-config",
      raw: { propertyId: booking.propertyId, propertyName: booking.propertyName },
    });
    return { code: row.access_code, source: row.source, row };
  }

  const jervisDirectPayload = await fetchJervisDirectAccessCode(
    booking,
    config,
    existing
  );
  if (jervisDirectPayload?.accessCode) {
    const row = await upsertAccessCodeRelease({
      ...jervisDirectPayload,
      propertyId: jervisDirectPayload.propertyId || booking.propertyId,
      propertyName: jervisDirectPayload.propertyName || booking.propertyName,
      guestEmail: jervisDirectPayload.guestEmail || booking.guestEmail,
      guestName: jervisDirectPayload.guestName || booking.guestName,
      checkinDate: jervisDirectPayload.checkinDate || booking.checkinDate,
    });
    return { code: row.access_code, source: row.source, row };
  }

  const lodgifyCode = extractAccessCodeFromLodgifyBooking(
    booking.lodgifyBooking || booking.rawBooking || booking.raw
  );
  if (lodgifyCode?.accessCode) {
    const row = await upsertAccessCodeRelease({
      bookingId,
      accessCode: lodgifyCode.accessCode,
      propertyId: booking.propertyId,
      propertyName: booking.propertyName,
      guestEmail: booking.guestEmail,
      guestName: booking.guestName,
      checkinDate: booking.checkinDate,
      source: "lodgify-booking-payload",
      raw: {
        fieldPath: lodgifyCode.fieldPath,
        propertyId: booking.propertyId,
        propertyName: booking.propertyName,
      },
    });
    return { code: row.access_code, source: row.source, row };
  }

  const jervisPayload = await fetchJervisAccessCode(booking, config);
  if (jervisPayload?.accessCode) {
    const row = await upsertAccessCodeRelease({
      ...jervisPayload,
      propertyId: jervisPayload.propertyId || booking.propertyId,
      propertyName: jervisPayload.propertyName || booking.propertyName,
      guestEmail: jervisPayload.guestEmail || booking.guestEmail,
      guestName: jervisPayload.guestName || booking.guestName,
      checkinDate: jervisPayload.checkinDate || booking.checkinDate,
    });
    return { code: row.access_code, source: row.source, row };
  }

  return { code: "", source: "", row: existing };
}

export async function markAccessCodeReleaseSent({
  bookingId,
  templateId,
  channel = "email",
  raw = {},
}) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  if (!normalizedBookingId) return null;

  const existing = await getAccessCodeRelease(normalizedBookingId);
  const rawSource =
    raw && typeof raw === "object" && Object.keys(raw).length > 0
      ? {
          ...(existing?.raw_source && typeof existing.raw_source === "object"
            ? existing.raw_source
            : {}),
          ...raw,
        }
      : null;

  const update = {
    status: "sent",
    sent_at: new Date().toISOString(),
    last_attempt_at: new Date().toISOString(),
    last_error: null,
    channel,
    sendgrid_template_id: clean(templateId) || null,
  };
  if (rawSource) update.raw_source = rawSource;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("access_code_releases")
    .update(update)
    .eq("booking_id", normalizedBookingId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to mark access code sent: ${error.message}`);
  }

  return data;
}

export async function markAccessCodeReleaseBlocked({
  bookingId,
  propertyId = "",
  propertyName = "",
  guestEmail = "",
  guestName = "",
  checkinDate = "",
  templateId = "",
  channel = "email",
  error = "Form not submitted yet.",
  raw = {},
}) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  if (!normalizedBookingId) return null;

  const existing = await getAccessCodeRelease(normalizedBookingId);
  if (existing?.sent_at || existing?.status === "sent") {
    return existing;
  }

  const row = {
    booking_id: normalizedBookingId,
    property_id: clean(propertyId) || existing?.property_id || null,
    property_name: clean(propertyName) || existing?.property_name || null,
    guest_email: clean(guestEmail).toLowerCase() || existing?.guest_email || null,
    guest_name: clean(guestName) || existing?.guest_name || null,
    checkin_date: clean(checkinDate) || existing?.checkin_date || null,
    access_code: existing?.access_code || null,
    source: existing?.source || "form-gate",
    status: "blocked",
    channel: clean(channel) || "email",
    sendgrid_template_id: clean(templateId) || existing?.sendgrid_template_id || null,
    last_attempt_at: new Date().toISOString(),
    last_error: clean(error).slice(0, 1000) || "Form not submitted yet.",
    raw_source: {
      ...(existing?.raw_source && typeof existing.raw_source === "object"
        ? existing.raw_source
        : {}),
      ...(raw && typeof raw === "object" ? raw : {}),
    },
  };

  const supabase = createSupabaseAdminClient();
  if (!existing) {
    const { data, error: insertError } = await supabase
      .from("access_code_releases")
      .insert(row)
      .select("*")
      .single();

    if (insertError) {
      throw new Error(`Failed to save blocked access code release: ${insertError.message}`);
    }

    return data;
  }

  const { data, error: updateError } = await supabase
    .from("access_code_releases")
    .update(row)
    .eq("booking_id", normalizedBookingId)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Failed to update blocked access code release: ${updateError.message}`);
  }

  return data;
}

export async function markAccessCodeReleaseFailed({
  bookingId,
  error,
  status = "failed",
  propertyId = "",
  propertyName = "",
  guestEmail = "",
  guestName = "",
  checkinDate = "",
  source = "unknown",
  channel = "email",
  templateId = "",
  raw = {},
}) {
  const normalizedBookingId = normalizeBookingId(bookingId);
  if (!normalizedBookingId) return null;

  const existing = await getAccessCodeRelease(normalizedBookingId);
  const row = {
    booking_id: normalizedBookingId,
    property_id: clean(propertyId) || existing?.property_id || null,
    property_name: clean(propertyName) || existing?.property_name || null,
    guest_email: clean(guestEmail).toLowerCase() || existing?.guest_email || null,
    guest_name: clean(guestName) || existing?.guest_name || null,
    checkin_date: clean(checkinDate) || existing?.checkin_date || null,
    access_code: existing?.access_code || null,
    source: clean(source) || existing?.source || "unknown",
    status,
    channel: clean(channel) || existing?.channel || "email",
    sendgrid_template_id: clean(templateId) || existing?.sendgrid_template_id || null,
    last_attempt_at: new Date().toISOString(),
    last_error: clean(error).slice(0, 1000) || "Unknown error",
    raw_source: {
      ...(existing?.raw_source && typeof existing.raw_source === "object"
        ? existing.raw_source
        : {}),
      ...(raw && typeof raw === "object" ? raw : {}),
    },
  };

  const supabase = createSupabaseAdminClient();
  if (!existing) {
    const { data, error: insertError } = await supabase
      .from("access_code_releases")
      .insert(row)
      .select("*")
      .single();

    if (insertError) {
      throw new Error(`Failed to save access code failure: ${insertError.message}`);
    }

    return data;
  }

  const { data, error: updateError } = await supabase
    .from("access_code_releases")
    .update(row)
    .eq("booking_id", normalizedBookingId)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Failed to mark access code failure: ${updateError.message}`);
  }

  return data;
}
