import sgMail from "@sendgrid/mail";
import { SENDGRID_API_KEY } from "@/config/keys";

sgMail.setApiKey(SENDGRID_API_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImportJob(jobId, contextLabel = "SendGrid import") {
  const startedAt = Date.now();
  const timeoutMs = 90000;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1000);

    const statusRes = await fetch(
      `https://api.sendgrid.com/v3/marketing/contacts/imports/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const statusText = await statusRes.text();
    if (!statusRes.ok) {
      throw new Error(
        `${contextLabel} status check failed: ${statusRes.status} ${statusRes.statusText} ${statusText}`
      );
    }

    const statusData = statusText ? JSON.parse(statusText) : {};
    if (statusData.status === "completed") {
      return statusData;
    }

    if (statusData.status === "failed") {
      throw new Error(`${contextLabel} failed for job ${jobId}`);
    }
  }

  return {
    id: jobId,
    status: "pending_timeout",
    results: {},
  };
}

/**
 * Send a SendGrid dynamic template email.
 * @param {object} options
 * @param {string} options.to
 * @param {string} options.templateId
 * @param {object} options.data
 * @param {object} options.from
 * @param {string|number} [options.unsubscribeGroupId]
 */
export async function sendTemplateEmail({
  to,
  templateId,
  data,
  from,
  unsubscribeGroupId,
}) {
  const groupId = Number(unsubscribeGroupId);
  const msg = {
    to,
    from,
    templateId,
    dynamicTemplateData: data,
    ...(Number.isInteger(groupId) && groupId > 0
      ? { asm: { groupId } }
      : {}),
  };

  await sgMail.send(msg);
}

/**
 * Send one dynamic template to many recipients in a single SendGrid request
 * (one personalization per recipient, at most 1,000 per call).
 */
export async function sendTemplateEmailBatch({ recipients, templateId, from, unsubscribeGroupId }) {
  if (!Array.isArray(recipients) || recipients.length === 0) return;
  if (recipients.length > 1000) throw new Error("SendGrid allows at most 1,000 recipients per request.");
  const groupId = Number(unsubscribeGroupId);
  await sgMail.send({
    from,
    templateId,
    personalizations: recipients.map(({ to, data }) => ({
      to: [{ email: to }],
      dynamicTemplateData: data,
    })),
    ...(Number.isInteger(groupId) && groupId > 0 ? { asm: { groupId } } : {}),
  });
}

/**
 * Create a SendGrid dynamic template with one active code-editor version.
 * Returns the new template ID (d-...).
 */
export async function createDynamicTemplate({ name, subject, html }) {
  const headers = {
    Authorization: `Bearer ${SENDGRID_API_KEY}`,
    "Content-Type": "application/json",
  };
  const created = await fetch("https://api.sendgrid.com/v3/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, generation: "dynamic" }),
  });
  const template = await created.json().catch(() => ({}));
  if (!created.ok || !template.id) {
    throw new Error(template?.errors?.[0]?.message || `SendGrid template create failed (${created.status})`);
  }
  const version = await fetch(`https://api.sendgrid.com/v3/templates/${template.id}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `${name} v1`,
      subject,
      html_content: html,
      generate_plain_content: true,
      editor: "code",
      active: 1,
    }),
  });
  const versionBody = await version.json().catch(() => ({}));
  if (!version.ok) {
    throw new Error(versionBody?.errors?.[0]?.message || `SendGrid template version failed (${version.status})`);
  }
  return template.id;
}

/**
 * Send a plain one-off SendGrid email without a dynamic template.
 * @param {object} options
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {object} options.from
 */
export async function sendPlainEmail({ to, subject, text, from }) {
  const body = String(text || "").trim();
  if (!to) {
    throw new Error("Cannot send email without a destination address.");
  }
  if (!subject || !String(subject).trim()) {
    throw new Error("Cannot send email without a subject.");
  }
  if (!body) {
    throw new Error("Cannot send email without a message body.");
  }

  await sgMail.send({
    to,
    from,
    subject: String(subject).trim(),
    text: body,
  });
}

