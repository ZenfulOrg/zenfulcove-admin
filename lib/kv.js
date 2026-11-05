import { Redis } from "@upstash/redis";
import { automationConfig as defaults } from "@/config/automations";
import {
  BIRTHDAY_PACKAGE_DESCRIPTION,
  DEFAULT_PACKAGE_PRODUCTS,
  packageProductIdentity,
} from "@/lib/commerce";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token:
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CONFIG_KEY = "zenfulcove:config";
const COMPANY_DISPLAY_NAME = "Zenfulcove Glamping";
const DEFAULT_GOOGLE_MAPS_ADDRESS = "103 potato smith rd, unit c, elgin texas 78621";
const DEFAULT_GOOGLE_MAPS_URL = "https://maps.app.goo.gl/QowaHLFH3anBavuv6?g_st=ic";
const EVENT_POPUP_CONTACT_KEY_PREFIX = "zenfulcove:event-popup:contact:";
const EVENT_POPUP_SMS_SENT_KEY_PREFIX = "zenfulcove:event-popup:sms-sent:";
const POPUP_FOLLOWUP_SENT_KEY_PREFIX = "zenfulcove:popup:sent:";
const SALESMATE_FORM_SYNC_KEY_PREFIX = "zenfulcove:salesmate-form-sync:";
const SMS_MESSAGES_KEY_PREFIX = "zenfulcove:sms:msgs:";
const SMS_THREAD_INDEX_KEY_PREFIX = "zenfulcove:sms:idx:";
const SMS_THREAD_META_KEY_PREFIX = "zenfulcove:sms:meta:";
const SMS_SEEN_KEY_PREFIX = "zenfulcove:sms:seen:";
const SMS_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const STAY_MESSAGES_KEY_PREFIX = "zenfulcove:stay:msgs:";
const STAY_MESSAGES_SEEN_KEY_PREFIX = "zenfulcove:stay:seen:";
const STAY_MESSAGES_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const COMMERCE_PRODUCTS_KEY = "zenfulcove:commerce:products";
const COMMERCE_DEFAULTS_SEEDED_KEY = "zenfulcove:commerce:defaults-seeded";
const COMMERCE_BIRTHDAY_DETAILS_MIGRATED_KEY =
  "zenfulcove:commerce:migration:2026-08-birthday-details-v1";
const COMMERCE_PURCHASE_KEY_PREFIX = "zenfulcove:commerce:purchase:";
const COMMERCE_PURCHASES_BY_RESERVATION_KEY_PREFIX =
  "zenfulcove:commerce:purchases:";
const COMMERCE_FULFILLMENT_LOCK_KEY_PREFIX = "zenfulcove:commerce:fulfill-lock:";

function normalizeLedgerKey(value) {
  return encodeURIComponent(String(value || "").trim().toLowerCase());
}

function normalizePropertyMessageData(map = {}) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      next[key] = value;
      continue;
    }
    const entry = { ...value };
    const address = String(entry.address || "").trim();
    if (
      !address ||
      /103\s+potato\s+smith/i.test(address)
    ) {
      entry.address = DEFAULT_GOOGLE_MAPS_ADDRESS;
    }
    if (!String(entry.googleMapsAddress || "").trim()) {
      entry.googleMapsAddress = DEFAULT_GOOGLE_MAPS_ADDRESS;
    }
    if (!String(entry.googleMapsUrl || entry.googleMapsURL || "").trim()) {
      entry.googleMapsUrl = DEFAULT_GOOGLE_MAPS_URL;
    }
    next[key] = entry;
  }
  return next;
}

