/**
 * Toast stack, top right.
 *
 * Behaviour, per spec:
 *   - spinner while a request is in flight
 *   - auto-dismiss on success
 *   - STAY and turn red on failure, with a retry action
 *
 * A failed toast is the only record the user has that something went wrong, so it
 * must never disappear on its own.
 */

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type ToastState = "pending" | "success" | "error";

export interface Toast {
  id: number;
  label: string;
  state: ToastState;
  detail?: string;
  /** Shown on error toasts only. */
  onRetry?: () => void;
}

interface ToastApi {
  push: (label: string) => number;
  resolve: (id: number, state: ToastState, detail?: string, onRetry?: () => void) => void;
  dismiss: (id: number) => void;
  toasts: Toast[];
}

const Ctx = createContext<ToastApi | null>(null);

export function useToasts(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToasts must be used inside <ToastProvider>");
  return c;
}

let nextId = 1;
const SUCCESS_LINGER_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((label: string) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, label, state: "pending" }]);
    return id;
  }, []);

  const resolve = useCallback(
    (id: number, state: ToastState, detail?: string, onRetry?: () => void) => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, state, detail, onRetry } : x)));
      // Success fades; failure stays until the human acknowledges it.
      if (state === "success") setTimeout(() => dismiss(id), SUCCESS_LINGER_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, resolve, dismiss, toasts }), [push, resolve, dismiss, toasts]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed top-3 right-3 z-50 flex w-80 flex-col gap-2"
      // Announced politely so a screen reader is told about outcomes without
      // interrupting whatever the user is typing.
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const isError = toast.state === "error";
  return (
    <div
      className={[
        "rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur",
        "transition-colors duration-200",
        isError
          ? "border-danger/60 bg-danger/15 text-ink"
          : toast.state === "success"
            ? "border-accent/50 bg-accent/12 text-ink"
            : "border-line bg-surface-2/90 text-ink",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {toast.state === "pending" && (
            <svg
              className="size-4 animate-spin text-muted"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {toast.state === "success" && (
            <svg className="size-4 text-accent" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m5 13 4 4L19 7"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {isError && (
            <svg className="size-4 text-danger" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            </svg>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{toast.label}</div>
          {toast.detail && <div className="mt-0.5 text-xs text-muted break-words">{toast.detail}</div>}
          {isError && toast.onRetry && (
            <button
              type="button"
              onClick={() => {
                onDismiss(toast.id);
                toast.onRetry?.();
              }}
              className="mt-1.5 rounded border border-line px-2 py-0.5 text-xs hover:bg-surface-2"
            >
              Retry
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-muted hover:text-ink"
        >
          <svg className="size-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
