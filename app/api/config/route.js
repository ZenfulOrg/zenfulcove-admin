import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig, setConfig } from "@/lib/kv";

export async function GET(request) {
  const unauthorized = await requireAdminRequest(request, { agentRead: true });
  if (unauthorized) return unauthorized;

  try {
    const config = await getConfig();
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to read config", details: err.message },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const updates = await request.json();
    const current = await getConfig();

    const updated = { ...current };

    if (updates.sendgrid !== undefined) {
      updated.sendgrid = {
        ...updated.sendgrid,
        ...updates.sendgrid,
      };
    }

    if (updates.vacancyEmails !== undefined) {
      updated.vacancyEmails = {
        ...updated.vacancyEmails,
        ...updates.vacancyEmails,
      };
      if (updates.vacancyEmails.windows) {
        updated.vacancyEmails.windows = updates.vacancyEmails.windows;
      }
    }

    if (updates.waiverReminders !== undefined) {
      updated.waiverReminders = {
        ...updated.waiverReminders,
        ...updates.waiverReminders,
      };
      if (updates.waiverReminders.jotformFormId !== undefined) {
        updated.waiverReminders.jotformFormId = updates.waiverReminders.jotformFormId;
      }
      if (updates.waiverReminders.emails) {
        updated.waiverReminders.emails = updates.waiverReminders.emails;
      } else if (updates.waiverReminders.reminders) {
        updated.waiverReminders.reminders = updates.waiverReminders.reminders;
      }
      if (updates.waiverReminders.propertyIds !== undefined) {
        updated.waiverReminders.propertyIds = Array.isArray(updates.waiverReminders.propertyIds)
          ? updates.waiverReminders.propertyIds
          : [];
      }
    }

    if (updates.accessCodeRelease !== undefined) {
      updated.accessCodeRelease = {
        ...updated.accessCodeRelease,
        ...updates.accessCodeRelease,
      };
      if (updates.accessCodeRelease.propertyIds !== undefined) {
        updated.accessCodeRelease.propertyIds = Array.isArray(
          updates.accessCodeRelease.propertyIds
        )
          ? updates.accessCodeRelease.propertyIds
          : [];
      }
      if (updates.accessCodeRelease.propertyCodes !== undefined) {
        updated.accessCodeRelease.propertyCodes =
          updates.accessCodeRelease.propertyCodes &&
          typeof updates.accessCodeRelease.propertyCodes === "object"
            ? updates.accessCodeRelease.propertyCodes
            : {};
      }
      if (updates.accessCodeRelease.jervisPropertyIds !== undefined) {
        updated.accessCodeRelease.jervisPropertyIds =
          updates.accessCodeRelease.jervisPropertyIds &&
          typeof updates.accessCodeRelease.jervisPropertyIds === "object"
            ? updates.accessCodeRelease.jervisPropertyIds
            : {};
      }
      if (updates.accessCodeRelease.propertyMessageData !== undefined) {
        updated.accessCodeRelease.propertyMessageData =
          updates.accessCodeRelease.propertyMessageData &&
          typeof updates.accessCodeRelease.propertyMessageData === "object"
            ? updates.accessCodeRelease.propertyMessageData
            : {};
      }
    }

    if (updates.popupFollowups !== undefined) {
      updated.popupFollowups = {
        ...updated.popupFollowups,
        ...updates.popupFollowups,
      };
      if (updates.popupFollowups.testDestinations !== undefined) {
        updated.popupFollowups.testDestinations = {
          ...updated.popupFollowups.testDestinations,
          ...updates.popupFollowups.testDestinations,
        };
      }
      if (updates.popupFollowups.emails) {
        updated.popupFollowups.emails = updates.popupFollowups.emails;
      }
      if (updates.popupFollowups.sms) {
        updated.popupFollowups.sms = updates.popupFollowups.sms;
      }
      if (updated.popupFollowups.twilio !== undefined) {
        delete updated.popupFollowups.twilio;
      }
    }

    if (updates.eventPopupSalesmateSms !== undefined) {
      updated.eventPopupSalesmateSms = {
        ...updated.eventPopupSalesmateSms,
        ...updates.eventPopupSalesmateSms,
      };
      if (updates.eventPopupSalesmateSms.testDestinations !== undefined) {
        updated.eventPopupSalesmateSms.testDestinations = {
          ...updated.eventPopupSalesmateSms.testDestinations,
          ...updates.eventPopupSalesmateSms.testDestinations,
        };
      }
      if (updates.eventPopupSalesmateSms.sms) {
        updated.eventPopupSalesmateSms.sms = updates.eventPopupSalesmateSms.sms;
      }
      if (updates.eventPopupSalesmateSms.salesmateTags !== undefined) {
        updated.eventPopupSalesmateSms.salesmateTags = Array.isArray(updates.eventPopupSalesmateSms.salesmateTags)
          ? updates.eventPopupSalesmateSms.salesmateTags
          : [];
      }
    }

    if (updates.jotformClientSync !== undefined) {
      updated.jotformClientSync = {
        ...updated.jotformClientSync,
        ...updates.jotformClientSync,
      };
      if (updates.jotformClientSync.jotformFormIds !== undefined) {
        updated.jotformClientSync.jotformFormIds = Array.isArray(updates.jotformClientSync.jotformFormIds)
          ? updates.jotformClientSync.jotformFormIds
          : [];
      }
    }

    if (updates.localFormClientSync !== undefined) {
      updated.localFormClientSync = {
        ...updated.localFormClientSync,
        ...updates.localFormClientSync,
      };
      if (updates.localFormClientSync.formSlugs !== undefined) {
        updated.localFormClientSync.formSlugs = Array.isArray(updates.localFormClientSync.formSlugs)
          ? updates.localFormClientSync.formSlugs
          : [];
      }
    }

    if (updates.jotformLocalFormImport !== undefined) {
      updated.jotformLocalFormImport = {
        ...updated.jotformLocalFormImport,
        ...updates.jotformLocalFormImport,
      };
      if (updates.jotformLocalFormImport.mappings !== undefined) {
        updated.jotformLocalFormImport.mappings = Array.isArray(
          updates.jotformLocalFormImport.mappings
        )
          ? updates.jotformLocalFormImport.mappings
          : [];
      }
    }

    if (updates.lodgifyClientSync !== undefined) {
      updated.lodgifyClientSync = {
        ...updated.lodgifyClientSync,
        ...updates.lodgifyClientSync,
      };
    }

    if (updates.salesmateFormSync !== undefined) {
      updated.salesmateFormSync = {
        ...updated.salesmateFormSync,
        ...updates.salesmateFormSync,
      };
    }

    if (updates.messageNotifications !== undefined) {
      updated.messageNotifications = {
        ...updated.messageNotifications,
        ...updates.messageNotifications,
      };
      if (updates.messageNotifications.recipients !== undefined) {
        updated.messageNotifications.recipients = Array.isArray(
          updates.messageNotifications.recipients
        )
          ? updates.messageNotifications.recipients
          : [];
      }
    }

    if (updates.customerPortal !== undefined) {
      updated.customerPortal = {
        ...updated.customerPortal,
        ...updates.customerPortal,
      };
      if (updates.customerPortal.navigation !== undefined) {
        updated.customerPortal.navigation = {
          ...updated.customerPortal.navigation,
          ...updates.customerPortal.navigation,
        };
      }
      if (updates.customerPortal.myStaySections !== undefined) {
        updated.customerPortal.myStaySections =
          updates.customerPortal.myStaySections &&
          typeof updates.customerPortal.myStaySections === "object" &&
          !Array.isArray(updates.customerPortal.myStaySections)
            ? updates.customerPortal.myStaySections
            : {};
      }
    }

    if (updates.eventPortal !== undefined) {
      updated.eventPortal = {
        ...updated.eventPortal,
        ...updates.eventPortal,
      };
      if (updates.eventPortal.events !== undefined) {
        updated.eventPortal.events = Array.isArray(updates.eventPortal.events)
          ? updates.eventPortal.events
          : [];
      }
    }

    await setConfig(updated);

    return NextResponse.json({ success: true, config: updated });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to update config", details: err.message },
      { status: 500 }
    );
  }
}
