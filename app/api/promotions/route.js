import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import { appendLogs, writeLastRunStatus } from "@/lib/activity-log";
import { runOneOffPromotion } from "@/lib/promotions";

export const maxDuration = 300;

export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const config = await getConfig();

    const { logs, summary } = await runOneOffPromotion({
      config,
      mode: body?.mode,
      segments: body?.segments,
      lists: body?.lists,
      channel: body?.channel,
      templateId: body?.templateId,
      smsBody: body?.smsBody,
      smsMediaUrl: body?.smsMediaUrl,
      testDestinations: body?.testDestinations,
      audienceFilter: body?.audienceFilter,
    });

    const icon = (status) =>
      status === "success" ? "✓" : status === "failed" ? "✗" : status === "info" ? "→" : "○";
    logs.forEach((log) => {
      console.log(`[promotions] ${icon(log.status)} ${log.action}`);
    });

    await appendLogs(logs);

    // PARTIAL: messages went out but something failed along the way. FAILED is
    // reserved for runs where nothing was delivered.
    const hasFailed = logs.some((log) => log.status === "failed");
    const sentCount = summary?.sent ?? 0;
    const status = hasFailed ? (sentCount > 0 ? "PARTIAL" : "FAILED") : "SUCCESS";
    await writeLastRunStatus(status);

    return NextResponse.json({
      status,
      timestamp: new Date().toISOString(),
      logs,
      summary,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Promotion send failed." },
      { status: 500 }
    );
  }
}
