"use client";

import { useEffect, useState } from "react";

type SetupResult = {
  dryRun: boolean;
  lists: { created: string[]; smsListId: string; emailListId: string };
  email: { eligible: number; sample: string[]; upsert?: Record<string, number> };
  sms: { eligible: number; sample: string[]; upsert?: Record<string, number> };
  notes: string[];
  error?: string;
};

type Saved = {
  smsListId: string;
  emailListId: string;
  lastBackfill: { at: string; email: number; sms: number } | null;
};

export default function MarketingOptInsManager() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [running, setRunning] = useState<"" | "preview" | "run">("");
  const [error, setError] = useState("");

  async function loadSaved() {
    const res = await fetch("/api/marketing-opt-ins");
    if (res.ok) setSaved(await res.json());
  }

  useEffect(() => {
    loadSaved();
  }, []);

  async function run(dryRun: boolean) {
    setRunning(dryRun ? "preview" : "run");
    setError("");
    try {
      const res = await fetch("/api/marketing-opt-ins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const data = (await res.json()) as SetupResult;
      if (!res.ok) throw new Error(data.error || "Setup failed");
      setResult(data);
      await loadSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setRunning("");
    }
  }

  return (
    <section className="mt-6 space-y-5 rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-sm">
      <dl className="grid gap-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">Email Offers list</dt>
          <dd className="mt-1 break-all font-mono text-xs">{saved?.emailListId || "Not set up yet"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">Text Club list</dt>
          <dd className="mt-1 break-all font-mono text-xs">{saved?.smsListId || "Not set up yet"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">Last backfill</dt>
          <dd className="mt-1 text-xs">
            {saved?.lastBackfill
              ? `${new Date(saved.lastBackfill.at).toLocaleString()} · ${saved.lastBackfill.email} email · ${saved.lastBackfill.sms} text`
              : "Never"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={Boolean(running)}
          className="rounded-full border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium transition hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          {running === "preview" ? "Checking..." : "Preview (no changes)"}
        </button>
        <button
          type="button"
          onClick={() => run(false)}
          disabled={Boolean(running) || !result?.dryRun}
          title={!result?.dryRun ? "Run a preview first" : undefined}
          className="rounded-full bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
        >
          {running === "run" ? "Setting up... (can take a few minutes)" : "Create lists & add contacts"}
        </button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {result ? (
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
          <p className="font-medium">
            {result.dryRun ? "Preview — nothing was changed" : "Done"}
          </p>
          <p>
            Email Offers: <strong>{result.email.eligible}</strong> eligible
            {result.email.upsert ? ` · added/updated ${result.email.upsert.requested}, errors ${result.email.upsert.errored}` : ""}
          </p>
          <p>
            Text Club: <strong>{result.sms.eligible}</strong> eligible
            {result.sms.upsert ? ` · added/updated ${result.sms.upsert.requested}, errors ${result.sms.upsert.errored}` : ""}
          </p>
          {result.lists.created.length ? <p>Lists: {result.lists.created.join(", ")}</p> : null}
          <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-ink-muted)]">
            {result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
