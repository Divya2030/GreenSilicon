import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, CheckCircle2, FileUp, FileText, Fingerprint, GitMerge, Loader2, Lock, PenLine, ShieldCheck, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { Audit, Disclosure, PassportSummary } from "../lib/types";
import { ErrorBox, Hash, PageHeader, Pill, Section, VerdictBadge } from "../components/ui";
import { LOCATION_LABEL, STAGE_LABEL, fmtCarbon } from "../lib/format";
import { useConfig } from "../lib/context";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

const ROLE_STAGES: Record<string, string[]> = {
  DESIGNER_ROLE: ["Design"],
  FAB_ROLE: ["WaferFab"],
  OSAT_ROLE: ["Assembly", "Test"],
  LOGISTICS_ROLE: ["Logistics"],
  RECYCLER_ROLE: ["EndOfLife"],
};

type Extracted = { disclosure: Disclosure; engine: string; evidence_hash: string; ai_error?: string | null };
type Submitted = { index: number; tx: string; root?: string; signature?: string; audit: Audit; reward_circ?: number };

const NUM_FIELDS: [keyof Disclosure, string][] = [
  ["claimed_carbon_kgco2e", "Claimed total (kg CO₂e)"],
  ["units", "Units"],
  ["electricity_kwh", "Electricity (kWh)"],
  ["renewable_share", "Renewable share (0–1)"],
  ["scope1_process_gas_kgco2e", "Process gas (kg CO₂e)"],
  ["abatement_rate", "Abatement (0–1)"],
  ["water_l", "Water (L)"],
  ["die_yield", "Die yield (0–1)"],
  ["distance_km", "Distance (km)"],
  ["shipment_mass_kg", "Shipment mass (kg)"],
  ["recovered_material_g", "Recovered material (g)"],
];

