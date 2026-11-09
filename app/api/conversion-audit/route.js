import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getAllBookingsInStayWindow, getBookingV2Raw, listWebhookSubscriptions } from "@/lib/lodgify";

export const maxDuration = 300;

// Read-only audit: runs recent real Lodgify bookings through the website's
// purchase-conversion rule (zenfulcove-site lib/booking-conversion.ts
// directBookingPurchase) and reports why each passes or fails. No guest
// names, emails or phones are returned.

function dateOnly(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function evaluate(booking, now = Date.now()) {
  const status = String(booking.status ?? booking.booking_status ?? "").toLowerCase();
  if (!["booked", "confirmed"].includes(status)) return `status "${status || "none"}"`;
  const paid = num(booking.total_paid) ?? num(booking.amount_paid);
  if (paid === undefined) return "no total_paid/amount_paid field";
  if (paid <= 0) return "nothing paid";
  const cur = booking.currency && typeof booking.currency === "object" ? booking.currency : {};
  const currency = String(booking.currency_code ?? cur.code ?? booking.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return `bad currency "${currency}"`;
  if (booking.source !== "OH") return `not direct (source ${booking.source || "none"})`;
  let host = "";
  try {
    host = new URL(`https://${String(booking.source_text || "").replace(/^https?:\/\//, "")}`).hostname;
  } catch {
    return `source_text not a host ("${String(booking.source_text || "").slice(0, 40)}")`;
  }
  if (host !== "zenfulcove.com" && !host.endsWith(".zenfulcove.com")) return `source_text host "${host}"`;
  const txs = Array.isArray(booking.transactions) ? booking.transactions : null;
  if (!txs) return "no transactions field";
  const times = txs
    .filter((t) => t && t.type === "Payment" && t.status === "Done" && Number(t.amount) > 0)
    .map((t) => String(t.processed_at || ""))
    .map((t) => Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`))
    .filter(Number.isFinite);
  if (!times.length) {
    const kinds = txs.map((t) => `${t?.type}/${t?.status}`).join(", ");
    return `no completed payment transaction (${kinds || "empty list"})`;
  }
  const first = Math.min(...times);
  if (first < now - 7 * 86400000) return "PASS (but payment older than 7 days, so a webhook today would skip it)";
  return "PASS";
}

// Click-ID capture counts come from the website's database (zenfulcove-site
// /api/marketing/attribution-stats), which this app cannot reach directly.
async function getClickIdCapture(days = 30) {
  const token = process.env.ATTRIBUTION_STATS_TOKEN || "";
  if (!token) return { error: "ATTRIBUTION_STATS_TOKEN not set" };
  const base = process.env.SITE_BASE_URL || "https://www.zenfulcove.com";
  try {
    const res = await fetch(`${base}/api/marketing/attribution-stats?days=${days}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `site returned ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
}

export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const clickIdCapturePromise = getClickIdCapture(30);
    const bookings = await getAllBookingsInStayWindow(addDays(today, -60), addDays(today, 500), {
      includeTransactions: true,
    });
    const recent = bookings
      .filter((b) => Number(b?.id) > 0)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 40);

    const sources = {};
    for (const b of bookings) sources[b?.source || "none"] = (sources[b?.source || "none"] || 0) + 1;

    const rows = [];
    let singleChecks = 0;
    for (const b of recent) {
      const row = {
        id: b.id,
        created: dateOnly(b.date_created || b.created_at || b.createdAt || b.booked_at),
        arrival: dateOnly(b.arrival),
        source: b.source || "",
        sourceText: String(b.source_text || "").slice(0, 60),
        status: b.status || "",
        totalPaid: num(b.total_paid) ?? num(b.amount_paid) ?? null,
        listHasTransactions: Array.isArray(b.transactions),
        verdictFromList: evaluate(b),
      };
      if (b.source === "OH" && singleChecks < 12) {
        singleChecks += 1;
        try {
          const plain = await getBookingV2Raw(b.id);
          row.webhookFetchHasTransactions = Array.isArray(plain?.transactions);
          row.verdictAsWebhookSeesIt = evaluate(plain);
          const withTx = await getBookingV2Raw(b.id, { includeTransactions: true });
          row.withParamHasTransactions = Array.isArray(withTx?.transactions);
          row.verdictWithTransactions = evaluate(withTx);
        } catch (err) {
          row.singleFetchError = err instanceof Error ? err.message.slice(0, 160) : String(err);
        }
      }
      rows.push(row);
    }

    let webhooks = [];
    try {
      const list = await listWebhookSubscriptions();
      webhooks = (Array.isArray(list) ? list : list?.items || []).map((hook) => {
        let url = String(hook?.url || hook?.target_url || "");
        try {
          const parsed = new URL(url);
          url = `${parsed.origin}${parsed.pathname}${parsed.search ? " (+query)" : ""}`;
        } catch {
          url = url.split("?")[0];
        }
        return { event: hook?.event || hook?.type || "", url };
      });
    } catch (err) {
      webhooks = [{ error: err instanceof Error ? err.message.slice(0, 160) : String(err) }];
    }

    const clickIdCapture = await clickIdCapturePromise;
    return NextResponse.json({ today, totalBookingsInWindow: bookings.length, sources, webhooks, clickIdCapture, rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