function mergeNamedSectionDefaults(defaultSections = {}, configuredSections = {}) {
  const sections =
    configuredSections && typeof configuredSections === "object" && !Array.isArray(configuredSections)
      ? configuredSections
      : {};
  const keys = new Set([
    ...Object.keys(defaultSections || {}),
    ...Object.keys(sections || {}),
  ]);

  return Array.from(keys).reduce((merged, key) => {
    const defaultValue =
      defaultSections?.[key] &&
      typeof defaultSections[key] === "object" &&
      !Array.isArray(defaultSections[key])
        ? defaultSections[key]
        : {};
    const configuredValue =
      sections?.[key] &&
      typeof sections[key] === "object" &&
      !Array.isArray(sections[key])
        ? sections[key]
        : {};
    merged[key] = {
      ...defaultValue,
      ...configuredValue,
    };
    return merged;
  }, {});
}

function smsKeyFor(twilioNumber, contactPhone) {
  return `${normalizeLedgerKey(twilioNumber)}:${normalizeLedgerKey(contactPhone)}`;
}

export async function appendSmsMessage({ twilioNumber, contactPhone, message, suppressUnread = false }) {
  if (!twilioNumber || !contactPhone || !message) return;
  const composite = smsKeyFor(twilioNumber, contactPhone);
  const messagesKey = `${SMS_MESSAGES_KEY_PREFIX}${composite}`;
  const indexKey = `${SMS_THREAD_INDEX_KEY_PREFIX}${normalizeLedgerKey(twilioNumber)}`;
  const metaKey = `${SMS_THREAD_META_KEY_PREFIX}${composite}`;
  const seenKey = `${SMS_SEEN_KEY_PREFIX}${composite}`;

  const sid = String(message.sid || message.id || "").trim();
  if (sid) {
    const added = await redis.sadd(seenKey, sid);
    if (added === 0) return;
  }

  const ts = Number(message.timestamp) || Date.now();
  const score = ts;
  const member = JSON.stringify({ ...message, timestamp: ts });

  const cutoff = Date.now() - SMS_RETENTION_MS;

  await Promise.all([
    redis.zadd(messagesKey, { score, member }),
    redis.zremrangebyscore(messagesKey, 0, cutoff),
    redis.zadd(indexKey, { score, member: String(contactPhone) }),
  ]);

  const existingMeta = (await redis.get(metaKey)) || {};
  const isNewerThanExisting = ts >= (existingMeta.lastMessageAt || 0);
  const shouldBumpUnread = !suppressUnread && message.direction === "in";
  const incomingUnread = shouldBumpUnread
    ? (existingMeta.unreadCount || 0) + 1
    : existingMeta.unreadCount || 0;

  const meta = isNewerThanExisting
    ? {
        twilioNumber: String(twilioNumber),
        contactPhone: String(contactPhone),
        lastMessageAt: ts,
        lastMessagePreview: String(message.body || "").slice(0, 140),
        lastMessageDirection: message.direction || "in",
        unreadCount: incomingUnread,
      }
    : { ...existingMeta, unreadCount: incomingUnread };

  await redis.set(metaKey, meta);
}

