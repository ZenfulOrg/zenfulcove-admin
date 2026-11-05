import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getTwilioMessageStatus } from "@/lib/twilio";

// Admin-only: delivery status for one outbound Twilio message by SID.
export async function GET(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const sid = new URL(request.url).searchParams.get("sid") || "";
  try {
    return NextResponse.json(await getTwilioMessageStatus(sid), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Status lookup failed." }, { status: 400 });
  }
}
