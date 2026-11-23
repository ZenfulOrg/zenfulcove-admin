import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import { getBookingById } from "@/lib/lodgify";
import {
  bookingHasLocalFormSubmission,
  listLocalFormSubmissions,
} from "@/lib/local-forms";
import { bookingHasWaiver, getFormSubmissions } from "@/lib/jotform";
import {
  isDelayedAccessCodeBooking,
  sendAccessCodeForBooking,
  sendCheckinInfoForBooking,
  sendWaiverReminderForBooking,
  waiverReminderFormSource,
} from "@/lib/access-code-messages";
import { runAccessCodeRelease } from "@/app/api/cron/route";

function clean(value) {
  return String(value || "").trim();
}

function mergeConfig(base, body = {}) {
  return {
    ...base,
    waiverReminders: body.waiverReminders
      ? { ...base.waiverReminders, ...body.waiverReminders }
      : base.waiverReminders,
    accessCodeRelease: {
      ...base.accessCodeRelease,
      ...(body.accessCodeRelease || {}),
    },
  };
}

function dateDaysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sampleBookingFor({
  id,
  status = "Booked",
  propertyId = "608954",
  propertyName = "Sky Castle",
  arrivalDays = 1,
  departureDays = 3,
} = {}) {
  return {
    id,
    status,
    property_id: propertyId,
    property_name: propertyName,
    arrival: dateDaysFromNow(arrivalDays),
    departure: dateDaysFromNow(departureDays),
    guest: {
      firstName: "Sample",
      lastName: "Guest",
      name: "Sample Guest",
      email: "sample.guest@example.com",
      phone: "+15551234567",
    },
  };
}

function resultLog(sendResult, property) {
  return {
    timestamp: sendResult.timestamp || new Date().toISOString(),
    automation: "Access Code Release Test",
    property,
    action: sendResult.action,
    status: sendResult.status,
    ...(sendResult.decision ? { decision: sendResult.decision } : {}),
    ...(sendResult.deliveryChannel ? { deliveryChannel: sendResult.deliveryChannel } : {}),
    ...(sendResult.templateId ? { templateId: sendResult.templateId } : {}),
    ...(sendResult.bookingId ? { bookingId: sendResult.bookingId } : {}),
    ...(sendResult.bookingChannel ? { bookingChannel: sendResult.bookingChannel } : {}),
    ...(sendResult.bookingSource ? { bookingSource: sendResult.bookingSource } : {}),
    ...(sendResult.bookingSourceText ? { bookingSourceText: sendResult.bookingSourceText } : {}),
    ...(sendResult.messageFormat ? { messageFormat: sendResult.messageFormat } : {}),
    ...(sendResult.messageChars ? { messageChars: sendResult.messageChars } : {}),
    ...(sendResult.messageLinkHosts ? { messageLinkHosts: sendResult.messageLinkHosts } : {}),
    ...(sendResult.messageLinksMasked ? { messageLinksMasked: sendResult.messageLinksMasked } : {}),
    ...(sendResult.templateData ? { templateData: sendResult.templateData } : {}),
  };
}

function reminderForTest(automationConfig) {
  const reminders = automationConfig.waiverReminders?.emails ||
    automationConfig.waiverReminders?.reminders ||
    [];
  return (
    reminders.find((reminder) => Number(reminder?.daysBeforeCheckin) === 1) ||
    reminders[0] ||
    {
      daysBeforeCheckin: 1,
      label: "Reminder 2",
      subjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
      messageTemplate: "",
    }
  );
}

