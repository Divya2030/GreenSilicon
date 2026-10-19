import { useState } from "react";
import { Link } from "react-router-dom";
import { Ban, Coins, Flame, Layers, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { PassportSummary, Retirement } from "../lib/types";
import { ErrorBox, Hash, Loading, Meter, PageHeader, Section } from "../components/ui";
import { fmtCarbon, fmtNum, fmtTime } from "../lib/format";

type Batch = { batchId: number; projectName: string; methodology: string; registrySerial: string; vintage: number; issuedKg: number; retiredKg: number; evidenceHash: string; issuer: string; holders: Record<string, number> };

export default function Credits() {
  const { data, error, reload } = useApi<{ batches: Batch[]; retirements: Retirement[] }>("/credits");
  const lots = useApi<PassportSummary[]>("/passports");
  if (error) return <ErrorBox error={error} />;
  if (!data || !lots.data) return <Loading />;
  const lotName = (id: number) => lots.data!.find((p) => p.id === id)?.product ?? `#${id}`;

  return (
    <>
      <PageHeader
        title="Carbon Credits"
        subtitle="Verified credits are tokenised (1 token = 1 kg CO₂e) and can only be used by retiring them against a specific chip lot. Retiring burns them permanently."
      />

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {[
          { icon: Layers, t: "No double issuance", d: "Each external registry serial can be tokenised exactly once (SerialAlreadyTokenized)." },
          { icon: Flame, t: "No double use", d: "Retirement burns the ERC-1155 balance, so a credit cannot be resold after it is claimed." },
          { icon: Ban, t: "No over-claiming", d: "A lot can never be offset beyond its attested footprint (OffsetExceedsFootprint)." },
        ].map(({ icon: Icon, t, d }) => (
          <div key={t} className="card card-pad">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Icon size={16} className="text-brand-600" /> {t}
            </div>
            <p className="mt-1 text-xs muted">{d}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Section title="Tokenised credit batches">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-xs muted">
                    <th className="pb-2 font-medium">Batch</th>
                    <th className="px-3 pb-2 font-medium">Methodology</th>
                    <th className="px-3 pb-2 text-right font-medium">Issued</th>
                    <th className="w-40 px-3 pb-2 font-medium">Retired</th>
                    <th className="pb-2 text-right font-medium">Buyer holds</th>
                  </tr>
                </thead>
                <tbody>
                  {data.batches.map((b) => (
                    <tr key={b.batchId} className="border-t border-slate-100 align-top dark:border-slate-800">
                      <td className="py-2.5">
                        <div className="font-medium">#{b.batchId} {b.projectName}</div>
                        <div className="text-xs muted">
                          <span className="font-mono">{b.registrySerial}</span> · vintage {b.vintage}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs">{b.methodology}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(b.issuedKg / 1000, 1)} t</td>
                      <td className="px-3 py-2.5">
                        <Meter value={b.retiredKg / b.issuedKg} />
                        <div className="mt-1 text-xs tabular-nums muted">{fmtNum(b.retiredKg / 1000, 1)} t retired</div>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{fmtNum((b.holders.oem ?? 0) / 1000, 1)} t</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Retirement ledger">
            {data.retirements.length === 0 ? (
              <p className="text-sm muted">No retirements yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.retirements.map((r) => (
                  <li key={r.retirementId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <div>
                      <div>
                        <b>{fmtNum(r.amountKg / 1000, 1)} t</b> from batch #{r.batchId} →{" "}
                        <Link className="text-brand-700 hover:underline dark:text-brand-400" to={`/passport/${r.passportId}`}>
                          #{r.passportId} {lotName(r.passportId)}
                        </Link>
                      </div>
                      <div className="text-xs muted">{r.beneficiary}</div>
                    </div>
                    <div className="text-right text-xs muted">
                      <div>{fmtTime(r.timestamp)}</div>
                      <Hash value={r.retiree} n={4} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          <RetireForm batches={data.batches} lots={lots.data} onDone={() => { reload(); lots.reload(); }} />
          <IssueForm batches={data.batches} onDone={reload} />
        </div>
      </div>
    </>
  );
}

function RetireForm({ batches, lots, onDone }: { batches: Batch[]; lots: PassportSummary[]; onDone: () => void }) {
  const [batch, setBatch] = useState(batches[0]?.batchId ?? 1);
  const [pid, setPid] = useState(lots.find((p) => p.kind === "product")?.id ?? 1);
  const [kg, setKg] = useState(5000);
  const [ben, setBen] = useState("Helios Cloud - FY2026 Scope 3 hardware");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const lot = lots.find((p) => p.id === pid);
  const headroom = lot ? Math.max(0, (lot.totalCarbonG - lot.offsetG) / 1000) : 0;

  async function go() {
    setMsg(null);
    try {
      const r = await api.post<{ retirement_id: number; tx: string }>("/credits/retire", { actor: "oem", batch_id: batch, amount_kg: kg, passport_id: pid, beneficiary: ben });
      setMsg({ ok: true, t: `Retired: retirement #${r.retirement_id}` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, t: (e as Error).message });
    }
  }

  return (
    <Section title="Retire credits against a lot" right={<Flame size={15} className="text-orange-500" />}>
      <div className="space-y-3">
        <label className="block">
          <span className="label">Credit batch</span>
          <select className="input" value={batch} onChange={(e) => setBatch(+e.target.value)}>
            {batches.map((b) => <option key={b.batchId} value={b.batchId}>#{b.batchId} {b.projectName} ({fmtNum((b.holders.oem ?? 0) / 1000, 1)} t held)</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Chip lot</span>
          <select className="input" value={pid} onChange={(e) => setPid(+e.target.value)}>
            {lots.map((p) => <option key={p.id} value={p.id}>#{p.id} {p.product}</option>)}
          </select>
          {lot && <span className="mt-1 block text-xs muted">Footprint {fmtCarbon(lot.totalCarbonG)} · offset {fmtCarbon(lot.offsetG)} · headroom {fmtNum(headroom)} kg</span>}
        </label>
        <label className="block">
          <span className="label">Amount (kg CO₂e)</span>
          <input className="input" type="number" min={1} value={kg} onChange={(e) => setKg(Math.max(1, +e.target.value))} />
        </label>
        <label className="block">
          <span className="label">Beneficiary / claim</span>
          <input className="input" value={ben} onChange={(e) => setBen(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={go}>
            <Coins size={15} /> Retire on-chain
          </button>
          <button className="btn-ghost text-xs" onClick={() => setKg(Math.ceil(headroom) + 1000)} title="Demonstrates the over-claiming guard">
            Try over-claiming
          </button>
        </div>
        {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{msg.t}</p>}
      </div>
    </Section>
  );
}

function IssueForm({ batches, onDone }: { batches: Batch[]; onDone: () => void }) {
  const [f, setF] = useState({ project: "Changhua Offshore Wind Phase 2", methodology: "CDM ACM0002 grid-connected renewable", serial: `GS-TW-2026-${Math.floor(Math.random() * 9e5 + 1e5)}`, vintage: 2026, amount_kg: 20000 });
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  async function go() {
    setMsg(null);
    try {
      const r = await api.post<{ batch_id: number }>("/credits/issue", { ...f, to_actor: "oem" });
      setMsg({ ok: true, t: `Tokenised as batch #${r.batch_id}` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, t: (e as Error).message });
    }
  }
  return (
    <Section title="Tokenise verified credits (bridge)" right={<ShieldCheck size={15} className="text-slate-400" />}>
      <div className="space-y-2.5">
        <input className="input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} placeholder="Project" />
        <input className="input" value={f.methodology} onChange={(e) => setF({ ...f, methodology: e.target.value })} placeholder="Methodology" />
        <div className="grid grid-cols-2 gap-2">
          <input className="input font-mono text-xs" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} placeholder="Registry serial" />
          <input className="input" type="number" value={f.amount_kg} onChange={(e) => setF({ ...f, amount_kg: Math.max(1, +e.target.value) })} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={go}>Tokenise</button>
          {batches[0] && (
            <button className="btn-ghost text-xs" onClick={() => setF({ ...f, serial: batches[0].registrySerial })} title="Demonstrates the double-issuance guard">
              Reuse an existing serial
            </button>
          )}
        </div>
        {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{msg.t}</p>}
        <p className="text-xs muted">Only the credit-bridge account (ISSUER_ROLE) can tokenise. In production this is fed by Verra / Gold Standard registry APIs.</p>
      </div>
    </Section>
  );
}
