import { sendSms, validateTwilioConfig } from "@/lib/twilio";
import {
  getContactsFromListDetailed,
  getContactByEmailDetailed,
  sendTemplateEmail,
  sendTemplateEmailBatch,
} from "@/lib/sendgrid";
import { PROMOTION_CONTACT_LISTS } from "@/lib/promotion-lists";
import { getPastGuestEmails } from "@/lib/past-guests";
import { addPromotionSentRecipients, getPromotionSentRecipients } from "@/lib/kv";
import { createHash } from "node:crypto";

const EMAIL_BATCH_SIZE = 500;
const SMS_CONCURRENCY = 8;

export function normalizeAudienceFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["past-guests", "not-past-guests"].includes(normalized) ? normalized : "all";
}

// Keeps only past guests ("past-guests") or drops them ("not-past-guests").
export function applyAudienceFilter(recipients, filter, pastGuestEmails) {
  if (filter === "all") return recipients;
  const wantPast = filter === "past-guests";
  return recipients.filter((contact) => pastGuestEmails.has(normalizeEmail(contact.email)) === wantPast);
}

export function promotionCampaignKey(channel, { templateId, smsBody }) {
  return channel === "email"
    ? `email:${String(templateId || "").trim()}`
    : `sms:${createHash("sha256").update(String(smsBody || "").trim()).digest("hex").slice(0, 32)}`;
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const PROMOTION_NAME = "One-Off Promotions";
const MAX_PREVIEW_LOGS = 50;

// Per-recipient Twilio errors that mean this contact can't receive the SMS —
// expected conditions on a marketing list, not campaign failures.
const SMS_SKIP_REASONS = {
  "21211": "invalid phone number",
  "21408": "SMS to this recipient's region is not enabled",
  "21610": "recipient has opted out (replied STOP)",
  "21614": "number is a landline or cannot receive SMS",
};

function nowLog(action, status = "info") {
  return {
    timestamp: new Date().toISOString(),
    automation: PROMOTION_NAME,
    property: "—",
    action,
    status,
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (/^(\d)\1{6,}$/.test(digits)) return "";

  if (raw.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  }

  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
}

function normalizeChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["email", "sms", "both"].includes(normalized) ? normalized : "email";
}

function normalizeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["dryrun", "dry-run", "dry_run"].includes(normalized)
    ? "dryRun"
    : ["test", "send"].includes(normalized)
      ? normalized
      : "dryRun";
}

function getListDefinitions() {
  const definitions = {};
  PROMOTION_CONTACT_LISTS.forEach((list) => {
    definitions[list.key] = list;
  });

  // Backwards-compatible aliases for any older client payloads.
  definitions.customers = PROMOTION_CONTACT_LISTS.find(
    (list) => list.key === "lodgify-booked-guests"
  );
  definitions.prospects = PROMOTION_CONTACT_LISTS.find(
    (list) => list.key === "all-clients"
  );

  return definitions;
}

function dedupeContactsByEmail(contacts) {
  const byEmail = new Map();

  contacts.forEach((contact) => {
    const email = normalizeEmail(contact?.email);
    if (!email) return;

    const existing = byEmail.get(email) || {};
    byEmail.set(email, {
      ...existing,
      ...contact,
      email,
      first_name: existing.first_name || contact?.first_name || "",
      last_name: existing.last_name || contact?.last_name || "",
      phone_number:
        normalizePhoneNumber(existing.phone_number || existing.phone || "") ||
        normalizePhoneNumber(contact?.phone_number || contact?.phone || ""),
      _segments: Array.from(
        new Set([...(existing._segments || []), ...(contact._segments || [])])
      ),
    });
  });

  return Array.from(byEmail.values());
}

function getRecipientName(contact) {
  return [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
}

function resolveListEntry(rawValue, definitions) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return null;

  const keyMatch = definitions[trimmed.toLowerCase()];
  if (keyMatch) {
    return { listId: keyMatch.listId, label: keyMatch.label };
  }

  return { listId: trimmed, label: `SendGrid list ${trimmed}` };
}

