import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { listActivityLogs } from "@/lib/activity-log";

const DEFAULT_LIMIT = 10;

export async function GET(request) {
  const unauthorized = await requireAdminRequest(request, { agentRead: true });
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
  const result = await listActivityLogs({ page, limit });

  return NextResponse.json({
    logs: result.logs,
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    ...(result.latestRun && { latestRun: result.latestRun }),
  });
}
