import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, AlertTriangle, Droplets, Gauge, Pause, Play, Radio, ShieldCheck, ShieldX, Wind, Zap } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Hash, Loading, PageHeader, Pill, Section, Stat } from "../components/ui";
import { fmtNum, fmtTime } from "../lib/format";

type Device = {
  address: string; key: string; kind: "Power" | "Abatement" | "Water"; facility: string; operator: string; operatorName: string;
  batches: number; active: boolean; lastRoot: string | null; alerts: number; readings: number; mean?: number; last?: number; uptime?: number;
};
type Series = { kind: string; points: { ts: number; v: number }[]; running: boolean };
type BatchRow = { index: number; fromTs: number; toTs: number; count: number; total: number; alerts: number; root: string; tx: string; step: number };
type Alert = { ts: number; device: string; severity: string; facility: string; message: string };
type Proof = { ts: number; value: number; display: number; kind: string; proof: string[]; root: string; valid: boolean; tampered_valid: boolean; index: number };

const UNIT: Record<string, string> = { Power: "kW", Abatement: "%", Water: "L / 15 min" };
const ICON = { Power: Zap, Abatement: Wind, Water: Droplets };

export default function Telemetry() {
  const devs = useApi<{ devices: Device[]; live: boolean; contract: string }>("/telemetry/devices");
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"history" | "live">("history");
  const [series, setSeries] = useState<Series | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const devices = devs.data?.devices ?? [];
  const device = devices.find((d) => d.address === sel) ?? null;

  useEffect(() => {
    if (!sel && devices.length) setSel(devices.find((d) => d.key === "us_abate")?.address ?? devices[0].address);
    if (devs.data) setLive(devs.data.live);
  }, [devs.data, sel, devices]);

  useEffect(() => {
    if (!sel) return;
    let stop = false;
    const tick = async () => {
      try {
        const [s, a] = await Promise.all([api.get<Series>(`/telemetry/series/${sel}?mode=${mode}&limit=${mode === "live" ? 180 : 700}`), api.get<Alert[]>("/telemetry/alerts?limit=30")]);
        if (!stop) {
          setSeries(s);
          setAlerts(a);
          setLive(s.running);
        }
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    tick();
    const t = mode === "live" ? setInterval(tick, 1500) : setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sel, mode]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(devs.reload, 6000);
    return () => clearInterval(t);
  }, [live, devs.reload]);

  async function toggleLive() {
    await api.post("/telemetry/live", { on: !live });
    setLive(!live);
    if (!live) setMode("live");
  }

  async function fault() {
    if (!device) return;
    await api.post(`/telemetry/fault/${device.address}`);
    setLive(true);
    setMode("live");
  }

  if (devs.error) return <ErrorBox error={devs.error} />;
  if (!devs.data) return <Loading />;

  const facilities = [...new Set(devices.map((d) => d.facility.split(" · ")[0]))];
  const totalBatches = devices.reduce((a, d) => a + d.batches, 0);
  const totalReadings = devices.reduce((a, d) => a + d.readings, 0);
  const crit = devices.filter((d) => d.kind === "Abatement").reduce((a, d) => a + d.alerts, 0);

  return (
    <>
      <PageHeader
        title="Fab Telemetry (IoT digital MRV)"
        subtitle="Tool-line power sub-meters, abatement-unit gas analysers and water meters each sign their readings with their own key. Batches are anchored on-chain as Merkle roots and must be contiguous in time, so a fab cannot hide an abatement outage. The AI auditor checks every supplier claim against this metered evidence."
        actions={
          <>
            <button className={live ? "btn-ghost" : "btn-primary"} onClick={toggleLive}>
              {live ? <Pause size={15} /> : <Play size={15} />} {live ? "Stop live feed" : "Start live feed"}
            </button>
            {device?.kind === "Abatement" && (
              <button className="btn-ghost text-red-700 dark:text-red-400" onClick={fault} title="Simulate a bypassed abatement unit">
                <AlertTriangle size={15} /> Inject abatement bypass
              </button>
            )}
          </>
        }
      />
      {err && <ErrorBox error={err} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Meters online" value={devices.filter((d) => d.active).length} sub={`${facilities.length} facilities`} icon={<Radio size={16} />} />
        <Stat label="Batches anchored on-chain" value={fmtNum(totalBatches)} sub={<Hash value={devs.data.contract} n={4} label="registry" />} icon={<ShieldCheck size={16} />} />
        <Stat label="Signed readings" value={fmtNum(totalReadings)} sub="15-min history + 1 s live" icon={<Activity size={16} />} />
        <Stat label="Abatement bypass readings" value={fmtNum(crit)} sub="flagged by the meters' anomaly rules" tone={crit ? "bad" : "good"} icon={<AlertTriangle size={16} />} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-4">
        <Section title="Meters" className="xl:col-span-1">
          <div className="space-y-4">
            {facilities.map((f) => (
              <div key={f}>
                <div className="mb-1.5 text-xs font-semibold">{f}</div>
                <div className="space-y-1.5">
                  {devices.filter((d) => d.facility.startsWith(f)).map((d) => {
                    const Icon = ICON[d.kind];
                    const bad = d.kind === "Abatement" && (d.uptime ?? 1) < 0.97;
                    return (
                      <button
                        key={d.address}
                        onClick={() => setSel(d.address)}
                        className={`w-full rounded-lg border p-2.5 text-left text-xs transition ${sel === d.address ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10" : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            <Icon size={13} className="text-slate-400" /> {d.facility.split(" · ")[1] ?? d.kind}
                          </span>
                          {bad ? <Pill tone="red">{Math.round((d.uptime ?? 0) * 100)}% uptime</Pill> : <Pill tone="brand">ok</Pill>}
                        </div>
                        <div className="mt-1 flex justify-between muted">
                          <span>
                            {d.mean != null ? `${fmtNum(d.mean, 1)} ${UNIT[d.kind]}` : "—"} avg
                          </span>
                          <span>{d.batches} batches</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <div className="space-y-5 xl:col-span-3">
          {device && (
            <Section
              title={device.facility}
              right={
                <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
                  {(["history", "live"] as const).map((m) => (
                    <button key={m} onClick={() => setMode(m)} className={`rounded-md px-2.5 py-1 ${mode === m ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "muted"}`}>
                      {m === "history" ? "7-day history" : live ? "● Live" : "Live"}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap items-center gap-3 text-xs muted">
                <span>Device <Hash value={device.address} n={4} /></span>
                <span>operated by {device.operatorName}</span>
                <span>latest root <Hash value={device.lastRoot} n={4} /></span>
              </div>
              <Chart series={series} kind={device.kind} mode={mode} />
              {mode === "live" && !live && <p className="mt-2 text-xs muted">Start the live feed to stream one signed reading per second per meter (anchored every 15 readings).</p>}
            </Section>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            {device && <Batches device={device} />}
            <Section title="Anomaly alerts" right={<AlertTriangle size={15} className="text-slate-400" />}>
              {alerts.length === 0 ? (
                <p className="text-sm muted">No alerts.</p>
              ) : (
                <ul className="max-h-80 space-y-2 overflow-auto pr-1 text-xs">
                  {alerts.map((a, i) => (
                    <li key={i} className="flex gap-2">
                      <AlertTriangle size={13} className={`mt-px shrink-0 ${a.severity === "critical" ? "text-red-600" : "text-amber-600"}`} />
                      <div>
                        <div>{a.message}</div>
                        <div className="muted">{a.facility} · {fmtTime(a.ts)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}

function Chart({ series, kind, mode }: { series: Series | null; kind: string; mode: string }) {
  const data = useMemo(() => (series?.points ?? []).map((p) => ({ ...p, label: p.ts })), [series]);
  if (!series) return <Loading />;
  if (!data.length) return <div className="grid h-64 place-items-center text-sm muted">No readings yet.</div>;
  const fmt = (ts: number) => {
    const d = new Date(ts * 1000);
    return mode === "live" ? d.toLocaleTimeString() : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="ts" tickFormatter={fmt} tick={{ fill: "var(--viz-axis)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis
            tick={{ fill: "var(--viz-axis)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
            domain={kind === "Abatement" ? [0, 100] : ["auto", "auto"]}
            tickFormatter={(v) => fmtNum(v, 0)}
          />
          <Tooltip
            labelFormatter={(ts) => new Date(Number(ts) * 1000).toLocaleString()}
            formatter={(v) => [`${Number(v).toFixed(kind === "Abatement" ? 2 : 1)} ${UNIT[kind]}`, kind]}
            contentStyle={{ borderRadius: 8, fontSize: 12 }}
          />
          {kind === "Abatement" && (
            <ReferenceLine y={95} stroke="var(--status-critical)" strokeDasharray="4 4" label={{ value: "alert < 95%", fill: "var(--status-critical)", fontSize: 11, position: "insideBottomLeft" }} />
          )}
          <Line type="monotone" dataKey="v" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Batches({ device }: { device: Device }) {
  const { data, reload } = useApi<BatchRow[]>(`/telemetry/batches/${device.address}`, [device.address, device.batches]);
  const [proof, setProof] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setProof(null), [device.address]);

  async function prove(b: BatchRow) {
    setBusy(true);
    try {
      setProof(await api.get<Proof>(`/telemetry/prove/${device.address}/${b.index}/${Math.floor(Math.random() * b.count)}`));
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <Section title="On-chain batches" right={<Gauge size={15} className="text-slate-400" />}>
      {!data ? (
        <Loading />
      ) : (
        <ul className="max-h-60 divide-y divide-slate-100 overflow-auto text-xs dark:divide-slate-800">
          {data.slice(0, 30).map((b) => (
            <li key={b.index} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="font-medium">
                  #{b.index} · {b.count} readings {b.alerts > 0 && <span className="text-red-600">· {b.alerts} alerts</span>}
                </div>
                <div className="muted">
                  {fmtTime(b.fromTs)} → {new Date(b.toTs * 1000).toLocaleTimeString()} · <Hash value={b.tx} n={4} />
                </div>
              </div>
              <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={busy} onClick={() => prove(b)}>
                Prove a reading
              </button>
            </li>
          ))}
        </ul>
      )}
      {proof && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950/50">
          <div className="flex flex-wrap items-center gap-2">
            {proof.valid ? <ShieldCheck size={14} className="text-emerald-600" /> : <ShieldX size={14} className="text-red-600" />}
            <span>
              Reading at {fmtTime(proof.ts)} = <b>{fmtNum(proof.display, 2)} {UNIT[proof.kind]}</b> is {proof.valid ? "proven" : "NOT proven"} in batch #{proof.index} ({proof.proof.length}-hash proof, checked by the contract).
            </span>
          </div>
          <div className="mt-1 muted">Same proof with the value changed by one unit: {proof.tampered_valid ? "accepted (!)" : "rejected ✓"}</div>
        </div>
      )}
    </Section>
  );
}
