const DEFAULT_BASE_URL = "https://www.jervis.systems/api/v1";

function clean(value) {
  return String(value || "").trim();
}

function normalizeLookupKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return "";
}

function splitName(fullName) {
  const parts = clean(fullName).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function jervisBaseUrl(config = {}) {
  return clean(config.jervisApiBaseUrl || process.env.JERVIS_API_BASE_URL || DEFAULT_BASE_URL)
    .replace(/\/+$/, "");
}

function jervisUuid(config = {}) {
  return clean(config.jervisAccountUuid || process.env.JERVIS_ACCOUNT_UUID);
}

function jervisToken(config = {}) {
  return clean(process.env.JERVIS_API_TOKEN || config.jervisApiToken);
}

function jervisHeaders(config = {}, accept = "application/json") {
  const token = jervisToken(config);
  const uuid = jervisUuid(config);
  if (!token) {
    throw new Error("JERVIS_API_TOKEN is not set.");
  }
  if (!uuid) {
    throw new Error("JERVIS_ACCOUNT_UUID is not set.");
  }

  return {
    accept,
    Authorization: `Bearer ${token}`,
    uuid,
    "Content-Type": "application/json",
  };
}

async function readJervisJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function jervisRequest(path, { config = {}, method = "GET", body, accept } = {}) {
  const url = `${jervisBaseUrl(config)}${path}`;
  const response = await fetch(url, {
    method,
    headers: jervisHeaders(config, accept),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await readJervisJson(response);
  if (!response.ok) {
    throw new Error(
      `Jervis API error: ${response.status} ${response.statusText} | ${url} | ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  return data;
}

export function isJervisConfigured(config = {}) {
  return Boolean(jervisToken(config) && jervisUuid(config));
}

export async function getJervisProperties(config = {}) {
  const data = await jervisRequest("/properties/", { config });
  return Array.isArray(data?.data) ? data.data : [];
}

export async function getJervisReservation(reservationId, config = {}) {
  const id = encodeURIComponent(clean(reservationId));
  if (!id) return null;
  const data = await jervisRequest(`/reservations/${id}`, {
    config,
    accept: "text/plain",
  });
  return data?.data || data || null;
}

export async function createJervisReservation(propertyId, reservation, config = {}) {
  const id = encodeURIComponent(clean(propertyId));
  if (!id) throw new Error("Missing Jervis property ID.");
  return jervisRequest(`/reservations/${id}`, {
    config,
    method: "POST",
    body: reservation,
  });
}

export async function updateJervisReservation(reservationId, reservation, config = {}) {
  const id = encodeURIComponent(clean(reservationId));
  if (!id) throw new Error("Missing Jervis reservation ID.");
  return jervisRequest(`/reservations/${id}`, {
    config,
    method: "PUT",
    accept: "text/plain",
    body: reservation,
  });
}

function configuredObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function lookupMappedPropertyId(booking, config = {}) {
  const map = configuredObject(config.jervisPropertyIds || config.jervisPropertyMap);
  const candidates = [
    clean(booking.propertyId),
    clean(booking.propertyName),
    normalizeLookupKey(booking.propertyId),
    normalizeLookupKey(booking.propertyName),
  ].filter(Boolean);

  for (const key of candidates) {
    if (map[key]) return clean(map[key]);
  }

  for (const [key, value] of Object.entries(map)) {
    const normalizedKey = normalizeLookupKey(key);
    if (
      candidates.some(
        (candidate) =>
          candidate === normalizedKey ||
          candidate.includes(normalizedKey) ||
          normalizedKey.includes(candidate)
      )
    ) {
      return clean(value);
    }
  }

  return "";
}

function propertyMatchesBooking(property, booking) {
  const platformPropertyId = clean(property.platform_property_id);
  const jervisTitle = clean(property.title);
  const bookingPropertyId = clean(booking.propertyId);
  const bookingPropertyName = clean(booking.propertyName);

  if (platformPropertyId && bookingPropertyId && platformPropertyId === bookingPropertyId) {
    return true;
  }

  const titleKey = normalizeLookupKey(jervisTitle);
  const nameKey = normalizeLookupKey(bookingPropertyName);
  return Boolean(
    titleKey &&
      nameKey &&
      (titleKey === nameKey || titleKey.includes(nameKey) || nameKey.includes(titleKey))
  );
}

export async function resolveJervisPropertyId(booking, config = {}) {
  const mapped = lookupMappedPropertyId(booking, config);
  if (mapped) return { propertyId: mapped, source: "config" };

  const properties = await getJervisProperties(config);
  const matched = properties.find((property) => propertyMatchesBooking(property, booking));
  if (!matched?.id) {
    return { propertyId: "", source: "", properties };
  }

  return { propertyId: clean(matched.id), source: "properties", properties };
}

function centralIsoDateTime(dateOnly, time) {
  const date = clean(dateOnly);
  if (!date) return "";
  const normalizedTime = clean(time) || "15:00:00";
  return `${date}T${normalizedTime.length === 5 ? `${normalizedTime}:00` : normalizedTime}`;
}

// Per-arrival-date overrides of the standard door-code window, e.g. a retreat
// whose guests may enter before the normal 3 PM check-in. Each entry:
// { checkinDate: "YYYY-MM-DD", accessStartTime: "HH:MM:SS", checkinTimeLabel }.
export function accessWindowOverrideFor(checkinDate, config = {}) {
  const date = clean(checkinDate).slice(0, 10);
  if (!date || !Array.isArray(config.accessWindowOverrides)) return null;
  return config.accessWindowOverrides.find((o) => clean(o?.checkinDate) === date) || null;
}

export function jervisReservationPayload(booking, config = {}) {
  const override = accessWindowOverrideFor(booking.checkinDate, config);
  const derived = splitName(booking.guestName);
  // Deliberately no phone: when Jervis receives a guest phone it sets the door
  // pincode to the last 4 digits of it, which a guest exploited to enter a unit
  // before completing the required forms. Without a phone Jervis generates a
  // random pincode instead.
  return {
    first_name: firstNonEmpty([booking.guestFirstName, derived.firstName, "Guest"]),
    last_name: firstNonEmpty([booking.guestLastName, derived.lastName, "."]),
    email: clean(booking.guestEmail),
    start_date: centralIsoDateTime(
      booking.checkinDate,
      override?.accessStartTime ||
        config.jervisAccessStartTime ||
        config.checkinTime ||
        "15:00:00"
    ),
    end_date: centralIsoDateTime(
      booking.checkoutDate,
      config.jervisAccessEndTime || config.checkoutTime || "11:00:00"
    ),
  };
}

export function extractJervisPincode(reservation) {
  return firstNonEmpty([
    reservation?.pincode,
    reservation?.pin_code,
    reservation?.pinCode,
    reservation?.access_code,
    reservation?.accessCode,
    reservation?.code,
  ]);
}

export function extractJervisReservationId(response) {
  return firstNonEmpty([
    response?.reservationId,
    response?.reservation_id,
    response?.id,
    response?.data?.reservationId,
    response?.data?.reservation_id,
    response?.data?.id,
  ]);
}
