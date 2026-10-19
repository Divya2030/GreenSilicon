import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Cpu, Lightbulb, Plus, Stamp, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Estimate, Recommendation } from "../lib/types";
import { ErrorBox, PageHeader, Section, Stat } from "../components/ui";
import { BREAKDOWN_LABEL, LOCATION_LABEL, fmtCarbon, fmtNum, fmtPct } from "../lib/format";

type Die = { name: string; node: string; area_mm2: number; count: number; fab_location: string; renewable_share: number; renewable_source: string; abatement: "95" | "99" };
type Mem = { kind: string; capacity_gb: number; stacks: number };
type Pkg = { type: string; area_mm2: number; integration: string; interposer_area_mm2: number; interposer_type: string; bonding: string; assembly_location: string };
type Design = { product: string; units: number; dies: Die[]; memory: Mem[]; package: Pkg | null };

const NODES = ["28nm", "20nm", "14nm", "10nm", "7nm", "5nm", "3nm"];
const LOCS = ["taiwan", "south_korea", "japan", "usa", "europe", "singapore", "india", "world"];
const die = (o: Partial<Die> = {}): Die => ({ name: "compute die", node: "5nm", area_mm2: 120, count: 1, fab_location: "taiwan", renewable_share: 0, renewable_source: "solar", abatement: "99", ...o });
const pkg = (o: Partial<Pkg> = {}): Pkg => ({ type: "FCBGA", area_mm2: 900, integration: "monolithic", interposer_area_mm2: 0, interposer_type: "silicon", bonding: "microbump", assembly_location: "world", ...o });

const PRESETS: Record<string, Design> = {
  "AI accelerator (2.5D, HBM)": {
    product: "NX-7 AI accelerator", units: 1000,
    dies: [die({ area_mm2: 420, count: 2 }), die({ name: "IO die", node: "7nm", area_mm2: 120, fab_location: "usa" })],
    memory: [{ kind: "hbm3", capacity_gb: 96, stacks: 4 }],
    package: pkg({ area_mm2: 3600, integration: "2.5d", interposer_area_mm2: 1200 }),
  },
  "Flagship phone SoC (3nm)": {
    product: "Mobile SoC", units: 100000, dies: [die({ name: "SoC", node: "3nm", area_mm2: 105 })], memory: [{ kind: "lpddr4", capacity_gb: 12, stacks: 1 }],
    package: pkg({ type: "WLCSP", area_mm2: 150 }),
  },
  "Edge AI chip (28nm)": { product: "EV-28 edge AI", units: 5000, dies: [die({ name: "SoC", node: "28nm", area_mm2: 60, abatement: "95" })], memory: [], package: pkg({ area_mm2: 400 }) },
  "Monolithic GPU (reticle-size)": { product: "Big GPU", units: 1000, dies: [die({ name: "GPU die", node: "5nm", area_mm2: 800 })], memory: [{ kind: "hbm3", capacity_gb: 80, stacks: 5 }], package: pkg({ area_mm2: 3000, integration: "2.5d", interposer_area_mm2: 1700 }) },
};

const SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)"];

type ExploreRow = { node: string; location: string; area_mm2: number; carbon_g: number; water_l: number; yield: number };

