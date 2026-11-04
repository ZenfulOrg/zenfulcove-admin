"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { optionsForLocalFormSource } from "@/lib/local-form-options";
import { saveGuestBookingSession, stayHref } from "@/components/customer/bookingSession";
import {
  EMAIL_OPT_IN_FIELD,
  EMAIL_OPT_IN_TEXT,
  SMS_OPT_IN_FIELD,
  SMS_OPT_IN_TEXT,
} from "@/lib/marketing-consent";

type LocalFormField = {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  optionSource?: string;
  multiple?: boolean;
};

type LocalFormSchema = {
  fields?: LocalFormField[];
  subtitle?: string;
  introText?: string;
  termsText?: string;
  submitLabel?: string;
  successMessage?: string;
};

type SignaturePadProps = {
  label: string;
  required?: boolean;
  helpText?: string;
  value: string;
  onChange: (value: string) => void;
};

type LocalFormSubmissionFile = {
  fieldName?: string;
  kind?: string;
  fileName?: string;
  signedUrl?: string;
  contentType?: string;
  size?: number;
  path?: string;
  bucket?: string;
};

const inputClass =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] focus:bg-white";

const MAX_CLIENT_FILE_BYTES = 3.5 * 1024 * 1024;
const MAX_CLIENT_REQUEST_BYTES = 3.8 * 1024 * 1024;
const IMAGE_COMPRESSION_TARGET_BYTES = 1.6 * 1024 * 1024;
const MAX_COMPRESSED_IMAGE_DIMENSION = 1800;

function fieldDomId(name: string, suffix = "") {
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, "-") || "field";
  return `local-form-${safeName}${suffix ? `-${suffix}` : ""}`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function dataUrlToBlob(dataUrl: string) {
  const [meta, data] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);/)?.[1] || "image/png";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function payloadString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") {
      const cleaned = String(value).trim();
      if (cleaned) return cleaned;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const objectValue = value as Record<string, unknown>;
      const joined = [objectValue.first, objectValue.last]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" ");
      if (joined) return joined;
    }
  }
  return "";
}

function bookingCodeFromPayload(payload: Record<string, unknown>) {
  return payloadString(payload, [
    "bookingCode",
    "booking_code",
    "bookingId",
    "booking_id",
    "bookingConfirmationId",
    "booking_confirmation_id",
    "confirmationCode",
    "confirmationId",
    "confirmation_id",
    "reservationId",
    "reservation_id",
  ]);
}

function initialValueFor(value: unknown): string | boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "";
}

function buildInitialFormValues(
  fields: LocalFormField[],
  initialValues: Record<string, unknown>
) {
  const next: Record<string, string | boolean> = {};

  for (const field of fields) {
    const name = String(field.name || "").trim();
    if (!name) continue;
    const value = initialValues[name];
    const type = String(field.type || "text").toLowerCase();

    if (type === "daterange" && value && typeof value === "object") {
      const range = value as { checkIn?: unknown; checkOut?: unknown };
      next[`${name}CheckIn`] = initialValueFor(range.checkIn);
      next[`${name}CheckOut`] = initialValueFor(range.checkOut);
      continue;
    }

    if (value !== undefined && value !== null) {
      next[name] = initialValueFor(value);
    }
  }

  return next;
}

function cleanDisplay(value: unknown) {
  return String(value ?? "").trim();
}

function formatSubmittedAt(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function readOnlyValueForField(
  field: LocalFormField,
  initialValues: Record<string, unknown>
) {
  const name = String(field.name || "").trim();
  const type = String(field.type || "text").toLowerCase();
  const value = initialValues[name];

  if (type === "daterange") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const range = value as { checkIn?: unknown; checkOut?: unknown };
      const checkIn = cleanDisplay(range.checkIn);
      const checkOut = cleanDisplay(range.checkOut);
      return [checkIn, checkOut].filter(Boolean).join(" to ");
    }
    return "";
  }

  if (type === "checkbox") {
    return value === true || value === "true" || value === "1" ? "Yes" : "";
  }

  if (type === "terms") {
    return value === true || value === "true" || value === "1" ? "Accepted" : "";
  }

  if (Array.isArray(value)) {
    return value.map(cleanDisplay).filter(Boolean).join(", ");
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const joinedName = [objectValue.first, objectValue.last]
      .map(cleanDisplay)
      .filter(Boolean)
      .join(" ");
    if (joinedName) return joinedName;
    return JSON.stringify(value);
  }

  return cleanDisplay(value);
}