export async function listSmsThreads(twilioNumber, { limit = 100 } = {}) {
  if (!twilioNumber) return [];
  const indexKey = `${SMS_THREAD_INDEX_KEY_PREFIX}${normalizeLedgerKey(twilioNumber)}`;
  const phones = await redis.zrange(indexKey, 0, Math.max(0, limit - 1), { rev: true });
  if (!phones?.length) return [];

  const metaKeys = phones.map(
    (phone) => `${SMS_THREAD_META_KEY_PREFIX}${smsKeyFor(twilioNumber, phone)}`
  );
  const metas = await Promise.all(metaKeys.map((key) => redis.get(key)));
  return metas
    .map((meta, i) => meta || { twilioNumber, contactPhone: phones[i], lastMessageAt: 0, lastMessagePreview: "", unreadCount: 0 })
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

export async function listSmsMessages({ twilioNumber, contactPhone, limit = 200 }) {
  if (!twilioNumber || !contactPhone) return [];
  const messagesKey = `${SMS_MESSAGES_KEY_PREFIX}${smsKeyFor(twilioNumber, contactPhone)}`;
  const raw = await redis.zrange(messagesKey, -limit, -1);
  return (raw || []).map((entry) => {
    if (typeof entry === "string") {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    }
    return entry;
  }).filter(Boolean);
}

async function scanAndDelete(pattern) {
  let cursor = "0";
  let total = 0;
  do {
    const result = await redis.scan(cursor, { match: pattern, count: 500 });
    cursor = String(result[0]);
    const keys = result[1] || [];
    if (keys.length) {
      await redis.del(...keys);
      total += keys.length;
    }
  } while (cursor !== "0");
  return total;
}

export async function clearAllSmsData(twilioNumber) {
  const numberSuffix = twilioNumber ? `${normalizeLedgerKey(twilioNumber)}*` : "*";
  const messagePattern = `${SMS_MESSAGES_KEY_PREFIX}${numberSuffix}`;
  const metaPattern = `${SMS_THREAD_META_KEY_PREFIX}${numberSuffix}`;
  const seenPattern = `${SMS_SEEN_KEY_PREFIX}${numberSuffix}`;

  const [msgsDeleted, metaDeleted] = await Promise.all([
    scanAndDelete(messagePattern),
    scanAndDelete(metaPattern),
    scanAndDelete(seenPattern),
  ]);

  let indexDeleted = 0;
  if (twilioNumber) {
    const indexKey = `${SMS_THREAD_INDEX_KEY_PREFIX}${normalizeLedgerKey(twilioNumber)}`;
    indexDeleted = (await redis.del(indexKey)) || 0;
  } else {
    indexDeleted = await scanAndDelete(`${SMS_THREAD_INDEX_KEY_PREFIX}*`);
  }

  return { messagesCleared: msgsDeleted, metaCleared: metaDeleted, indexCleared: indexDeleted };
}

export async function getPopupFollowupSent(contactKey, followupId) {
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  const normalizedFollowupId = normalizeLedgerKey(followupId);
  if (!normalizedContactKey || !normalizedFollowupId) return null;
  return redis.get(`${POPUP_FOLLOWUP_SENT_KEY_PREFIX}${normalizedContactKey}:${normalizedFollowupId}`);
}

export async function setPopupFollowupSent(contactKey, followupId, state) {
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  const normalizedFollowupId = normalizeLedgerKey(followupId);
  if (!normalizedContactKey || !normalizedFollowupId) return;
  await redis.set(`${POPUP_FOLLOWUP_SENT_KEY_PREFIX}${normalizedContactKey}:${normalizedFollowupId}`, state);
}

export async function markSmsThreadRead({ twilioNumber, contactPhone }) {
  if (!twilioNumber || !contactPhone) return;
  const metaKey = `${SMS_THREAD_META_KEY_PREFIX}${smsKeyFor(twilioNumber, contactPhone)}`;
  const meta = (await redis.get(metaKey)) || {};
  await redis.set(metaKey, { ...meta, twilioNumber, contactPhone, unreadCount: 0 });
}

export async function appendStayMessage({ bookingId, message }) {
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId || !message) return;

  const composite = normalizeLedgerKey(normalizedBookingId);
  const messagesKey = `${STAY_MESSAGES_KEY_PREFIX}${composite}`;
  const seenKey = `${STAY_MESSAGES_SEEN_KEY_PREFIX}${composite}`;
  const id = String(message.id || message.sid || "").trim();
  if (id) {
    const added = await redis.sadd(seenKey, id);
    if (added === 0) return;
  }

  const ts = Number(message.timestamp) || Date.now();
  const cutoff = Date.now() - STAY_MESSAGES_RETENTION_MS;
  await Promise.all([
    redis.zadd(messagesKey, {
      score: ts,
      member: JSON.stringify({ ...message, bookingId: normalizedBookingId, timestamp: ts }),
    }),
    redis.zremrangebyscore(messagesKey, 0, cutoff),
  ]);
}

export async function listStayMessages({ bookingId, limit = 200 }) {
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId) return [];

  const messagesKey = `${STAY_MESSAGES_KEY_PREFIX}${normalizeLedgerKey(normalizedBookingId)}`;
  const raw = await redis.zrange(messagesKey, -Math.max(1, Number(limit) || 200), -1);
  return (raw || [])
    .map((entry) => {
      if (typeof entry === "string") {
        try {
          return JSON.parse(entry);
        } catch {
          return null;
        }
      }
      return entry;
    })
    .filter(Boolean);
}

