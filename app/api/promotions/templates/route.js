import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { createDynamicTemplate } from "@/lib/sendgrid";

// Admin-only: turn pasted HTML into a SendGrid dynamic template so promotions
// can be sent without opening SendGrid. Returns the new template ID.
export async function POST(request) {
  const unauthorized = await requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const name = String(body?.name || "").trim().slice(0, 100);
  const subject = String(body?.subject || "").trim().slice(0, 255);
  const html = String(body?.html || "");
  if (!name || !subject || !html.trim()) {
    return NextResponse.json({ error: "Name, subject and HTML are required." }, { status: 400 });
  }
  if (html.length > 1_000_000) {
    return NextResponse.json({ error: "HTML is too large." }, { status: 413 });
  }
  try {
    const templateId = await createDynamicTemplate({ name, subject, html });
    return NextResponse.json({ templateId });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Template create failed." }, { status: 502 });
  }
}
