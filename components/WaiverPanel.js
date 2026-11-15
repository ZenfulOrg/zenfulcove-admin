"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Toggle from "./Toggle";

const KNOWN_UNITS = [
  { id: "608952", name: "Fairy House" },
  { id: "608953", name: "Desert Rose" },
  { id: "608954", name: "Sky Castle" },
  { id: "608955", name: "Bird House" },
  { id: "754651", name: "Doodle House" },
];

const DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES = ["Doodle House"];

const DEFAULT_EMAILS = [
  {
    daysBeforeCheckin: 2,
    templateId: "",
    subjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
    messageTemplate: "",
    label: "Reminder 1",
  },
  {
    daysBeforeCheckin: 1,
    templateId: "",
    subjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
    messageTemplate: "",
    label: "Reminder 2",
  },
  {
    daysBeforeCheckin: 0,
    templateId: "",
    subjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
    messageTemplate: "",
    label: "Reminder 3",
  },
];

const FORM_SOURCE_INTERNAL = "internal";
const FORM_SOURCE_JOTFORM = "jotform";
const TEST_MODE_ACCESS_CODE = "access-code";
const TEST_MODE_REMINDER = "waiver-reminder";
const PUBLIC_APP_BASE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://stay.zenfulcove.com"
).replace(/\/+$/, "");

const TEMPLATE_VARIABLES = [
  "GuestFirstName",
  "GuestName",
  "Arrival",
  "Departure",
  "KeyCode",
  "bookingId",
  "propertyDisplayName",
  "PropertyDisplayName",
  "propertyName",
  "PropertyName",
  "address",
  "googleMapsAddress",
  "googleMapsUrl",
  "googleMapsURL",
  "GoogleMapsURL",
  "wifiName",
  "wifiPassword",
  "unitDirections",
  "parkingInstructions",
  "dedicatedKayakText",
  "additionalKayakText",
  "lifeJacketText",
  "amenitiesText",
  "additionalRulesText",
  "hostName",
  "urgentPhone",
  "reservationFormUrl",
  "reservationFormURL",
  "waiverUrl",
  "waiverURL",
];

const ACCESS_MESSAGE_PLACEHOLDER =
  "Greetings {{GuestFirstName}},\n\nWe are excited to welcome you to {{propertyDisplayName}}.\n\nCheck-in Date: {{Arrival}}\nCheck-out Date: {{Departure}}\n\nAccess Code: {{KeyCode}}";

const CHECKIN_INFO_MESSAGE_PLACEHOLDER =
  "Greetings {{GuestFirstName}},\n\nWe are excited to welcome you to {{propertyDisplayName}}.\n\nCheck-in Date: {{Arrival}}\nCheck-out Date: {{Departure}}\n\nYour access code will be sent on the morning of check-in.";

const CODE_ONLY_MESSAGE_PLACEHOLDER =
  "Greetings {{GuestFirstName}},\n\nYour access code for {{propertyDisplayName}} is {{KeyCode}}.\n\nThis code will only work during your reservation time.";

const REMINDER_MESSAGE_PLACEHOLDER =
  "Greetings {{GuestFirstName}},\n\nYour stay at {{propertyDisplayName}} is coming up. Please complete the reservation form before arrival so we can release your access information.\n\nReservation Form: {{reservationFormUrl}}\n\nAccess codes are only released once the form is submitted.";

const DEFAULT_PREVIEW_VALUES = {
  GuestFirstName: "Sample",
  GuestName: "Sample Guest",
  GuestLastName: "Guest",
  guestFirstName: "Sample",
  guestName: "Sample Guest",
  guestLastName: "Guest",
  Arrival: "2026-05-20",
  Departure: "2026-05-22",
  checkinDate: "2026-05-20",
  checkoutDate: "2026-05-22",
  KeyCode: "1234",
  accessCode: "1234",
  code: "1234",
  propertyDisplayName: "SKY CASTLE",
  PropertyDisplayName: "SKY CASTLE",
  propertyName: "Sky Castle",
  PropertyName: "Sky Castle",
  unitName: "Sky Castle",
  UnitName: "Sky Castle",
  wifiName: "SKYCASTLE",
  wifiPassword: "Iamgrateful!",
  address: "103 potato smith rd, unit c, elgin texas 78621",
  googleMapsAddress: "103 potato smith rd, unit c, elgin texas 78621",
  googleMapsUrl: "https://maps.app.goo.gl/QowaHLFH3anBavuv6?g_st=ic",
  unitDirections: "Once you are at Zenfulcove Glamping, follow the signs to the \"SKY CASTLE\"",
  parkingInstructions: "Parking - please park in front of your unit on the white gravel driveway.",
  reservationFormUrl: `${PUBLIC_APP_BASE_URL}/forms/welcome-to-zenfulcove`,
  reservationFormURL: `${PUBLIC_APP_BASE_URL}/forms/welcome-to-zenfulcove`,
  waiverUrl: `${PUBLIC_APP_BASE_URL}/forms/welcome-to-zenfulcove`,
  waiverURL: `${PUBLIC_APP_BASE_URL}/forms/welcome-to-zenfulcove`,
  dedicatedKayakText: "There is one dedicated kayak for Sky Castle guests. The kayak lock code is 1010.",
  additionalKayakText: "Additional kayaks are available for rent.",
  lifeJacketText: "Please use the provided life jackets when boarding.",
  amenitiesText: "There is a gas grill on the deck, an outdoor soaking tub, private beach access, and one kayak for your enjoyment.",
  additionalRulesText: "Additional rules are in the unit.",
  hostName: "Norma",
  urgentPhone: "512-273-7962",
  accessMessageText: "Sample access message text",
  accessMessageHtml: "<strong>Sample access message</strong>",
};

const MESSAGE_PREVIEW_CLASS =
  "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-forest [&_a]:break-all [&_a]:text-grove [&_a]:underline [&_a]:underline-offset-2 [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6";

const FORMATTING_BUTTONS = [
  { label: "B", title: "Bold", before: "<strong>", after: "</strong>", fallback: "bold text" },
  { label: "I", title: "Italic", before: "<em>", after: "</em>", fallback: "italic text" },
  { label: "U", title: "Underline", before: "<u>", after: "</u>", fallback: "underlined text" },
  { label: "Bullets", title: "Bullet list", block: "<ul>\n  <li>First item</li>\n  <li>Second item</li>\n</ul>" },
  { label: "Link", title: "Link", before: '<a href="https://example.com">', after: "</a>", fallback: "link text" },
];

function normalizeFormSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^\/?forms\//, "");
}

