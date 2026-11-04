import {
  listCustomFieldDefinitions,
  updateContactCustomFields,
  upsertContactsToList,
} from "@/lib/sendgrid";
import type { MarketingConsentRecord } from "@/lib/marketing-consent";

// Adds guests who opted in on the check-in form to the SendGrid lists the
// marketing flows send from. Lists are configured per environment; when a list
// ID is unset that channel is skipped (consent is still stored on the form
// submission in Supabase, so it can be backfilled later).
export function marketingOptInListIds() {
  return {
    sms: String(process.env.SENDGRID_SMS_OPT_IN_LIST_ID || "").trim(),
    email: String(process.env.SENDGRID_EMAIL_OPT_IN_LIST_ID || "").trim(),
  };
}

// Custom fields are optional: they're filled only if fields with these names
// already exist in SendGrid (Marketing > Custom Fields).
const SMS_CONSENT_FIELD_NAME = "sms_consent";
const SMS_CONSENT_AT_FIELD_NAME = "sms_consent_at";

export async function syncMarketingConsentToSendGrid({
  consent,
  contact,
}: {
  consent: MarketingConsentRecord;
  contact: { email?: string; firstName?: string; lastName?: string; phone?: string };
}) {
  const results: string[] = [];
  const lists = marketingOptInListIds();
  const email = String(contact.email || "").trim().toLowerCase();
  if (!email) return ["skipped: no email on submission"];

  const sendgridContact = {
    email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
  };

  if (consent.sms.optedIn) {
    if (!lists.sms) {
      results.push("SMS opt-in saved; SendGrid sync skipped (SENDGRID_SMS_OPT_IN_LIST_ID not set)");
    } else {
      await upsertContactsToList({ listId: lists.sms, contacts: [sendgridContact] });
      results.push("added to SMS opt-in list");

      const fields = await listCustomFieldDefinitions().catch(() => []);
      const customFields: Record<string, string> = {};
      for (const field of fields) {
        if (field.name === SMS_CONSENT_FIELD_NAME) customFields[field.id] = "yes";
        if (field.name === SMS_CONSENT_AT_FIELD_NAME) customFields[field.id] = consent.recordedAt;
      }
      if (Object.keys(customFields).length > 0) {
        await updateContactCustomFields({ email, customFields });
        results.push("SMS consent custom fields updated");
      }
    }
  }

  if (consent.email.optedIn) {
    if (!lists.email) {
      results.push("Email opt-in saved; SendGrid sync skipped (SENDGRID_EMAIL_OPT_IN_LIST_ID not set)");
    } else {
      await upsertContactsToList({ listId: lists.email, contacts: [sendgridContact] });
      results.push("added to email opt-in list");
    }
  }

  return results;
}