function filesForField(files: LocalFormSubmissionFile[], fieldName: string) {
  return (files || []).filter(
    (file) => cleanDisplay(file.fieldName) === fieldName
  );
}

function isImageFile(file: LocalFormSubmissionFile) {
  const contentType = cleanDisplay(file.contentType).toLowerCase();
  return file.kind === "image" || file.kind === "signature" || contentType.startsWith("image/");
}

function loadImage(file: File) {
  return new Promise<{ image: HTMLImageElement; url: string }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image."));
    };
    image.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function compressImageFile(file: File) {
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    file.size <= IMAGE_COMPRESSION_TARGET_BYTES
  ) {
    return file;
  }

  let loaded: { image: HTMLImageElement; url: string } | null = null;
  try {
    loaded = await loadImage(file);
    const { image } = loaded;
    const ratio = Math.min(
      1,
      MAX_COMPRESSED_IMAGE_DIMENSION / Math.max(image.width, image.height)
    );
    const width = Math.max(1, Math.round(image.width * ratio));
    const height = Math.max(1, Math.round(image.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, width, height);

    const qualities = [0.82, 0.74, 0.66, 0.58];
    let best: Blob | null = null;
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (!blob) continue;
      best = blob;
      if (blob.size <= IMAGE_COMPRESSION_TARGET_BYTES) break;
    }
    if (!best || best.size >= file.size) return file;

    const fileName = file.name.replace(/\.[^.]+$/, "") || "upload";
    return new File([best], `${fileName}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    if (loaded) URL.revokeObjectURL(loaded.url);
  }
}

function SignaturePad({
  label,
  required,
  helpText,
  value,
  onChange,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(Boolean(value));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#1a2820";
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    hasInkRef.current = true;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function finish() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (canvas && hasInkRef.current) {
      onChange(canvas.toDataURL("image/png"));
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    onChange("");
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-muted)]">
            {label}
            {required ? " *" : ""}
          </span>
          <HelpNote text={helpText} />
        </span>
        <button
          type="button"
          onClick={clear}
          className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-ink-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        className="h-40 w-full touch-none rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]"
      />
      <p className="text-xs text-[var(--color-ink-muted)]">
        Sign inside the box using your finger, mouse, or trackpad.
      </p>
    </div>
  );
}

function HelpNote({ text }: { text?: string }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const trimmed = String(text || "").trim();
  const open = Boolean(trimmed && (hovered || focused || pinned));

  if (!trimmed) return null;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label="Please read"
        aria-expanded={open}
        onClick={() => setPinned((current) => !current)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="grid h-5 w-5 place-items-center rounded-full border border-[var(--color-border)] bg-white text-[11px] font-bold leading-none text-[var(--color-accent)] shadow-sm transition hover:border-[var(--color-accent)] hover:bg-[var(--color-bg)]"
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-7 z-30 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-[var(--color-border)] bg-white p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-[var(--color-ink)] shadow-xl"
        >
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
            Please read
          </span>
          <span className="whitespace-pre-line">{trimmed}</span>
        </span>
      ) : null}
    </span>
  );
}

function ReadOnlyFileList({ files }: { files: LocalFormSubmissionFile[] }) {
  if (files.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {files.map((file, index) => {
        const label = cleanDisplay(file.fileName) || `Upload ${index + 1}`;
        const url = cleanDisplay(file.signedUrl);
        const image = isImageFile(file);

        return (
          <div
            key={`${file.path || file.fileName || file.fieldName}-${index}`}
            className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {image && url ? (
              <a href={url} target="_blank" rel="noreferrer" className="block">
                <span
                  role="img"
                  aria-label={label}
                  className="block h-56 w-full bg-white bg-contain bg-center bg-no-repeat"
                  style={{ backgroundImage: `url("${url.replace(/"/g, '\\"')}")` }}
                />
              </a>
            ) : null}
            <div className="flex items-center justify-between gap-3 p-3">
              <span className="min-w-0 truncate text-sm font-medium text-[var(--color-ink)]">
                {label}
              </span>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-full border border-[var(--color-border)] bg-white px-3 py-1 text-xs font-medium text-[var(--color-ink)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  View
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReadOnlyField({
  field,
  schema,
  initialValues,
  existingFiles,
}: {
  field: LocalFormField;
  schema: LocalFormSchema;
  initialValues: Record<string, unknown>;
  existingFiles: LocalFormSubmissionFile[];
}) {
  const name = cleanDisplay(field.name);
  if (!name) return null;

  const type = cleanDisplay(field.type || "text").toLowerCase();
  const label = field.label || name;
  const helpText = field.helpText || "";

  if (type === "section") {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <div className="flex items-center gap-2">
          <h2 className="font-serif text-xl font-medium tracking-tight text-[var(--color-ink)]">
            {label}
          </h2>
          <HelpNote text={helpText} />
        </div>
        {field.placeholder ? (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-[var(--color-ink-muted)]">
            {field.placeholder}
          </p>
        ) : null}
      </section>
    );
  }

  const fieldFiles = filesForField(existingFiles, name);
  const value = readOnlyValueForField(field, initialValues);
  const showValue =
    Boolean(value) && !(fieldFiles.length > 0 && ["file", "image", "signature"].includes(type));
  if (fieldFiles.length === 0 && !value) return null;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-muted)]">
          {type === "signature" ? `${label} signature` : label}
        </p>
        <HelpNote text={helpText} />
      </div>

      {type === "terms" && schema.termsText ? (
        <div className="mb-3 max-h-44 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-white p-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          <p className="whitespace-pre-line">{schema.termsText}</p>
        </div>
      ) : null}

      {fieldFiles.length > 0 ? <ReadOnlyFileList files={fieldFiles} /> : null}
      {showValue ? (
        <p className="whitespace-pre-line break-words text-sm leading-relaxed text-[var(--color-ink)]">
          {value}
        </p>
      ) : null}
    </div>
  );
}