function normalizeFormSource(value) {
  return String(value || "").trim().toLowerCase() === FORM_SOURCE_INTERNAL
    ? FORM_SOURCE_INTERNAL
    : FORM_SOURCE_JOTFORM;
}

function jotformUrl(formId) {
  const normalized = String(formId || "").trim();
  if (!normalized) return "";
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `https://form.jotform.com/${normalized}`;
}

function localFormUrl(slug) {
  const normalized = normalizeFormSlug(slug || "welcome-to-zenfulcove");
  return `${PUBLIC_APP_BASE_URL}/forms/${normalized}`;
}

function normalizeLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function escapePreviewHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizePreviewHtml(value) {
  const safeTags = new Set([
    "a",
    "br",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "strong",
    "b",
    "u",
    "ul",
  ]);
  return String(value || "").replace(
    /<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (tag, rawName, rawAttrs = "") => {
      const name = rawName.toLowerCase();
      if (!safeTags.has(name)) return escapePreviewHtml(tag);
      if (tag.startsWith("</")) return `</${name}>`;
      if (name !== "a") return `<${name}>`;

      const hrefMatch = rawAttrs.match(/\shref=(["'])(.*?)\1/i);
      const href = hrefMatch?.[2]?.trim() || "";
      const isSafeHref = /^(https?:|mailto:|tel:|\/)/i.test(href);
      return isSafeHref ? `<a href="${escapePreviewHtml(href)}">` : "<a>";
    }
  );
}

function linkifyEscapedPreviewUrls(value) {
  return String(value || "").replace(/\bhttps?:\/\/[^\s<]+/g, (match) => {
    const trailingMatch = match.match(/[),.!?:;]+$/);
    const trailing = trailingMatch?.[0] || "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `<a href="${url}">${url}</a>${trailing}`;
  });
}

function previewValueForVariable(variable, previewValues = {}) {
  const key = String(variable || "").trim();
  const lowerCamel = key ? `${key.charAt(0).toLowerCase()}${key.slice(1)}` : "";
  const direct =
    previewValues[key] ??
    previewValues[lowerCamel] ??
    DEFAULT_PREVIEW_VALUES[key] ??
    DEFAULT_PREVIEW_VALUES[lowerCamel];
  return direct === undefined || direct === null || direct === ""
    ? `Sample ${key}`
    : String(direct);
}

function applyPreviewVariables(value, previewValues = {}) {
  return String(value || "").replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, variable) =>
    previewValueForVariable(variable, previewValues)
  );
}

function messagePreviewHtml(value, previewValues = {}) {
  const raw = applyPreviewVariables(value, previewValues).trim();
  if (!raw) return "";
  const hasHtml = /<\/?(a|br|em|i|li|ol|p|strong|b|u|ul)\b/i.test(raw);
  return hasHtml
    ? sanitizePreviewHtml(raw)
    : linkifyEscapedPreviewUrls(escapePreviewHtml(raw));
}

function compactMessageHtml(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/>\s+</g, "><")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPreviewValues({ selectedProperty, selectedMessageData, currentFormSlug }) {
  const formUrl = currentFormSlug
    ? localFormUrl(currentFormSlug)
    : DEFAULT_PREVIEW_VALUES.reservationFormUrl;
  const propertyDisplayName =
    selectedMessageData.displayName ||
    selectedMessageData.propertyDisplayName ||
    selectedProperty?.name ||
    DEFAULT_PREVIEW_VALUES.propertyDisplayName;
  const propertyName = selectedProperty?.name || propertyDisplayName;

  return {
    ...DEFAULT_PREVIEW_VALUES,
    propertyDisplayName,
    PropertyDisplayName: propertyDisplayName,
    propertyName,
    PropertyName: propertyName,
    unitName: propertyName,
    UnitName: propertyName,
    address: selectedMessageData.address || DEFAULT_PREVIEW_VALUES.address,
    googleMapsAddress:
      selectedMessageData.googleMapsAddress || DEFAULT_PREVIEW_VALUES.googleMapsAddress,
    googleMapsUrl: selectedMessageData.googleMapsUrl || DEFAULT_PREVIEW_VALUES.googleMapsUrl,
    wifiName: selectedMessageData.wifiName || DEFAULT_PREVIEW_VALUES.wifiName,
    wifiPassword: selectedMessageData.wifiPassword || DEFAULT_PREVIEW_VALUES.wifiPassword,
    unitDirections:
      selectedMessageData.unitDirections || DEFAULT_PREVIEW_VALUES.unitDirections,
    parkingInstructions:
      selectedMessageData.parkingInstructions || DEFAULT_PREVIEW_VALUES.parkingInstructions,
    reservationFormUrl: formUrl,
    reservationFormURL: formUrl,
    waiverUrl: formUrl,
    waiverURL: formUrl,
    dedicatedKayakText:
      selectedMessageData.dedicatedKayakText || DEFAULT_PREVIEW_VALUES.dedicatedKayakText,
    additionalKayakText:
      selectedMessageData.additionalKayakText || DEFAULT_PREVIEW_VALUES.additionalKayakText,
    lifeJacketText:
      selectedMessageData.lifeJacketText || DEFAULT_PREVIEW_VALUES.lifeJacketText,
    amenitiesText: selectedMessageData.amenitiesText || DEFAULT_PREVIEW_VALUES.amenitiesText,
    additionalRulesText:
      selectedMessageData.additionalRulesText || DEFAULT_PREVIEW_VALUES.additionalRulesText,
    hostName: selectedMessageData.hostName || DEFAULT_PREVIEW_VALUES.hostName,
    urgentPhone: selectedMessageData.urgentPhone || DEFAULT_PREVIEW_VALUES.urgentPhone,
  };
}

function findMapEntry(map, property) {
  if (!map || typeof map !== "object" || !property) return null;
  const candidates = [
    property.key,
    property.id,
    property.name,
    normalizeLookupKey(property.key),
    normalizeLookupKey(property.id),
    normalizeLookupKey(property.name),
  ].filter(Boolean);

  for (const key of candidates) {
    if (map[key] !== undefined) return { key, value: map[key] };
  }

  for (const [key, value] of Object.entries(map)) {
    const normalizedKey = normalizeLookupKey(key);
    if (
      candidates.some(
        (candidate) =>
          candidate === normalizedKey ||
          candidate.includes(normalizedKey) ||
          normalizedKey.includes(candidate)
      )
    ) {
      return { key, value };
    }
  }

  return null;
}

function configuredList(value, fallback = []) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length ? items : fallback;
  }
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function delayedAccessPropertyNames(codeRelease = {}) {
  return configuredList(
    codeRelease.delayedAccessCodePropertyNames,
    DEFAULT_DELAYED_ACCESS_PROPERTY_NAMES
  );
}

