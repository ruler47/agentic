import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  ariaLabel: string;
  /** Maximum width — Tailwind utility. Defaults to max-w-2xl. */
  widthClassName?: string;
};

/**
 * Lightweight modal: portal to body, click-outside + Escape close, focus
 * restored to the element that opened it. We deliberately keep this small
 * and skip Radix until we hit a screen that needs popovers/dropdowns.
 */
export function Modal({ open, onClose, children, ariaLabel, widthClassName = "max-w-2xl" }: ModalProps) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    // Move focus inside the modal on open.
    requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={[
          "mt-10 w-full rounded-[var(--radius-card)] border border-app-border bg-app-surface text-app-text shadow-2xl outline-none",
          widthClassName,
        ].join(" ")}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
