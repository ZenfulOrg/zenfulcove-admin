import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { META_AUDIENCES, buildMetaAudienceCsv } from "@/lib/meta-audiences";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET ?audience=past-guests|subscribers|text-club|everyone
// Admin-only download of a hashed customer list for Meta Ads Manager.
export async function GET(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  const audience = new URL(request.url).searchParams.get("audience") || "";
  if (!META_AUDIENCES.includes(audience)) {
    return NextResponse.json({ error: `audience must be one of: ${META_AUDIENCES.join(", ")}` }, { status: 400 });
  }
  try {
    const { csv, count } = await buildMetaAudienceCsv(audience);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="zenfulcove-meta-${audience}-${date}.csv"`,
        "Cache-Control": "no-store",
        "X-Row-Count": String(count),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 500 });
  }
}
