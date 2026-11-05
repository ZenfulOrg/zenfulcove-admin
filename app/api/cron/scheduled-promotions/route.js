import { NextResponse } from "next/server";
import { CRON_SECRET } from "@/config/keys";
import { runDueScheduledPromotions } from "@/lib/scheduled-promotions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Every 5 minutes (vercel.json): send scheduled one-off promotions that are due.
export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const results = await runDueScheduledPromotions();
    if (results.length) console.info("scheduled promotions sent", results);
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("scheduled promotions cron failed:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
