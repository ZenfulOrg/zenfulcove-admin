import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyAdminSessionToken } from "@/lib/adminSession";

export const ADMIN_COOKIE_NAME = "zc_admin_auth";

// Shared check for server components and server actions: is there a valid
// (signed, unexpired) admin session cookie on this request?
export async function hasAdminSessionCookie() {
  const cookieStore = await cookies();
  return verifyAdminSessionToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

function bearerToken(request) {
  const header = request?.headers?.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export async function isAdminRequest(request) {
  if (await hasAdminSessionCookie()) return true;
  return safeEqual(bearerToken(request), process.env.CRON_SECRET);
}

// Read-only key for Claude/agents (env AGENT_READ_TOKEN). It is accepted only
// on routes that opt in with { agentRead: true }, and those routes only read
// data or run dry-run simulations. It can never save settings or send messages.
export function isAgentReadRequest(request) {
  return safeEqual(bearerToken(request), process.env.AGENT_READ_TOKEN);
}

export async function requireAdminRequest(request, { agentRead = false } = {}) {
  if (await isAdminRequest(request)) return null;
  if (agentRead && isAgentReadRequest(request)) return null;
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}
