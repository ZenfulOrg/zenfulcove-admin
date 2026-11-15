import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import {
  createJervisReservation,
  extractJervisReservationId,
  resolveJervisPropertyId,
  updateJervisReservation,
} from "@/lib/jervis";
import { getJervisReservationWithPincode } from "@/lib/access-code-releases";

// Admin-only live lock test. "create" makes a short Jervis test reservation on
// one unit (same create -> update -> poll steps as guest releases) and returns
// the pincode; "end" moves that reservation's window into the past so the code
// stops working. Nothing is posted to Lodgify or emailed to a guest, and no
// access_code_releases row is written.
const UNITS = {
  "608952": "Fairy House",
  "608953": "Desert Rose",
  "608954": "Sky Castle",
  "608955": "Bird House",
};
const MAX_TEST_MINUTES = 120;

function centralIso(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function testPayload(config, start, end) {
  return {
    first_name: "Zenfulcove",
    last_name: "Lock Test",
    email: String(config.jervisTestEmail || "contact@zenfulcove.com"),
    start_date: centralIso(start),
    end_date: centralIso(end),
  };
}

export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const config = (await getConfig()).accessCodeRelease || {};
    const propertyId = String(body?.propertyId || "608953");
    const propertyName = UNITS[propertyId];
    if (!propertyName) {
      return NextResponse.json({ error: "Unknown or non-Jervis unit." }, { status: 400 });
    }

    const { propertyId: jervisPropertyId } = await resolveJervisPropertyId(
      { propertyId, propertyName },
      config
    );
    if (!jervisPropertyId) {
      return NextResponse.json(
        { error: `No Jervis property found for ${propertyName}.` },
        { status: 404 }
      );
    }

    if (body?.action === "end") {
      const reservationId = String(body?.reservationId || "").trim();
      if (!reservationId) {
        return NextResponse.json({ error: "reservationId is required." }, { status: 400 });
      }
      const now = Date.now();
      const payload = testPayload(
        config,
        new Date(now - 2 * 60 * 60 * 1000),
        new Date(now - 60 * 60 * 1000)
      );
      await updateJervisReservation(reservationId, payload, config);
      const { reservation } = await getJervisReservationWithPincode(reservationId, config);
      return NextResponse.json({
        ended: true,
        reservationId,
        window: { start: payload.start_date, end: payload.end_date },
        jervisWindow: {
          start: reservation?.start_date || null,
          end: reservation?.end_date || null,
        },
      });
    }

    const minutes = Math.min(
      Math.max(Number(body?.minutes) || 15, 5),
      MAX_TEST_MINUTES
    );
    const start = new Date();
    const payload = testPayload(config, start, new Date(start.getTime() + minutes * 60 * 1000));
    const created = await createJervisReservation(jervisPropertyId, payload, config);
    const reservationId = extractJervisReservationId(created);
    if (!reservationId) {
      return NextResponse.json(
        { error: "Jervis created no reservation ID.", created },
        { status: 502 }
      );
    }

    let updateError = "";
    try {
      await updateJervisReservation(reservationId, payload, config);
    } catch (err) {
      updateError = err.message;
    }
    const { pincode, attempts, reservation } = await getJervisReservationWithPincode(
      reservationId,
      config
    );

    return NextResponse.json({
      propertyName,
      jervisPropertyId,
      reservationId,
      window: { start: payload.start_date, end: payload.end_date },
      pincode: pincode || null,
      pollAttempts: attempts,
      ...(updateError ? { updateError } : {}),
      jervisWindow: {
        start: reservation?.start_date || null,
        end: reservation?.end_date || null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Jervis lock test failed", details: err.message },
      { status: 500 }
    );
  }
}
