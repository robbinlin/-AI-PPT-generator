import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export const inputClass =
  "w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-accent-500 focus:outline-none disabled:opacity-50";

export function Field({
  label,
  hint,
  children,
  inline = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <label className={inline ? "flex items-center justify-between gap-3 text-sm" : "flex flex-col gap-1 text-sm"}>
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} resize-none ${props.className ?? ""}`} />;
}

export interface Option<V extends string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: V | "";
  options: ReadonlyArray<Option<V>>;
  onChange: (value: V) => void;
  placeholder?: string;
}

export function Select<V extends string>({ value, options, onChange, placeholder, className = "", ...rest }: SelectProps<V>) {
  return (
    <select
      {...rest}
      value={value}
      onChange={(e) => {
        const next = options.find((o) => o.value === e.target.value);
        if (next) onChange(next.value);
      }}
      className={`${inputClass} ${className}`}
    >
      {(value === "" || placeholder) && (
        <option value="" disabled>
          {placeholder ?? ""}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-accent-500" : "bg-neutral-700"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </label>
  );
}
