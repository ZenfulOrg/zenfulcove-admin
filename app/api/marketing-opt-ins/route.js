import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getMarketingOptInLists } from "@/lib/kv";
import {
  getLastBackfillImportResults,
  runMarketingOptInSetup,
} from "@/lib/marketing-opt-in-setup";

export const maxDuration = 300;

export async function GET(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  if (url.searchParams.get("imports") === "1") {
    try {
      return NextResponse.json(await getLastBackfillImportResults());
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Import lookup failed" },
        { status: 500 }
      );
    }
  }
  return NextResponse.json(await getMarketingOptInLists());
}

// POST { dryRun: boolean } — dryRun defaults to true; only an explicit false writes.
export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await runMarketingOptInSetup({ dryRun: body?.dryRun !== false });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Marketing opt-in setup failed" },
      { status: 500 }
    );
  }
}