async function resolveRecipients({ selectedLists, logs }) {
  const definitions = getListDefinitions();
  const selected = (selectedLists || [])
    .map((item) => resolveListEntry(item, definitions))
    .filter(Boolean);

  if (selected.length === 0) {
    logs.push(nowLog("Skipped: no promotion contact list selected", "skipped"));
    return [];
  }

  const allContacts = [];
  const loadedListIds = new Set();

  for (const list of selected) {
    if (loadedListIds.has(list.listId)) {
      logs.push(
        nowLog(
          `Using already-loaded SendGrid list ${list.listId} for ${list.label}`,
          "info"
        )
      );
      continue;
    }

    try {
      const contacts = await getContactsFromListDetailed(list.listId);
      loadedListIds.add(list.listId);
      allContacts.push(
        ...contacts.map((contact) => ({
          ...contact,
          _segments: [list.label],
        }))
      );
      logs.push(
        nowLog(
          `Loaded ${contacts.length} contact(s) from ${list.label} (${list.listId})`,
          "info"
        )
      );
    } catch (err) {
      logs.push(
        nowLog(
          `Failed to fetch ${list.label} (${list.listId}): ${err.message}`,
          "failed"
        )
      );
    }
  }

  return dedupeContactsByEmail(allContacts);
}

function summarizeRecipients({ recipients, shouldSendEmail, shouldSendSms, logs }) {
  const emailEligible = recipients.filter((contact) => normalizeEmail(contact.email));
  const smsEligible = recipients.filter((contact) =>
    normalizePhoneNumber(contact.phone_number || contact.phone || "")
  );
  const smsInvalid = recipients.filter((contact) => {
    const rawPhone = String(contact?.phone_number || contact?.phone || "").trim();
    return Boolean(rawPhone) && !normalizePhoneNumber(rawPhone);
  });

  logs.push(
    nowLog(
      `Prepared ${recipients.length} unique recipient(s) | email-ready: ${emailEligible.length} | SMS-ready: ${smsEligible.length}`,
      "info"
    )
  );

  if (shouldSendEmail && emailEligible.length === 0) {
    logs.push(nowLog("No recipients have email addresses for this promotion", "skipped"));
  }

  if (shouldSendSms && smsEligible.length === 0) {
    logs.push(nowLog("No recipients have phone numbers for this promotion", "skipped"));
  }

  if (shouldSendSms && smsInvalid.length > 0) {
    logs.push(
      nowLog(
        `Skipped ${smsInvalid.length} contact(s) with invalid SMS phone numbers`,
        "skipped"
      )
    );
  }

  return { emailEligible, smsEligible };
}

async function hydrateMissingPhonesForSms(recipients, logs) {
  const hydrationCache = new Map();
  let hydratedCount = 0;
  let failedCount = 0;
  const candidates = recipients.filter((contact) => {
    const email = normalizeEmail(contact.email);
    const existingPhone = normalizePhoneNumber(contact.phone_number || contact.phone || "");
    return Boolean(email && !existingPhone && !contact._sendgridExport);
  });

  if (candidates.length === 0) {
    return;
  }

  logs.push(
    nowLog(
      "Checking contacts without list-level phone numbers using direct SendGrid contact lookup",
      "info"
    )
  );

  for (const contact of candidates) {
    const email = normalizeEmail(contact.email);

    try {
      let hydrated = hydrationCache.get(email);
      if (hydrated === undefined) {
        hydrated = await getContactByEmailDetailed(email);
        hydrationCache.set(email, hydrated || null);
      }

      const hydratedPhone = normalizePhoneNumber(
        hydrated?.phone_number || hydrated?.phone || ""
      );
      if (hydratedPhone) {
        contact.phone_number = hydratedPhone;
        hydratedCount += 1;
        logs.push(
          nowLog(
            `Hydrated missing phone for ${email} via direct SendGrid contact lookup`,
            "info"
          )
        );
      }
    } catch (err) {
      failedCount += 1;
      logs.push(
        nowLog(`Failed to hydrate phone for ${email}: ${err.message}`, "failed")
      );
    }
  }

  logs.push(
    nowLog(
      `Phone hydration complete | hydrated: ${hydratedCount} | failed lookups: ${failedCount}`,
      failedCount > 0 ? "failed" : "info"
    )
  );
}