export default function DesignLab() {
  const nav = useNavigate();
  const [d, setD] = useState<Design>(PRESETS["AI accelerator (2.5D, HBM)"]);
  const [est, setEst] = useState<{ estimate: Estimate; recommendations: Recommendation[] } | null>(null);
  const [grid, setGrid] = useState<ExploreRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lot, setLot] = useState(`AUR-${Date.now().toString(36).toUpperCase().slice(-6)}`);
  const [minting, setMinting] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const [e, g] = await Promise.all([
          api.post<{ estimate: Estimate; recommendations: Recommendation[] }>("/carbon/estimate", d),
          d.dies.length ? api.post<ExploreRow[]>("/carbon/explore", d) : Promise.resolve([]),
        ]);
        setEst(e);
        setGrid(g);
        setErr(null);
      } catch (x) {
        setErr((x as Error).message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [d]);

  const setDie = (i: number, patch: Partial<Die>) => setD({ ...d, dies: d.dies.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  async function mint() {
    setMinting(true);
    try {
      const r = await api.post<{ id: number }>("/passports", { design: d, lot_code: lot, kind: d.package ? "product" : "chiplet" });
      nav(`/passport/${r.id}`);
    } catch (x) {
      setErr((x as Error).message);
      setMinting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Design Lab"
        subtitle="Estimate a chip's embodied carbon before tape-out, using published fab data (ACT, imec.netzero, 3D-Carbon). Compare nodes, fabs and packaging, then mint a lot passport that commits to this design."
        actions={
          <select className="input w-auto" onChange={(e) => e.target.value && setD(PRESETS[e.target.value])} defaultValue="">
            <option value="" disabled>
              Load a preset…
            </option>
            {Object.keys(PRESETS).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        }
      />

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="space-y-5 xl:col-span-2">
          <Section title="Product">
            <div className="grid grid-cols-3 gap-3">
              <label className="col-span-2">
                <span className="label">Product name</span>
                <input className="input" value={d.product} onChange={(e) => setD({ ...d, product: e.target.value })} />
              </label>
              <label>
                <span className="label">Units in lot</span>
                <input className="input" type="number" min={1} value={d.units} onChange={(e) => setD({ ...d, units: Math.max(1, +e.target.value) })} />
              </label>
            </div>
          </Section>

          <Section
            title="Dies"
            right={
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setD({ ...d, dies: [...d.dies, die({ name: `die ${d.dies.length + 1}` })] })}>
                <Plus size={13} /> Add die
              </button>
            }
          >
            <div className="space-y-4">
              {d.dies.map((x, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <div className="mb-2 flex items-center gap-2">
                    <Cpu size={14} className="text-slate-400" />
                    <input className="input py-1 text-sm font-medium" value={x.name} onChange={(e) => setDie(i, { name: e.target.value })} />
                    <button className="btn-ghost px-2 py-1" aria-label="Remove die" onClick={() => setD({ ...d, dies: d.dies.filter((_, j) => j !== i) })}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label>
                      <span className="label">Node</span>
                      <select className="input" value={x.node} onChange={(e) => setDie(i, { node: e.target.value })}>
                        {NODES.map((n) => <option key={n}>{n}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="label">Area mm²</span>
                      <input className="input" type="number" min={1} max={858} value={x.area_mm2} onChange={(e) => setDie(i, { area_mm2: Math.min(858, Math.max(1, +e.target.value)) })} />
                    </label>
                    <label>
                      <span className="label">Per package</span>
                      <input className="input" type="number" min={1} max={64} value={x.count} onChange={(e) => setDie(i, { count: Math.max(1, +e.target.value) })} />
                    </label>
                    <label>
                      <span className="label">Fab grid</span>
                      <select className="input" value={x.fab_location} onChange={(e) => setDie(i, { fab_location: e.target.value })}>
                        {LOCS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="label">Renewables {Math.round(x.renewable_share * 100)}%</span>
                      <input className="w-full accent-emerald-600" type="range" min={0} max={1} step={0.05} value={x.renewable_share} onChange={(e) => setDie(i, { renewable_share: +e.target.value })} />
                    </label>
                    <label>
                      <span className="label">Gas abatement</span>
                      <select className="input" value={x.abatement} onChange={(e) => setDie(i, { abatement: e.target.value as "95" | "99" })}>
                        <option value="99">99%</option>
                        <option value="95">95%</option>
                      </select>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Memory & package"
            right={
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!d.package} onChange={(e) => setD({ ...d, package: e.target.checked ? pkg() : null })} className="accent-emerald-600" />
                packaged product
              </label>
            }
          >
            <div className="space-y-3">
              {d.memory.map((m, i) => (
                <div key={i} className="grid grid-cols-3 items-end gap-2">
                  <label>
                    <span className="label">Memory</span>
                    <select className="input" value={m.kind} onChange={(e) => setD({ ...d, memory: d.memory.map((y, j) => (j === i ? { ...y, kind: e.target.value } : y)) })}>
                      <option value="hbm3">HBM3</option>
                      <option value="ddr4_10nm">DDR4</option>
                      <option value="lpddr4">LPDDR4</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Capacity GB</span>
                    <input className="input" type="number" min={1} value={m.capacity_gb} onChange={(e) => setD({ ...d, memory: d.memory.map((y, j) => (j === i ? { ...y, capacity_gb: Math.max(1, +e.target.value) } : y)) })} />
                  </label>
                  <button className="btn-ghost" onClick={() => setD({ ...d, memory: d.memory.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} /> Remove
                  </button>
                </div>
              ))}
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setD({ ...d, memory: [...d.memory, { kind: "hbm3", capacity_gb: 24, stacks: 1 }] })}>
                <Plus size={13} /> Add memory
              </button>
              {d.package && (
                <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <label>
                    <span className="label">Package</span>
                    <select className="input" value={d.package.type} onChange={(e) => setD({ ...d, package: { ...d.package!, type: e.target.value } })}>
                      <option>FCBGA</option>
                      <option>WLCSP</option>
                      <option>TSSOP</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Package mm²</span>
                    <input className="input" type="number" min={1} value={d.package.area_mm2} onChange={(e) => setD({ ...d, package: { ...d.package!, area_mm2: Math.max(1, +e.target.value) } })} />
                  </label>
                  <label>
                    <span className="label">Integration</span>
                    <select className="input" value={d.package.integration} onChange={(e) => setD({ ...d, package: { ...d.package!, integration: e.target.value } })}>
                      <option value="monolithic">Monolithic</option>
                      <option value="2.5d">2.5D interposer</option>
                      <option value="3d">3D stacked</option>
                    </select>
                  </label>
                  {d.package.integration === "2.5d" && (
                    <>
                      <label>
                        <span className="label">Interposer mm²</span>
                        <input className="input" type="number" min={0} value={d.package.interposer_area_mm2} onChange={(e) => setD({ ...d, package: { ...d.package!, interposer_area_mm2: Math.max(0, +e.target.value) } })} />
                      </label>
                      <label>
                        <span className="label">Interposer</span>
                        <select className="input" value={d.package.interposer_type} onChange={(e) => setD({ ...d, package: { ...d.package!, interposer_type: e.target.value } })}>
                          <option value="silicon">Silicon</option>
                          <option value="rdl">Organic RDL</option>
                        </select>
                      </label>
                    </>
                  )}
                  <label>
                    <span className="label">Assembly grid</span>
                    <select className="input" value={d.package.assembly_location} onChange={(e) => setD({ ...d, package: { ...d.package!, assembly_location: e.target.value } })}>
                      {LOCS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          </Section>
        </div>

        <div className="space-y-5 xl:col-span-3">
          {err && <ErrorBox error={err} />}
          {est && <Results est={est} units={d.units} />}
          {grid && grid.length > 0 && <Heatmap rows={grid} current={d.dies[0]} />}
          <Section title="Mint a lot passport">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-48 flex-1">
                <span className="label">Lot code</span>
                <input className="input font-mono" value={lot} onChange={(e) => setLot(e.target.value)} maxLength={64} />
              </label>
              <button className="btn-primary" onClick={mint} disabled={minting || !lot || (!d.dies.length && !d.memory.length)}>
                <Stamp size={15} /> {minting ? "Minting on-chain…" : "Mint passport"}
              </button>
            </div>
            <p className="mt-2 text-xs muted">
              The designer account mints an ERC-721 passport. The keccak-256 hash of this exact design is stored on-chain as a commitment, so later supplier disclosures are
              audited against it.
            </p>
          </Section>
        </div>
      </div>
    </>
  );
}

function Results({ est, units }: { est: { estimate: Estimate; recommendations: Recommendation[] }; units: number }) {
  const e = est.estimate;
  const entries = Object.entries(e.per_unit.breakdown_g).filter(([, v]) => v > 0);
  const row: Record<string, number | string> = { name: "unit" };
  entries.forEach(([k, v]) => (row[k] = v / 1000));
  const yields = useMemo(() => e.dies.map((x) => `${x.name}: ${fmtPct(x.yield)}`).join(" · "), [e]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Embodied carbon / unit" value={fmtCarbon(e.per_unit.carbon_g)} sub={`lot: ${fmtCarbon(e.per_lot.carbon_kg * 1000)}`} />
        <Stat label="Fab energy / unit" value={`${fmtNum(e.per_unit.energy_kwh, 1)} kWh`} sub={`lot: ${fmtNum(e.per_lot.energy_mwh, 1)} MWh`} />
        <Stat label="Water / unit" value={`${fmtNum(e.per_unit.water_l, 0)} L`} sub={`lot: ${fmtNum(e.per_lot.water_m3, 0)} m³`} />
        <Stat label="Die yield" value={e.dies[0] ? fmtPct(e.dies[0].yield) : "—"} sub={yields || "no logic dies"} />
      </div>
      <Section title="Carbon breakdown per unit" right={<span className="text-xs muted">{e.cross_check.ratio ? `silicon = ${e.cross_check.ratio.toFixed(2)}× imec.netzero reference` : ""}</span>}>
        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[row]} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }} barSize={26}>
              <XAxis type="number" hide domain={[0, e.per_unit.carbon_g / 1000]} />
              <YAxis type="category" dataKey="name" hide />
              <Tooltip formatter={(v, n) => [`${Number(v).toFixed(2)} kg`, BREAKDOWN_LABEL[String(n)] ?? n]} contentStyle={{ borderRadius: 8, fontSize: 12 }} cursor={false} />
              <Legend itemSorter={null} formatter={(v) => <span className="text-xs text-slate-600 dark:text-slate-300">{BREAKDOWN_LABEL[v] ?? v}</span>} iconType="circle" iconSize={8} />
              {entries.map(([k], i) => (
                <Bar key={k} dataKey={k} stackId="a" fill={SERIES[i % SERIES.length]} stroke="var(--viz-surface)" strokeWidth={2} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        {est.recommendations.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Lightbulb size={15} className="text-amber-500" /> Levers ranked by saving
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {est.recommendations.map((r) => (
                <li key={r.lever} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{r.lever}</span>
                  <span className="shrink-0 text-right">
                    <span className="font-semibold text-emerald-700 tabular-nums dark:text-emerald-400">−{r.saving_pct.toFixed(1)}%</span>
                    <span className="ml-2 text-xs muted tabular-nums">{fmtCarbon(r.saving_g * units)} / lot</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </>
  );
}

function Heatmap({ rows, current }: { rows: ExploreRow[]; current: Die }) {
  const nodes = [...new Set(rows.map((r) => r.node))];
  const locs = [...new Set(rows.map((r) => r.location))];
  const vals = rows.map((r) => r.carbon_g);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const color = (v: number) => SEQ[Math.round(((v - lo) / (hi - lo || 1)) * (SEQ.length - 1))];
  const at = (n: string, l: string) => rows.find((r) => r.node === n && r.location === l);

  return (
    <Section title={`Design space · ${current.name}`} right={<span className="text-xs muted">per-unit kg CO₂e · area rescaled per node</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th className="p-1.5 text-left font-medium muted">Node \ fab</th>
              {locs.map((l) => (
                <th key={l} className="p-1.5 font-medium muted">{LOCATION_LABEL[l]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n}>
                <td className="p-1.5 font-medium">{n}</td>
                {locs.map((l) => {
                  const r = at(n, l);
                  if (!r) return <td key={l} />;
                  const c = color(r.carbon_g);
                  const darkCell = SEQ.indexOf(c) >= 6;
                  const isCurrent = n === current.node && l === current.fab_location;
                  return (
                    <td
                      key={l}
                      title={`${n} at ${LOCATION_LABEL[l]}: ${(r.carbon_g / 1000).toFixed(2)} kg, ${r.area_mm2} mm², yield ${(r.yield * 100).toFixed(0)}%`}
                      className={`rounded p-2 text-center tabular-nums ${isCurrent ? "ring-2 ring-slate-900 dark:ring-white" : ""}`}
                      style={{ background: c, color: darkCell ? "#fff" : "#0b0b0b" }}
                    >
                      {(r.carbon_g / 1000).toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] muted">
        <span>{(lo / 1000).toFixed(1)} kg</span>
        <div className="h-2 w-40 rounded" style={{ background: `linear-gradient(to right, ${SEQ.join(",")})` }} />
        <span>{(hi / 1000).toFixed(1)} kg</span>
        <span className="ml-2">outlined = current design</span>
        {nodes.length < 7 && <span className="ml-2">· older nodes omitted: the die would exceed the 858 mm² reticle limit</span>}
      </div>
    </Section>
  );
}