export async function getConfig() {
  let config = await redis.get(CONFIG_KEY);

  if (!config) {
    await redis.set(CONFIG_KEY, defaults);
    return defaults;
  }

  const accessCodeRelease = {
    ...defaults.accessCodeRelease,
    ...config.accessCodeRelease,
    propertyIds: config.accessCodeRelease?.propertyIds || defaults.accessCodeRelease.propertyIds,
    propertyCodes: {
      ...defaults.accessCodeRelease?.propertyCodes,
      ...config.accessCodeRelease?.propertyCodes,
    },
    jervisPropertyIds: {
      ...defaults.accessCodeRelease?.jervisPropertyIds,
      ...config.accessCodeRelease?.jervisPropertyIds,
    },
    propertyMessageData: {
      ...defaults.accessCodeRelease?.propertyMessageData,
      ...config.accessCodeRelease?.propertyMessageData,
    },
  };
  accessCodeRelease.propertyMessageData = normalizePropertyMessageData(
    accessCodeRelease.propertyMessageData
  );

  if (
    Number(config.accessCodeRelease?.waiverLodgifyScheduleVersion || 0) < 2
  ) {
    accessCodeRelease.waiverLodgifyScheduleVersion = 2;
    if (Number(accessCodeRelease.releaseHourCentral) === 11) {
      accessCodeRelease.releaseHourCentral =
        defaults.accessCodeRelease.releaseHourCentral;
    }
  }

  const sendgrid = {
    ...defaults.sendgrid,
    ...config.sendgrid,
  };
  if (String(sendgrid.fromName || "").trim() === "Zenfulcove") {
    sendgrid.fromName = COMPANY_DISPLAY_NAME;
  }

  const messageNotifications = {
    ...defaults.messageNotifications,
    ...config.messageNotifications,
  };
  if (String(messageNotifications.subjectPrefix || "").trim() === "[Zenfulcove SMS]") {
    messageNotifications.subjectPrefix = "[Zenfulcove Glamping SMS]";
  }

  return {
    ...defaults,
    ...config,
    sendgrid,
    vacancyEmails: {
      ...defaults.vacancyEmails,
      ...config.vacancyEmails,
      windows: config.vacancyEmails?.windows || defaults.vacancyEmails.windows,
    },
    waiverReminders: {
      ...defaults.waiverReminders,
      ...config.waiverReminders,
      emails: config.waiverReminders?.emails || config.waiverReminders?.reminders || defaults.waiverReminders.emails,
    },
    accessCodeRelease,
    popupFollowups: {
      ...defaults.popupFollowups,
      ...config.popupFollowups,
      testDestinations: {
        ...defaults.popupFollowups.testDestinations,
        ...config.popupFollowups?.testDestinations,
      },
      emails: config.popupFollowups?.emails || defaults.popupFollowups.emails,
      sms: config.popupFollowups?.sms || defaults.popupFollowups.sms,
    },
    eventPopupSalesmateSms: {
      ...defaults.eventPopupSalesmateSms,
      ...config.eventPopupSalesmateSms,
      testDestinations: {
        ...defaults.eventPopupSalesmateSms.testDestinations,
        ...config.eventPopupSalesmateSms?.testDestinations,
      },
      sms: config.eventPopupSalesmateSms?.sms || defaults.eventPopupSalesmateSms.sms,
    },
    jotformClientSync: {
      ...defaults.jotformClientSync,
      ...config.jotformClientSync,
      jotformFormIds: config.jotformClientSync?.jotformFormIds || defaults.jotformClientSync.jotformFormIds,
    },
    localFormClientSync: {
      ...defaults.localFormClientSync,
      ...config.localFormClientSync,
      formSlugs: config.localFormClientSync?.formSlugs || defaults.localFormClientSync.formSlugs,
    },
    jotformLocalFormImport: {
      ...defaults.jotformLocalFormImport,
      ...config.jotformLocalFormImport,
      mappings: config.jotformLocalFormImport?.mappings || defaults.jotformLocalFormImport.mappings,
    },
    lodgifyClientSync: {
      ...defaults.lodgifyClientSync,
      ...config.lodgifyClientSync,
    },
    salesmateFormSync: {
      ...defaults.salesmateFormSync,
      ...config.salesmateFormSync,
    },
    messageNotifications,
    customerPortal: {
      ...defaults.customerPortal,
      ...config.customerPortal,
      navigation: {
        ...defaults.customerPortal?.navigation,
        ...config.customerPortal?.navigation,
      },
      myStaySections: mergeNamedSectionDefaults(
        defaults.customerPortal?.myStaySections,
        config.customerPortal?.myStaySections
      ),
    },
    eventPortal: {
      ...defaults.eventPortal,
      ...config.eventPortal,
      events: Array.isArray(config.eventPortal?.events)
        ? config.eventPortal.events
        : defaults.eventPortal?.events || [],
    },
    spaSettings: {
      ...defaults.spaSettings,
      ...config.spaSettings,
      masterHours: {
        ...defaults.spaSettings?.masterHours,
        ...config.spaSettings?.masterHours,
      },
    },
  };
}

