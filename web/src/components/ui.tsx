/** Small building blocks shared by every page. */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export function Card({ title, subtitle, actions, children, className = "" }:
  { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Stat tile: label, value, optional context line. A status tone always comes with an icon. */
export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      {sub && <span className="tile-sub">{tone && <StatusIcon tone={tone} />}{sub}</span>}
    </div>
  );
}

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";
const ICON: Record<Tone, string> = { good: "✓", warning: "▲", serious: "!", critical: "✕", neutral: "○", info: "■" };

export const StatusIcon = ({ tone }: { tone: Tone }) => <span className={`status-icon ${tone}`} aria-hidden>{ICON[tone]}</span>;

/** Status is never color alone: icon + label, colored by tone. */
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}><StatusIcon tone={tone} />{children}</span>;
}

export function Button({ children, onClick, variant = "default", disabled, busy, title, type = "button", small }: {
  children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "danger" | "ghost"; disabled?: boolean;
  busy?: boolean; title?: string; type?: "button" | "submit"; small?: boolean;
}) {
  return (
    <button type={type} className={`btn ${variant}${small ? " small" : ""}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? "…" : children}
    </button>
  );
}

/** A row of mutually exclusive options (tabs, time ranges). */
export function Segmented<T extends string | number>({ value, options, onChange, label }:
  { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

// ---------------------------------------------------------------------------
// toasts: the result of every control command is shown, success or refusal
// ---------------------------------------------------------------------------
interface Toast { id: number; ok: boolean; text: string }
const ToastContext = createContext<(ok: boolean, text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((ok: boolean, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, ok, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ok ? 3500 : 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.ok ? "ok" : "fail"}`}><StatusIcon tone={t.ok ? "good" : "critical"} />{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Run a control call and report its outcome as a toast. */
export function useCommand() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    try {
      const r = await fn();
      toast(r.ok, r.message);
    } catch (e) {
      toast(false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}
