import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Database, Fingerprint, Gauge, Recycle, Waves } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Pill, Section } from "../components/ui";
import { fmtCarbon, fmtNum } from "../lib/format";

type DCLite = { code: string; name: string; coastal: boolean };

// ------------------------------------------------------------- reuse panel

type ReuseCheck = { workHash: string; sourceCertId: number | null; source?: { operationalG: number; embodiedG: number; waterL: number; centiHours: number; name: string | null } };

export function ReusePanel({ onDone }: { onDone: () => void }) {
  const [w, setW] = useState({ model: "aurora-timing-gnn", dataset: "nx7-timing-paths-v12", params: "epochs=40", name: "Timing-model results (repeat request)", customer: "lumen" });
  const [check, setCheck] = useState<ReuseCheck | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const ai = useApi<{ total: { hits: number; misses: number; hit_rate: number; tokens_saved: number; llm_calls_saved: number }; entries: number }>("/ai/cache");

  async function doCheck() {
    setMsg(null);
    setCheck(await api.post<ReuseCheck>("/compute/reuse/check", w));
  }
  async function doReuse() {
    try {
      const r = await api.post<{ certId: number; avoided_g: number }>("/compute/reuse", w);
      setMsg({ ok: true, t: `Reuse certificate #${r.certId} minted: ${fmtCarbon(r.avoided_g)} avoided, 0 kWh used.` });
      onDone();
      ai.reload();
    } catch (e) {
      setMsg({ ok: false, t: (e as Error).message });
    }
  }

  return (
    <Section title="Don't compute twice: reuse and incremental" right={<Recycle size={15} className="text-slate-400" />}>
      <p className="mb-3 text-xs muted">
        Every certified job carries a <b>work fingerprint</b> (model + dataset version + parameters). If the identical work was already computed, the stored result is
        served and a reuse certificate is minted with zero new energy. The contract credits the avoided footprint from the original certificate, so it can't be inflated.
        Incremental runs (continuing from a checkpoint on new data only) are credited against their from-scratch parent.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label><span className="label">Model</span><input className="input font-mono text-xs" value={w.model} onChange={(e) => { setW({ ...w, model: e.target.value }); setCheck(null); }} /></label>
        <label><span className="label">Dataset version</span><input className="input font-mono text-xs" value={w.dataset} onChange={(e) => { setW({ ...w, dataset: e.target.value }); setCheck(null); }} /></label>
        <label><span className="label">Parameters</span><input className="input font-mono text-xs" value={w.params} onChange={(e) => { setW({ ...w, params: e.target.value }); setCheck(null); }} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost" onClick={doCheck}><Fingerprint size={14} /> Check for a reusable result</button>
        {check?.sourceCertId != null && <button className="btn-primary" onClick={doReuse}><Recycle size={14} /> Reuse result (0 kWh)</button>}
      </div>
      {check && (
        <div className={`mt-3 rounded-lg p-3 text-xs ${check.sourceCertId != null ? "bg-emerald-50 dark:bg-emerald-500/10" : "bg-slate-50 dark:bg-slate-950/50"}`}>
          <div className="font-mono break-all muted">{check.workHash}</div>
          {check.sourceCertId != null && check.source ? (
            <div className="mt-1">
              Identical work already computed in certificate <b>#{check.sourceCertId}</b> ({check.source.name}): {fmtNum(check.source.centiHours / 100)} accelerator-hours,{" "}
              {fmtCarbon(check.source.operationalG + check.source.embodiedG)}, {fmtNum(check.source.waterL / 1000, 1)} m³ water. Reusing it avoids all of that.
            </div>
          ) : (
            <div className="mt-1">No identical computation on record. Run it once with this fingerprint and every future identical request can reuse it.</div>
          )}
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700"}`}>{msg.t}</p>}
      {ai.data && (
        <div className="mt-4 flex items-start gap-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
          <Database size={14} className="mt-px shrink-0 text-brand-600" />
          <span>
            <b>GreenSilicon's own AI uses the same idea:</b> supplier documents, audits and copilot questions are content-addressed (keccak-256), so identical
            requests are never sent to the model twice. Cache: {ai.data.total.hits} hits / {ai.data.total.hits + ai.data.total.misses} requests
            ({Math.round(ai.data.total.hit_rate * 100)}%), {fmtNum(ai.data.total.llm_calls_saved)} LLM calls and {fmtNum(ai.data.total.tokens_saved)} tokens avoided.
          </span>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------ inference planner

const SHORT = ["Baseline", "+ Cache", "+ Routing", "+ Spec. decode", "+ Quantize", "+ Concise"];

type Plan = {
  multiplier: number; steps: { label: string; wh_per_query: number }[];
  baseline: { wh_per_query: number; daily_mwh: number; daily_carbon_kg: number; daily_water_m3: number; ml_per_query: number };
  optimised: { wh_per_query: number; daily_mwh: number; daily_carbon_kg: number; daily_water_m3: number; ml_per_query: number };
  annual_saved_mwh: number; annual_saved_carbon_t: number; annual_saved_water_m3: number; references: Record<string, string>;
};

export function InferencePlanner({ dcs }: { dcs: DCLite[] }) {
  const [f, setF] = useState({ queries_per_day: 10_000_000, cache_hit_rate: 0.3, small_model_share: 0.5, small_model_cost: 0.15, speculative_speedup: 1.6, quantization_factor: 0.85, output_tokens_factor: 0.8, code: "PHX-1" });
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api.post<Plan>("/compute/inference", f).then(setPlan).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [f]);

  const slider = (key: keyof typeof f, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="block">
      <span className="label flex justify-between"><span>{label}</span><span className="tabular-nums">{fmt(f[key] as number)}</span></span>
      <input type="range" className="w-full accent-emerald-600" min={min} max={max} step={step} value={f[key] as number} onChange={(e) => setF({ ...f, [key]: +e.target.value })} />
    </label>
  );

  return (
    <Section title="Green inference: energy per AI question" right={<Gauge size={15} className="text-slate-400" />}>
      <p className="mb-3 text-xs muted">
        A typical chatbot question costs about 0.3 Wh on a frontier model (Epoch AI). Google reports 0.24 Wh and 0.26 mL of water for its median Gemini prompt, after a 33× efficiency gain in one year. These levers compound:
      </p>
      <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
        {slider("cache_hit_rate", "Answered from semantic cache", 0, 0.8, 0.05, (v) => `${Math.round(v * 100)}%`)}
        {slider("small_model_share", "Routed to a distilled small model", 0, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`)}
        {slider("speculative_speedup", "Speculative decoding speed-up", 1, 2.5, 0.1, (v) => `${v.toFixed(1)}×`)}
        {slider("quantization_factor", "Quantization energy factor", 0.6, 1, 0.05, (v) => `${v.toFixed(2)}×`)}
        {slider("output_tokens_factor", "Answer length vs today", 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        <div className="grid grid-cols-2 gap-2">
          <label><span className="label">Queries / day</span><input className="input" type="number" value={f.queries_per_day} onChange={(e) => setF({ ...f, queries_per_day: Math.max(1, +e.target.value) })} /></label>
          <label><span className="label">Site</span><select className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{dcs.map((d) => <option key={d.code}>{d.code}</option>)}</select></label>
        </div>
      </div>
      {plan && (
        <>
          <div className="mt-4 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={plan.steps.map((s, i) => ({ name: SHORT[i] ?? s.label, full: s.label, wh: s.wh_per_query }))} margin={{ left: 0, right: 8, top: 8 }} barCategoryGap={6}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="name" tick={{ fill: "var(--viz-axis)", fontSize: 11 }} interval={0} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "var(--viz-axis)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => Number(v).toFixed(2)} />
                <Tooltip labelFormatter={(_, pl) => (pl?.[0]?.payload as { full?: string } | undefined)?.full ?? ""} formatter={(v) => [`${Number(v).toFixed(3)} Wh per query`, "after this lever"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="wh" fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <KV k="Per question" v={`${plan.baseline.wh_per_query.toFixed(2)} → ${plan.optimised.wh_per_query.toFixed(3)} Wh`} sub={`−${Math.round((1 - plan.multiplier) * 100)}% energy`} />
            <KV k="Water per question" v={`${plan.baseline.ml_per_query.toFixed(2)} → ${plan.optimised.ml_per_query.toFixed(2)} mL`} sub="incl. power-plant water" />
            <KV k="Saved per year" v={`${fmtNum(plan.annual_saved_mwh)} MWh`} sub={`${fmtNum(plan.annual_saved_carbon_t)} t CO₂e`} />
            <KV k="Water saved per year" v={`${fmtNum(plan.annual_saved_water_m3)} m³`} sub={`at ${f.code}`} />
          </div>
          <p className="mt-3 text-[11px] muted">{Object.values(plan.references).join(" · ")}. Lever sizes are adjustable assumptions; quality must be validated per workload (route only queries the small model answers well).</p>
        </>
      )}
    </Section>
  );
}

function KV({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/50">
      <div className="muted">{k}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{v}</div>
      {sub && <div className="muted">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------ cooling panel

type CoolingOpt = { key: string; label: string; feasible: boolean; pue: number; carbon_t: number; onsite_m3: number; offsite_m3: number; freshwater_m3: number; freshwater_saved_pct: number; carbon_delta_pct: number; notes: string };
type Cooling = { code: string; name: string; region: string; coastal: boolean; stress: string; options: CoolingOpt[]; insight: string; it_mwh_per_year: number };

export function CoolingPanel({ dcs }: { dcs: DCLite[] }) {
  const [code, setCode] = useState("PHX-1");
  const { data } = useApi<Cooling>(`/compute/cooling/${code}?it_mwh=5000`, [code]);
  return (
    <Section
      title="Cooling water: can seawater replace drinking water?"
      right={
        <select className="input w-auto py-1 text-xs" value={code} onChange={(e) => setCode(e.target.value)}>
          {dcs.map((d) => <option key={d.code} value={d.code}>{d.code}{d.coastal ? " (coastal)" : ""}</option>)}
        </select>
      }
    >
      {data && (
        <>
          <p className="mb-3 text-xs muted">{data.name}, {data.region}: {data.stress.toLowerCase()} water stress, 5,000 MWh/year IT load.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-xs">
              <thead>
                <tr className="text-left muted">
                  <th className="pb-2 font-medium">Cooling strategy</th>
                  <th className="px-2 pb-2 text-right font-medium">PUE</th>
                  <th className="px-2 pb-2 text-right font-medium">Freshwater / yr</th>
                  <th className="px-2 pb-2 text-right font-medium">vs current</th>
                  <th className="px-2 pb-2 text-right font-medium">CO₂e / yr</th>
                </tr>
              </thead>
              <tbody>
                {data.options.map((o) => (
                  <tr key={o.key} className={`border-t border-slate-100 align-top dark:border-slate-800 ${!o.feasible ? "opacity-50" : ""}`}>
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium">
                        {o.key.startsWith("seawater") && <Waves size={13} className="text-blue-600" />} {o.label} {!o.feasible && <Pill tone="red">inland</Pill>}
                      </div>
                      <div className="mt-0.5 muted">{o.notes}</div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{o.pue.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(o.freshwater_m3)} m³</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${o.freshwater_saved_pct > 0.5 ? "text-emerald-700 dark:text-emerald-400" : o.freshwater_saved_pct < -0.5 ? "text-red-700" : "muted"}`}>
                      {o.key === "current" ? "—" : `${o.freshwater_saved_pct > 0 ? "−" : "+"}${Math.abs(o.freshwater_saved_pct).toFixed(0)}%`}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {fmtNum(o.carbon_t)} t {o.key !== "current" && <span className={o.carbon_delta_pct > 0.5 ? "text-red-700" : o.carbon_delta_pct < -0.5 ? "text-emerald-700 dark:text-emerald-400" : "muted"}>({o.carbon_delta_pct > 0 ? "+" : ""}{o.carbon_delta_pct.toFixed(1)}%)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 rounded-lg bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-500/10 dark:text-blue-200">{data.insight}</p>
          <p className="mt-2 text-[11px] muted">
            Seawater heat exchange is proven at scale: Google Hamina (Finland) has run on seawater since 2011 at PUE 1.09, and Microsoft's Natick undersea pod reached PUE 1.07. RO desalination ≈ 3–4 kWh/m³. Dry-cooler PUE penalty is an assumption.
          </p>
        </>
      )}
    </Section>
  );
}
