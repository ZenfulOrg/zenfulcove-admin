"use client";

import { useEffect, useState } from "react";
import SendGridListPicker from "./SendGridListPicker";
import { PROMOTION_CONTACT_LISTS } from "@/lib/promotion-lists";

const DEFAULT_LIST_ID =
  PROMOTION_CONTACT_LISTS.find((list) => list.key === "all-clients")?.listId ||
  PROMOTION_CONTACT_LISTS[0]?.listId ||
  "";

const AUDIENCE_FILTERS = [
  { value: "all", label: "Everyone on the list" },
  { value: "past-guests", label: "Only past guests" },
  { value: "not-past-guests", label: "Skip past guests" },
];

const CHANNELS = [
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "both", label: "Both" },
];

const TEMPLATE_VARIABLES = [
  { token: "{{first_name}}", description: "Recipient's first name" },
  { token: "{{last_name}}", description: "Recipient's last name" },
  { token: "{{full_name}}", description: "Recipient's full name (first + last)" },
  { token: "{{email}}", description: "Recipient's email address" },
];

function TemplateVariablesInfo() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Supported template variables"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-forest/30 text-[10px] font-semibold text-forest/60 hover:border-forest hover:text-forest"
      >
        i
      </button>
      {open ? (
        <div className="absolute left-6 top-0 z-20 w-72 rounded-xl border border-sand bg-white p-3 shadow-lg">
          <p className="text-xs font-medium text-forest mb-2">
            Supported template variables
          </p>
          <p className="text-[11px] text-forest/60 mb-2">
            Reference these inside your SendGrid dynamic template.
          </p>
          <ul className="space-y-1.5">
            {TEMPLATE_VARIABLES.map((item) => (
              <li key={item.token} className="text-[11px] text-forest/80">
                <code className="font-mono text-forest">{item.token}</code>
                <span className="text-forest/50"> — {item.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

function FieldLabel({ children }) {
  return (
    <label className="block text-xs text-forest/60 uppercase tracking-wider mb-1">
      {children}
    </label>
  );
}

function ResultLog({ result }) {
  const logs = Array.isArray(result?.logs) ? result.logs : [];
  if (logs.length === 0) return null;

  return (
    <div className="rounded-xl border border-sand bg-cream/50 p-4 space-y-2 max-h-80 overflow-auto">
      <div className="text-xs uppercase tracking-wider text-forest/50">
        Latest Result
      </div>
      {logs.map((log, index) => (
        <div key={`${log.timestamp}-${index}`} className="text-sm text-forest/80">
          <span className="font-medium">[{String(log.status || "info").toUpperCase()}]</span>{" "}
          {log.action}
        </div>
      ))}
    </div>
  );
}

export default function OneOffPromotionsPanel({ onComplete }) {
  const [selectedListId, setSelectedListId] = useState(DEFAULT_LIST_ID);
  const [selectedListName, setSelectedListName] = useState("");
  const [channel, setChannel] = useState("sms");
  const [templateId, setTemplateId] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [smsMediaUrl, setSmsMediaUrl] = useState("");
  const [smsStatus, setSmsStatus] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleLabel, setScheduleLabel] = useState("");
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [scheduled, setScheduled] = useState([]);

  async function loadScheduled() {
    try {
      const res = await fetch("/api/promotions/schedule", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setScheduled(Array.isArray(data.items) ? data.items : []);
    } catch {
      /* list is informational */
    }
  }

  useEffect(() => {
    loadScheduled();
  }, []);

  async function schedulePromotion() {
    const when = new Date(scheduleAt);
    if (!scheduleAt || Number.isNaN(when.getTime())) {
      setScheduleStatus("Choose a send date and time.");
      return;
    }
    setScheduleStatus("Scheduling…");
    try {
      const res = await fetch("/api/promotions/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sendAt: when.toISOString(),
          label: scheduleLabel,
          lists: [selectedListId],
          channel,
          templateId,
          smsBody,
          smsMediaUrl,
          audienceFilter,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Scheduling failed.");
      setScheduleStatus(`Scheduled for ${new Date(data.job.sendAt).toLocaleString()}`);
      loadScheduled();
    } catch (err) {
      setScheduleStatus(err.message || "Scheduling failed.");
    }
  }

  async function cancelScheduled(id) {
    if (!window.confirm("Cancel this scheduled promotion?")) return;
    await fetch(`/api/promotions/schedule?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    loadScheduled();
  }
  const [audienceFilter, setAudienceFilter] = useState("all");
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateHtml, setTemplateHtml] = useState("");
  const [templateStatus, setTemplateStatus] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testSms, setTestSms] = useState("");
  const [testMode, setTestMode] = useState("dryRun");
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [resultModalOpen, setResultModalOpen] = useState(false);

  const emailSelected = channel === "email" || channel === "both";
  const smsSelected = channel === "sms" || channel === "both";
  const canSubmit =
    Boolean(selectedListId) &&
    (!emailSelected || templateId.trim()) &&
    (!smsSelected || smsBody.trim());

  async function runPromotion(mode) {
    if (mode === "send") {
      const fallbackLabel =
        PROMOTION_CONTACT_LISTS.find((list) => list.listId === selectedListId)?.label ||
        selectedListId;
      const selectedLabel = selectedListName || fallbackLabel;
      const confirmed = window.confirm(
        `Send this ${channel} promotion to ${selectedLabel} now?`
      );
      if (!confirmed) return;
    }

    setRunning(mode);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          lists: [selectedListId],
          channel,
          templateId,
          smsBody,
          smsMediaUrl,
          audienceFilter,
          testDestinations: {
            email: testEmail,
            sms: testSms,
          },
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Promotion request failed.");
      }

      setResult(data);
      if (mode === "send") {
        setResultModalOpen(true);
      }
      if (onComplete) onComplete(1);
    } catch (err) {
      setError(err.message || "Promotion request failed.");
    } finally {
      setRunning("");
    }
  }

  async function createTemplate() {
    setCreatingTemplate(true);
    setTemplateStatus("");
    try {
      const res = await fetch("/api/promotions/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: templateName, subject: templateSubject, html: templateHtml }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Template create failed.");
      setTemplateId(data.templateId);
      setTemplateStatus(`Created template ${data.templateId}`);
    } catch (err) {
      setTemplateStatus(err.message || "Template create failed.");
    } finally {
      setCreatingTemplate(false);
    }
  }

  async function checkLastSmsStatus() {
    const sid = String(result?.logs?.map((log) => log.action).join(" ") || "").match(/sid: ((?:SM|MM)[a-f0-9]{32})/i)?.[1];
    if (!sid) {
      setSmsStatus("No text message ID in the latest result.");
      return;
    }
    setSmsStatus("Checking…");
    try {
      const res = await fetch(`/api/messages/status?sid=${encodeURIComponent(sid)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Status lookup failed.");
      setSmsStatus(`${data.status}${data.errorCode ? ` (Twilio ${data.errorCode}: ${data.errorMessage || ""})` : ""} | media: ${data.numMedia} | segments: ${data.numSegments}`);
    } catch (err) {
      setSmsStatus(err.message || "Status lookup failed.");
    }
  }

  function openTestModal() {
    setTestMode("dryRun");
    setResult(null);
    setError("");
    setTestModalOpen(true);
  }

  async function runModalTest() {
    await runPromotion(testMode);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="font-serif text-2xl text-forest">One-Off Promotions</h2>
        <p className="text-sm text-forest/70">
          Send immediate promotions from selected SendGrid contact lists.
        </p>
      </div>

      <section className="bg-white rounded-xl shadow-sm border border-sand p-5 space-y-5">
        <div>
          <h3 className="text-lg font-medium text-forest mb-3">Audience List</h3>
          <SendGridListPicker
            label="SendGrid Contact List"
            value={selectedListId}
            onChange={(id, list) => {
              setSelectedListId(id);
              setSelectedListName(list?.name || "");
            }}
            helperText="Pick any SendGrid contact list as the audience for this promotion."
          />
        </div>

        <div>
          <FieldLabel>Past guests</FieldLabel>
          <select
            value={audienceFilter}
            onChange={(e) => setAudienceFilter(e.target.value)}
            aria-label="Past guests filter"
            className="border border-sand rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-grove/30"
          >
            {AUDIENCE_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <p className="text-xs text-forest/40 mt-1">
            Past guests are people with a non-cancelled Lodgify stay that has started.
          </p>
        </div>

        <div>
          <FieldLabel>Channel</FieldLabel>
          <div className="grid grid-cols-3 rounded-lg border border-sand p-1">
            {CHANNELS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setChannel(item.value)}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  channel === item.value
                    ? "bg-grove text-white"
                    : "text-forest/60 hover:text-forest"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {emailSelected ? (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <FieldLabel>SendGrid Template ID</FieldLabel>
              <TemplateVariablesInfo />
            </div>
            <input
              type="text"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              placeholder="d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="border border-sand rounded-lg px-3 py-2 text-sm w-full font-mono focus:outline-none focus:ring-2 focus:ring-grove/30"
            />
            <p className="text-xs text-forest/40 mt-1">
              Subject and body are defined inside the SendGrid dynamic template. Click the info icon to see the supported variables.
            </p>
            <details className="mt-3 rounded-lg border border-sand p-3">
              <summary className="cursor-pointer text-sm text-forest">Create a template from HTML</summary>
              <div className="mt-3 space-y-3">
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Template name"
                  aria-label="Template name"
                  className="border border-sand rounded-lg px-3 py-2 text-sm w-full"
                />
                <input
                  type="text"
                  value={templateSubject}
                  onChange={(e) => setTemplateSubject(e.target.value)}
                  placeholder="Email subject"
                  aria-label="Email subject"
                  className="border border-sand rounded-lg px-3 py-2 text-sm w-full"
                />
                <textarea
                  rows={6}
                  value={templateHtml}
                  onChange={(e) => setTemplateHtml(e.target.value)}
                  placeholder="Paste the email HTML"
                  aria-label="Email HTML"
                  className="border border-sand rounded-lg px-3 py-2 text-xs w-full font-mono"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={creatingTemplate || !templateName.trim() || !templateSubject.trim() || !templateHtml.trim()}
                    onClick={createTemplate}
                    className="rounded-full bg-grove px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {creatingTemplate ? "Creating…" : "Create template"}
                  </button>
                  {templateStatus ? <span className="text-xs text-forest/60">{templateStatus}</span> : null}
                </div>
              </div>
            </details>
          </div>
        ) : null}

        {smsSelected ? (
          <div>
            <div className="flex items-end justify-between gap-3">
              <FieldLabel>SMS Message</FieldLabel>
              <span className="mb-1 text-xs text-forest/40">{smsBody.length} characters</span>
            </div>
            <textarea
              rows={5}
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              className="border border-sand rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-grove/30"
            />
            <FieldLabel>Photo URL (optional, sends as MMS)</FieldLabel>
            <input
              type="url"
              value={smsMediaUrl}
              onChange={(e) => setSmsMediaUrl(e.target.value)}
              placeholder="https://www.zenfulcove.com/images/...jpg"
              aria-label="SMS photo URL"
              className="border border-sand rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-grove/30"
            />
            <p className="text-xs text-forest/40 mt-1">JPG or PNG under 500 KB. Photo texts cost more than plain texts.</p>
          </div>
        ) : null}

        <div className="flex justify-end">
          <button
            type="button"
            disabled={Boolean(running) || !canSubmit}
            onClick={openTestModal}
            className="rounded-full border border-grove/30 px-4 py-2 text-sm font-medium text-grove hover:border-grove hover:text-forest disabled:opacity-50"
          >
            Test / Dry Run
          </button>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow-sm border border-sand p-5 space-y-4">
        <h3 className="text-lg font-medium text-forest">Schedule this promotion</h3>
        <p className="text-xs text-forest/50">
          Uses the list, past-guest filter, channel and message above. Sends automatically at the chosen time (checked every 5 minutes, your local time).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            aria-label="Scheduled send time"
            className="border border-sand rounded-lg px-3 py-2 text-sm w-full"
          />
          <input
            type="text"
            value={scheduleLabel}
            onChange={(e) => setScheduleLabel(e.target.value)}
            placeholder="Label (e.g. Holiday email - past guests)"
            aria-label="Scheduled send label"
            className="border border-sand rounded-lg px-3 py-2 text-sm w-full"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={Boolean(running) || !canSubmit || !scheduleAt}
            onClick={schedulePromotion}
            className="rounded-full bg-grove px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Schedule send
          </button>
          {scheduleStatus ? <span className="text-xs text-forest/60">{scheduleStatus}</span> : null}
        </div>
        {scheduled.length ? (
          <ul className="divide-y divide-sand text-sm">
            {scheduled.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-forest/80">
                  <span className="font-medium">{item.label || item.payload?.channel}</span> · {new Date(item.sendAt).toLocaleString()} ·{" "}
                  {item.payload?.channel} · {item.payload?.audienceFilter || "all"} ·{" "}
                  <span className="uppercase text-xs">{item.status}</span>
                  {item.summary ? ` · sent ${item.summary.sent}, skipped ${item.summary.skipped}, failed ${item.summary.failed}` : ""}
                </span>
                {item.status === "pending" ? (
                  <button type="button" onClick={() => cancelScheduled(item.id)} className="text-xs text-red-600 hover:underline">
                    Cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {testModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-forest/35 px-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl border border-sand p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-medium text-forest">Test Promotion</h3>
                <p className="text-sm text-forest/55 mt-1">
                  Uses the selected list and channel from the current promotion.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTestModalOpen(false)}
                className="text-2xl leading-none text-forest/40 hover:text-forest"
              >
                ×
              </button>
            </div>

            <div>
              <FieldLabel>Run Type</FieldLabel>
              <div className="grid grid-cols-2 rounded-lg border border-sand p-1">
                <button
                  type="button"
                  onClick={() => setTestMode("dryRun")}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    testMode === "dryRun"
                      ? "bg-grove text-white"
                      : "text-forest/60 hover:text-forest"
                  }`}
                >
                  Dry Run
                </button>
                <button
                  type="button"
                  onClick={() => setTestMode("test")}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    testMode === "test"
                      ? "bg-grove text-white"
                      : "text-forest/60 hover:text-forest"
                  }`}
                >
                  Test Send
                </button>
              </div>
            </div>

            {testMode === "test" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {emailSelected ? (
                  <div>
                    <FieldLabel>Test Email</FieldLabel>
                    <input
                      type="email"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="border border-sand rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-grove/30"
                    />
                  </div>
                ) : null}
                {smsSelected ? (
                  <div>
                    <FieldLabel>Test Phone</FieldLabel>
                    <input
                      type="tel"
                      value={testSms}
                      onChange={(e) => setTestSms(e.target.value)}
                      placeholder="+18325551234"
                      className="border border-sand rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-grove/30"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <ResultLog result={result} />
            {smsSelected && result ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={checkLastSmsStatus}
                  className="rounded-full border border-grove/30 px-3 py-1.5 text-xs font-medium text-grove hover:border-grove"
                >
                  Check text delivery
                </button>
                {smsStatus ? <span className="text-xs text-forest/60">{smsStatus}</span> : null}
              </div>
            ) : null}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setTestModalOpen(false)}
                className="rounded-full border border-sand px-4 py-2 text-sm text-forest/70 hover:text-forest"
              >
                Close
              </button>
              <button
                type="button"
                disabled={
                  Boolean(running) ||
                  !canSubmit ||
                  (testMode === "test" && emailSelected && !testEmail.trim()) ||
                  (testMode === "test" && smsSelected && !testSms.trim())
                }
                onClick={runModalTest}
                className="rounded-full bg-grove px-4 py-2 text-sm font-medium text-white hover:bg-forest disabled:opacity-50"
              >
                {running ? "Running..." : testMode === "dryRun" ? "Run Dry Run" : "Send Test"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resultModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-forest/35 px-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl border border-sand p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-medium text-forest">Promotion Result</h3>
                <p className="text-sm text-forest/55 mt-1">
                  {result?.status || "Result"} from the latest promotion action.
                </p>
                {result?.summary ? (
                  <p className="text-sm font-medium text-forest/80 mt-1">
                    Sent {result.summary.sent} · Skipped {result.summary.skipped} · Failed{" "}
                    {result.summary.failed}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setResultModalOpen(false)}
                className="text-2xl leading-none text-forest/40 hover:text-forest"
              >
                ×
              </button>
            </div>
            <ResultLog result={result} />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setResultModalOpen(false)}
                className="rounded-full bg-grove px-4 py-2 text-sm font-medium text-white hover:bg-forest"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          disabled={Boolean(running) || !canSubmit}
          onClick={() => runPromotion("send")}
          className="rounded-full bg-grove px-5 py-2 text-sm font-medium text-white hover:bg-forest disabled:opacity-50"
        >
          {running === "send" ? "Sending..." : "Send Promotion"}
        </button>
      </div>
    </div>
  );
}
