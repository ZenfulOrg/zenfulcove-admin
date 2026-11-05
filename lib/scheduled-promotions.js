import { randomUUID } from "node:crypto";
import { getConfig, listScheduledPromotions, saveScheduledPromotions, acquireScheduledPromotionLock } from "@/lib/kv";
import { runOneOffPromotion } from "@/lib/promotions";
import { appendLogs } from "@/lib/activity-log";

const FIELDS = ["lists", "channel", "templateId", "smsBody", "smsMediaUrl", "audienceFilter"];

export function validateScheduleInput(body, now = Date.now()) {
  const sendAt = new Date(String(body?.sendAt || ""));
  if (Number.isNaN(sendAt.getTime())) return { error: "Choose a valid send time." };
  if (sendAt.getTime() < now - 60_000) return { error: "Send time is in the past." };
  if (!Array.isArray(body?.lists) || body.lists.length === 0) return { error: "Choose a contact list." };
  const channel = String(body?.channel || "");
  if (!["email", "sms", "both"].includes(channel)) return { error: "Choose a channel." };
  if (channel !== "sms" && !String(body?.templateId || "").trim()) return { error: "Email needs a template ID." };
  if (channel !== "email" && !String(body?.smsBody || "").trim()) return { error: "Text needs a message." };
  const payload = {};
  for (const field of FIELDS) if (body?.[field] !== undefined) payload[field] = body[field];
  return { sendAt: sendAt.toISOString(), payload };
}

export async function schedulePromotion(body, createdBy = "admin") {
  const checked = validateScheduleInput(body);
  if (checked.error) return checked;
  const items = await listScheduledPromotions();
  const job = {
    id: randomUUID(),
    label: String(body?.label || "").trim().slice(0, 120),
    sendAt: checked.sendAt,
    payload: checked.payload,
    status: "pending",
    createdAt: new Date().toISOString(),
    createdBy,
  };
  items.push(job);
  await saveScheduledPromotions(items);
  return { job };
}

export async function cancelScheduledPromotion(id) {
  const items = await listScheduledPromotions();
  const job = items.find((item) => item.id === id);
  if (!job || job.status !== "pending") return false;
  job.status = "cancelled";
  job.cancelledAt = new Date().toISOString();
  await saveScheduledPromotions(items);
  return true;
}

// Called by the cron every few minutes: sends every pending job that is due.
export async function runDueScheduledPromotions(now = Date.now()) {
  const due = (await listScheduledPromotions()).filter(
    (item) => item.status === "pending" && new Date(item.sendAt).getTime() <= now
  );
  const results = [];
  for (const job of due) {
    if (!(await acquireScheduledPromotionLock(job.id))) continue;
    await updateJob(job.id, { status: "sending", startedAt: new Date().toISOString() });
    try {
      const config = await getConfig();
      const { logs, summary } = await runOneOffPromotion({ config, mode: "send", ...job.payload });
      await appendLogs(logs.map((log) => ({ ...log, automation: `Scheduled: ${job.label || "promotion"}` })));
      const failed = logs.some((log) => log.status === "failed");
      await updateJob(job.id, {
        status: failed ? (summary?.sent ? "partial" : "failed") : "sent",
        finishedAt: new Date().toISOString(),
        summary: summary || null,
      });
      results.push({ id: job.id, label: job.label, summary });
    } catch (err) {
      await updateJob(job.id, { status: "failed", finishedAt: new Date().toISOString(), error: err.message });
      results.push({ id: job.id, label: job.label, error: err.message });
    }
  }
  return results;
}

async function updateJob(id, patch) {
  const items = await listScheduledPromotions();
  const job = items.find((item) => item.id === id);
  if (!job) return;
  Object.assign(job, patch);
  await saveScheduledPromotions(items);
}