function uniqueEmails(contacts) {
  const seen = new Set();
  return contacts.filter((contact) => {
    const email = String(contact?.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
}

async function sendgridJson(path, options = {}, contextLabel = "SendGrid request") {
  const res = await fetch(`https://api.sendgrid.com/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new Error(`${contextLabel} failed: ${res.status} ${res.statusText} ${text}`);
  }

  return data;
}

function parseContactExport(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }

  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed?.result)) return parsed.result;
    if (Array.isArray(parsed?.contacts)) return parsed.contacts;
    return [];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForContactExport(jobId, contextLabel = "SendGrid contact export") {
  const startedAt = Date.now();
  const timeoutMs = 90000;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1000);

    const statusData = await sendgridJson(
      `/marketing/contacts/exports/${jobId}`,
      {},
      `${contextLabel} status check`
    );

    if (statusData.status === "ready") {
      return statusData;
    }

    if (statusData.status === "failure") {
      throw new Error(`${contextLabel} failed for job ${jobId}: ${statusData.message || "unknown error"}`);
    }
  }

  throw new Error(`${contextLabel} timed out for job ${jobId}`);
}

async function exportContactsFromListDetailed(listId) {
  const exportJob = await sendgridJson(
    "/marketing/contacts/exports",
    {
      method: "POST",
      body: JSON.stringify({
        list_ids: [listId],
        notifications: { email: false },
        file_type: "json",
      }),
    },
    "SendGrid contact export"
  );

  const jobId = exportJob?.id;
  if (!jobId) {
    throw new Error("SendGrid contact export did not return a job ID.");
  }

  const statusData = await waitForContactExport(jobId);
  const urls = Array.isArray(statusData.urls) ? statusData.urls.filter(Boolean) : [];
  if (urls.length === 0) {
    return [];
  }

  const contacts = [];
  for (const url of urls) {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SendGrid contact export download failed: ${res.status} ${res.statusText} ${text}`);
    }
    contacts.push(...parseContactExport(text));
  }

  return contacts;
}

export async function listAllContactLists() {
  const lists = [];
  let pageToken = "";

  while (true) {
    const params = new URLSearchParams({ page_size: "100" });
    if (pageToken) params.set("page_token", pageToken);

    const res = await fetch(
      `https://api.sendgrid.com/v3/marketing/lists?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `SendGrid list-all failed: ${res.status} ${res.statusText} ${text}`
      );
    }

    const data = await res.json();
    const batch = Array.isArray(data?.result) ? data.result : [];
    for (const item of batch) {
      lists.push({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "").trim(),
        contactCount: Number(item?.contact_count || 0),
      });
    }

    const nextUrl = data?._metadata?.next || "";
    if (!nextUrl) break;
    try {
      const parsed = new URL(nextUrl, "https://api.sendgrid.com");
      pageToken = parsed.searchParams.get("page_token") || "";
    } catch {
      pageToken = "";
    }
    if (!pageToken) break;
  }

  return lists.filter((list) => list.id);
}

export async function getContactsFromList(listId) {
  const contacts = await getContactsFromListDetailed(listId);
  return contacts.map((c) => c.email).filter(Boolean);
}

export async function getContactsFromListDetailed(listId) {
  try {
    const exportedContacts = await exportContactsFromListDetailed(listId);
    return uniqueEmails(
      exportedContacts.map((contact) => ({
        ...contact,
        _sendgridExport: true,
      }))
    );
  } catch (exportErr) {
    console.warn("[sendgrid] Contact export failed; falling back to search:", exportErr.message);
  }

  let pageToken = "";
  const allContacts = [];
  let totalMatched = null;

  while (true) {
    const body = {
      query: `CONTAINS(list_ids, '${listId}')`,
    };
    if (pageToken) {
      body.page_token = pageToken;
    }

    const searchRes = await fetch(
      "https://api.sendgrid.com/v3/marketing/contacts/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!searchRes.ok) {
      const text = await searchRes.text();
      throw new Error(
        `SendGrid search API error: ${searchRes.status} ${searchRes.statusText} ${text}`
      );
    }

    const searchData = await searchRes.json();
    const batch = Array.isArray(searchData.result) ? searchData.result : [];
    if (Number.isFinite(Number(searchData.contact_count))) {
      totalMatched = Number(searchData.contact_count);
    }
    allContacts.push(...batch);

    const nextPageToken = extractNextPageToken(searchData);
    if (!nextPageToken || batch.length === 0) {
      break;
    }

    pageToken = nextPageToken;
  }

  if (totalMatched !== null && allContacts.length < totalMatched) {
    throw new Error(
      `SendGrid search returned only ${allContacts.length} of ${totalMatched} contact(s); contact export is required for full lists.`
    );
  }

  return uniqueEmails(allContacts);
}

export async function getContactByEmailDetailed(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const res = await fetch(
    "https://api.sendgrid.com/v3/marketing/contacts/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `email = '${normalizedEmail}'`,
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `SendGrid contact lookup failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  const data = await res.json();
  const result = Array.isArray(data.result) ? data.result : [];
  return result[0] || null;
}

export async function listCustomFieldDefinitions() {
  const res = await fetch(
    "https://api.sendgrid.com/v3/marketing/field_definitions",
    {
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `SendGrid custom field lookup failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  const data = text ? JSON.parse(text) : {};
  const fields = Array.isArray(data?.custom_fields)
    ? data.custom_fields
    : Array.isArray(data?.result)
      ? data.result
      : [];

  return fields
    .map((field) => ({
      id: String(field?.id || "").trim(),
      name: String(field?.name || "").trim(),
      type: String(field?.field_type || field?.type || "").trim(),
    }))
    .filter((field) => field.id || field.name);
}

export async function validateContactCustomFieldKeys(fieldKeys = []) {
  const required = Array.from(
    new Set(
      (fieldKeys || [])
        .map((key) => String(key || "").trim())
        .filter(Boolean)
    )
  );
  if (required.length === 0) return [];

  const fields = await listCustomFieldDefinitions();
  const validKeys = new Set(
    fields.flatMap((field) => [field.id, field.name]).filter(Boolean)
  );
  const missing = required.filter((key) => !validKeys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing SendGrid custom field definition(s): ${missing.join(", ")}`
    );
  }

  return fields;
}

function extractNextPageToken(searchData) {
  const metadata = searchData?._metadata || {};
  const directToken = metadata.next_page_token || metadata.nextPageToken || "";
  if (directToken) return String(directToken).trim();

  const nextUrl = metadata.next || "";
  if (!nextUrl) return "";

  try {
    const parsed = new URL(nextUrl, "https://api.sendgrid.com");
    return parsed.searchParams.get("page_token") || "";
  } catch {
    return "";
  }
}

export async function updateContactCustomFields({ email, customFields, identifiers = {} }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Cannot update SendGrid contact without an email");
  }

  const res = await fetch("https://api.sendgrid.com/v3/marketing/contacts", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contacts: [
        {
          email: normalizedEmail,
          custom_fields: customFields,
          ...(identifiers.phoneNumberId ? { phone_number_id: identifiers.phoneNumberId } : {}),
          ...(identifiers.externalId ? { external_id: identifiers.externalId } : {}),
          ...(identifiers.anonymousId ? { anonymous_id: identifiers.anonymousId } : {}),
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `SendGrid contact update failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  const result = text ? JSON.parse(text) : {};
  const jobId = result?.job_id;

  if (!jobId) {
    return result;
  }

  return waitForImportJob(jobId, `SendGrid contact update for ${normalizedEmail}`);
}

function toMarketingContact(contact) {
  const normalizedEmail = String(contact?.email || "").trim().toLowerCase();
  const payload = { email: normalizedEmail };

  if (contact?.firstName) payload.first_name = String(contact.firstName).trim();
  if (contact?.lastName) payload.last_name = String(contact.lastName).trim();
  if (contact?.phone) payload.phone_number = String(contact.phone).trim();
  // SendGrid rejects updates to a contact that has other identifiers unless
  // all of them are supplied ("Please provide all identifiers").
  if (contact?.phoneNumberId) payload.phone_number_id = String(contact.phoneNumberId).trim();
  if (contact?.externalId) payload.external_id = String(contact.externalId).trim();
  if (contact?.anonymousId) payload.anonymous_id = String(contact.anonymousId).trim();

  return payload;
}

export async function upsertContactsToList({ listId, contacts, wait = true }) {
  const normalizedContacts = (contacts || [])
    .map(toMarketingContact)
    .filter((contact) => contact.email);

  if (!listId) {
    throw new Error("Cannot upsert SendGrid contacts without a list ID");
  }

  if (normalizedContacts.length === 0) {
    return [];
  }

  const results = [];
  for (let i = 0; i < normalizedContacts.length; i += 500) {
    const batch = normalizedContacts.slice(i, i + 500);
    const res = await fetch("https://api.sendgrid.com/v3/marketing/contacts", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        list_ids: [listId],
        contacts: batch,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `SendGrid contact upsert failed: ${res.status} ${res.statusText} ${text}`
      );
    }

    const result = text ? JSON.parse(text) : {};
    const jobId = result?.job_id;
    if (jobId && !wait) {
      results.push({ id: jobId, status: "submitted", results: {} });
    } else if (jobId) {
      results.push(await waitForImportJob(jobId, `SendGrid list upsert batch ${Math.floor(i / 500) + 1}`));
    } else {
      results.push(result);
    }
  }

  return results;
}

export async function createContactList(name) {
  const data = await sendgridJson(
    "/marketing/lists",
    { method: "POST", body: JSON.stringify({ name }) },
    "SendGrid list create"
  );
  return { id: String(data?.id || ""), name: String(data?.name || name) };
}

export async function getImportJobStatus(jobId) {
  return sendgridJson(
    `/marketing/contacts/imports/${encodeURIComponent(jobId)}`,
    {},
    "SendGrid import status"
  );
}

// errors_url on a finished import is a signed download link for the rows
// SendGrid rejected. Returns its raw text (CSV/JSON), capped in size.
export async function fetchImportErrors(errorsUrl, maxChars = 20000) {
  if (!errorsUrl) return "";
  let res = await fetch(errorsUrl);
  if (res.status === 401 || res.status === 403) {
    res = await fetch(errorsUrl, {
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` },
    });
  }
  if (!res.ok) {
    return `Could not download error report: ${res.status} ${res.statusText}`;
  }
  const text = await res.text();
  return text.slice(0, maxChars);
}

// Looks up existing contacts by email (100 per request) and returns their
// extra identifiers, keyed by lowercase email. Emails not in SendGrid are
// simply absent from the map.
export async function getContactIdentifiersByEmails(emails = []) {
  const unique = Array.from(
    new Set(emails.map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))
  );
  const identifiers = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const res = await fetch("https://api.sendgrid.com/v3/marketing/contacts/search/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ emails: batch }),
    });
    if (res.status === 404) continue; // none of this batch exist yet
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SendGrid email search failed: ${res.status} ${res.statusText} ${text}`);
    }
    const data = text ? JSON.parse(text) : {};
    for (const [email, entry] of Object.entries(data?.result || {})) {
      const contact = entry?.contact;
      if (!contact) continue;
      const ids = {
        phoneNumberId: contact.phone_number_id || "",
        externalId: contact.external_id || "",
        anonymousId: contact.anonymous_id || "",
      };
      if (ids.phoneNumberId || ids.externalId || ids.anonymousId) {
        identifiers.set(String(email).toLowerCase(), ids);
      }
    }
  }
  return identifiers;
}
