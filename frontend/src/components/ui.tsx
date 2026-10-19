import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Clock, Copy, Loader2, ShieldAlert, XCircle } from "lucide-react";
import type { Verdict } from "../lib/types";
import { short } from "../lib/format";

export function Stat({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  const toneCls = tone === "good" ? "text-emerald-700 dark:text-emerald-400" : tone === "bad" ? "text-red-700 dark:text-red-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-slate-900 dark:text-white";
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
        {icon && <span className="text-slate-400">{icon}</span>}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
    </div>
  );
}

const VERDICT: Record<Verdict, { cls: string; icon: ReactNode }> = {
  Verified: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300", icon: <CheckCircle2 size={13} /> },
  Flagged: { cls: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300", icon: <AlertTriangle size={13} /> },
  Rejected: { cls: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300", icon: <XCircle size={13} /> },
  Pending: { cls: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300", icon: <Clock size={13} /> },
};

export function VerdictBadge({ v, score }: { v: Verdict; score?: number }) {
  const s = VERDICT[v] ?? VERDICT.Pending;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.cls}`}>
      {s.icon}
      {v}
      {score !== undefined && v !== "Pending" && <span className="opacity-70">· {Math.round(score)}</span>}
    </span>
  );
}

export function Pill({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "brand" | "blue" | "amber" | "red" }) {
  const t = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400",
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
    amber: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
    red: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function Hash({ value, n = 6, label }: { value?: string | null; n?: number; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <button
      type="button"
      title={value}
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded font-mono text-xs text-slate-600 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-400"
    >
      {label && <span className="font-sans text-slate-400">{label}</span>}
      {short(value, n)}
      {copied ? <Check size={11} /> : <Copy size={11} className="opacity-50" />}
    </button>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-8 text-sm text-slate-500">
      <Loader2 className="animate-spin" size={16} /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <ShieldAlert size={16} className="mt-0.5 shrink-0" />
      <span className="break-words">{error}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <h2 className="h-section">{title}</h2>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Meter({ value, tone = "brand" }: { value: number; tone?: "brand" | "amber" | "red" }) {
  const c = tone === "brand" ? "bg-brand-500" : tone === "amber" ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <div className={`h-full rounded-full ${c}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