function ReadOnlyLocalForm({
  fields,
  schema,
  initialValues,
  existingFiles,
  submittedAt,
  bookingCode,
  returnHref,
}: {
  fields: LocalFormField[];
  schema: LocalFormSchema;
  initialValues: Record<string, unknown>;
  existingFiles: LocalFormSubmissionFile[];
  submittedAt?: string;
  bookingCode?: string;
  returnHref?: string;
}) {
  const resolvedBookingCode =
    cleanDisplay(bookingCode) || bookingCodeFromPayload(initialValues);
  const backHref = cleanDisplay(returnHref) || (resolvedBookingCode ? stayHref(resolvedBookingCode) : "");
  const visibleFields = fields
    .map((field) => cleanDisplay(field.name))
    .filter(Boolean);
  const visibleFieldSet = new Set(visibleFields);
  const unmatchedFiles = existingFiles.filter(
    (file) => !visibleFieldSet.has(cleanDisplay(file.fieldName))
  );
  const hasVisibleData =
    visibleFields.some((fieldName) => {
      const field = fields.find((candidate) => candidate.name === fieldName);
      return (
        field &&
        (readOnlyValueForField(field, initialValues) ||
          filesForField(existingFiles, fieldName).length > 0)
      );
    }) || fields.some((field) => cleanDisplay(field.type).toLowerCase() === "section");

  return (
    <div className="space-y-5 rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-800">
          Submitted form
        </p>
        <h2 className="mt-1 font-serif text-2xl font-medium tracking-tight text-[var(--color-ink)]">
          Your reservation form is complete.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          This copy is view-only. Contact Zenfulcove Glamping if anything needs
          to be changed.
        </p>
        {submittedAt ? (
          <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
            Submitted {formatSubmittedAt(submittedAt)}
          </p>
        ) : null}
      </div>

      {hasVisibleData ? (
        fields.map((field) => (
          <ReadOnlyField
            key={field.name}
            field={field}
            schema={schema}
            initialValues={initialValues}
            existingFiles={existingFiles}
          />
        ))
      ) : (
        <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm text-[var(--color-ink-muted)]">
          No saved form details are available to show.
        </p>
      )}

      {unmatchedFiles.length > 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-muted)]">
            Uploaded files
          </p>
          <ReadOnlyFileList files={unmatchedFiles} />
        </div>
      ) : null}

      {backHref ? (
        <a
          href={backHref}
          className="inline-flex rounded-full bg-[var(--color-accent)] px-5 py-3 text-sm font-medium text-white transition hover:bg-[var(--color-accent-strong)]"
        >
          {returnHref ? "Back to Event" : "Back to My Stay"}
        </a>
      ) : null}
    </div>
  );
}