export async function setConfig(config) {
  await redis.set(CONFIG_KEY, config);
}

function normalizeCommerceProduct(product = {}) {
  const now = new Date().toISOString();
  return {
    id: String(product.id || "").trim(),
    title: String(product.title || "").trim(),
    sku: String(product.sku || "").trim(),
    description: String(product.description || "").trim(),
    price_cents: Math.max(0, Math.round(Number(product.price_cents || 0))),
    image_urls: Array.isArray(product.image_urls)
      ? product.image_urls
          .map((url) => String(url || "").trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
    is_active: product.is_active !== false,
    is_public: product.is_public === true,
    display_order: Number.isFinite(Number(product.display_order))
      ? Number(product.display_order)
      : 0,
    created_at: String(product.created_at || now),
    updated_at: String(product.updated_at || now),
  };
}

function productSort(a, b) {
  return (
    Number(a.display_order || 0) - Number(b.display_order || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""))
  );
}

export async function listCommerceProducts({ includeInactive = false } = {}) {
  const products = await redis.get(COMMERCE_PRODUCTS_KEY);
  const normalized = Array.isArray(products)
    ? products.map(normalizeCommerceProduct).filter((product) => product.id)
    : [];
  return normalized
    .filter((product) => includeInactive || product.is_active)
    .sort(productSort);
}

export async function getCommerceProduct(productId) {
  const id = String(productId || "").trim();
  if (!id) return null;
  const products = await listCommerceProducts({ includeInactive: true });
  return products.find((product) => product.id === id) || null;
}

export async function saveCommerceProduct(product) {
  const normalized = normalizeCommerceProduct(product);
  if (!normalized.id) throw new Error("Missing product id.");
  const products = await listCommerceProducts({ includeInactive: true });
  const next = [
    ...products.filter((item) => item.id !== normalized.id),
    normalized,
  ].sort(productSort);
  await redis.set(COMMERCE_PRODUCTS_KEY, next);
  return normalized;
}

