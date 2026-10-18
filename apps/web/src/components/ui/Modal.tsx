import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { IconButton } from "./Button";

export interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

/** Centered dialog with a backdrop. Escape and backdrop clicks close it. */
export function Modal({ title, open, onClose, children, footer, width = "w-[440px]" }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, button[data-autofocus]");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${width} max-w-[90vw] rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <IconButton icon={X} label={t.common.close} onClick={onClose} />
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