export default function SupplierPortal() {
  const cfg = useConfig()!;
  const lots = useApi<PassportSummary[]>("/passports");
  const samples = useApi<string[]>("/samples");
  const suppliers = Object.entries(cfg.actors).filter(([, a]) => a.roles.some((r) => r in ROLE_STAGES));
  const [actor, setActor] = useState("fab_tw");
  const stages = useMemo(() => cfg.actors[actor]?.roles.flatMap((r) => ROLE_STAGES[r] ?? []) ?? [], [actor, cfg]);
  const [stage, setStage] = useState("WaferFab");
  const [pid, setPid] = useState<number | null>(null);
  const [ex, setEx] = useState<Extracted | null>(null);
  const [busy, setBusy] = useState<"extract" | "submit" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Submitted | null>(null);
  const [recycleUnits, setRecycleUnits] = useState(100);
  const [mode, setMode] = useState<"demo" | "wallet">("demo");
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);
  const roleForStage = Object.entries(ROLE_STAGES).find(([, st]) => st.includes(stage))?.[0] ?? "FAB_ROLE";

  async function connectWallet() {
    setWalletMsg(null);
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!eth) {
      setWalletMsg("No browser wallet found. Install MetaMask, or use the demo supplier keys.");
      return;
    }
    try {
      const [acct] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const chainHex = "0x" + cfg.chainId.toString(16);
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: chainHex, chainName: "GreenSilicon demo chain", rpcUrls: [cfg.rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
        });
      }
      setWallet(acct);
    } catch (e) {
      setWalletMsg((e as Error).message);
    }
  }

  async function grantDemoRole() {
    if (!wallet) return;
    try {
      await api.post("/dev/grant-role", { wallet, role: roleForStage });
      setWalletMsg(`${roleForStage} granted to your wallet on the demo chain.`);
    } catch (e) {
      setWalletMsg((e as Error).message);
    }
  }

  useEffect(() => {
    if (!stages.includes(stage)) setStage(stages[0]);
  }, [stages, stage]);

  const eligible = (lots.data ?? []).filter((p) => (stage === "EndOfLife" ? p.status !== "Recycled" : p.status === "Active"));
  useEffect(() => {
    if (eligible.length && !eligible.some((p) => p.id === pid)) setPid(eligible[eligible.length - 1].id);
  }, [eligible, pid]);

  async function extract(file: File) {
    setBusy("extract");
    setErr(null);
    setDone(null);
    try {
      const f = new FormData();
      f.append("file", file);
      f.append("stage", stage);
      const r = await api.upload<Extracted>("/extract", f);
      setEx(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function loadSample(name: string) {
    const r = await fetch(`/api/samples/${name}`);
    const blob = await r.blob();
    extract(new File([blob], name, { type: blob.type }));
  }

  async function submit() {
    if (!ex || pid == null) return;
    setBusy("submit");
    setErr(null);
    try {
      const d = { ...ex.disclosure, stage };
      if (mode === "wallet" && stage !== "EndOfLife") {
        const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
        if (!eth || !wallet) throw new Error("Connect your wallet first");
        const prep = await api.post<{ draft: string; typedData: unknown }>(`/passports/${pid}/stages/wallet/prepare`, {
          wallet, organisation: d.supplier_name, disclosure: d, evidence_hash: ex.evidence_hash,
        });
        const signature = (await eth.request({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(prep.typedData)] })) as string;
        const r = await api.post<Submitted>("/stages/wallet/submit", { draft: prep.draft, signature });
        setDone(r);
        lots.reload();
        return;
      }
      const r =
        stage === "EndOfLife"
          ? await api.post<Submitted>(`/passports/${pid}/recycle`, { units: recycleUnits, disclosure: d, evidence_hash: ex.evidence_hash })
          : await api.post<Submitted>(`/passports/${pid}/stages?actor=${actor}&evidence_hash=${ex.evidence_hash}`, d);
      setDone(r);
      lots.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const setField = (k: keyof Disclosure, v: string) => {
    if (!ex) return;
    const num = v === "" ? null : Number(v);
    setEx({ ...ex, disclosure: { ...ex.disclosure, [k]: Number.isNaN(num) ? ex.disclosure[k] : num } });
  };

  return (
    <>
      <PageHeader
        title="Supplier Portal"
        subtitle="Fabs, OSATs, carriers and recyclers upload their usual sustainability reports. Claude extracts the figures, the supplier reviews and signs them (EIP-712), and the record is relayed on-chain gas-free and audited."
      />

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="space-y-5 xl:col-span-2">
          <Section title="1 · Who is attesting?">
            <div className="space-y-3">
              <label className="block">
                <span className="label">Supplier account (signing key)</span>
                <select className="input" value={actor} onChange={(e) => { setActor(e.target.value); setEx(null); setDone(null); }}>
                  {suppliers.map(([k, a]) => (
                    <option key={k} value={k}>{a.name}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Hash value={cfg.actors[actor]?.address} />
                {cfg.actors[actor]?.roles.map((r) => <Pill key={r} tone="blue">{r}</Pill>)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="label">Lifecycle stage</span>
                  <select className="input" value={stage} onChange={(e) => setStage(e.target.value)}>
                    {stages.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                </label>
                <label>
                  <span className="label">Production lot</span>
                  <select className="input" value={pid ?? ""} onChange={(e) => setPid(+e.target.value)}>
                    {eligible.map((p) => (
                      <option key={p.id} value={p.id}>#{p.id} {p.product} · {p.lot_code}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-xs muted">The contract enforces roles per stage: a fab key cannot sign an assembly record, and stages must follow lifecycle order.</p>
              <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
                <span className="label">Signing key</span>
                <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
                  {(["demo", "wallet"] as const).map((m) => (
                    <button key={m} onClick={() => setMode(m)} className={`flex-1 rounded-md px-2.5 py-1.5 ${mode === m ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "muted"}`}>
                      {m === "demo" ? "Demo supplier key" : "My own wallet (MetaMask)"}
                    </button>
                  ))}
                </div>
                {mode === "wallet" && (
                  <div className="mt-2 space-y-2 text-xs">
                    {wallet ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone="brand">connected</Pill> <Hash value={wallet} />
                        {cfg.chainId === 31337 && (
                          <button className="btn-ghost px-2 py-1 text-[11px]" onClick={grantDemoRole}>Grant me {roleForStage} (demo chain)</button>
                        )}
                      </div>
                    ) : (
                      <button className="btn-ghost w-full" onClick={connectWallet}>
                        <Wallet size={14} /> Connect wallet
                      </button>
                    )}
                    {walletMsg && <p className="muted">{walletMsg}</p>}
                    <p className="muted">You sign the EIP-712 attestation in your wallet. GreenSilicon only relays it (you need no gas) and never sees your key.</p>
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Section title="2 · Upload evidence">
            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-6 text-center hover:border-brand-500 dark:border-slate-700"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) extract(f);
              }}
            >
              {busy === "extract" ? <Loader2 className="animate-spin text-brand-600" /> : <FileUp className="text-slate-400" />}
              <span className="text-sm font-medium">{busy === "extract" ? "AI is reading the document…" : "Drop a PDF or text report"}</span>
              <span className="text-xs muted">lot report, PCF (ISO 14067), utility bill, air waybill, recycling certificate</span>
              <input type="file" className="hidden" accept=".pdf,.txt,.md,.csv" onChange={(e) => e.target.files?.[0] && extract(e.target.files[0])} />
            </label>
            {samples.data && samples.data.length > 0 && (
              <div className="mt-3">
                <div className="label">or try a sample supplier document</div>
                <div className="flex flex-wrap gap-1.5">
                  {samples.data.map((s) => (
                    <button key={s} className="btn-ghost px-2 py-1 text-[11px]" onClick={() => loadSample(s)} disabled={!!busy}>
                      <FileText size={12} /> {s.replace(/^\d+_/, "").replace(/\.txt$/, "").replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section title="What goes on-chain">
            <ul className="space-y-2 text-xs">
              <li className="flex gap-2"><Lock size={14} className="shrink-0 text-brand-600" /> <span><b>On-chain:</b> totals (carbon, energy, water), facility, a salted Merkle root of every field, the evidence hash and the supplier's signature.</span></li>
              <li className="flex gap-2"><Fingerprint size={14} className="shrink-0 text-brand-600" /> <span><b>Off-chain:</b> confidential values (yield, gas mix) stay private, but any single field can be revealed later with a proof the contract checks.</span></li>
              <li className="flex gap-2"><ShieldCheck size={14} className="shrink-0 text-brand-600" /> <span><b>Security:</b> uploaded documents are treated as untrusted input. Prompt-injection text cannot override the physics checks.</span></li>
            </ul>
          </Section>
        </div>

        <div className="space-y-5 xl:col-span-3">
          {err && <ErrorBox error={err} />}
          {!ex && !done && (
            <div className="card grid min-h-64 place-items-center p-10 text-center text-sm muted">
              <div>
                <Bot className="mx-auto mb-2 text-violet-500" />
                Upload a document to see what the AI extracts.
              </div>
            </div>
          )}

          {ex && (
            <Section
              title="3 · Review the extracted disclosure"
              right={<Pill tone={ex.engine === "heuristic" ? "slate" : "brand"}>{ex.engine === "heuristic" ? "offline parser" : `extracted by ${ex.engine}`}</Pill>}
            >
              {ex.ai_error && <p className="mb-3 text-xs text-amber-700">Claude unavailable ({ex.ai_error}); used the offline parser.</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <ReadOnly k="Supplier" v={ex.disclosure.supplier_name} />
                <ReadOnly k="Facility" v={`${ex.disclosure.facility} · ${LOCATION_LABEL[ex.disclosure.location] ?? ex.disclosure.location}`} />
                <ReadOnly k="Period / lot" v={ex.disclosure.reporting_period} />
                <ReadOnly k="Certifications" v={ex.disclosure.certifications.join("; ") || "none cited"} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                {NUM_FIELDS.filter(([k]) => ex.disclosure[k] != null || ["claimed_carbon_kgco2e", "units", "electricity_kwh"].includes(k)).map(([k, label]) => (
                  <label key={k}>
                    <span className="label">{label}</span>
                    <input className="input tabular-nums" type="number" step="any" value={(ex.disclosure[k] as number | null) ?? ""} onChange={(e) => setField(k, e.target.value)} />
                  </label>
                ))}
              </div>
              {ex.disclosure.evidence_quotes.length > 0 && (
                <div className="mt-4">
                  <div className="label">Evidence quoted by the AI</div>
                  <ul className="space-y-1 text-xs">
                    {ex.disclosure.evidence_quotes.slice(0, 5).map((q, i) => (
                      <li key={i} className="border-l-2 border-slate-300 pl-2 italic muted">“{q}”</li>
                    ))}
                  </ul>
                </div>
              )}
              {ex.disclosure.missing_or_unclear.length > 0 && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">Not stated in document: {ex.disclosure.missing_or_unclear.join(", ")}</p>
              )}
              {stage === "EndOfLife" && (
                <label className="mt-4 block w-40">
                  <span className="label">Units recycled</span>
                  <input className="input" type="number" min={1} value={recycleUnits} onChange={(e) => setRecycleUnits(Math.max(1, +e.target.value))} />
                </label>
              )}
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button className="btn-primary" onClick={submit} disabled={busy !== null || pid == null}>
                  {busy === "submit" ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />}
                  {busy === "submit" ? "Signing, anchoring & auditing…" : mode === "wallet" ? `Sign in wallet & anchor to #${pid}` : `Sign & anchor to passport #${pid}`}
                </button>
                <span className="text-xs muted">evidence <Hash value={ex.evidence_hash} n={4} /></span>
              </div>
            </Section>
          )}

          {done && (
            <Section title="4 · Anchored and audited" right={<CheckCircle2 size={16} className="text-emerald-500" />}>
              <div className="flex flex-wrap items-center gap-3">
                <VerdictBadge v={done.audit.verdict} score={done.audit.score} />
                <span className="text-sm">{fmtCarbon(done.audit.rules.claimed_g)} claimed</span>
                {done.audit.rules.ratio != null && <span className="text-sm muted">{done.audit.rules.ratio.toFixed(2)}× the independent estimate</span>}
                {done.reward_circ != null && <Pill tone="brand">+{done.reward_circ} CIRC minted to recycler</Pill>}
              </div>
              <p className="mt-3 text-sm leading-relaxed">{done.audit.summary}</p>
              {done.audit.findings.filter((f) => f.severity !== "info").length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                  {done.audit.findings.filter((f) => f.severity !== "info").map((f, i) => (
                    <li key={i}><b>{f.title}</b> <span className="muted">{f.detail}</span></li>
                  ))}
                </ul>
              )}
              <div className="mt-4 grid gap-1.5 text-xs sm:grid-cols-2">
                <span>Stage tx <Hash value={done.tx} /></span>
                {done.signature && <span>Supplier signature <Hash value={done.signature} /></span>}
                {done.root && <span>Merkle root <Hash value={done.root} /></span>}
                <span>AI verdict tx <Hash value={done.audit.tx} /></span>
              </div>
              <Link to={`/passport/${pid}`} className="btn-ghost mt-4">Open passport #{pid}</Link>
            </Section>
          )}

          {cfg.actors[actor]?.roles.includes("OSAT_ROLE") && <Integrate lots={lots.data ?? []} onDone={lots.reload} />}
        </div>
      </div>
    </>
  );
}

function ReadOnly({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="label">{k}</div>
      <div className="text-sm">{v}</div>
    </div>
  );
}

function Integrate({ lots, onDone }: { lots: PassportSummary[]; onDone: () => void }) {
  const active = lots.filter((p) => p.status === "Active");
  const [parent, setParent] = useState<number>(active[active.length - 1]?.id ?? 0);
  const [child, setChild] = useState<number>(active[0]?.id ?? 0);
  const [units, setUnits] = useState(100);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function go() {
    try {
      const r = await api.post<{ tx: string; carbon_g: number }>(`/passports/${parent}/components`, { child_id: child, units });
      setMsg({ ok: true, text: `Integrated: ${fmtCarbon(r.carbon_g)} allocated to #${parent}` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Section title="Integrate a component lot (OSAT)" right={<GitMerge size={15} className="text-slate-400" />}>
      <div className="grid grid-cols-3 gap-3">
        <label>
          <span className="label">Component (child)</span>
          <select className="input" value={child} onChange={(e) => setChild(+e.target.value)}>
            {active.map((p) => <option key={p.id} value={p.id}>#{p.id} {p.product}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Into product (parent)</span>
          <select className="input" value={parent} onChange={(e) => setParent(+e.target.value)}>
            {active.map((p) => <option key={p.id} value={p.id}>#{p.id} {p.product}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Units consumed</span>
          <input className="input" type="number" min={1} value={units} onChange={(e) => setUnits(Math.max(1, +e.target.value))} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn-ghost" onClick={go}>Allocate carbon on-chain</button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
      </div>
      <p className="mt-2 text-xs muted">Try allocating more units than a lot has: the contract reverts with ComponentOverAllocated, so the same chiplet carbon can't be claimed twice.</p>
    </Section>
  );
}
