import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AlertTriangle, BadgeCheck, Bot, Boxes, ChevronDown, ChevronRight, Download, Droplets, ExternalLink, FileText, Info, Leaf, Lightbulb,
  Lock, Send, ShieldCheck, ShieldX, Sparkles, XCircle, Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { Component, Passport, StageRec } from "../lib/types";
import { ErrorBox, Hash, Loading, Meter, PageHeader, Pill, Section, Stat, VerdictBadge } from "../components/ui";
import { BREAKDOWN_LABEL, STAGE_LABEL, fmtCarbon, fmtNum, fmtPct, fmtTime } from "../lib/format";
import { actorName, useConfig } from "../lib/context";

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)"];

export default function PassportDetail() {
  const { id } = useParams();
  const cfg = useConfig();
  const { data: p, error } = useApi<Passport>(`/passports/${id}`, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading label="Reading passport from chain…" />;

  const verifyUrl = `${window.location.origin}/verify/${p.id}`;
  const verified = p.verifiedShareBps / 10000;

  async function exportDpp() {
    const vc = await api.get(`/passports/${p!.id}/dpp`);
    const blob = new Blob([JSON.stringify(vc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `greensilicon-${p!.id}-${p!.lot_code}.dpp.json`;
    a.click();
  }

  return (
    <>
      <PageHeader
        title={`#${p.id} · ${p.product}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{p.lot_code}</span>
            <Pill>{p.processNode}</Pill>
            <Pill tone="blue">{p.kind}</Pill>
            <Pill tone={p.status === "Active" ? "brand" : "amber"}>{p.status}</Pill>
            <span>{fmtNum(p.units)} units</span>
          </span>
        }
        actions={
          <>
            <button className="btn-ghost" onClick={exportDpp}>
              <Download size={15} /> DPP credential
            </button>
            <Link className="btn-primary" to={`/verify/${p.id}`}>
              <BadgeCheck size={15} /> Verify trustlessly
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Cradle-to-gate footprint" value={fmtCarbon(p.totalCarbonG)} sub={`${fmtCarbon(p.perUnitG)} per unit`} />
        <Stat
          label="Net after retired offsets"
          value={fmtCarbon(p.netCarbonG)}
          sub={p.offsetG ? `${fmtCarbon(p.offsetG)} offset (${fmtPct(p.offsetG / p.totalCarbonG)})` : "no offsets retired"}
          tone={p.offsetG ? "good" : undefined}
        />
        <Stat
          label="AI-verified share"
          value={`${(p.verifiedShareBps / 100).toFixed(p.verifiedShareBps % 100 ? 2 : 0)}%`}
          sub={(() => {
            const n = p.stages.filter((s) => s.verdict === "Flagged" || s.verdict === "Rejected").length;
            return n ? `of own carbon · ${n} record${n > 1 ? "s need" : " needs"} review` : "of this lot's own attested carbon";
          })()} tone={verified > 0.9 ? "good" : "warn"} icon={<ShieldCheck size={16} />} />
        <Stat
          label="Carbon at risk"
          value={fmtCarbon(p.carbonAtRiskG)}
          sub={p.carbonAtRiskG > 0 ? "under-reported in flagged records" : "no unverified gaps"}
          tone={p.carbonAtRiskG > 0 ? "bad" : "good"}
          icon={<AlertTriangle size={16} />}
        />
        <Stat label="Water (this lot's stages)" value={`${fmtNum(p.waterL / 1000, 1)} m³`} sub={p.estimate ? `model: ${fmtNum(p.estimate.per_lot.water_m3, 0)} m³ incl. supply chain` : undefined} icon={<Droplets size={16} />} />
        <Stat label="Energy (attested)" value={`${fmtNum(p.energyWh / 1e6, 1)} MWh`} icon={<Zap size={16} />} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Section title="Lifecycle ledger" right={<span className="text-xs muted">EIP-712 signed by each supplier · append-only</span>}>
            {p.stages.length === 0 ? (
              <p className="text-sm muted">No stage records yet. Suppliers can attest via the Supplier Portal.</p>
            ) : (
              <ol className="relative space-y-4 border-l border-slate-200 pl-5 dark:border-slate-800">
                {p.stages.map((s) => (
                  <StageCard key={s.index} s={s} pid={p.id} />
                ))}
              </ol>
            )}
          </Section>

          {p.usePhase && <UsePhasePanel p={p} />}
          {p.estimate && <Breakdown p={p} />}
          <Copilot pid={p.id} />
        </div>

        <div className="space-y-5">
          <Section title="Scan to verify">
            <div className="flex items-center gap-4">
              <div className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
                <QRCodeSVG value={verifyUrl} size={108} />
              </div>
              <div className="min-w-0 space-y-1.5 text-xs">
                <div className="muted">Anyone can check this lot directly against the blockchain, without trusting our server.</div>
                <a href={verifyUrl} className="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-400">
                  Open verifier <ExternalLink size={11} />
                </a>
              </div>
            </div>
            <dl className="mt-4 space-y-1.5 text-xs">
              <Row k="Contract"><Hash value={p.contract} /></Row>
              <Row k="Token ID">#{p.id} (ERC-721)</Row>
              <Row k="Owner"><span className="truncate">{actorName(cfg, p.owner)}</span></Row>
              <Row k="Design commitment"><Hash value={p.designCommitment} /></Row>
              <Row k="Minted in tx"><Hash value={p.created_tx} /></Row>
              <Row k="Minted">{fmtTime(p.createdAt)}</Row>
            </dl>
          </Section>

          {p.components.length > 0 && (
            <Section title="Bill of materials (passported)" right={<Boxes size={15} className="text-slate-400" />}>
              <ComponentTree items={p.components} />
              <p className="mt-3 text-xs muted">
                Inherited {fmtCarbon(p.inheritedCarbonG)}. Each component lot can only be allocated up to its unit count, so chiplet carbon is never counted twice.
              </p>
            </Section>
          )}

          <Section title="Offsets retired against this lot" right={<Leaf size={15} className="text-emerald-500" />}>
            {p.retirements.length === 0 ? (
              <p className="text-sm muted">
                None yet. <Link to="/credits" className="text-brand-700 underline dark:text-brand-400">Retire credits</Link>
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {p.retirements.map((r) => (
                  <li key={r.retirementId} className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{fmtNum(r.amountKg)} kg · batch {r.batchId}</div>
                      <div className="text-xs muted">{r.beneficiary}</div>
                    </div>
                    <span className="text-xs muted">{fmtTime(r.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {p.recommendations.length > 0 && (
            <Section title="Decarbonisation levers" right={<Lightbulb size={15} className="text-amber-500" />}>
              <ul className="space-y-3">
                {p.recommendations.slice(0, 5).map((r) => (
                  <li key={r.lever}>
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <span>{r.lever}</span>
                      <span className="shrink-0 font-semibold text-emerald-700 tabular-nums dark:text-emerald-400">−{r.saving_pct.toFixed(0)}%</span>
                    </div>
                    <div className="mt-1 text-xs muted">
                      saves {fmtCarbon(r.saving_g * p.units)} on this lot · {r.category}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="muted">{k}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function ComponentTree({ items, depth = 0 }: { items: Component[]; depth?: number }) {
  return (
    <ul className={depth ? "ml-4 mt-2 border-l border-slate-200 pl-3 dark:border-slate-800" : "space-y-2.5"}>
      {items.map((c) => (
        <li key={c.childId} className="text-sm">
          <div className="flex items-start justify-between gap-2">
            <Link to={`/passport/${c.childId}`} className="font-medium hover:text-brand-700">
              #{c.childId} {c.product}
            </Link>
            <span className="shrink-0 tabular-nums">{fmtCarbon(c.carbonG)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs muted">
            <span>
              {fmtNum(c.units)} / {fmtNum(c.child_units)} units · {c.node}
            </span>
            <span>{Math.round((c.verifiedShareBps ?? 0) / 100)}% verified</span>
            {(c.carbonAtRiskG ?? 0) > 0 && (
              <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                <AlertTriangle size={11} /> {fmtCarbon(((c.carbonAtRiskG ?? 0) * c.units) / (c.child_units || 1))} at risk
              </span>
            )}
          </div>
          {c.components && c.components.length > 0 && <ComponentTree items={c.components} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function StageCard({ s, pid }: { s: StageRec; pid: number }) {
  const cfg = useConfig();
  const [open, setOpen] = useState(s.verdict !== "Verified");
  const a = s.audit;
  const ratio = a?.rules?.ratio;
  const evidenceIsFile = !!s.evidence_file;

  return (
    <li className="relative">
      <span
        className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-white dark:ring-slate-900 ${
          s.verdict === "Verified" ? "bg-emerald-500" : s.verdict === "Rejected" ? "bg-red-500" : s.verdict === "Flagged" ? "bg-amber-500" : "bg-slate-400"
        }`}
      />
      <div className="rounded-lg border border-slate-200 dark:border-slate-800">
        <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 p-3.5 text-left" onClick={() => setOpen(!open)}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{STAGE_LABEL[s.stage] ?? s.stage}</span>
              <VerdictBadge v={s.verdict} score={s.aiScore / 100} />
              {s.integrity === true && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400" title="Off-chain disclosure re-hashed to the on-chain Merkle root">
                  <Lock size={11} /> integrity ok
                </span>
              )}
              {s.integrity === false && (
                <span className="inline-flex items-center gap-1 text-xs text-red-700">
                  <ShieldX size={11} /> tampered
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs muted">
              {s.facility} · {actorName(cfg, s.attester)} · {fmtTime(s.timestamp)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold tabular-nums">{fmtCarbon(s.carbonG)}</div>
            <div className="text-xs muted tabular-nums">
              {s.energyWh ? `${fmtNum(s.energyWh / 1000)} kWh` : ""} {s.waterL ? `· ${fmtNum(s.waterL / 1000, 1)} m³` : ""}
            </div>
          </div>
          {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
        </button>

        {open && (
          <div className="space-y-4 border-t border-slate-100 p-3.5 dark:border-slate-800">
            {a && (
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/50">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <Bot size={14} className="text-violet-500" />
                  <span className="font-medium">AI audit</span>
                  <Pill tone="slate">{a.engine === "rules+ml" ? "physics + IsolationForest" : `${a.model} + physics + ML`}</Pill>
                  {a.confidence !== undefined && <span className="muted">confidence {fmtPct(a.confidence)}</span>}
                </div>
                <p className="text-sm leading-relaxed">{a.summary}</p>
                {ratio != null && a.rules.expected_g != null && (
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between text-xs muted">
                      <span>Claimed vs independent estimate</span>
                      <span className="tabular-nums">
                        {fmtCarbon(a.rules.claimed_g)} / {fmtCarbon(a.rules.expected_g)} = {ratio.toFixed(2)}×
                      </span>
                    </div>
                    <Meter value={Math.min(ratio, 2) / 2} tone={ratio < 0.7 ? "red" : ratio > 2 ? "amber" : "brand"} />
                    <div className="mt-1 text-[11px] muted">{a.rules.expected_basis} · anomaly score {a.rules.anomaly.toFixed(2)}</div>
                  </div>
                )}
                {a.findings.filter((f) => f.severity !== "info" || a.findings.length < 3).length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {a.findings.map((f, i) => (
                      <li key={i} className="flex gap-2 text-xs">
                        {f.severity === "critical" ? (
                          <XCircle size={14} className="mt-px shrink-0 text-red-600" />
                        ) : f.severity === "warning" ? (
                          <AlertTriangle size={14} className="mt-px shrink-0 text-amber-600" />
                        ) : (
                          <Info size={14} className="mt-px shrink-0 text-slate-400" />
                        )}
                        <span>
                          <span className="font-medium">{f.title}.</span> <span className="muted">{f.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {a.recommended_actions?.length > 0 && a.recommended_actions[0] !== "No action required." && (
                  <div className="mt-3 text-xs">
                    <span className="font-medium">Next steps: </span>
                    <span className="muted">{a.recommended_actions.join(" · ")}</span>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row k="Attestation tx"><Hash value={s.tx} /></Row>
              <Row k="Supplier signature"><Hash value={s.signature} /></Row>
              <Row k="Fields Merkle root"><Hash value={s.fieldsRoot} /></Row>
              <Row k="AI report hash"><Hash value={s.aiReportHash} /></Row>
              <Row k="Evidence">
                <span className="inline-flex items-center gap-2">
                  <Hash value={s.evidenceHash} />
                  {evidenceIsFile && (
                    <a href={`/api/evidence/${s.evidenceHash}`} target="_blank" rel="noreferrer" className="text-brand-700 dark:text-brand-400" title="Open source document">
                      <FileText size={13} />
                    </a>
                  )}
                </span>
              </Row>
              {s.disclosure && <Row k="Supplier">{s.disclosure.supplier_name}</Row>}
            </div>

            {s.disclosable_fields.length > 0 && <Disclosure pid={pid} s={s} />}
          </div>
        )}
      </div>
    </li>
  );
}

function Disclosure({ pid, s }: { pid: number; s: StageRec }) {
  const [field, setField] = useState(s.disclosable_fields.includes("scope1_process_gas_kgco2e") ? "scope1_process_gas_kgco2e" : s.disclosable_fields.includes("renewable_share") ? "renewable_share" : s.disclosable_fields[0]);
  const [result, setResult] = useState<{ value: string; valid: boolean; proofLen: number; pkg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function prove() {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.get<{ key: string; value: string; salt: string; proof: string[] }>(`/passports/${pid}/stages/${s.index}/disclose/${field}`);
      const v = await api.post<{ valid: boolean }>("/verify/field", { passportId: pid, index: s.index, key: d.key, value: d.value, salt: d.salt, proof: d.proof });
      setResult({ value: d.value, valid: v.valid, proofLen: d.proof.length, pkg: JSON.stringify({ passportId: pid, index: s.index, key: d.key, value: d.value, salt: d.salt, proof: d.proof }) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <Lock size={13} /> Selective disclosure
        <span className="font-normal muted">· reveal one field with a Merkle proof; the rest stays confidential</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto max-w-full text-xs" value={field} onChange={(e) => { setField(e.target.value); setResult(null); }}>
          {s.disclosable_fields.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button className="btn-ghost text-xs" onClick={prove} disabled={busy}>
          {busy ? "Proving…" : "Reveal & verify on-chain"}
        </button>
        {result && (
          <span className={`inline-flex items-center gap-1 text-xs ${result.valid ? "text-emerald-700 dark:text-emerald-400" : "text-red-700"}`}>
            {result.valid ? <ShieldCheck size={13} /> : <ShieldX size={13} />}
            <span className="font-mono">{field} = {result.value}</span>
            <span className="muted">· {result.valid ? `proof valid (${result.proofLen} hashes, checked by contract)` : "proof invalid"}</span>
          </span>
        )}
        {result && (
          <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => navigator.clipboard?.writeText(result.pkg)} title="Share with an auditor; verify it on the Public Verifier page">
            Copy proof package
          </button>
        )}
      </div>
      {err && <div className="mt-2"><ErrorBox error={err} /></div>}
    </div>
  );
}

function Breakdown({ p }: { p: Passport }) {
  const e = p.estimate!;
  const entries = Object.entries(e.per_unit.breakdown_g).filter(([, v]) => v > 0);
  const row: Record<string, number | string> = { name: "per unit" };
  entries.forEach(([k, v]) => (row[k] = v / 1000));
  const total = e.per_unit.carbon_g;

  return (
    <Section title="Where the carbon comes from (model, per unit)" right={<span className="text-xs muted">ACT · imec.netzero · 3D-Carbon</span>}>
      <div className="h-24">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[row]} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }} barSize={26}>
            <XAxis type="number" hide domain={[0, total / 1000]} />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip formatter={(v, n) => [`${Number(v).toFixed(2)} kg CO₂e`, BREAKDOWN_LABEL[String(n)] ?? n]} contentStyle={{ borderRadius: 8, fontSize: 12 }} cursor={false} />
            <Legend itemSorter={null} formatter={(v) => <span className="text-xs text-slate-600 dark:text-slate-300">{BREAKDOWN_LABEL[v] ?? v}</span>} iconType="circle" iconSize={8} />
            {entries.map(([k], i) => (
              <Bar key={k} dataKey={k} stackId="a" fill={SERIES[i % SERIES.length]} stroke="var(--viz-surface)" strokeWidth={2} radius={i === entries.length - 1 ? [0, 4, 4, 0] : i === 0 ? [4, 0, 0, 4] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {entries
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <tr key={k} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-1.5">{BREAKDOWN_LABEL[k] ?? k}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtCarbon(v)}</td>
                  <td className="w-16 py-1.5 text-right text-xs tabular-nums muted">{fmtPct(v / total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/50">
          <div className="muted">Model estimate (lot)</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">{fmtCarbon(total * p.units)}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/50">
          <div className="muted">Attested on-chain (lot)</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">{fmtCarbon(p.totalCarbonG)}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/50">
          <div className="muted">imec.netzero cross-check (silicon)</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">{e.cross_check.ratio ? `${e.cross_check.ratio.toFixed(2)}× imec` : "n/a"}</div>
        </div>
      </div>
    </Section>
  );
}

function Copilot({ pid }: { pid: number }) {
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState<{ role: "user" | "ai"; text: string; engine?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const suggestions = ["Why is this lot's footprint so high?", "Which supplier record needs attention and why?", "Can the buyer claim this lot as carbon neutral?"];

  async function ask(question: string) {
    if (!question.trim()) return;
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setQ("");
    setBusy(true);
    try {
      const r = await api.post<{ answer: string; engine: string }>("/copilot", { question, passport_id: pid });
      setMsgs((m) => [...m, { role: "ai", text: r.answer, engine: r.engine }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "ai", text: `Error: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Passport copilot" right={<Sparkles size={15} className="text-violet-500" />}>
      <div className="space-y-3">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} className="btn-ghost text-xs" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : ""}`}>
            <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>
              {m.text}
              {m.engine && <div className="mt-1 text-[10px] opacity-60">{m.engine === "offline" ? "offline summary (set ANTHROPIC_API_KEY for Claude)" : m.engine}</div>}
            </div>
          </div>
        ))}
        {busy && <div className="text-xs muted">Thinking…</div>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(q);
          }}
        >
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this passport…" maxLength={500} />
          <button className="btn-primary" disabled={busy || !q.trim()} aria-label="Send">
            <Send size={15} />
          </button>
        </form>
      </div>
    </Section>
  );
}

function UsePhasePanel({ p }: { p: Passport }) {
  const u = p.usePhase!;
  const proj = u.projection;
  const total = u.embodied_total_g + proj.operational_g;
  const embShare = total ? u.embodied_total_g / total : 0;
  const water = u.fab_water_l + proj.water_l;
  const fabShare = water ? u.fab_water_l / water : 0;
  return (
    <Section title="From fab to inference: full lifecycle" right={<Link to="/compute" className="text-xs text-brand-700 hover:underline dark:text-brand-400">AI Compute →</Link>}>
      <p className="mb-3 text-xs muted">
        {fmtNum(u.unitsDeployed)} accelerators from this lot run in {u.deployments.length} data centers. Projection: each runs its rated life ({fmtNum(u.deployments[0]?.lifetime ?? 0)} h) at its site's average grid and cooling.
      </p>
      {[
        { label: "Carbon", a: embShare, aLabel: `Embodied (this passport) ${fmtCarbon(u.embodied_total_g)}`, bLabel: `Operational, lifetime ${fmtCarbon(proj.operational_g)}` },
        { label: "Water", a: fabShare, aLabel: `Fab (modelled) ${fmtNum(u.fab_water_l / 1000)} m³`, bLabel: `Data centers, lifetime ${fmtNum(proj.water_l / 1000)} m³` },
      ].map((r) => (
        <div key={r.label} className="mb-3">
          <div className="mb-1 flex justify-between text-xs"><span className="font-medium">{r.label}</span><span className="muted">{(r.a * 100).toFixed(1)}% manufacturing · {((1 - r.a) * 100).toFixed(1)}% use</span></div>
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div style={{ width: `${Math.max(r.a * 100, 0.8)}%`, background: "var(--series-2)" }} />
            <div style={{ width: `${(1 - r.a) * 100}%`, background: "var(--series-1)", borderLeft: "2px solid var(--viz-surface)" }} />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] muted">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "var(--series-2)" }} />{r.aLabel}</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "var(--series-1)" }} />{r.bLabel}</span>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/50"><div className="muted">Certified so far</div><div className="font-semibold">{u.certificates} AI jobs</div><div className="muted">{fmtNum(u.centiHours / 100)} accel-h</div></div>
        <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/50"><div className="muted">Operational to date</div><div className="font-semibold">{fmtCarbon(u.operationalG)}</div></div>
        <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/50"><div className="muted">Embodied amortised</div><div className="font-semibold">{fmtCarbon(u.embodiedAllocatedG)}</div><div className="muted">of {fmtCarbon(u.embodied_total_g)}</div></div>
        <div className="rounded-lg bg-emerald-50 p-2.5 dark:bg-emerald-500/10"><div className="muted">Avoided by reuse</div><div className="font-semibold text-emerald-700 dark:text-emerald-400">{fmtCarbon(u.avoidedG)}</div></div>
      </div>
      <p className="mt-3 text-xs muted">
        Use-phase energy dominates over a chip's life, which is why scheduling, caching and reuse matter as much as cleaner fabs. On very clean grids (Stockholm, Hamina) the embodied share rises, which is why the passport matters there.
      </p>
    </Section>
  );
}
