"use client";

import { useEffect, useState } from "react";

type SetupResult = {
  dryRun: boolean;
  lists: { created: string[]; smsListId: string; emailListId: string };
  email: { eligible: number; sample: string[]; jobs?: string[] };
  sms: { eligible: number; sample: string[]; jobs?: string[] };
  notes: string[];
  rejected?: { email: string; name: string; reason: string; sources: string }[];
  rejectedTotal?: number;
  error?: string;
};

type ImportJob = {
  jobId: string;
  status: string;
  results?: Record<string, unknown>;
  errors?: string;
  error?: string;
};

type ImportResults = { at: string | null; email: ImportJob[]; sms: ImportJob[]; error?: string };

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
  const [imports, setImports] = useState<ImportResults | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkImports() {
    setChecking(true);
    setError("");
    try {
      const res = await fetch("/api/marketing-opt-ins?imports=1");
      const data = (await res.json()) as ImportResults;
      if (!res.ok) throw new Error(data.error || "Import lookup failed");
      setImports(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import lookup failed");
    } finally {
      setChecking(false);
    }
  }

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
          {running === "run" ? "Setting up..." : "Create lists & add contacts"}
        </button>
        <button
          type="button"
          onClick={checkImports}
          disabled={checking || !saved?.lastBackfill}
          className="rounded-full border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium transition hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          {checking ? "Checking..." : "Check import results"}
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
            {result.email.jobs ? ` · ${result.email.jobs.length} import job(s) started` : ""}
          </p>
          <p>
            Text Club: <strong>{result.sms.eligible}</strong> eligible
            {result.sms.jobs ? ` · ${result.sms.jobs.length} import job(s) started` : ""}
          </p>
          {result.lists.created.length ? <p>Lists: {result.lists.created.join(", ")}</p> : null}
          <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-ink-muted)]">
            {result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {result.rejected?.length ? (
            <details className="rounded-lg bg-white p-3">
              <summary className="cursor-pointer text-xs font-medium">
                Filtered out ({result.rejectedTotal ?? result.rejected.length}) — review for real people
              </summary>
              <div className="mt-2 max-h-80 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[var(--color-ink-muted)]">
                      <th className="py-1 pr-3">Email</th>
                      <th className="py-1 pr-3">Name</th>
                      <th className="py-1 pr-3">Reason</th>
                      <th className="py-1">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rejected.map((row, index) => (
                      <tr key={`${row.email}-${index}`} className="border-t border-[var(--color-border)]">
                        <td className="py-1 pr-3 font-mono">{row.email}</td>
                        <td className="py-1 pr-3">{row.name}</td>
                        <td className="py-1 pr-3">{row.reason}</td>
                        <td className="py-1">{row.sources}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {imports ? (
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
          <p className="font-medium">
            SendGrid import results{imports.at ? ` for ${new Date(imports.at).toLocaleString()}` : ""}
          </p>
          {(["email", "sms"] as const).map((channel) =>
            imports[channel].map((job) => (
              <div key={job.jobId} className="space-y-1">
                <p>
                  {channel === "email" ? "Email Offers" : "Text Club"} · {job.status}
                  {job.results
                    ? ` · requested ${String(job.results.requested_count ?? "?")}, created ${String(
                        job.results.created_count ?? "?"
                      )}, updated ${String(job.results.updated_count ?? "?")}, errored ${String(
                        job.results.errored_count ?? "?"
                      )}`
                    : ""}
                  {job.error ? ` · ${job.error}` : ""}
                </p>
                {job.errors ? (
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs">
                    {job.errors}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
