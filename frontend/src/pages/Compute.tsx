import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, CalendarClock, Cpu, Droplets, Factory, Leaf, RefreshCw, Server, Sparkles, Stamp } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Hash, Loading, PageHeader, Pill, Section, Stat } from "../components/ui";
import { fmtCarbon, fmtNum, fmtTime } from "../lib/format";
import { CoolingPanel, InferencePlanner, ReusePanel } from "./ComputeExtras";

type DC = { code: string; name: string; region: string; pue: number; wue: number; ewif: number; ci: number; stress: number; stressLabel: string; cooling: string; coolingLabel: string; coastal: boolean; ciNow: number; wueNow: number; accelerators: number; jobs: number; operational_g: number };
type Footprint = { it_kwh: number; facility_kwh: number; operational_g: number; embodied_g: number; total_g: number; water_onsite_l: number; water_offsite_l: number; water_l: number; scarcity_water_l: number };
type Cand = Footprint & { code: string; offset_h: number; start: number; score: number };
type Plan = { job: { accelerators: number; hours: number; home: string }; baseline: Footprint & { code: string; start: number }; best: Cand; best_per_dc: Cand[]; savings: { carbon_g: number; carbon_pct: number; water_l: number; scarcity_water_pct: number }; rationale: string };
type Job = { certId: number; tx: string; jobHash: string | null; customerName: string; reuseOf?: number; manifest: { name: string; dc: string; accelerators: number; hours: number; start: number; scheduled: boolean; mode?: string; cache_hit_rate?: number }; onchain: { centiHours: number; operationalG: number; embodiedG: number; waterOnsiteL: number; waterOffsiteL: number; baselineG: number; facilityEnergyWh: number; avoidedG: number; reused: boolean; parentCertPlusOne: number } };
type Fleet = { dcs: DC[]; jobs: Job[]; totals: { certificates: number; accelerator_hours: number; operational_g: number; embodied_g: number; water_l: number; saved_g: number; avoided_g: number; reused: number; incremental: number }; assumptions: { it_kw_per_accelerator: number; rated_life_hours: number } };
type Fc = { code: string; points: { ts: number; ci: number; wue: number }[] }[];

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];
const STRESS_TONE = ["brand", "brand", "amber", "red", "red"] as const;