// One-time backfill: the launch packages used to live only in code, so they
// never appeared in the admin catalog and couldn't be edited. Seeding them
// into the store makes them fully editable; the flag keeps deliberate edits
// and deletions from being re-seeded later.
export async function ensureDefaultCommerceProducts() {
  const seeded = await redis.get(COMMERCE_DEFAULTS_SEEDED_KEY);
  if (!seeded) {
    const existing = await listCommerceProducts({ includeInactive: true });
    const covered = new Set(existing.map(packageProductIdentity));
    const additions = DEFAULT_PACKAGE_PRODUCTS.filter(
      (product) => !covered.has(packageProductIdentity(product))
    ).map(normalizeCommerceProduct);
    if (additions.length > 0) {
      await redis.set(
        COMMERCE_PRODUCTS_KEY,
        [...existing, ...additions].sort(productSort)
      );
    }
    await redis.set(COMMERCE_DEFAULTS_SEEDED_KEY, true);
  }

  // Versioned, conservative content repair. Only the previous stock wording is
  // replaced; deliberate admin edits remain untouched.
  const migrated = await redis.get(COMMERCE_BIRTHDAY_DETAILS_MIGRATED_KEY);
  if (!migrated) {
    const products = await listCommerceProducts({ includeInactive: true });
    const oldDescription =
      "Includes a small birthday cake, bundle of roses, Happy Birthday sign on an easel, and a bouquet of balloons.";
    let changed = false;
    const next = products.map((product) => {
      if (
        packageProductIdentity(product) === "birthday" &&
        String(product.description || "").trim() === oldDescription
      ) {
        changed = true;
        return {
          ...product,
          description: BIRTHDAY_PACKAGE_DESCRIPTION,
          updated_at: new Date().toISOString(),
        };
      }
      return product;
    });
    if (changed) {
      await redis.set(COMMERCE_PRODUCTS_KEY, next.sort(productSort));
    }
    await redis.set(COMMERCE_BIRTHDAY_DETAILS_MIGRATED_KEY, true);
  }
}

export async function deleteCommerceProduct(productId) {
  const id = String(productId || "").trim();
  if (!id) return;
  const products = await listCommerceProducts({ includeInactive: true });
  await redis.set(
    COMMERCE_PRODUCTS_KEY,
    products.filter((product) => product.id !== id)
  );
}

function normalizeCommercePurchase(purchase = {}) {
  const now = new Date().toISOString();
  const items = Array.isArray(purchase.items)
    ? purchase.items
        .map((item) => ({
          product_id: String(item.product_id || "").trim(),
          title: String(item.title || "").trim(),
          sku: String(item.sku || "").trim(),
          quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
          unit_amount_cents: Math.max(
            0,
            Math.round(Number(item.unit_amount_cents || 0))
          ),
          amount_cents: Math.max(0, Math.round(Number(item.amount_cents || 0))),
          image_url: String(item.image_url || "").trim() || null,
        }))
        .filter((item) => item.product_id && item.quantity > 0)
    : [];
  return {
    id: String(purchase.id || "").trim(),
    reservation_id: String(purchase.reservation_id || "").trim(),
    // The sentinel reservation_id "public" and channel are two views of the
    // same fact; deriving channel from either keeps them from drifting apart.
    channel:
      purchase.channel === "public" || purchase.reservation_id === "public"
        ? "public"
        : "guest",
    customer_name: String(purchase.customer_name || "").trim(),
    stay_location: String(purchase.stay_location || "").trim() || null,
    status: ["pending", "paid", "cancelled"].includes(purchase.status)
      ? purchase.status
      : "pending",
    amount_cents: Math.max(0, Math.round(Number(purchase.amount_cents || 0))),
    items,
    stripe_checkout_session_id:
      String(purchase.stripe_checkout_session_id || "").trim() || null,
    stripe_payment_intent_id:
      String(purchase.stripe_payment_intent_id || "").trim() || null,
    customer_email: String(purchase.customer_email || "").trim() || null,
    customer_phone: String(purchase.customer_phone || "").trim() || null,
    customer_confirmation_sent_at:
      String(purchase.customer_confirmation_sent_at || "").trim() || null,
    team_notification_sent_at:
      String(purchase.team_notification_sent_at || "").trim() || null,
    lodgify_note_sent_at:
      String(purchase.lodgify_note_sent_at || "").trim() || null,
    lodgify_booking_note_added_at:
      String(purchase.lodgify_booking_note_added_at || "").trim() || null,
    fulfillment_error: String(purchase.fulfillment_error || "").trim() || null,
    created_at: String(purchase.created_at || now),
    updated_at: String(purchase.updated_at || now),
  };
}