function isDelayedAccessProperty(property, messageData = {}, codeRelease = {}) {
  if (messageData.delayAccessCodeUntilCheckinDay === true) return true;
  if (messageData.delayAccessCodeUntilCheckinDay === false) return false;

  const delayedIds = configuredList(codeRelease.delayedAccessCodePropertyIds);
  const propertyId = String(property?.id || "").trim();
  if (propertyId && delayedIds.includes(propertyId)) return true;

  const delayedNames = delayedAccessPropertyNames(codeRelease).map(normalizeLookupKey);
  const candidates = [
    property?.name,
    property?.key,
    messageData.displayName,
    messageData.propertyDisplayName,
    messageData.directionsName,
  ]
    .map(normalizeLookupKey)
    .filter(Boolean);

  return candidates.some((candidate) =>
    delayedNames.some(
      (delayed) =>
        candidate === delayed ||
        candidate.includes(delayed) ||
        delayed.includes(candidate)
    )
  );
}

function Chevron({ open }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-xl border border-sand bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, description, badge, open, onToggle, children }) {
  return (
    <section className="rounded-xl border border-sand bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-serif text-xl text-forest">{title}</h3>
            {badge ? (
              <span className="rounded-full border border-sand bg-cream px-2.5 py-1 text-[11px] font-medium text-forest/70">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-forest/60">{description}</p>
          ) : null}
        </div>
        <span className="rounded-full border border-sand p-2 text-forest/60">
          <Chevron open={open} />
        </span>
      </button>
      {open ? <div className="border-t border-sand/70 p-5">{children}</div> : null}
    </section>
  );
}

function SettingsDisclosure({ title, description, badge, open, onToggle, children }) {
  return (
    <div className="rounded-lg border border-sand/80 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-forest">{title}</h4>
            {badge ? (
              <span className="rounded-full border border-sand bg-cream px-2 py-0.5 text-[11px] font-medium text-forest/60">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-forest/50">{description}</p>
          ) : null}
        </div>
        <span className="rounded-full border border-sand p-1.5 text-forest/60">
          <Chevron open={open} />
        </span>
      </button>
      {open ? <div className="border-t border-sand/70 p-4">{children}</div> : null}
    </div>
  );
}