export default function LocalForm({
  formSlug,
  schema,
  preview = false,
  staffPreview = false,
  initialValues = {},
  existingSubmissionId = "",
  existingSubmissionSubmittedAt = "",
  existingFiles = [],
  bookingCode = "",
  returnHref = "",
  showMarketingConsent = false,
}: {
  formSlug: string;
  schema: LocalFormSchema;
  preview?: boolean;
  staffPreview?: boolean;
  initialValues?: Record<string, unknown>;
  existingSubmissionId?: string;
  existingSubmissionSubmittedAt?: string;
  existingFiles?: LocalFormSubmissionFile[];
  bookingCode?: string;
  returnHref?: string;
  showMarketingConsent?: boolean;
}) {
  const router = useRouter();
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  const readOnly = Boolean(existingSubmissionId && !staffPreview && !preview);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    buildInitialFormValues(fields, initialValues)
  );
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "success">("idle");
  const [successStayHref, setSuccessStayHref] = useState("");
  const [preparingFiles, setPreparingFiles] = useState(false);
  const [error, setError] = useState("");

  if (readOnly) {
    return (
      <ReadOnlyLocalForm
        fields={fields}
        schema={schema}
        initialValues={initialValues}
        existingFiles={existingFiles}
        submittedAt={existingSubmissionSubmittedAt}
        bookingCode={bookingCode}
        returnHref={returnHref}
      />
    );
  }

  function update(name: string, value: string | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function updateFiles(
    name: string,
    fileList: FileList | null,
    fieldType = "file"
  ) {
    const selectedFiles = fileList ? Array.from(fileList) : [];
    if (selectedFiles.length === 0) {
      setFiles((current) => ({ ...current, [name]: [] }));
      return;
    }

    setPreparingFiles(true);
    setError("");
    try {
      const preparedFiles: File[] = [];
      for (const file of selectedFiles) {
        preparedFiles.push(
          fieldType === "image" ? await compressImageFile(file) : file
        );
      }
      const tooLarge = preparedFiles.find(
        (file) => file.size > MAX_CLIENT_FILE_BYTES
      );
      if (tooLarge) {
        setFiles((current) => ({ ...current, [name]: [] }));
        setError(
          `${tooLarge.name} is too large after preparing (${formatBytes(tooLarge.size)}). Please choose a smaller photo or screenshot.`
        );
        return;
      }
      setFiles((current) => ({ ...current, [name]: preparedFiles }));
    } finally {
      setPreparingFiles(false);
    }
  }

  function currentUploadBytes() {
    const fileBytes = Object.values(files)
      .flat()
      .reduce((sum, file) => sum + file.size, 0);
    const signatureBytes = Object.values(signatures)
      .filter(Boolean)
      .reduce((sum, signature) => sum + dataUrlToBlob(signature).size, 0);
    return fileBytes + signatureBytes;
  }

  function validateRequired() {
    for (const field of fields) {
      const name = String(field.name || "").trim();
      if (!name || !field.required) continue;
      const type = String(field.type || "text").toLowerCase();
      if (type === "section") continue;
      if (type === "signature" && !signatures[name]) {
        if (String(values[name] || "").trim()) continue;
        return `${field.label || name} is required.`;
      }
      if ((type === "file" || type === "image") && !(files[name]?.length > 0)) {
        return `${field.label || name} is required.`;
      }
      if (type === "checkbox" && values[name] !== true) {
        return `${field.label || name} is required.`;
      }
      if (type === "terms" && values[name] !== true) {
        return `${field.label || name} is required.`;
      }
      if (
        type === "daterange" &&
        (!String(values[`${name}CheckIn`] || "").trim() ||
          !String(values[`${name}CheckOut`] || "").trim())
      ) {
        return `${field.label || name} is required.`;
      }
      if (
        ![
          "file",
          "image",
          "signature",
          "checkbox",
          "daterange",
          "section",
          "terms",
        ].includes(type)
      ) {
        const value = values[name];
        if (!String(value || "").trim()) {
          return `${field.label || name} is required.`;
        }
      }
    }
    return "";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (preview) return;

    setStatus("submitting");
    setError("");

    const requiredError = validateRequired();
    if (requiredError) {
      setError(requiredError);
      setStatus("idle");
      return;
    }

    const uploadBytes = currentUploadBytes();
    if (uploadBytes > MAX_CLIENT_REQUEST_BYTES) {
      setError(
        `The uploaded files are too large to submit online (${formatBytes(uploadBytes)}). Please choose a smaller photo or screenshot.`
      );
      setStatus("idle");
      return;
    }

    const payload: Record<string, unknown> = {};
    const formData = new FormData();
    formData.append("formSlug", formSlug);
    formData.append("source", staffPreview ? "staff-preview" : "local");
    if (staffPreview) {
      formData.append("preview", "1");
    }

    for (const field of fields) {
      const name = String(field.name || "").trim();
      if (!name) continue;
      const type = String(field.type || "text").toLowerCase();

      if (type === "section") {
        continue;
      }

      if (type === "file" || type === "image") {
        const selectedFiles = files[name] || [];
        payload[name] = selectedFiles.map((file) => file.name);
        for (const file of selectedFiles) {
          formData.append(`file:${name}`, file, file.name);
        }
        formData.append(`fieldType:${name}`, type);
        continue;
      }

      if (type === "signature") {
        if (signatures[name]) {
          const blob = dataUrlToBlob(signatures[name]);
          formData.append(`file:${name}`, blob, `${name}-signature.png`);
          payload[name] = "Signed";
        } else if (String(values[name] || "").trim()) {
          payload[name] = values[name];
        }
        formData.append(`fieldType:${name}`, "signature");
        continue;
      }

      if (type === "daterange") {
        payload[name] = {
          checkIn: values[`${name}CheckIn`] || "",
          checkOut: values[`${name}CheckOut`] || "",
        };
        continue;
      }

      payload[name] = values[name] ?? "";
    }

    if (showMarketingConsent) {
      payload[SMS_OPT_IN_FIELD] = values[SMS_OPT_IN_FIELD] === true;
      payload[EMAIL_OPT_IN_FIELD] = values[EMAIL_OPT_IN_FIELD] === true;
    }

    const normalizedBookingCode = String(bookingCode || "").trim();
    if (normalizedBookingCode && !bookingCodeFromPayload(payload)) {
      payload.bookingCode = normalizedBookingCode;
    }

    if (existingSubmissionId) {
      formData.append("submissionId", existingSubmissionId);
    }
    formData.append("payload", JSON.stringify(payload));

    try {
      const response = await fetch("/api/forms/submit", {
        method: "POST",
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Could not submit the form.");
      }
      const bookingCode = bookingCodeFromPayload(payload);
      const redirectHref =
        !staffPreview && returnHref
          ? returnHref
          : !staffPreview && bookingCode
            ? stayHref(bookingCode)
            : "";
      if (redirectHref && !returnHref) {
        saveGuestBookingSession({
          reservation: bookingCode,
        });
      }
      setSuccessStayHref(redirectHref);
      setStatus("success");
      setValues({});
      setFiles({});
      setSignatures({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the form.");
      setStatus("idle");
    }
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm"
      >
        {fields.map((field) => {
          const name = String(field.name || "").trim();
          if (!name) return null;
          const type = String(field.type || "text").toLowerCase();
          const label = field.label || name;
          const helpText = field.helpText || "";
          const fieldId = fieldDomId(name);

          if (type === "section") {
            return (
              <section
                key={name}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
              >
                <div className="flex items-center gap-2">
                  <h2 className="font-serif text-xl font-medium tracking-tight text-[var(--color-ink)]">
                    {label}
                  </h2>
                  <HelpNote text={helpText} />
                </div>
                {field.placeholder ? (
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-[var(--color-ink-muted)]">
                    {field.placeholder}
                  </p>
                ) : null}
              </section>
            );
          }

        if (type === "textarea") {
          return (
            <FieldShell
              key={name}
              label={label}
              required={field.required}
              helpText={helpText}
              htmlFor={fieldId}
            >
              <textarea
                id={fieldId}
                name={name}
                required={Boolean(field.required)}
                value={String(values[name] || "")}
                onChange={(event) => update(name, event.target.value)}
                placeholder={field.placeholder || ""}
                rows={4}
                className={`${inputClass} resize-y`}
              />
            </FieldShell>
          );
        }

        if (type === "select") {
          const sourcedOptions = optionsForLocalFormSource(field.optionSource);
          const options =
            sourcedOptions.length > 0
              ? sourcedOptions
              : Array.isArray(field.options)
                ? field.options
                : [];
          return (
            <FieldShell
              key={name}
              label={label}
              required={field.required}
              helpText={helpText}
              htmlFor={fieldId}
            >
              <select
                id={fieldId}
                name={name}
                required={Boolean(field.required)}
                value={String(values[name] || "")}
                onChange={(event) => update(name, event.target.value)}
                className={inputClass}
              >
                <option value="">Select one</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FieldShell>
          );
        }

        if (type === "daterange") {
          const checkInName = `${name}CheckIn`;
          const checkOutName = `${name}CheckOut`;
          return (
            <FieldShell
              key={name}
              label={label}
              required={field.required}
              helpText={helpText}
              htmlFor={fieldDomId(name, "check-in")}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]">
                    Check-in
                  </span>
                  <input
                    id={fieldDomId(name, "check-in")}
                    name={checkInName}
                    type="date"
                    required={Boolean(field.required)}
                    value={String(values[checkInName] || "")}
                    onChange={(event) =>
                      update(checkInName, event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]">
                    Check-out
                  </span>
                  <input
                    id={fieldDomId(name, "check-out")}
                    name={checkOutName}
                    type="date"
                    required={Boolean(field.required)}
                    min={String(values[checkInName] || "") || undefined}
                    value={String(values[checkOutName] || "")}
                    onChange={(event) =>
                      update(checkOutName, event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
              </div>
            </FieldShell>
          );
        }

        if (type === "checkbox") {
          return (
            <label
              key={name}
              className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
            >
              <input
                name={name}
                type="checkbox"
                checked={values[name] === true}
                onChange={(event) => update(name, event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
              />
              <span className="flex-1 text-sm text-[var(--color-ink)]">
                <span className="inline-flex items-center gap-2">
                  <span>
                    {label}
                    {field.required ? " *" : ""}
                  </span>
                  <HelpNote text={helpText} />
                </span>
              </span>
            </label>
          );
        }

        if (type === "file" || type === "image") {
          return (
            <FieldShell
              key={name}
              label={label}
              required={field.required}
              helpText={helpText}
              htmlFor={fieldId}
            >
              <input
                id={fieldId}
                name={name}
                type="file"
                required={Boolean(field.required)}
                multiple={field.multiple !== false}
                accept={type === "image" ? "image/*" : undefined}
                onChange={(event) =>
                  updateFiles(name, event.target.files, type)
                }
                className="block w-full cursor-pointer rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-ink)] file:mr-3 file:cursor-pointer file:border-0 file:bg-[var(--color-accent)] file:px-4 file:py-3 file:text-sm file:font-medium file:text-white"
              />
              <span className="mt-1 block text-xs text-[var(--color-ink-muted)]">
                {type === "image"
                  ? "Large phone photos are compressed automatically. If it still fails, use a smaller photo or screenshot."
                  : "Upload files up to 4MB each."}
              </span>
            </FieldShell>
          );
        }

        if (type === "signature") {
          return (
            <SignaturePad
              key={name}
              label={label}
              required={field.required}
              helpText={helpText}
              value={signatures[name] || String(values[name] || "")}
              onChange={(value) => {
                setValues((current) => ({ ...current, [name]: value || "" }));
                setSignatures((current) => ({ ...current, [name]: value }));
              }}
            />
          );
        }

        if (type === "terms") {
          const termsText = String(schema.termsText || "").trim();
          return (
            <div
              key={name}
              className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
            >
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-xl font-medium tracking-tight text-[var(--color-ink)]">
                  Terms and Conditions
                </h2>
                <HelpNote text={helpText} />
              </div>
              <div className="max-h-52 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-white p-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
                {termsText ? (
                  <p className="whitespace-pre-line">{termsText}</p>
                ) : (
                  <p className="text-amber-800">
                    Terms and conditions have not been configured for this
                    form yet.
                  </p>
                )}
              </div>
              <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--color-ink)]">
                <input
                  name={name}
                  type="checkbox"
                  required={Boolean(field.required)}
                  checked={values[name] === true}
                  onChange={(event) => update(name, event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
                />
                <span>
                  {label}
                  {field.required ? " *" : ""}
                </span>
              </label>
            </div>
          );
        }

        return (
          <FieldShell
            key={name}
            label={label}
            required={field.required}
            helpText={helpText}
            htmlFor={fieldId}
          >
            <input
              id={fieldId}
              name={name}
              type={type || "text"}
              required={Boolean(field.required)}
              value={String(values[name] || "")}
              onChange={(event) => update(name, event.target.value)}
              placeholder={field.placeholder || ""}
              className={inputClass}
            />
          </FieldShell>
        );
      })}

        {showMarketingConsent ? (
          <fieldset className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
              Stay in touch (optional)
            </legend>
            {[
              { name: SMS_OPT_IN_FIELD, text: SMS_OPT_IN_TEXT },
              { name: EMAIL_OPT_IN_FIELD, text: EMAIL_OPT_IN_TEXT },
            ].map((option) => (
              <label
                key={option.name}
                className="flex cursor-pointer items-start gap-3 text-sm text-[var(--color-ink)]"
              >
                <input
                  name={option.name}
                  type="checkbox"
                  checked={values[option.name] === true}
                  onChange={(event) => update(option.name, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
                />
                <span className="leading-relaxed">{option.text}</span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {error ? <p className="text-sm text-red-700">{error}</p> : null}

        <button
          type={preview ? "button" : "submit"}
          disabled={status === "submitting" || preparingFiles}
          className="rounded-full bg-[var(--color-accent)] px-6 py-3 text-sm font-medium text-white transition hover:bg-[var(--color-accent-strong)] disabled:opacity-60"
        >
          {preparingFiles
            ? "Preparing uploads..."
            : status === "submitting"
              ? "Submitting..."
              : schema.submitLabel || "Submit"}
        </button>
      </form>

      {status === "success" ? (
        <SuccessModal
          message={schema.successMessage}
          onClose={() => {
            if (successStayHref) {
              router.push(successStayHref);
              return;
            }
            setStatus("idle");
          }}
        />
      ) : null}
    </>
  );
}

function SuccessModal({
  message,
  onClose,
}: {
  message?: string;
  onClose: () => void;
}) {
  const confetti = Array.from({ length: 18 }, (_, index) => index);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[var(--color-ink)]/45 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-success-title"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white p-6 text-center shadow-2xl"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 overflow-hidden">
          {confetti.map((piece) => (
            <span
              key={piece}
              className="success-confetti absolute top-[-1rem] block h-3 w-2 rounded-sm"
              style={{
                left: `${8 + ((piece * 47) % 84)}%`,
                animationDelay: `${piece * 0.08}s`,
                background:
                  piece % 3 === 0
                    ? "var(--color-accent)"
                    : piece % 3 === 1
                      ? "#f2c94c"
                      : "#5bbf8a",
              }}
            />
          ))}
        </div>

        <div className="relative">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl font-semibold text-emerald-800">
            ✓
          </div>
          <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-accent)]">
            Submission Received
          </p>
          <h2
            id="form-success-title"
            className="mt-2 font-serif text-3xl font-medium tracking-tight text-[var(--color-ink)]"
          >
            Thanks, we have it.
          </h2>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[var(--color-ink-muted)]">
            {message || "Thanks. We received your information."}
          </p>

          <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left text-sm leading-relaxed text-[var(--color-ink-muted)]">
            <p className="font-semibold text-[var(--color-ink)]">
              What happens next
            </p>
            <p className="mt-1">
              Your submission is saved for the Zenfulcove Glamping team to review before
              any stay codes or follow-up details are sent.
            </p>
            <p className="mt-2">
              Need to update something? Contact us at{" "}
              <a
                href="mailto:contact@zenfulcove.com"
                className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-strong)]"
              >
                contact@zenfulcove.com
              </a>
              .
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="mt-6 rounded-full bg-[var(--color-accent)] px-6 py-3 text-sm font-medium text-white transition hover:bg-[var(--color-accent-strong)]"
          >
            OK
          </button>
        </div>

        <style>{`
          @keyframes success-confetti-fall {
            0% {
              transform: translateY(-1rem) rotate(0deg);
              opacity: 0;
            }
            15% {
              opacity: 1;
            }
            100% {
              transform: translateY(8rem) rotate(240deg);
              opacity: 0;
            }
          }
          .success-confetti {
            animation: success-confetti-fall 1.4s ease-out forwards;
          }
        `}</style>
      </div>
    </div>
  );
}

function FieldShell({
  label,
  required,
  helpText,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  helpText?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <div className="mb-1 flex items-center gap-2">
        <label
          htmlFor={htmlFor}
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-muted)]"
        >
          {label}
          {required ? " *" : ""}
        </label>
        <HelpNote text={helpText} />
      </div>
      {children}
    </div>
  );
}
