import { NextResponse } from "next/server";
import { CRON_SECRET } from "@/config/keys";
import { isAgentReadRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";
import {
  extractJervisPincode,
  getJervisProperties,
  getJervisReservation,
  resolveJervisPropertyId,
} from "@/lib/jervis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only troubleshooting: for recent check-ins, compares the door code we
// stored/sent with what Jervis currently holds for that reservation (code,
// property, access window). Writes nothing. Output goes to the runtime log
// under the "[access-code-diagnose]" label and the JSON response.
function centralDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj && obj[key] !== undefined) out[key] = obj[key];
  return out;
}

export async function GET(request) {
  if (
    request.headers.get("authorization") !== `Bearer ${CRON_SECRET}` &&
    !isAgentReadRequest(request)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report = { nowUtc: new Date().toISOString(), rows: [] };
  try {
    const config = (await getConfig()).accessCodeRelease || {};
    report.config = pick(config, [
      "enabled",
      "jervisPropertyIds",
      "jervisPropertyMap",
      "jervisAccessStartTime",
      "jervisAccessEndTime",
      "checkinTime",
      "checkoutTime",
      "accessWindowOverrides",
      "delayedPropertyNames",
      "delayedPropertyIds",
      "delayAccessCodeUntilCheckinDay",
    ]);
    report.config.propertyCodeKeys = Object.keys(
      config.propertyCodes || config.staticCodesByProperty || {}
    );

    const properties = await getJervisProperties(config);
    report.jervisProperties = properties.map((p) => ({
      id: p.id,
      title: p.title,
      platformPropertyId: p.platform_property_id,
    }));
    report.desertRoseResolves = await resolveJervisPropertyId(
      { propertyId: "608953", propertyName: "Desert Rose" },
      config
    ).then((r) => ({ propertyId: r.propertyId, source: r.source }));

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("access_code_releases")
      .select("*")
      .gte("checkin_date", centralDate(-2))
      .lte("checkin_date", centralDate(2))
      .order("checkin_date", { ascending: true });
    if (error) throw new Error(error.message);

    for (const row of data || []) {
      const raw = row.raw_source || {};
      const entry = {
        bookingId: row.booking_id,
        property: row.property_name,
        propertyId: row.property_id,
        guest: String(row.guest_name || "").split(/\s+/)[0],
        checkinDate: row.checkin_date,
        status: row.status,
        source: row.source,
        channel: row.channel,
        storedCode: row.access_code,
        sentAt: row.sent_at,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error,
        jervisReservationId: raw.jervisReservationId || null,
        jervisPropertyId: raw.jervisPropertyId || null,
        jervisPropertySource: raw.jervisPropertySource || null,
        jervisUpdateError: raw.jervisUpdateError || null,
      };
      if (entry.jervisReservationId) {
        try {
          const live = await getJervisReservation(entry.jervisReservationId, config);
          const liveCode = extractJervisPincode(live);
          entry.jervisLive = {
            keys: Object.keys(live || {}),
            pincode: liveCode,
            matchesStored: liveCode === row.access_code,
            phoneLast4IsPincode: Boolean(
              liveCode &&
                String(live?.phone || "").replace(/\D/g, "").slice(-4) === liveCode
            ),
            hasPhone: Boolean(String(live?.phone || "").trim()),
            reservationSource: live?.source,
            checkedIn: live?.checked_in,
            accessStart: live?.access_start_time,
            accessEnd: live?.access_end_time,
            ...pick(live, [
              "property_id",
              "propertyId",
              "property",
              "start_date",
              "end_date",
              "status",
              "state",
              "lock_status",
              "sync_status",
              "is_active",
              "cancelled",
            ]),
          };
        } catch (err) {
          entry.jervisLiveError = err.message;
        }
      }
      report.rows.push(entry);
    }
  } catch (err) {
    report.error = err.message;
  }

  console.log("[access-code-diagnose]", JSON.stringify(report));
  return NextResponse.json(report);
}