function validatePromotionInput({
  mode,
  channel,
  templateId,
  smsBody,
  testDestinations,
  logs,
}) {
  const shouldSendEmail = channel === "email" || channel === "both";
  const shouldSendSms = channel === "sms" || channel === "both";

  if (shouldSendEmail && !String(templateId || "").trim()) {
    logs.push(nowLog("Skipped: email template ID is required", "skipped"));
    return false;
  }

  if (shouldSendSms && !String(smsBody || "").trim()) {
    logs.push(nowLog("Skipped: SMS message body is required", "skipped"));
    return false;
  }

  if (mode === "test" && shouldSendEmail && !String(testDestinations?.email || "").trim()) {
    logs.push(nowLog("Skipped: test email destination is required", "skipped"));
    return false;
  }

  if (mode === "test" && shouldSendSms && !String(testDestinations?.sms || "").trim()) {
    logs.push(nowLog("Skipped: test SMS destination is required", "skipped"));
    return false;
  }

  if (
    mode === "test" &&
    shouldSendSms &&
    !normalizePhoneNumber(testDestinations?.sms || "")
  ) {
    logs.push(
      nowLog(
        "Skipped: test SMS destination must be a valid 10-digit or E.164 phone number",
        "skipped"
      )
    );
    return false;
  }

  if ((mode === "test" || mode === "send") && shouldSendSms) {
    try {
      validateTwilioConfig();
    } catch (err) {
      logs.push(nowLog(`Skipped: ${err.message}`, "skipped"));
      return false;
    }
  }

  return true;
}

function logDryRunPreview({ recipients, shouldSendEmail, shouldSendSms, logs }) {
  const preview = recipients.slice(0, MAX_PREVIEW_LOGS);
  preview.forEach((contact) => {
    const email = normalizeEmail(contact.email) || "(no email)";
    const rawPhone = String(contact.phone_number || contact.phone || "").trim();
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    const phone = normalizedPhone || (rawPhone ? "(invalid phone)" : "(no phone)");
    const channels = [
      shouldSendEmail && normalizeEmail(contact.email) ? "email" : "",
      shouldSendSms && normalizedPhone ? "sms" : "",
    ].filter(Boolean);
    logs.push(
      nowLog(
        `[DRY RUN] ${email} | ${phone} | ${channels.join("+") || "no eligible channel"} | ${getRecipientName(contact) || "(no name)"}`,
        channels.length > 0 ? "success" : "skipped"
      )
    );
  });

  if (recipients.length > MAX_PREVIEW_LOGS) {
    logs.push(
      nowLog(
        `[DRY RUN] Preview limited to ${MAX_PREVIEW_LOGS} recipient(s); ${recipients.length - MAX_PREVIEW_LOGS} additional recipient(s) omitted from log detail`,
        "info"
      )
    );
  }
}

