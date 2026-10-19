import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { BadgeCheck, Boxes, Building2, Cpu, Server, FileBarChart, FlaskConical, LayoutDashboard, Leaf, Menu, Moon, Radio, Sparkles, Sun, Upload, X } from "lucide-react";
import { useConfig } from "../lib/context";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/passports", label: "Passports", icon: Boxes },
  { to: "/design", label: "Design Lab", icon: FlaskConical },
  { to: "/submit", label: "Supplier Portal", icon: Upload },
  { to: "/telemetry", label: "Fab Telemetry", icon: Radio },
  { to: "/compute", label: "AI Compute", icon: Server },
  { to: "/suppliers", label: "Supplier Trust", icon: Building2 },
  { to: "/credits", label: "Carbon Credits", icon: Leaf },
  { to: "/report", label: "Scope 3 Report", icon: FileBarChart },
  { to: "/verify", label: "Public Verifier", icon: BadgeCheck },
];

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const s = localStorage.getItem("theme");
      if (s) return s === "dark";
    } catch {
      /* storage unavailable */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);
  return [dark, setDark] as const;
}

export default function Layout({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const [dark, setDark] = useTheme();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
              isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400" : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            }`
          }
        >
          <Icon size={17} /> {label}
        </NavLink>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-2">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white">
        <Cpu size={20} />
      </div>
      <div>
        <div className="text-[15px] font-semibold leading-tight text-slate-900 dark:text-white">GreenSilicon</div>
        <div className="text-[11px] leading-tight text-slate-500">Semiconductor carbon DPP</div>
      </div>
    </div>
  );

  const status = cfg && (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="font-medium">{cfg.network === "localhost" || cfg.chainId === 31337 ? "Local EVM" : cfg.network}</span>
        <span className="muted">chain {cfg.chainId}</span>
      </div>
      <div className="flex items-center gap-2">
        <Sparkles size={12} className={cfg.ai.enabled ? "text-violet-500" : "text-slate-400"} />
        <span className="muted">{cfg.ai.enabled ? `Claude · ${cfg.ai.model}` : "AI: rules + ML (offline)"}</span>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-slate-200 bg-white px-3 py-5 lg:sticky lg:top-0 lg:flex lg:h-screen dark:border-slate-800 dark:bg-slate-900">
        {brand}
        {nav}
        <div className="mt-auto space-y-3">
          {status}
          <button className="btn-ghost w-full" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={15} /> : <Moon size={15} />} {dark ? "Light" : "Dark"} mode
          </button>
          <p className="px-1 text-[11px] leading-snug text-slate-400">IEEE ClimateChain 2026 · Primary track: Sustainable Supply Chains (+ Carbon Markets, Renewable Energy, Climate Data) · Built by Divya Kohli, UC Santa Cruz</p>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/90">
        {brand}
        <div className="flex gap-1">
          <button className="btn-ghost px-2.5" aria-label="Toggle theme" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="btn-ghost px-2.5" aria-label="Menu" onClick={() => setOpen(!open)}>
            {open ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>
      </header>
      {open && (
        <div className="space-y-3 border-b border-slate-200 bg-white p-3 lg:hidden dark:border-slate-800 dark:bg-slate-900">
          {nav}
          {status}
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