export default function Compute() {
  const fleet = useApi<Fleet>("/compute");
  const fc = useApi<Fc>("/compute/forecast?hours=48");
  if (fleet.error) return <ErrorBox error={fleet.error} />;
  if (!fleet.data) return <Loading />;
  const f = fleet.data;
  const t = f.totals;

  return (
    <>
      <PageHeader
        title="AI Compute: from fab to inference"
        subtitle="The chip passport continues into the data center. Accelerator lots are deployed to sites with published PUE, cooling water (WUE) and grid-water intensity. Every AI job gets an on-chain Green Compute Certificate combining operational carbon, cooling and grid water, and the chip's embodied carbon amortised by the contract from its passport. A scheduler moves flexible jobs to the cleanest, least water-stressed site and hour."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Accelerators deployed" value={fmtNum(f.dcs.reduce((a, d) => a + d.accelerators, 0))} sub={`${f.dcs.length} data centers`} icon={<Server size={16} />} />
        <Stat label="Compute certificates" value={t.certificates} sub={`${fmtNum(t.accelerator_hours)} accelerator-hours`} icon={<Stamp size={16} />} />
        <Stat label="Operational CO₂e" value={fmtCarbon(t.operational_g)} sub="location-based, certified" icon={<Factory size={16} />} />
        <Stat label="Embodied, amortised" value={fmtCarbon(t.embodied_g)} sub="from chip passports, on-chain" icon={<Cpu size={16} />} />
        <Stat label="Water (cooling + grid)" value={`${fmtNum(t.water_l / 1000, 1)} m³`} sub="on-site WUE + off-site EWIF" icon={<Droplets size={16} />} />
        <Stat label="Avoided by scheduling & caching" value={fmtCarbon(t.saved_g)} sub="vs home site now, no cache" tone="good" icon={<Leaf size={16} />} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Avoided by reuse & incremental runs (on-chain)" value={fmtCarbon(t.avoided_g)} sub={`${t.reused} reused result · ${t.incremental} incremental run`} tone="good" icon={<Leaf size={16} />} />
        <Stat label="Freshwater-free cooling sites" value={`${f.dcs.filter((d) => d.cooling === "seawater").length} of ${f.dcs.length}`} sub="seawater heat exchange (coastal)" icon={<Droplets size={16} />} />
        <Stat label="Data-center water stress" value={`${f.dcs.filter((d) => d.stress >= 3).length} high-stress sites`} sub="scheduler weights scarce water 3–4×" icon={<Droplets size={16} />} />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {f.dcs.map((d) => (
          <div key={d.code} className="card card-pad">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{d.name}</div>
                <div className="text-xs muted">{d.region}</div>
              </div>
              <Pill tone={STRESS_TONE[d.stress]}>{d.stressLabel} water stress</Pill>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="muted">Grid now</dt><dd className="text-right tabular-nums">{fmtNum(d.ciNow)} g/kWh</dd>
              <dt className="muted">PUE</dt><dd className="text-right tabular-nums">{d.pue.toFixed(2)}</dd>
              <dt className="muted">On-site WUE</dt><dd className="text-right tabular-nums">{d.wueNow.toFixed(2)} L/kWh</dd>
              <dt className="muted">Grid water</dt><dd className="text-right tabular-nums">{d.ewif.toFixed(2)} L/kWh</dd>
              <dt className="muted">Accelerators</dt><dd className="text-right tabular-nums">{fmtNum(d.accelerators)}</dd>
            </dl>
            <div className="mt-2 flex flex-wrap gap-1">
              <Pill tone={d.cooling === "seawater" ? "blue" : "slate"}>{d.coolingLabel}</Pill>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-5">
        <div className="space-y-5 xl:col-span-3">
          <ForecastChart fc={fc.data} />
          <Scheduler dcs={f.dcs} jobs={f.jobs} onDone={fleet.reload} />
        </div>
        <div className="space-y-5 xl:col-span-2">
          <ReusePanel onDone={fleet.reload} />
          <Refresh dcs={f.dcs} />
          <Section title="Why both water numbers matter">
            <p className="text-xs leading-relaxed muted">
              On-site water evaporates in cooling towers (WUE, highest on hot afternoons). Off-site water is consumed generating the electricity (EWIF). Stockholm's
              hydro-heavy grid has a high EWIF but low water stress. Phoenix has both high cooling water and extremely high stress. The scheduler weighs water by
              local scarcity, not just litres.
            </p>
            <p className="mt-2 text-[11px] muted">
              Sources: PUE, WUE and EWIF from Li et al., "Making AI Less 'Thirsty'" (Table 1). Grid intensity from Ember 2023. Hourly shapes and scarcity weights are documented assumptions.
            </p>
          </Section>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <InferencePlanner dcs={f.dcs} />
        <CoolingPanel dcs={f.dcs} />
      </div>

      <Section title="Green Compute Certificates (ERC-721, minted to the customer)" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs muted">
                <th className="pb-2 font-medium">Job</th>
                <th className="px-3 pb-2 font-medium">Site</th>
                <th className="px-3 pb-2 text-right font-medium">Accel-h</th>
                <th className="px-3 pb-2 text-right font-medium">Operational</th>
                <th className="px-3 pb-2 text-right font-medium">Embodied</th>
                <th className="px-3 pb-2 text-right font-medium">Water</th>
                <th className="px-3 pb-2 text-right font-medium">Avoided</th>
                <th className="px-3 pb-2 font-medium">Certificate</th>
              </tr>
            </thead>
            <tbody>
              {f.jobs.map((j) => {
                const c = j.onchain;
                const saved = c.reused || c.parentCertPlusOne ? c.avoidedG : c.baselineG - c.operationalG;
                const mode = c.reused ? "reused result" : c.parentCertPlusOne ? `incremental from #${c.parentCertPlusOne - 1}` : (j.manifest.cache_hit_rate ?? 0) > 0 ? `${Math.round((j.manifest.cache_hit_rate ?? 0) * 100)}% cache hits` : null;
                return (
                  <tr key={j.certId} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="py-2.5">
                      <div className="font-medium">{j.manifest.name}</div>
                      <div className="text-xs muted">{j.customerName} · {fmtTime(j.manifest.start)} · {j.manifest.accelerators} × {j.manifest.hours} h</div>
                    </td>
                    <td className="px-3 py-2.5">
                      {c.reused ? "—" : j.manifest.dc}
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {j.manifest.scheduled && <Pill tone="brand">scheduled</Pill>}
                        {mode && <Pill tone="blue">{mode}</Pill>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(c.centiHours / 100)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtCarbon(c.operationalG)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtCarbon(c.embodiedG)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum((c.waterOnsiteL + c.waterOffsiteL) / 1000, 1)} m³</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${saved > 0 ? "text-emerald-700 dark:text-emerald-400" : "muted"}`}>
                      {saved > 0 ? fmtCarbon(saved) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      #{j.certId} <Hash value={j.tx} n={4} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function ForecastChart({ fc }: { fc: Fc | null }) {
  const [metric, setMetric] = useState<"ci" | "wue">("ci");
  if (!fc) return <Loading />;
  const rows = fc[0].points.map((p, i) => {
    const r: Record<string, number> = { ts: p.ts };
    fc.forEach((d) => (r[d.code] = d.points[i][metric]));
    return r;
  });
  return (
    <Section
      title="Next 48 hours by site"
      right={
        <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
          {(["ci", "wue"] as const).map((m) => (
            <button key={m} onClick={() => setMetric(m)} className={`rounded-md px-2.5 py-1 ${metric === m ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "muted"}`}>
              {m === "ci" ? "Grid gCO₂/kWh" : "Cooling water L/kWh"}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="ts" tickFormatter={(ts) => new Date(ts * 1000).toLocaleTimeString([], { weekday: "short", hour: "2-digit" })} tick={{ fill: "var(--viz-axis)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={50} />
            <YAxis tick={{ fill: "var(--viz-axis)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip labelFormatter={(ts) => new Date(Number(ts) * 1000).toLocaleString()} formatter={(v) => Number(v).toFixed(metric === "ci" ? 0 : 2)} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            {fc.map((d, i) => (
              <Line key={d.code} type="monotone" dataKey={d.code} stroke={SERIES[i]} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Section>
  );
}

function Scheduler({ dcs, jobs, onDone }: { dcs: DC[]; jobs: Job[]; onDone: () => void }) {
  const [job, setJob] = useState({ name: "Lumen LLM fine-tune", customer: "lumen", accelerators: 128, hours: 24, window_hours: 72, water_weight: 0.4, home: "PHX-1", cache_hit_rate: 0, model: "lumen-llm-8b", dataset: "support-chats-2026-10", params: "lora-r16" });
  const [parent, setParent] = useState<{ cert: number; fraction: number } | null>(null);
  const [allowed, setAllowed] = useState<string[]>(dcs.map((d) => d.code));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  async function optimise() {
    setBusy("plan");
    setMsg(null);
    try {
      setPlan(await api.post<Plan>("/compute/schedule", { accelerators: job.accelerators, hours: job.hours, window_hours: job.window_hours, water_weight: job.water_weight, home: job.home, allowed, cache_hit_rate: job.cache_hit_rate }));
    } catch (e) {
      setMsg({ ok: false, t: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!plan) return;
    setBusy("run");
    try {
      const r = await api.post<{ certId: number }>("/compute/run", {
        name: job.name, customer: job.customer, code: plan.best.code, accelerators: job.accelerators, hours: job.hours, start: plan.best.start,
        baseline_g: plan.baseline.operational_g, scheduled: plan.best.code !== job.home || plan.best.offset_h > 0,
        cache_hit_rate: job.cache_hit_rate, parent_cert: parent?.cert ?? null, model: job.model, dataset: job.dataset, params: job.params,
      });
      setMsg({ ok: true, t: `Green Compute Certificate #${r.certId} minted on-chain.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, t: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Carbon- and water-aware scheduler" right={<CalendarClock size={15} className="text-slate-400" />}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="col-span-2">
          <span className="label">Job</span>
          <input className="input" value={job.name} onChange={(e) => setJob({ ...job, name: e.target.value })} />
        </label>
        <label>
          <span className="label">Accelerators</span>
          <input className="input" type="number" min={1} value={job.accelerators} onChange={(e) => setJob({ ...job, accelerators: Math.max(1, +e.target.value) })} />
        </label>
        <label>
          <span className="label">Runtime (h)</span>
          <input className="input" type="number" min={1} value={job.hours} onChange={(e) => setJob({ ...job, hours: Math.max(1, +e.target.value) })} />
        </label>
        <label>
          <span className="label">Must finish within (h)</span>
          <input className="input" type="number" min={1} value={job.window_hours} onChange={(e) => setJob({ ...job, window_hours: Math.max(1, +e.target.value) })} />
        </label>
        <label>
          <span className="label">Home site</span>
          <select className="input" value={job.home} onChange={(e) => setJob({ ...job, home: e.target.value })}>
            {dcs.map((d) => <option key={d.code}>{d.code}</option>)}
          </select>
        </label>
        <label className="col-span-2">
          <span className="label">Priority: carbon ← → water ({Math.round(job.water_weight * 100)}% water)</span>
          <input className="w-full accent-emerald-600" type="range" min={0} max={1} step={0.05} value={job.water_weight} onChange={(e) => setJob({ ...job, water_weight: +e.target.value })} />
        </label>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <label>
          <span className="label">Inference cache hit rate ({Math.round(job.cache_hit_rate * 100)}%)</span>
          <input className="w-full accent-emerald-600" type="range" min={0} max={0.8} step={0.05} value={job.cache_hit_rate} onChange={(e) => setJob({ ...job, cache_hit_rate: +e.target.value })} />
        </label>
        <label className="md:col-span-2">
          <span className="label">Incremental: continue from a checkpoint instead of retraining</span>
          <div className="flex gap-2">
            <select
              className="input"
              value={parent?.cert ?? ""}
              onChange={(e) => {
                if (e.target.value === "") return setParent(null);
                const cert = +e.target.value;
                const src = jobs.find((j) => j.certId === cert);
                const fraction = parent?.fraction ?? 0.1;
                setParent({ cert, fraction });
                if (src) setJob({ ...job, accelerators: src.manifest.accelerators, hours: Math.max(1, Math.ceil(src.manifest.hours * fraction)) });
              }}
            >
              <option value="">From scratch</option>
              {jobs.filter((j) => !j.onchain.reused && j.manifest.hours > 0).map((j) => (
                <option key={j.certId} value={j.certId}>#{j.certId} {j.manifest.name.slice(0, 40)}</option>
              ))}
            </select>
            {parent && (
              <input
                className="input w-28"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                title="Share of new data"
                value={parent.fraction}
                onChange={(e) => {
                  const fraction = Math.min(1, Math.max(0.01, +e.target.value));
                  const src = jobs.find((j) => j.certId === parent.cert);
                  setParent({ ...parent, fraction });
                  if (src) setJob({ ...job, hours: Math.max(1, Math.ceil(src.manifest.hours * fraction)) });
                }}
              />
            )}
          </div>
        </label>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
        <input className="input font-mono text-xs" value={job.model} onChange={(e) => setJob({ ...job, model: e.target.value })} title="Model (work fingerprint)" />
        <input className="input font-mono text-xs" value={job.dataset} onChange={(e) => setJob({ ...job, dataset: e.target.value })} title="Dataset version (work fingerprint)" />
        <input className="input font-mono text-xs" value={job.params} onChange={(e) => setJob({ ...job, params: e.target.value })} title="Parameters (work fingerprint)" />
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        <span className="muted">Allowed sites (data residency):</span>
        {dcs.map((d) => (
          <label key={d.code} className="flex items-center gap-1">
            <input type="checkbox" className="accent-emerald-600" checked={allowed.includes(d.code)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, d.code] : allowed.filter((x) => x !== d.code))} />
            {d.code}
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary" onClick={optimise} disabled={busy !== null || !allowed.length}>
          <Sparkles size={15} /> {busy === "plan" ? "Optimising…" : "Find greenest slot"}
        </button>
        {plan && (
          <button className="btn-ghost" onClick={run} disabled={busy !== null}>
            <Stamp size={15} /> {busy === "run" ? "Certifying…" : "Run & mint certificate"}
          </button>
        )}
        {msg && <span className={`self-center text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700"}`}>{msg.t}</span>}
      </div>

      {plan && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950/50">
              <div className="muted">Run now at {plan.baseline.code}</div>
              <div className="mt-1 text-base font-semibold tabular-nums">{fmtCarbon(plan.baseline.operational_g)}</div>
              <div className="muted">{fmtNum(plan.baseline.water_l / 1000, 1)} m³ water</div>
            </div>
            <div className="flex items-center justify-center"><ArrowRight className="text-slate-400" /></div>
            <div className="rounded-lg bg-emerald-50 p-3 text-xs dark:bg-emerald-500/10">
              <div className="text-emerald-800 dark:text-emerald-300">{plan.best.code} · {plan.best.offset_h ? `start in ${plan.best.offset_h} h` : "start now"}</div>
              <div className="mt-1 text-base font-semibold tabular-nums">{fmtCarbon(plan.best.operational_g)}</div>
              <div className="muted">{fmtNum(plan.best.water_l / 1000, 1)} m³ water · +{fmtCarbon(plan.best.embodied_g)} embodied</div>
            </div>
          </div>
          <p className="text-sm">
            <b className="text-emerald-700 dark:text-emerald-400">−{plan.savings.carbon_pct.toFixed(0)}% CO₂e, −{plan.savings.scarcity_water_pct.toFixed(0)}% scarcity-weighted water.</b>{" "}
            <span className="muted">{plan.rationale}</span>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="text-left muted">
                  <th className="pb-1 font-medium">Best slot per site</th>
                  <th className="pb-1 text-right font-medium">Operational</th>
                  <th className="pb-1 text-right font-medium">Water</th>
                  <th className="pb-1 text-right font-medium">Scarcity-weighted</th>
                  <th className="pb-1 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {plan.best_per_dc.map((c) => (
                  <tr key={c.code} className={`border-t border-slate-100 dark:border-slate-800 ${c.code === plan.best.code ? "font-semibold" : ""}`}>
                    <td className="py-1.5">{c.code} {c.offset_h ? `(+${c.offset_h} h)` : "(now)"}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtCarbon(c.operational_g)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtNum(c.water_l / 1000, 1)} m³</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtNum(c.scarcity_water_l / 1000, 1)} m³</td>
                    <td className="py-1.5 text-right tabular-nums">{c.score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}

type RefreshRes = { new_units: number; embodied_new_g: number; annual_kwh_old: number; annual_kwh_new: number; annual_saved_g: number; annual_saved_water_l: number; payback_months: number | null; five_year_net_g: number; verdict: string };

function Refresh({ dcs }: { dcs: DC[] }) {
  const [f, setF] = useState({ old_units: 1000, old_kw: 0.45, old_perf: 0.3, code: "PHX-1" });
  const [r, setR] = useState<RefreshRes | null>(null);
  async function go() {
    setR(await api.post<RefreshRes>("/compute/refresh", f));
  }
  return (
    <Section title="Hardware refresh: carbon payback" right={<RefreshCw size={15} className="text-slate-400" />}>
      <p className="mb-3 text-xs muted">Replace an older accelerator fleet with NX-7s delivering the same throughput. Does the energy saved repay the new chips' embodied carbon (from their passport)?</p>
      <div className="grid grid-cols-2 gap-2">
        <label><span className="label">Old units</span><input className="input" type="number" value={f.old_units} onChange={(e) => setF({ ...f, old_units: Math.max(1, +e.target.value) })} /></label>
        <label><span className="label">Old kW / unit</span><input className="input" type="number" step="0.05" value={f.old_kw} onChange={(e) => setF({ ...f, old_kw: Math.max(0.01, +e.target.value) })} /></label>
        <label><span className="label">Old perf (NX-7 = 1)</span><input className="input" type="number" step="0.05" value={f.old_perf} onChange={(e) => setF({ ...f, old_perf: Math.max(0.01, +e.target.value) })} /></label>
        <label><span className="label">Site</span>
          <select className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{dcs.map((d) => <option key={d.code}>{d.code}</option>)}</select>
        </label>
      </div>
      <button className="btn-ghost mt-3" onClick={go}>Calculate payback</button>
      {r && (
        <div className="mt-3 space-y-1.5 text-xs">
          <div className="text-sm font-semibold">{r.verdict}</div>
          <div className="flex justify-between"><span className="muted">New NX-7 units needed</span><span className="tabular-nums">{fmtNum(r.new_units)}</span></div>
          <div className="flex justify-between"><span className="muted">Embodied carbon of new fleet</span><span className="tabular-nums">{fmtCarbon(r.embodied_new_g)}</span></div>
          <div className="flex justify-between"><span className="muted">Operational CO₂e saved / year</span><span className="tabular-nums">{fmtCarbon(r.annual_saved_g)}</span></div>
          <div className="flex justify-between"><span className="muted">Water saved / year</span><span className="tabular-nums">{fmtNum(r.annual_saved_water_l / 1000)} m³</span></div>
          <div className="flex justify-between"><span className="muted">Carbon payback</span><span className="font-semibold tabular-nums">{r.payback_months != null ? `${r.payback_months.toFixed(1)} months` : "never"}</span></div>
          <div className="flex justify-between"><span className="muted">5-year net impact</span><span className="tabular-nums">{r.five_year_net_g > 0 ? "−" : "+"}{fmtCarbon(Math.abs(r.five_year_net_g))}</span></div>
        </div>
      )}
    </Section>
  );
}