function purchaseSort(a, b) {
  return (
    new Date(b.created_at || 0).getTime() -
    new Date(a.created_at || 0).getTime()
  );
}

export async function getCommercePurchase(purchaseId) {
  const id = String(purchaseId || "").trim();
  if (!id) return null;
  const purchase = await redis.get(`${COMMERCE_PURCHASE_KEY_PREFIX}${id}`);
  return purchase ? normalizeCommercePurchase(purchase) : null;
}

export async function listCommercePurchases(reservationId) {
  const id = String(reservationId || "").trim();
  if (!id) return [];
  const purchases = await redis.get(
    `${COMMERCE_PURCHASES_BY_RESERVATION_KEY_PREFIX}${normalizeLedgerKey(id)}`
  );
  return Array.isArray(purchases)
    ? purchases.map(normalizeCommercePurchase).filter((purchase) => purchase.id)
    : [];
}

export async function saveCommercePurchase(purchase) {
  const normalized = normalizeCommercePurchase({
    ...purchase,
    updated_at: new Date().toISOString(),
  });
  if (!normalized.id) throw new Error("Missing purchase id.");
  if (!normalized.reservation_id) throw new Error("Missing reservation id.");

  // Public shop purchases all carry the sentinel reservation_id "public", so
  // indexing them per-reservation would funnel every public purchase into one
  // shared list that grows without bound and races under concurrent saves.
  // Nothing reads that index (the purchases API requires a real Lodgify
  // reservation), so the per-purchase key alone is the record for them.
  if (normalized.channel === "public") {
    await redis.set(
      `${COMMERCE_PURCHASE_KEY_PREFIX}${normalized.id}`,
      normalized
    );
    return normalized;
  }

  const reservationKey = `${COMMERCE_PURCHASES_BY_RESERVATION_KEY_PREFIX}${normalizeLedgerKey(
    normalized.reservation_id
  )}`;
  const purchases = await listCommercePurchases(normalized.reservation_id);
  const next = [
    ...purchases.filter((item) => item.id !== normalized.id),
    normalized,
  ].sort(purchaseSort);

  await Promise.all([
    redis.set(`${COMMERCE_PURCHASE_KEY_PREFIX}${normalized.id}`, normalized),
    redis.set(reservationKey, next),
  ]);

  return normalized;
}

// Atomic single-flight lock for commerce purchase fulfillment. Returns true only
// for the first caller to claim this purchase within the TTL window. Fulfillment
// runs from BOTH the Stripe webhook (incl. retries and async_payment_succeeded)
// and the confirmation page on load; without this, a concurrent pair both pass
// the per-step *_sent_at guards (which are read-then-write, not atomic) and each
// send the customer + team emails. The TTL lets a later retry re-claim and
// finish any step a crashed/failed attempt left incomplete — the *_sent_at
// guards still prevent re-sending a step that already succeeded.
export async function claimCommerceFulfillment(purchaseId, ttlSeconds = 60) {
  const id = String(purchaseId || "").trim();
  if (!id) return false;
  const result = await redis.set(
    `${COMMERCE_FULFILLMENT_LOCK_KEY_PREFIX}${id}`,
    new Date().toISOString(),
    { nx: true, ex: Math.max(1, Number(ttlSeconds) || 60) }
  );
  return Boolean(result);
}

export async function getEventPopupContactState(contactKey) {
  const key = normalizeLedgerKey(contactKey);
  if (!key) return null;
  return redis.get(`${EVENT_POPUP_CONTACT_KEY_PREFIX}${key}`);
}

export async function setEventPopupContactState(contactKey, state) {
  const key = normalizeLedgerKey(contactKey);
  if (!key) return;
  await redis.set(`${EVENT_POPUP_CONTACT_KEY_PREFIX}${key}`, state);
}

export async function getEventPopupSmsSent(contactKey, followupId) {
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  const normalizedFollowupId = normalizeLedgerKey(followupId);
  if (!normalizedContactKey || !normalizedFollowupId) return null;
  return redis.get(`${EVENT_POPUP_SMS_SENT_KEY_PREFIX}${normalizedContactKey}:${normalizedFollowupId}`);
}

