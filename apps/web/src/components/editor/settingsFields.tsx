import { useEffect, useState, type ReactNode } from "react";
import { inputClass } from "../ui/Field";

/** Text input that commits on blur / Enter rather than on every keystroke. */
export function CommitText({
  value,
  onCommit,
  placeholder,
  multiline = false,
  maxLength,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  label: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  if (multiline) {
    return (
      <textarea
        aria-label={label}
        className={`${inputClass} resize-y`}
        rows={3}
        value={local}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      aria-label={label}
      type="text"
      className={inputClass}
      value={local}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Number input committing on blur; empty commits `undefined` when `allowEmpty`. */
export function CommitNumber({
  value,
  onCommit,
  min,
  max,
  step = 1,
  allowEmpty = false,
  placeholder,
  label,
}: {
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  min: number;
  max: number;
  step?: number;
  allowEmpty?: boolean;
  placeholder?: string;
  label: string;
}) {
  const [local, setLocal] = useState(value === undefined ? "" : String(value));
  useEffect(() => setLocal(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    if (local.trim() === "") {
      if (allowEmpty && value !== undefined) onCommit(undefined);
      else if (!allowEmpty) setLocal(value === undefined ? "" : String(value));
      return;
    }
    const n = Math.min(max, Math.max(min, Number(local)));
    if (!Number.isFinite(n)) return;
    setLocal(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      aria-label={label}
      type="number"
      className={inputClass}
      value={local}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Slider that previews locally and commits on release. */
export function CommitRange({
  value,
  onCommit,
  min,
  max,
  step,
  format,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  label: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={label}
        type="range"
        className="flex-1 accent-[var(--color-accent-500)]"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-12 text-right font-mono text-xs text-neutral-400 tabular-nums">{format(local)}</span>
    </div>
  );
}

/** Colour picker; the picker fires continuously, so it commits on blur. */
export function ColorInput({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#ffffff";
  const [local, setLocal] = useState(normalized);
  useEffect(() => setLocal(normalized), [normalized]);
  return (
    <input
      aria-label={label}
      type="color"
      className="h-8 w-full cursor-pointer rounded-md border border-neutral-700 bg-neutral-950 p-0.5"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== normalized && onCommit(local.toUpperCase())}
    />
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-4">
      <h3 className="mb-3 text-xs font-semibold tracking-wide text-neutral-300">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