export async function runOneOffPromotion({
  config,
  mode: rawMode,
  segments,
  lists,
  channel: rawChannel,
  templateId,
  smsBody,
  testDestinations,
  audienceFilter: rawAudienceFilter,
}) {
  const mode = normalizeMode(rawMode);
  const audienceFilter = normalizeAudienceFilter(rawAudienceFilter);
  const channel = normalizeChannel(rawChannel);
  const shouldSendEmail = channel === "email" || channel === "both";
  const shouldSendSms = channel === "sms" || channel === "both";
  const logs = [
    nowLog(
      `${mode === "dryRun" ? "Dry run" : mode === "test" ? "Test send" : "Live send"} requested for ${channel}`,
      "info"
    ),
  ];
  const selectedLists = Array.isArray(lists) && lists.length > 0 ? lists : segments;

  if (
    !validatePromotionInput({
      mode,
      channel,
      templateId,
      smsBody,
      testDestinations,
      logs,
    })
  ) {
    return { logs, summary: null };
  }

  let recipients = await resolveRecipients({
    selectedLists,
    logs,
  });

  if (audienceFilter !== "all" && recipients.length > 0) {
    try {
      const pastGuestEmails = await getPastGuestEmails();
      const before = recipients.length;
      recipients = applyAudienceFilter(recipients, audienceFilter, pastGuestEmails);
      logs.push(nowLog(
        `${audienceFilter === "past-guests" ? "Kept only past guests" : "Removed past guests"} (${pastGuestEmails.size} past-guest emails in Lodgify): ${before} → ${recipients.length} recipient(s)`,
        "info"
      ));
    } catch (err) {
      logs.push(nowLog(`Could not load past guests from Lodgify, nothing sent: ${err.message}`, "failed"));
      return { logs, summary: null };
    }
  }

  if (recipients.length === 0) {
    logs.push(nowLog("No eligible SendGrid contacts found for selected segments", "skipped"));
    return { logs, summary: null };
  }

  if (shouldSendSms) {
    await hydrateMissingPhonesForSms(recipients, logs);
  }

  const { emailEligible, smsEligible } = summarizeRecipients({
    recipients,
    shouldSendEmail,
    shouldSendSms,
    logs,
  });

  if (mode === "dryRun") {
    logs.push(nowLog("═══ DRY RUN: No promotion messages were sent. ═══", "info"));
    logDryRunPreview({ recipients, shouldSendEmail, shouldSendSms, logs });
    return { logs, summary: null };
  }

  const emailRecipients = mode === "test" ? emailEligible.slice(0, 1) : emailEligible;
  const smsRecipients = mode === "test" ? smsEligible.slice(0, 1) : smsEligible;
  const from = {
    email: config?.sendgrid?.fromEmail,
    name: config?.sendgrid?.fromName,
  };
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  if (shouldSendEmail && mode === "send") {
    const trimmedTemplateId = String(templateId || "").trim();
    const campaignKey = promotionCampaignKey("email", { templateId: trimmedTemplateId });
    const alreadySent = await getPromotionSentRecipients(campaignKey);
    const pending = emailRecipients.filter((contact) => !alreadySent.has(normalizeEmail(contact.email)));
    if (alreadySent.size > 0) {
      skippedCount += emailRecipients.length - pending.length;
      logs.push(nowLog(`Skipping ${emailRecipients.length - pending.length} recipient(s) who already received this email`, "info"));
    }
    for (let start = 0; start < pending.length; start += EMAIL_BATCH_SIZE) {
      const batch = pending.slice(start, start + EMAIL_BATCH_SIZE);
      try {
        await sendTemplateEmailBatch({
          from,
          templateId: trimmedTemplateId,
          unsubscribeGroupId: config?.sendgrid?.marketingUnsubscribeGroupId,
          recipients: batch.map((contact) => ({
            to: normalizeEmail(contact.email),
            data: {
              first_name: contact?.first_name || contact?.firstName || "",
              last_name: contact?.last_name || contact?.lastName || "",
              full_name: getRecipientName(contact),
              email: normalizeEmail(contact.email),
            },
          })),
        });
        await addPromotionSentRecipients(campaignKey, batch.map((contact) => normalizeEmail(contact.email)));
        sentCount += batch.length;
        logs.push(nowLog(`Sent email promotion batch ${start / EMAIL_BATCH_SIZE + 1} to ${batch.length} recipient(s) | template: ${trimmedTemplateId}`, "success"));
      } catch (err) {
        failedCount += batch.length;
        const detail = err.response?.body?.errors?.[0]?.message || err.message;
        logs.push(nowLog(`Failed email promotion batch ${start / EMAIL_BATCH_SIZE + 1} (${batch.length} recipients): ${detail}`, "failed"));
      }
    }
  }

  if (shouldSendEmail && mode === "test") {
    const trimmedTemplateId = String(templateId || "").trim();
    for (const contact of emailRecipients) {
      const originalEmail = normalizeEmail(contact.email);
      const to = mode === "test" ? String(testDestinations.email || "").trim() : originalEmail;
      try {
        await sendTemplateEmail({
          to,
          from,
          templateId: trimmedTemplateId,
          unsubscribeGroupId:
            config?.sendgrid?.marketingUnsubscribeGroupId,
          data: {
            first_name: contact?.first_name || contact?.firstName || "",
            last_name: contact?.last_name || contact?.lastName || "",
            full_name: getRecipientName(contact),
            email: originalEmail,
          },
        });
        sentCount += 1;
        logs.push(
          nowLog(
            mode === "test"
              ? `[TEST SEND] Routed email originally for ${originalEmail} to ${to} | template: ${trimmedTemplateId}`
              : `Sent email promotion to ${originalEmail} | template: ${trimmedTemplateId}`,
            "success"
          )
        );
      } catch (err) {
        failedCount += 1;
        const detail = err.response?.body?.errors?.[0]?.message || err.message;
        logs.push(nowLog(`Failed email promotion for ${originalEmail}: ${detail}`, "failed"));
      }
    }
  }

  if (shouldSendSms) {
    const smsCampaignKey = promotionCampaignKey("sms", { smsBody });
    const smsAlreadySent = mode === "send" ? await getPromotionSentRecipients(smsCampaignKey) : new Set();
    const seenPhones = new Set();
    const smsPending = smsRecipients.filter((contact) => {
      const phone = normalizePhoneNumber(contact.phone_number || contact.phone || "");
      if (!phone || seenPhones.has(phone)) return false;
      seenPhones.add(phone);
      return !smsAlreadySent.has(phone);
    });
    if (mode === "send" && smsPending.length < smsRecipients.length) {
      skippedCount += smsRecipients.length - smsPending.length;
      logs.push(nowLog(`Skipping ${smsRecipients.length - smsPending.length} SMS recipient(s): duplicate number or already received this text`, "info"));
    }
    await runWithConcurrency(smsPending, mode === "send" ? SMS_CONCURRENCY : 1, async (contact) => {
      const originalPhone = normalizePhoneNumber(contact.phone_number || contact.phone || "");
      const to =
        mode === "test"
          ? normalizePhoneNumber(testDestinations.sms || "")
          : originalPhone;
      try {
        const smsResult = await sendSms({
          to,
          body: smsBody,
        });
        sentCount += 1;
        if (mode === "send") await addPromotionSentRecipients(smsCampaignKey, [originalPhone]);
        const sidSuffix = smsResult?.sid ? ` | sid: ${smsResult.sid}` : "";
        logs.push(
          nowLog(
            mode === "test"
              ? `[TEST SEND] Routed SMS originally for ${originalPhone} to ${to}${sidSuffix}`
              : `Sent SMS promotion to ${originalPhone}${sidSuffix}`,
            "success"
          )
        );
      } catch (err) {
        const twilioErrorCode = String(err.message || "").match(/"code":\s*(\d+)/)?.[1];
        const skipReason =
          SMS_SKIP_REASONS[twilioErrorCode] ||
          (/Invalid 'To' Phone Number/i.test(err.message || "")
            ? SMS_SKIP_REASONS["21211"]
            : "");
        if (skipReason) {
          skippedCount += 1;
          logs.push(
            nowLog(
              `Skipped SMS for ${originalPhone}: ${skipReason}${twilioErrorCode ? ` (Twilio ${twilioErrorCode})` : ""}`,
              "skipped"
            )
          );
          return;
        }

        failedCount += 1;
        logs.push(nowLog(`Failed SMS promotion for ${originalPhone}: ${err.message}`, "failed"));
      }
    });
  }

  logs.push(
    nowLog(
      `${mode === "test" ? "Test send" : "Live send"} complete | sent: ${sentCount} | skipped: ${skippedCount} | failed: ${failedCount}`,
      failedCount > 0 ? "failed" : "success"
    )
  );

  return {
    logs,
    summary: { sent: sentCount, skipped: skippedCount, failed: failedCount },
  };
}