export async function setEventPopupSmsSent(contactKey, followupId, state) {
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  const normalizedFollowupId = normalizeLedgerKey(followupId);
  if (!normalizedContactKey || !normalizedFollowupId) return;
  await redis.set(`${EVENT_POPUP_SMS_SENT_KEY_PREFIX}${normalizedContactKey}:${normalizedFollowupId}`, state);
}

export async function getSalesmateFormSyncState(listId, contactKey) {
  const normalizedListId = normalizeLedgerKey(listId);
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  if (!normalizedListId || !normalizedContactKey) return null;
  return redis.get(`${SALESMATE_FORM_SYNC_KEY_PREFIX}${normalizedListId}:${normalizedContactKey}`);
}

export async function setSalesmateFormSyncState(listId, contactKey, state) {
  const normalizedListId = normalizeLedgerKey(listId);
  const normalizedContactKey = normalizeLedgerKey(contactKey);
  if (!normalizedListId || !normalizedContactKey) return;
  await redis.set(`${SALESMATE_FORM_SYNC_KEY_PREFIX}${normalizedListId}:${normalizedContactKey}`, state);
}

// ─── Marketing opt-in lists ─────────────────────────────────────────────────
// SendGrid list IDs for the check-in form opt-ins ("Text Club" / "Email
// Offers"). Saved by the Marketing Opt-ins admin setup; env vars are a fallback.
const MARKETING_OPT_IN_LISTS_KEY = "zenfulcove:marketing:opt-in-lists";

export async function getMarketingOptInLists() {
  const stored = (await redis.get(MARKETING_OPT_IN_LISTS_KEY)) || {};
  return {
    smsListId: String(stored.smsListId || "").trim(),
    emailListId: String(stored.emailListId || "").trim(),
    lastBackfill: stored.lastBackfill || null,
  };
}

export async function setMarketingOptInLists(next) {
  const current = (await redis.get(MARKETING_OPT_IN_LISTS_KEY)) || {};
  await redis.set(MARKETING_OPT_IN_LISTS_KEY, { ...current, ...next });
}

// One-off promotion delivery ledger: who already received a given campaign
// (keyed by template ID or SMS body hash), so a re-run or a timed-out send can
// be resumed without messaging anyone twice.
const PROMOTION_SENT_KEY_PREFIX = "zenfulcove:promotion-sent:";

export async function getPromotionSentRecipients(campaignKey) {
  const key = normalizeLedgerKey(campaignKey);
  if (!key) return new Set();
  const members = await redis.smembers(`${PROMOTION_SENT_KEY_PREFIX}${key}`);
  return new Set((members || []).map(String));
}

export async function addPromotionSentRecipients(campaignKey, recipients) {
  const key = normalizeLedgerKey(campaignKey);
  const values = (recipients || []).map(String).filter(Boolean);
  if (!key || values.length === 0) return;
  await redis.sadd(`${PROMOTION_SENT_KEY_PREFIX}${key}`, values[0], ...values.slice(1));
}

// Scheduled one-off promotions. The cron at /api/cron/scheduled-promotions
// sends each one once its sendAt time has passed.
const SCHEDULED_PROMOTIONS_KEY = "zenfulcove:scheduled-promotions";

export async function listScheduledPromotions() {
  const items = (await redis.get(SCHEDULED_PROMOTIONS_KEY)) || [];
  return Array.isArray(items) ? items : [];
}

export async function saveScheduledPromotions(items) {
  await redis.set(SCHEDULED_PROMOTIONS_KEY, items.slice(-100));
}

// Short lock so two overlapping cron runs never send the same job twice.
export async function acquireScheduledPromotionLock(id, seconds = 600) {
  const result = await redis.set(`${SCHEDULED_PROMOTIONS_KEY}:lock:${id}`, Date.now(), { nx: true, ex: seconds });
  return result === "OK";
}
