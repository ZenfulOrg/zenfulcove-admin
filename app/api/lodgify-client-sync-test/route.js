import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import { runLodgifyClientSync } from "@/app/api/cron/route";

export const maxDuration = 300;

// Admin-only test run of the nightly Lodgify Client Sync. Dry run by default;
// dry-run logs are summarized (no per-contact emails in the response).
export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const automationConfig = await getConfig();
    automationConfig.lodgifyClientSync = {
      ...(automationConfig.lodgifyClientSync || {}),
      enabled: true,
    };

    const logs = await runLodgifyClientSync(automationConfig, dryRun);
    const contactLogs = logs.filter((log) => String(log.action).startsWith("[DRY RUN] Would sync"));
    const summary = logs.filter((log) => !String(log.action).startsWith("[DRY RUN] Would sync"));

    return NextResponse.json({
      status: logs.some((log) => log.status === "failed") ? "FAILED" : "SUCCESS",
      dryRun,
      wouldSync: contactLogs.length,
      logs: summary,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Lodgify client sync test failed." },
      { status: 500 }
    );
  }
}
