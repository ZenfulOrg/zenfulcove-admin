import AdminRouteShell from "@/components/AdminRouteShell";
import MarketingOptInsManager from "./MarketingOptInsManager";

export const dynamic = "force-dynamic";

export default function MarketingOptInsPage() {
  return (
    <AdminRouteShell activeCategory="marketing-opt-ins" activeTitle="Marketing Opt-ins">
      <header className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-accent)]">
          Marketing
        </p>
        <h1 className="mt-2 font-serif text-3xl font-medium leading-tight tracking-tight md:text-4xl">
          Marketing Opt-ins
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Sets up the SendGrid &ldquo;Email Offers&rdquo; and &ldquo;Text Club&rdquo; lists and adds
          everyone eligible. Email Offers: every past guest plus check-in form submitters (OTA relay
          addresses excluded). Text Club: only people with a recorded text opt-in. Check-in form
          opt-ins are added automatically after setup. Re-running is safe.
        </p>
      </header>
      <MarketingOptInsManager />
    </AdminRouteShell>
  );
}