async function formIsCompleteForBooking(automationConfig, bookingId) {
  const releaseConfig = automationConfig.accessCodeRelease || {};
  const waiverConfig = automationConfig.waiverReminders || {};
  const localFormSlug = clean(
    releaseConfig.localFormSlug ||
      waiverConfig.localFormSlug ||
      waiverConfig.formSlug ||
      "welcome-to-zenfulcove"
  ).replace(/^\/?forms\//, "");
  const jotformFormId =
    releaseConfig.jotformFormId ||
    waiverConfig.jotformFormId ||
    waiverConfig.emails?.[0]?.jotformFormId ||
    waiverConfig.reminders?.[0]?.jotformFormId;
  const usesLocalForm = waiverReminderFormSource(waiverConfig) === "internal";

  if (usesLocalForm && localFormSlug) {
    const submissions = await listLocalFormSubmissions({
      formSlugs: [localFormSlug],
      limit: 10000,
    });
    return bookingHasLocalFormSubmission(bookingId, submissions);
  }

  if (!usesLocalForm && jotformFormId) {
    const submissions = await getFormSubmissions(jotformFormId);
    return bookingHasWaiver(bookingId, submissions);
  }

  return false;
}

export async function POST(request) {
  // Peek at the body so the read-only agent key is allowed for dry runs only.
  const body = await request.clone().json().catch(() => ({}));
  const dryRun = body?.dryRun !== false;
  const unauthorized = await requireAdminRequest(request, { agentRead: dryRun });
  if (unauthorized) return unauthorized;

  try {
    const sample = Boolean(body?.sample);
    const bookingId = clean(body?.bookingId);
    const baseConfig = await getConfig();
    const automationConfig = mergeConfig(baseConfig, body);

    if (sample) {
      const samplePropertyName = clean(body?.samplePropertyName) || "Sky Castle";
      const samplePropertyId = clean(body?.samplePropertyId) || "608954";
      const sampleBooking = sampleBookingFor({
        id: "sample-booked-form-submitted",
        propertyId: samplePropertyId,
        propertyName: samplePropertyName,
      });
      const missingFormBooking = sampleBookingFor({
        id: "sample-booked-form-missing",
        propertyId: samplePropertyId,
        propertyName: samplePropertyName,
      });
      const openBooking = sampleBookingFor({
        id: "sample-open-not-eligible",
        status: "Open",
        propertyId: samplePropertyId,
        propertyName: samplePropertyName,
      });
      const cancelledBooking = sampleBookingFor({
        id: "sample-cancelled-not-eligible",
        status: "Cancelled",
        propertyId: samplePropertyId,
        propertyName: samplePropertyName,
      });

      const delayedAccess = isDelayedAccessCodeBooking({
        booking: sampleBooking,
        automationConfig,
      });
      const accessResult = delayedAccess
        ? await sendCheckinInfoForBooking({
            booking: sampleBooking,
            automationConfig,
            dryRun: true,
            persistState: false,
          })
        : await sendAccessCodeForBooking({
            booking: sampleBooking,
            automationConfig,
            dryRun: true,
            persistState: false,
          });
      const codeOnlyResult = delayedAccess
        ? await sendAccessCodeForBooking({
            booking: sampleBooking,
            automationConfig,
            dryRun: true,
            persistState: false,
            messageKind: "code-only",
          })
        : null;
      const reminderResult = await sendWaiverReminderForBooking({
        booking: missingFormBooking,
        automationConfig,
        reminder: reminderForTest(automationConfig),
        dryRun: true,
        persistState: false,
      });
      const openReminderResult = await sendWaiverReminderForBooking({
        booking: openBooking,
        automationConfig,
        reminder: reminderForTest(automationConfig),
        dryRun: true,
        persistState: false,
      });
      const cancelledAccessResult = await sendAccessCodeForBooking({
        booking: cancelledBooking,
        automationConfig,
        dryRun: true,
        persistState: false,
      });
      const formSource = waiverReminderFormSource(
        automationConfig.waiverReminders || {}
      );
      const logs = [
        {
          timestamp: new Date().toISOString(),
          automation: "Access Code Release Test",
          property: samplePropertyName,
          action: `Rendered fake booking flow matrix without sending: submitted form, missing form, Open status skip, and Cancelled status skip. Waiver reminders use ${formSource === "internal" ? "Lodgify" : "SendGrid"}.`,
          status: "info",
        },
        resultLog(accessResult, samplePropertyName),
        ...(codeOnlyResult ? [resultLog(codeOnlyResult, samplePropertyName)] : []),
        resultLog(reminderResult, samplePropertyName),
        resultLog(openReminderResult, samplePropertyName),
        resultLog(cancelledAccessResult, samplePropertyName),
      ];
      const hasFailed = logs.some((log) => log.status === "failed");
      return NextResponse.json({
        status: hasFailed ? "FAILED" : "SUCCESS",
        timestamp: new Date().toISOString(),
        logs,
      });
    }

    if (!bookingId) {
      if (!dryRun) {
        return NextResponse.json(
          { error: "A Lodgify booking ID is required for a live Lodgify test." },
          { status: 400 }
        );
      }

      const logs = await runAccessCodeRelease(automationConfig, true, {
        bypassReleaseTime: true,
        maxBookings: 20,
        persistState: false,
      });
      const hasFailed = logs.some((log) => log.status === "failed");
      return NextResponse.json({
        status: hasFailed ? "FAILED" : "SUCCESS",
        timestamp: new Date().toISOString(),
        logs,
      });
    }

    const booking = await getBookingById(bookingId);
    if (!booking) {
      return NextResponse.json(
        { error: `Lodgify booking ${bookingId} was not found.` },
        { status: 404 }
      );
    }

    const hasForm = await formIsCompleteForBooking(automationConfig, bookingId);
    const formSource = waiverReminderFormSource(
      automationConfig.waiverReminders || {}
    );
    const messagePrefix = dryRun
      ? ""
      : "[TEST ONLY - Zenfulcove Glamping internal waiver flow]\n\n";
    const delayedAccess = isDelayedAccessCodeBooking({
      booking,
      automationConfig,
    });
    const sendResult = hasForm
      ? delayedAccess
        ? await sendCheckinInfoForBooking({
            booking,
            automationConfig,
            dryRun,
            persistState: false,
            messagePrefix,
          })
        : await sendAccessCodeForBooking({
            booking,
            automationConfig,
            dryRun,
            persistState: false,
            messagePrefix,
          })
      : await sendWaiverReminderForBooking({
          booking,
          automationConfig,
          reminder: reminderForTest(automationConfig),
          dryRun,
          persistState: false,
          messagePrefix,
        });

    const logs = [
      {
        timestamp: new Date().toISOString(),
        automation: "Access Code Release Test",
        property: booking.property_name || booking.propertyName || "—",
        action: hasForm
          ? delayedAccess
            ? `Booking ${bookingId} has the selected form; testing delayed-property no-code check-in Lodgify message.`
            : `Booking ${bookingId} has the selected form; testing access-code Lodgify message.`
          : `Booking ${bookingId} is missing the selected form; testing ${formSource === "internal" ? "Lodgify" : "SendGrid"} waiver reminder message.`,
        status: "info",
      },
      resultLog(sendResult, booking.property_name || booking.propertyName || "—"),
    ];

    const hasFailed = logs.some((log) => log.status === "failed");
    return NextResponse.json({
      status: hasFailed ? "FAILED" : "SUCCESS",
      timestamp: new Date().toISOString(),
      logs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Access code release test failed." },
      { status: 500 }
    );
  }
}
