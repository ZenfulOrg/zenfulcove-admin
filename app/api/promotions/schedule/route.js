import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { listScheduledPromotions } from "@/lib/kv";
import { cancelScheduledPromotion, schedulePromotion } from "@/lib/scheduled-promotions";

export async function GET(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const items = await listScheduledPromotions();
  return NextResponse.json({ items: items.slice().reverse() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const result = await schedulePromotion(body);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const id = new URL(request.url).searchParams.get("id") || "";
  const ok = await cancelScheduledPromotion(id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found or already sent." }, { status: 404 });
}