function VariablesPopover() {
  return (
    <div className="group relative">
      <button
        type="button"
        title="Standard variables"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-sand bg-white font-mono text-[13px] font-semibold text-forest transition hover:border-grove hover:text-grove focus:outline-none focus:ring-2 focus:ring-grove/30"
      >
        {"{}"}
      </button>
      <div className="invisible absolute right-0 top-10 z-20 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-sand bg-white p-3 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-forest/50">
          Variables
        </div>
        <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
          {TEMPLATE_VARIABLES.map((variable) => (
            <span
              key={variable}
              className="rounded border border-sand/80 bg-cream/30 px-2 py-1 font-mono text-forest/80"
            >
              {`{{${variable}}}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function InfoTooltip({ label, children }) {
  return (
    <span className="group relative inline-flex align-middle">
      <span
        role="img"
        aria-label={label}
        title={label}
        className="inline-flex h-6 w-6 cursor-help items-center justify-center rounded-full border border-sand bg-white text-[11px] font-bold text-forest/60 transition group-hover:border-grove group-hover:text-grove"
      >
        i
      </span>
      <span className="pointer-events-none invisible absolute left-1/2 top-8 z-30 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-sand bg-white px-3 py-2 text-left text-xs font-normal leading-relaxed text-forest/70 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100">
        {children}
      </span>
    </span>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", mono = false, helper }) {
  return (
    <label className="block text-xs text-forest/60">
      <span className="uppercase tracking-wider">{label}</span>
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`mt-1 block w-full rounded-lg border border-sand px-3 py-2 text-sm text-forest focus:outline-none focus:ring-2 focus:ring-grove/30 ${
          mono ? "font-mono" : ""
        }`}
      />
      {helper ? <span className="mt-1 block text-xs text-forest/40">{helper}</span> : null}
    </label>
  );
}

function InlineField({ label, value, onChange, placeholder, type = "text", mono = false }) {
  return (
    <label className="block text-xs text-forest/60">
      <span className="uppercase tracking-wider">{label}</span>
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`mt-1 h-10 w-full rounded-lg border border-sand px-3 text-sm text-forest focus:outline-none focus:ring-2 focus:ring-grove/30 ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

function RichMessageField({
  label,
  value,
  onChange,
  placeholder,
  rows = 7,
  helper,
  previewValues,
}) {
  const textareaRef = useRef(null);
  const [viewMode, setViewMode] = useState("edit");
  const currentValue = value ?? "";
  const previewHtml = messagePreviewHtml(currentValue, previewValues);

  function insertFormatting(format) {
    const textarea = textareaRef.current;
    const source = currentValue;
    const start = textarea?.selectionStart ?? source.length;
    const end = textarea?.selectionEnd ?? source.length;
    const selected = source.slice(start, end);
    let insert = format.block || "";
    let nextCursorStart = start;
    let nextCursorEnd = start + insert.length;

    if (!insert) {
      const replacement = selected || format.fallback || "text";
      insert = `${format.before || ""}${replacement}${format.after || ""}`;
      nextCursorStart = start + String(format.before || "").length;
      nextCursorEnd = nextCursorStart + replacement.length;
    }

    const nextValue = `${source.slice(0, start)}${insert}${source.slice(end)}`;
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCursorStart, nextCursorEnd);
    });
  }

  function compactHtml() {
    const compacted = compactMessageHtml(currentValue);
    onChange(compacted);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  return (
    <div className="block text-xs text-forest/60">
      <span className="uppercase tracking-wider">{label}</span>
      <div className="mt-1 rounded-lg border border-sand bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-sand/80 bg-cream/40 p-2">
          <div className="flex flex-wrap gap-1">
            {FORMATTING_BUTTONS.map((format) => (
              <button
                key={format.title}
                type="button"
                title={format.title}
                onClick={() => insertFormatting(format)}
                className="rounded-md border border-sand bg-white px-2.5 py-1 text-xs font-semibold text-forest transition hover:border-grove hover:text-grove"
              >
                {format.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              onClick={compactHtml}
              disabled={!currentValue.trim()}
              className="rounded-md border border-sand bg-white px-2.5 py-1 text-xs font-semibold text-forest transition hover:border-grove hover:text-grove disabled:cursor-not-allowed disabled:opacity-40"
            >
              Compact HTML
            </button>
            <button
              type="button"
              onClick={() => setViewMode("edit")}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === "edit"
                  ? "border-grove bg-grove text-white"
                  : "border-sand bg-white text-forest hover:border-grove hover:text-grove"
              }`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setViewMode("rendered")}
              disabled={!previewHtml}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                viewMode === "rendered"
                  ? "border-grove bg-grove text-white"
                  : "border-sand bg-white text-forest hover:border-grove hover:text-grove"
              }`}
            >
              Rendered
            </button>
            <VariablesPopover />
          </div>
        </div>
        {viewMode === "rendered" && previewHtml ? (
          <div className="min-h-44 rounded-b-lg bg-white px-3 py-3">
            <div
              className={MESSAGE_PREVIEW_CLASS}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={currentValue}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            rows={rows}
            className="block w-full rounded-b-lg border-0 px-3 py-2 text-sm text-forest focus:outline-none focus:ring-2 focus:ring-grove/30"
          />
        )}
      </div>
      {helper ? <span className="mt-1 block text-xs text-forest/40">{helper}</span> : null}
      {previewHtml && viewMode !== "rendered" ? (
        <div className="mt-3 rounded-lg border border-sand bg-cream/30 p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-forest/50">
            Lodgify preview
          </div>
          <div
            className={MESSAGE_PREVIEW_CLASS}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      ) : null}
    </div>
  );
}

function SegmentButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
        active
          ? "bg-grove text-white shadow-sm"
          : "text-forest/70 hover:bg-cream hover:text-forest"
      }`}
    >
      {children}
    </button>
  );
}

export default function WaiverPanel({
  config,
  onChange,
  accessCodeRelease,
  onAccessCodeReleaseChange,
}) {
  const safeConfig = config || {};
  const codeRelease = accessCodeRelease || {};
  const emails = safeConfig.emails || safeConfig.reminders || DEFAULT_EMAILS;
  const currentFormSlug = normalizeFormSlug(
    safeConfig.localFormSlug || codeRelease.localFormSlug
  );
  const configuredFormMode = normalizeFormSource(safeConfig.formSource);

  const [formMode, setFormMode] = useState(configuredFormMode);
  const [remindersOpen, setRemindersOpen] = useState(true);
  const [accessOpen, setAccessOpen] = useState(true);
  const [deliverySettingsOpen, setDeliverySettingsOpen] = useState(true);
  const [accessTemplateOpen, setAccessTemplateOpen] = useState(false);
  const [propertySettingsOpen, setPropertySettingsOpen] = useState(false);
  const [propertyMessageOpen, setPropertyMessageOpen] = useState(false);
  const [dayOfCodeMessageOpen, setDayOfCodeMessageOpen] = useState(false);
  const [lodgifyProperties, setLodgifyProperties] = useState([]);
  const [lodgifyPropertiesStatus, setLodgifyPropertiesStatus] = useState("loading");
  const [selectedPropertyKey, setSelectedPropertyKey] = useState("");
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testMode, setTestMode] = useState(TEST_MODE_ACCESS_CODE);
  const [testBookingId, setTestBookingId] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    setFormMode(configuredFormMode);
  }, [configuredFormMode]);

  useEffect(() => {
    let active = true;
    fetch("/api/lodgify/properties")
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok) throw new Error(data.error || "Failed to load Lodgify properties.");
        setLodgifyProperties(Array.isArray(data.properties) ? data.properties : []);
        setLodgifyPropertiesStatus("loaded");
      })
      .catch(() => {
        if (!active) return;
        setLodgifyPropertiesStatus("failed");
      });

    return () => {
      active = false;
    };
  }, []);

  const propertyRows = useMemo(() => {
    const rows = new Map();
    const addRow = (property) => {
      const name = String(property.name || property.title || "").trim();
      const id = String(property.id || property.property_id || "").trim();
      const key = name || id;
      if (!key) return;
      const normalizedKey = normalizeLookupKey(key);
      const matching = Array.from(rows.values()).find((row) => {
        const rowValues = [row.key, row.id, row.name].map(normalizeLookupKey);
        return rowValues.some(
          (value) =>
            value &&
            (value === normalizedKey ||
              value.includes(normalizedKey) ||
              normalizedKey.includes(value))
        );
      });
      const rowKey = matching?.key || key;
      const existing = rows.get(rowKey) || matching || {};
      rows.set(rowKey, {
        key: rowKey,
        id: id || existing.id || "",
        name: name && !/^\d+$/.test(name) ? name : existing.name || key,
      });
    };

    KNOWN_UNITS.forEach(addRow);
    lodgifyProperties.forEach(addRow);
    Object.keys(codeRelease.propertyMessageData || {}).forEach((key) => addRow({ name: key }));
    Object.keys(codeRelease.propertyCodes || {}).forEach((key) => addRow({ name: key }));

    return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [
    lodgifyProperties,
    codeRelease.propertyMessageData,
    codeRelease.propertyCodes,
  ]);

  const selectedProperty =
    propertyRows.find((property) => property.key === selectedPropertyKey) || propertyRows[0];
  const selectedKey = selectedProperty?.key || "";
  const selectedMessageEntry = findMapEntry(
    codeRelease.propertyMessageData,
    selectedProperty
  );
  const selectedCodeEntry = findMapEntry(codeRelease.propertyCodes, selectedProperty);
  const selectedConfigKey = selectedMessageEntry?.key || selectedKey;
  const selectedCodeKey = selectedCodeEntry?.key || selectedConfigKey;
  const selectedMessageData =
    selectedMessageEntry?.value && typeof selectedMessageEntry.value === "object"
      ? selectedMessageEntry.value
      : {};
  const selectedStaticCode = selectedCodeEntry?.value || "";
  const selectedDelayedAccess = isDelayedAccessProperty(
    selectedProperty,
    selectedMessageData,
    codeRelease
  );
  const previewValues = buildPreviewValues({
    selectedProperty,
    selectedMessageData,
    currentFormSlug,
  });
  const checkinInfoPreviewValues = selectedDelayedAccess
    ? { ...previewValues, KeyCode: "", accessCode: "", code: "" }
    : previewValues;
  const codeOnlyPreviewValues = {
    ...previewValues,
    KeyCode: selectedStaticCode || DEFAULT_PREVIEW_VALUES.KeyCode,
    accessCode: selectedStaticCode || DEFAULT_PREVIEW_VALUES.accessCode,
    code: selectedStaticCode || DEFAULT_PREVIEW_VALUES.code,
  };
  const currentJotformFormId =
    safeConfig.jotformFormId ||
    safeConfig.emails?.[0]?.jotformFormId ||
    safeConfig.reminders?.[0]?.jotformFormId ||
    "";
  const reminderFormUrl = currentFormSlug ? localFormUrl(currentFormSlug) : "";
  const legacyFormUrl = jotformUrl(currentJotformFormId);
  const activeReminderCount = emails.length;
  const propertyStatusLabel =
    lodgifyPropertiesStatus === "loaded"
      ? `${lodgifyProperties.length} Lodgify loaded`
      : lodgifyPropertiesStatus === "loading"
        ? "Loading Lodgify"
        : "Fallback property list";

  function updateEnabled(enabled) {
    onChange({ ...safeConfig, enabled });
  }

  function updateJotformFormId(value) {
    onChange({ ...safeConfig, formSource: FORM_SOURCE_JOTFORM, jotformFormId: value });
    onAccessCodeReleaseChange?.({ ...codeRelease, jotformFormId: value });
  }

  function updateLocalFormSlug(value) {
    const normalized = normalizeFormSlug(value);
    setFormMode(FORM_SOURCE_INTERNAL);
    onChange({
      ...safeConfig,
      formSource: FORM_SOURCE_INTERNAL,
      localFormSlug: normalized,
    });
    onAccessCodeReleaseChange?.({ ...codeRelease, localFormSlug: normalized });
  }

  function selectFormMode(mode) {
    const nextMode = normalizeFormSource(mode);
    setFormMode(nextMode);
    onChange({ ...safeConfig, formSource: nextMode });
  }

  function updateCodeRelease(field, value) {
    onAccessCodeReleaseChange?.({ ...codeRelease, [field]: value });
  }

  function updatePropertyMessageField(key, field, value) {
    const propertyMessageData = { ...(codeRelease.propertyMessageData || {}) };
    const current =
      propertyMessageData[key] && typeof propertyMessageData[key] === "object"
        ? { ...propertyMessageData[key] }
        : {};
    const next = String(value || "");
    if (next.trim()) {
      current[field] = next;
    } else {
      delete current[field];
    }
    if (Object.keys(current).length > 0) {
      propertyMessageData[key] = current;
    } else {
      delete propertyMessageData[key];
    }
    updateCodeRelease("propertyMessageData", propertyMessageData);
  }

  function setPropertyCode(key, code) {
    const propertyCodes = { ...(codeRelease.propertyCodes || {}) };
    const normalizedCode = String(code || "").trim();
    if (normalizedCode) {
      propertyCodes[key] = normalizedCode;
    } else {
      delete propertyCodes[key];
    }
    updateCodeRelease("propertyCodes", propertyCodes);
  }

  function updateEmail(index, field, value) {
    const list = [...emails];
    list[index] = { ...list[index], [field]: value };
    onChange({ ...safeConfig, emails: list });
  }

  function addEmail() {
    onChange({
      ...safeConfig,
      emails: [
        ...emails,
        {
          daysBeforeCheckin: 1,
          templateId: "",
          subjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
          messageTemplate: "",
          label: "Reminder",
        },
      ],
    });
  }

  function removeEmail(index) {
    onChange({ ...safeConfig, emails: emails.filter((_, i) => i !== index) });
  }

  function openTestModal(mode) {
    setTestMode(mode);
    setTestError("");
    setTestResult(null);
    setTestModalOpen(true);
  }

  async function runAccessCodeTest(dryRun, options = {}) {
    setTestRunning(true);
    setTestError("");
    setTestResult(null);
    try {
      const res = await fetch("/api/access-code-release-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          sample: Boolean(options.sample),
          samplePropertyName: selectedProperty?.name || "",
          samplePropertyId: selectedProperty?.id || "",
          bookingId: testBookingId.trim(),
          waiverReminders: safeConfig,
          accessCodeRelease: codeRelease,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Access code release test failed.");
      setTestResult(data);
    } catch (err) {
      setTestError(err.message || "Access code release test failed.");
    } finally {
      setTestRunning(false);
    }
  }

  async function runReminderTest(dryRun, options = {}) {
    setTestRunning(true);
    setTestError("");
    setTestResult(null);
    try {
      const res = await fetch("/api/waiver-reminder-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          sample: Boolean(options.sample),
          samplePropertyName: selectedProperty?.name || "",
          samplePropertyId: selectedProperty?.id || "",
          bookingId: testBookingId.trim(),
          waiverReminders: safeConfig,
          accessCodeRelease: codeRelease,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Waiver reminder test failed.");
      setTestResult(data);
    } catch (err) {
      setTestError(err.message || "Waiver reminder test failed.");
    } finally {
      setTestRunning(false);
    }
  }

  const runCurrentTest =
    testMode === TEST_MODE_REMINDER ? runReminderTest : runAccessCodeTest;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl text-forest">Waiver Reminders</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-forest/70">
            This controls the guest form reminders and Lodgify access-code
            messages. Operational routing is hidden here; staff only needs the
            form source, templates, and property-specific message values.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => openTestModal(TEST_MODE_REMINDER)}
            className="rounded-full border border-sand bg-white px-4 py-2 text-sm font-medium text-forest transition hover:border-grove hover:text-grove"
          >
            Test reminders
          </button>
          <Toggle enabled={safeConfig.enabled} onChange={updateEnabled} />
        </div>
      </div>

      <Card className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-serif text-xl text-forest">Reservation form source</h3>
            <p className="mt-1 text-sm text-forest/60">
              Pick the form system for reminder links and access-code gating.
            </p>
          </div>
          <div className="inline-flex rounded-xl border border-sand bg-white p-1">
            <SegmentButton
              active={formMode === FORM_SOURCE_INTERNAL}
              onClick={() => selectFormMode(FORM_SOURCE_INTERNAL)}
            >
              Internal form
            </SegmentButton>
            <SegmentButton
              active={formMode === FORM_SOURCE_JOTFORM}
              onClick={() => selectFormMode(FORM_SOURCE_JOTFORM)}
            >
              Legacy Jotform
            </SegmentButton>
          </div>
        </div>

        {formMode === FORM_SOURCE_INTERNAL ? (
          <Field
            label="Internal form route"
            value={currentFormSlug}
            onChange={updateLocalFormSlug}
            placeholder="welcome-to-zenfulcove"
            mono
            helper={
              reminderFormUrl
                ? `Guests receive ${reminderFormUrl}. Jotform remains saved as fallback data but is not used while this route is set.`
                : "Enter the published internal form slug, without /forms/."
            }
          />
        ) : (
          <Field
            label="Legacy Jotform form ID"
            value={currentJotformFormId}
            onChange={updateJotformFormId}
            placeholder="251834442091050"
            mono
            helper={
              legacyFormUrl
                ? `Guests receive the legacy Jotform link (${legacyFormUrl}) through SendGrid templates.`
                : "Used only while Legacy Jotform is selected."
            }
          />
        )}
      </Card>

      <CollapsibleSection
        title="Reminder messages"
        description={
          formMode === FORM_SOURCE_INTERNAL
            ? "Uses Lodgify booking-thread messages for guests who have not completed the internal form. The scheduled cron posts these at 11 AM Central."
            : "Uses legacy SendGrid dynamic template IDs for guests who have not completed the Jotform waiver."
        }
        badge={`${activeReminderCount} reminders`}
        open={remindersOpen}
        onToggle={() => setRemindersOpen((value) => !value)}
      >
        <div className="space-y-4">
          {emails.map((email, index) => (
            <div key={index} className="rounded-xl border border-sand/80 bg-cream/30 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-forest">
                  {email.label || `Reminder ${index + 1}`}
                </span>
                {emails.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeEmail(index)}
                    className="rounded-lg p-2 text-red-400 transition hover:bg-white hover:text-red-600"
                    title="Remove this reminder"
                  >
                    <TrashIcon />
                  </button>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr]">
                <Field
                  label="Days before check-in"
                  type="number"
                  value={email.daysBeforeCheckin}
                  onChange={(value) =>
                    updateEmail(index, "daysBeforeCheckin", parseInt(value, 10) || 0)
                  }
                  helper="0 = morning of stay"
                />
                {formMode === FORM_SOURCE_INTERNAL ? (
                  <Field
                    label="Subject"
                    value={email.subjectTemplate || ""}
                    onChange={(value) => updateEmail(index, "subjectTemplate", value)}
                    placeholder="Reservation form needed for {{propertyDisplayName}}"
                    helper="Supports standard variables."
                  />
                ) : (
                  <Field
                    label="SendGrid template ID"
                    value={email.templateId || ""}
                    onChange={(value) => updateEmail(index, "templateId", value)}
                    placeholder="d-xxxxxxxx"
                    mono
                    helper="Legacy Jotform mode sends this dynamic template."
                  />
                )}
              </div>
              <div className="mt-3 grid grid-cols-1 gap-4">
                <Field
                  label="Label"
                  value={email.label || ""}
                  onChange={(value) => updateEmail(index, "label", value)}
                  placeholder="Reminder 1"
                />
                {formMode === FORM_SOURCE_INTERNAL ? (
                  <RichMessageField
                    label="Lodgify message"
                    value={email.messageTemplate || ""}
                    onChange={(value) => updateEmail(index, "messageTemplate", value)}
                    placeholder={REMINDER_MESSAGE_PLACEHOLDER}
                    rows={7}
                    helper="Leave blank to use the built-in reminder copy."
                    previewValues={previewValues}
                  />
                ) : null}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addEmail}
            className="rounded-full border border-sand bg-white px-4 py-2 text-sm font-medium text-forest transition hover:border-grove hover:text-grove"
          >
            Add reminder
          </button>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Access code release"
        description="Uses Lodgify booking-thread messages for gated access-code release. Normal properties release codes at 3 PM Central the day before check-in. Doodle House sends no-code check-in info then, and a code-only message at 11 AM on check-in day."
        badge={codeRelease.enabled ? "Enabled" : "Disabled"}
        open={accessOpen}
        onToggle={() => setAccessOpen((value) => !value)}
      >
        <div className="space-y-5">
          <SettingsDisclosure
            title="Delivery and testing"
            description="Controls whether the daily access-code release is active, when it runs, and how test messages are handled."
            badge={codeRelease.enabled ? "Enabled" : "Disabled"}
            open={deliverySettingsOpen}
            onToggle={() => setDeliverySettingsOpen((value) => !value)}
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-4 rounded-xl bg-cream/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-forest">Code release automation</h4>
                  <p className="mt-1 text-xs text-forest/50">
                    Delivery is through Lodgify booking messages. The access-code cron only releases completed forms at this Central time.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => openTestModal(TEST_MODE_ACCESS_CODE)}
                    className="rounded-full border border-sand bg-white px-4 py-2 text-sm font-medium text-forest transition hover:border-grove hover:text-grove"
                  >
                    Test access
                  </button>
                  <Toggle
                    enabled={Boolean(codeRelease.enabled)}
                    onChange={(enabled) => updateCodeRelease("enabled", enabled)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Release hour Central"
                  type="number"
                  value={codeRelease.releaseHourCentral ?? 15}
                  onChange={(value) =>
                    updateCodeRelease(
                      "releaseHourCentral",
                      Math.max(0, Math.min(23, Number(value || 0)))
                    )
                  }
                  helper="24-hour time. 15 means 3 PM."
                />
                <Field
                  label="Release minute"
                  type="number"
                  value={codeRelease.releaseMinuteCentral ?? 0}
                  onChange={(value) =>
                    updateCodeRelease(
                      "releaseMinuteCentral",
                      Math.max(0, Math.min(59, Number(value || 0)))
                    )
                  }
                />
              </div>
            </div>
          </SettingsDisclosure>

          <SettingsDisclosure
            title="Fallback access code message"
            description="Used only when a selected property does not have its own access-code message."
            badge={codeRelease.accessCodeMessageTemplate ? "Custom" : "Default"}
            open={accessTemplateOpen}
            onToggle={() => setAccessTemplateOpen((value) => !value)}
          >
            <div className="space-y-4">
              <Field
                label="Subject"
                value={codeRelease.accessCodeSubjectTemplate || ""}
                onChange={(value) => updateCodeRelease("accessCodeSubjectTemplate", value)}
                placeholder="Access Code for {{propertyDisplayName}}"
                helper="Supports the same variables as the message body."
              />
              <RichMessageField
                label="Lodgify message"
                value={codeRelease.accessCodeMessageTemplate || ""}
                onChange={(value) => updateCodeRelease("accessCodeMessageTemplate", value)}
                placeholder={ACCESS_MESSAGE_PLACEHOLDER}
                rows={8}
                helper="Leave blank to use the built-in full access-code message."
                previewValues={previewValues}
              />
            </div>
          </SettingsDisclosure>

          <SettingsDisclosure
            title="Property message settings"
            description="Choose one property and write the Lodgify message for that property."
            badge={propertyStatusLabel}
            open={propertySettingsOpen}
            onToggle={() => setPropertySettingsOpen((value) => !value)}
          >
            <div className="space-y-4">
              <div className="grid grid-cols-1 items-start gap-4 border-b border-sand/70 pb-4 xl:grid-cols-[minmax(240px,360px)_auto_minmax(160px,220px)_1fr]">
                <label className="block text-xs uppercase tracking-wider text-forest/60">
                  Property
                  <select
                    value={selectedKey}
                    onChange={(event) => setSelectedPropertyKey(event.target.value)}
                    className="mt-1 block w-full rounded-lg border border-sand bg-white px-3 py-2 text-sm text-forest focus:outline-none focus:ring-2 focus:ring-grove/30"
                  >
                    {propertyRows.map((property) => (
                      <option key={property.key} value={property.key}>
                        {property.name}
                      </option>
                    ))}
                  </select>
                  {selectedProperty?.id ? (
                    <span className="mt-1 block text-xs normal-case tracking-normal text-forest/40">
                      Lodgify ID {selectedProperty.id}
                    </span>
                  ) : null}
                </label>

                <div>
                  <div className="text-xs uppercase tracking-wider text-forest/60">
                    Release behavior
                  </div>
                  <div className="mt-1 flex min-h-10 items-center gap-2">
                    <span className="inline-flex h-10 items-center rounded-full border border-sand bg-cream/40 px-3 text-xs font-semibold text-forest/70">
                      {selectedDelayedAccess
                        ? "No-code 3 PM; code 11 AM"
                        : "Dynamic code at 3 PM"}
                    </span>
                    <InfoTooltip label="Release behavior details">
                      {selectedDelayedAccess
                        ? "This property uses a fixed code. The full welcome/check-in message is sent without the code at 3 PM the day before, then a short code-only message sends at 11 AM on check-in day."
                        : "The access code is generated through Jervis and included in this property's 3 PM day-before Lodgify message."}
                    </InfoTooltip>
                  </div>
                </div>

                {selectedDelayedAccess ? (
                  <InlineField
                    label="Day-of fixed code"
                    value={selectedStaticCode}
                    onChange={(value) => setPropertyCode(selectedCodeKey, value)}
                    placeholder="1968"
                    mono
                  />
                ) : (
                  <div className="hidden xl:block" />
                )}

                <div className="flex min-h-10 items-end xl:justify-end">
                  {selectedDelayedAccess ? (
                    <InfoTooltip label="Delayed code message guidance">
                      Keep <code>{"{{KeyCode}}"}</code> out of the day-before welcome message. Use <code>{"{{KeyCode}}"}</code> only in the 11 AM day-of code message.
                    </InfoTooltip>
                  ) : null}
                </div>
              </div>

              <div className="border-b border-sand/70 pb-4">
                <button
                  type="button"
                  onClick={() => setPropertyMessageOpen((value) => !value)}
                  className="flex w-full items-center justify-between gap-4 py-2 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h5 className="text-sm font-semibold text-forest">
                        {selectedDelayedAccess
                          ? "Day-before welcome message"
                          : "Property access-code message"}
                      </h5>
                      {selectedDelayedAccess ? (
                        <InfoTooltip label="Day-before message guidance">
                          This message is sent at 3 PM the day before check-in after the selected form is complete. It should not include <code>{"{{KeyCode}}"}</code>.
                        </InfoTooltip>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-forest/50">
                      {selectedDelayedAccess
                        ? "Full welcome/check-in message."
                        : "Lodgify message for the selected property."}
                    </p>
                  </div>
                  <span className="flex items-center gap-2">
                    <span className="hidden rounded-full border border-sand bg-cream px-3 py-1 text-xs text-forest/60 sm:inline-flex">
                      {selectedProperty?.name || "Selected property"}
                    </span>
                    <span className="rounded-full border border-sand p-1.5 text-forest/60">
                      <Chevron open={propertyMessageOpen} />
                    </span>
                  </span>
                </button>

                {propertyMessageOpen ? (
                  <div className="mt-3 space-y-4">
                    <Field
                      label="Subject"
                      value={selectedMessageData.accessCodeSubjectTemplate || ""}
                      onChange={(value) =>
                        updatePropertyMessageField(
                          selectedConfigKey,
                          "accessCodeSubjectTemplate",
                          value
                        )
                      }
                      placeholder={
                        selectedDelayedAccess
                          ? "Check-in information for {{propertyDisplayName}}"
                          : "Access Code for {{propertyDisplayName}}"
                      }
                    />
                    <RichMessageField
                      label="Lodgify message"
                      value={selectedMessageData.accessCodeMessageTemplate || ""}
                      onChange={(value) =>
                        updatePropertyMessageField(
                          selectedConfigKey,
                          "accessCodeMessageTemplate",
                          value
                        )
                      }
                      placeholder={
                        selectedDelayedAccess
                          ? CHECKIN_INFO_MESSAGE_PLACEHOLDER
                          : ACCESS_MESSAGE_PLACEHOLDER
                      }
                      rows={12}
                      helper={
                        selectedDelayedAccess
                          ? "Leave blank to use the built-in no-code check-in information message."
                          : "Leave blank to use the fallback access-code message."
                      }
                      previewValues={
                        selectedDelayedAccess ? checkinInfoPreviewValues : previewValues
                      }
                    />
                  </div>
                ) : null}
              </div>

              {selectedDelayedAccess ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setDayOfCodeMessageOpen((value) => !value)}
                    className="flex w-full items-center justify-between gap-4 py-2 text-left"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h5 className="text-sm font-semibold text-forest">
                          Day-of code message
                        </h5>
                        <span className="rounded-full border border-sand bg-cream px-2.5 py-0.5 text-[11px] font-medium text-forest/60">
                          Code-only
                        </span>
                        <InfoTooltip label="Day-of code message guidance">
                          Sent at 11 AM Central on check-in day after the selected form is complete. This should be short and should include <code>{"{{KeyCode}}"}</code>.
                        </InfoTooltip>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-forest/50">
                        Short message with the fixed code for this property.
                      </p>
                    </div>
                    <span className="rounded-full border border-sand p-1.5 text-forest/60">
                      <Chevron open={dayOfCodeMessageOpen} />
                    </span>
                  </button>

                  {dayOfCodeMessageOpen ? (
                    <div className="mt-3 space-y-4">
                      <Field
                        label="Subject"
                        value={selectedMessageData.codeOnlySubjectTemplate || ""}
                        onChange={(value) =>
                          updatePropertyMessageField(
                            selectedConfigKey,
                            "codeOnlySubjectTemplate",
                            value
                          )
                        }
                        placeholder="Access code for {{propertyDisplayName}}"
                      />
                      <RichMessageField
                        label="Lodgify message"
                        value={selectedMessageData.codeOnlyMessageTemplate || ""}
                        onChange={(value) =>
                          updatePropertyMessageField(
                            selectedConfigKey,
                            "codeOnlyMessageTemplate",
                            value
                          )
                        }
                        placeholder={CODE_ONLY_MESSAGE_PLACEHOLDER}
                        rows={6}
                        helper="If set, this exact day-of Lodgify message is sent. If blank, the property access-code message above is used before any global fallback."
                        previewValues={codeOnlyPreviewValues}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </SettingsDisclosure>
        </div>
      </CollapsibleSection>

      {testModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-6">
          <div className="max-h-[calc(100vh-3rem)] w-full max-w-5xl overflow-y-auto rounded-xl border border-sand bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-serif text-xl text-forest">
                  {testMode === TEST_MODE_REMINDER
                    ? "Test Waiver Reminders"
                    : "Test Access Code Release"}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-forest/60">
                  {testMode === TEST_MODE_REMINDER
                    ? "Sample flow renders fake booked, completed-form, Open, and Cancelled reminder outcomes without sending. Dry run checks real upcoming Lodgify bookings without posting or emailing. A live reminder test requires a Lodgify booking ID, sends a test-prefixed Lodgify message, and does not mark the reminder as sent."
                    : "Sample flow renders fake booked, missing-form, Open, and Cancelled bookings without sending, so the template variables and status guards can be checked together. For Doodle House it also shows both the no-code welcome and code-only message. Dry run checks real upcoming Lodgify bookings without posting or emailing. A live test requires a Lodgify booking ID."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTestModalOpen(false)}
                className="rounded-full border border-sand px-3 py-1 text-sm text-forest/70 hover:bg-cream"
              >
                Close
              </button>
            </div>

            <div className="mt-4">
              <Field
                label="Lodgify booking ID for focused/live test"
                value={testBookingId}
                onChange={setTestBookingId}
                placeholder="20505018"
                mono
                helper={
                  testMode === TEST_MODE_REMINDER
                    ? "Optional for a focused dry run. Required for a live reminder test message."
                    : "Optional for dry run. Required for a live Lodgify test message."
                }
              />
            </div>

            {testError ? <p className="mt-3 text-sm text-red-600">{testError}</p> : null}

            {testResult ? (
              <div className="mt-4 max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-xl border border-sand bg-cream/30 p-4">
                <div className="text-xs uppercase tracking-wider text-forest/50">
                  Latest result: {testResult.status}
                </div>
                <div className="mt-3 space-y-2">
                  {(Array.isArray(testResult.logs) ? testResult.logs : []).map((log, index) => (
                    <div
                      key={index}
                      className="min-w-0 overflow-hidden rounded-lg bg-white px-3 py-2 text-sm"
                    >
                      <div className="font-medium text-forest">{log.status}</div>
                      <div className="whitespace-pre-wrap break-words text-forest/70 [overflow-wrap:anywhere]">
                        {log.action}
                      </div>
                      {log.deliveryChannel || log.decision || log.bookingId ? (
                        <div className="mt-2 flex min-w-0 flex-wrap gap-2 text-[11px] uppercase tracking-wider text-forest/50">
                          {log.deliveryChannel ? <span>{log.deliveryChannel}</span> : null}
                          {log.decision ? <span>{log.decision}</span> : null}
                          {log.templateId ? <span>{log.templateId}</span> : null}
                          {log.bookingId ? (
                            <span className="break-words [overflow-wrap:anywhere]">
                              Booking {log.bookingId}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {log.templateData?.lodgifyMessageSubject ? (
                        <div className="mt-2 min-w-0 rounded-md border border-sand/70 bg-cream/30 p-2">
                          <div className="text-[11px] uppercase tracking-wider text-forest/50">
                            Subject
                          </div>
                          <div className="mt-1 break-words text-forest [overflow-wrap:anywhere]">
                            {log.templateData.lodgifyMessageSubject}
                          </div>
                        </div>
                      ) : null}
                      {log.templateData?.lodgifyMessageText ? (
                        <details className="mt-2 max-h-80 overflow-y-auto overflow-x-hidden rounded-md border border-sand/70 bg-cream/30 p-2">
                          <summary className="cursor-pointer break-words text-[11px] uppercase tracking-wider text-forest/50 [overflow-wrap:anywhere]">
                            Message preview
                          </summary>
                          <div
                            className={`mt-2 ${MESSAGE_PREVIEW_CLASS}`}
                            dangerouslySetInnerHTML={{
                              __html: messagePreviewHtml(
                                log.templateData.lodgifyMessageHtml ||
                                  log.templateData.lodgifyMessageText
                              ),
                            }}
                          />
                        </details>
                      ) : null}
                      {log.templateData ? (
                        <details className="mt-2 min-w-0 overflow-hidden rounded-md border border-sand/70 bg-cream/30 p-2">
                          <summary className="cursor-pointer break-words text-[11px] uppercase tracking-wider text-forest/50 [overflow-wrap:anywhere]">
                            Variables
                          </summary>
                          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                            {[
                              ["propertyDisplayName", log.templateData.propertyDisplayName],
                              ["PropertyDisplayName", log.templateData.PropertyDisplayName],
                              ["propertyName", log.templateData.propertyName],
                              ["reservationFormURL", log.templateData.reservationFormURL],
                              ["waiverURL", log.templateData.waiverURL],
                            ].map(([key, value]) => (
                              <div key={key} className="min-w-0">
                                <dt className="font-mono text-[10px] uppercase tracking-wider text-forest/50">
                                  {key}
                                </dt>
                                <dd className="mt-0.5 break-all font-mono text-forest/80">
                                  {String(value || "")}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => runCurrentTest(true, { sample: true })}
                disabled={testRunning}
                className="rounded-full border border-sand bg-white px-4 py-2 text-sm font-medium text-forest transition hover:border-grove hover:text-grove disabled:opacity-50"
              >
                {testRunning ? "Running..." : "Preview Fake Flow"}
              </button>
              <button
                type="button"
                onClick={() => runCurrentTest(true)}
                disabled={testRunning}
                className="rounded-full border border-sand bg-white px-4 py-2 text-sm font-medium text-forest transition hover:border-grove hover:text-grove disabled:opacity-50"
              >
                {testRunning ? "Running..." : "Run Dry Run"}
              </button>
              <button
                type="button"
                onClick={() => runCurrentTest(false)}
                disabled={testRunning || !testBookingId.trim()}
                className="rounded-full bg-grove px-4 py-2 text-sm font-semibold text-white transition hover:bg-forest disabled:opacity-50"
              >
                {testRunning
                  ? "Running..."
                  : testMode === TEST_MODE_REMINDER
                    ? "Send Reminder Test"
                    : "Send Lodgify Test"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
