"use client";

import Link from "next/link";

const CATEGORIES = [
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    id: "messages",
    label: "Messages",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    id: "forms",
    label: "Forms",
    href: "/admin/forms",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
        <path d="M14 2v5h5" />
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </svg>
    ),
  },
  {
    id: "events",
    label: "Events",
    href: "/admin/events",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M16 2v4" />
        <path d="M8 2v4" />
        <path d="M3 10h18" />
        <path d="M8 14h.01" />
        <path d="M12 14h.01" />
        <path d="M16 14h.01" />
        <path d="M8 18h.01" />
        <path d="M12 18h.01" />
      </svg>
    ),
  },
  {
    id: "kayaks",
    label: "Rentals",
    href: "/admin/kayaks",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 16c4 3 14 3 18 0" />
        <path d="M5 13c2-3 12-3 14 0" />
        <path d="M8 11l2 7" />
        <path d="M16 11l-2 7" />
      </svg>
    ),
  },
  {
    id: "products",
    label: "Products",
    href: "/admin/products",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 2l1.5 4h9L18 2" />
        <path d="M5 6h14l-1 16H6L5 6z" />
        <path d="M9 10a3 3 0 006 0" />
      </svg>
    ),
  },
  {
    id: "spa",
    label: "In-Cabin Massage",
    href: "/admin/spa",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22c4.97-3 8-7 8-11a8 8 0 0 0-16 0c0 4 3.03 8 8 11z" />
        <path d="M12 11c0-2.5 1.5-4.5 4-5.5-.5 3-2 5-4 5.5z" />
        <path d="M12 11c0-2.5-1.5-4.5-4-5.5.5 3 2 5 4 5.5z" />
      </svg>
    ),
  },
  {
    id: "marketing-opt-ins",
    label: "Marketing Opt-ins",
    href: "/admin/marketing-opt-ins",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4h16v12H5.17L4 17.17V4z" />
        <path d="M8 9l2.5 2.5L16 7" />
      </svg>
    ),
  },
  {
    id: "promotions",
    label: "One-Off Promotions",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 11v2a4 4 0 0 0 4 4h1l4 4v-4h3a4 4 0 0 0 4-4v-2" />
        <path d="M8 9h8" />
        <path d="M9 5h6" />
      </svg>
    ),
  },
  {
    id: "vacancy",
    label: "Vacancy Promo Emails",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M22 4L12 13L2 4" />
      </svg>
    ),
  },
  {
    id: "waiver",
    label: "Waiver Reminders",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
  },
  {
    id: "popup",
    label: "Popup Follow Ups",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
    ),
  },
  {
    id: "event-popup",
    label: "Event Popup SMS",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        <path d="M8 9h8" />
        <path d="M8 13h5" />
      </svg>
    ),
  },
  {
    id: "syncs",
    label: "Syncs",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="17 8 21 12 17 16" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    ),
  },
];

const GROUPS = [
  { label: "Operations", ids: ["settings", "syncs"] },
  {
    label: "Marketing",
    ids: [
      "messages",
      "promotions",
      "vacancy",
      "waiver",
      "popup",
      "event-popup",
    ],
  },
  {
    label: "Customer Portal",
    ids: ["forms", "events", "kayaks", "products", "spa"],
  },
];

const CATEGORY_BY_ID = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category])
);

/**
 * @param {{
 *   activeCategory: string;
 *   onSelect: (category: string) => void;
 *   collapsed: boolean;
 *   onToggleCollapse: () => void;
 *   mobileOpen?: boolean;
 *   onClose?: (() => void) | null;
 * }} props
 */
export default function Sidebar({
  activeCategory,
  onSelect,
  collapsed,
  onToggleCollapse,
  mobileOpen = false,
  onClose = null,
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-all duration-200 md:relative md:z-auto md:translate-x-0 ${
        collapsed ? "md:w-[64px]" : "md:w-[260px]"
      } ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 md:hidden">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-ink-muted)]">
          Menu
        </span>
        <button
          type="button"
          onClick={() => onClose?.()}
          aria-label="Close menu"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--color-border)] bg-white text-xl leading-none text-[var(--color-ink-muted)]"
        >
          ×
        </button>
      </div>
      {/* Collapse toggle */}
      <button
        onClick={onToggleCollapse}
        className={`mx-2 mt-3 hidden items-center rounded-xl px-3 py-2 text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)] md:flex ${
          collapsed ? "justify-center" : "justify-between"
        }`}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {!collapsed && (
          <span className="text-xs font-semibold uppercase tracking-[0.2em]">
            Menu
          </span>
        )}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform duration-200 ${
            collapsed ? "rotate-180" : ""
          }`}
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      <nav className="flex-1 flex flex-col gap-4 px-2 py-3">
        {GROUPS.map((group) => (
          <div key={group.label} className="space-y-1.5">
            {!collapsed && (
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-muted)]">
                {group.label}
              </p>
            )}
            {group.ids.map((id) => {
              const cat = CATEGORY_BY_ID[id];
              const isActive = activeCategory === cat.id;
              if (cat.href) {
                return (
                  <Link
                    key={cat.id}
                    href={cat.href}
                    onClick={() => onClose?.()}
                    title={collapsed ? cat.label : undefined}
                    className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors duration-150 ${
                      isActive
                        ? "bg-[var(--color-accent)] text-white shadow-sm"
                        : "text-[var(--color-ink-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    <span className="shrink-0">{cat.icon}</span>
                    {!collapsed && (
                      <span className="truncate font-medium">
                        {cat.label}
                      </span>
                    )}
                  </Link>
                );
              }

              return (
                <button
                  key={cat.id}
                  onClick={() => {
                    onSelect(cat.id);
                    onClose?.();
                  }}
                  title={collapsed ? cat.label : undefined}
                  className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors duration-150 ${
                    isActive
                      ? "bg-[var(--color-accent)] text-white shadow-sm"
                      : "text-[var(--color-ink-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  <span className="shrink-0">{cat.icon}</span>
                  {!collapsed && (
                    <span className="truncate font-medium">{cat.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
