import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowRight, BrainCircuit, Coins, Droplets, FileSignature, Factory, Leaf, Recycle, ShieldCheck } from "lucide-react";
import { useApi } from "../lib/hooks";
import type { ActivityItem, PassportSummary, Stats } from "../lib/types";
import { ErrorBox, Hash, Loading, PageHeader, Section, Stat, VerdictBadge } from "../components/ui";
import { STAGE_LABEL, fmtCarbon, fmtNum } from "../lib/format";
import { actorName, useConfig } from "../lib/context";
import Tracks from "../components/Tracks";

const EVENT_TEXT: Record<string, (a: Record<string, string | number>) => string> = {
  PassportCreated: (a) => `Passport #${a.id} minted · ${a.product} (${a.processNode}, ${fmtNum(Number(a.units))} units)`,
  StageRecorded: (a) => `${STAGE_LABEL[a.stage as string] ?? a.stage} attested on #${a.id} · ${fmtCarbon(Number(a.carbonG))}`,
  AIVerdict: (a) => `AI auditor: #${a.id} record ${a.index} → ${a.verdict} (${(Number(a.score) / 100).toFixed(0)})`,
  ComponentIntegrated: (a) => `#${a.childId} integrated into #${a.parentId} · ${fmtNum(Number(a.units))} units, ${fmtCarbon(Number(a.carbonG))}`,
  OffsetApplied: (a) => `${fmtCarbon(Number(a.grams))} offset applied to #${a.id}`,
  Recycled: (a) => `#${a.id}: ${fmtNum(Number(a.units))} units recycled · ${fmtNum(Number(a.recoveredG))} g recovered`,
  BatchIssued: (a) => `Credit batch ${a.batchId} tokenised · ${fmtNum(Number(a.amountKg))} kg (${a.registrySerial})`,
  CreditsRetired: (a) => `${fmtNum(Number(a.amountKg))} kg credits retired for #${a.passportId}`,
};

export default function Overview() {
  const cfg = useConfig();
  const stats = useApi<Stats>("/stats");
  const lots = useApi<PassportSummary[]>("/passports");
  const act = useApi<ActivityItem[]>("/activity?limit=14");

  if (stats.error) return <ErrorBox error={stats.error} />;
  if (!stats.data || !lots.data) return <Loading />;
  const s = stats.data;
  const totalRecords = s.stage_records || 1;

  const chart = lots.data.map((p) => ({
    name: `#${p.id} ${p.product}`,
    total: p.totalCarbonG / 1e6,
  }));

  return (
    <>
      <PageHeader
        title="Every chip carries its climate story"
        subtitle={
          <>
            GreenSilicon gives each semiconductor production lot a tamper-proof digital product passport. Suppliers sign their carbon, water and energy disclosures,
            an AI auditor checks them against physics-based models, and offsets and recycling are settled on-chain so nothing is counted twice.
          </>
        }
        actions={
          <>
            <Link to="/design" className="btn-ghost">
              Estimate a chip
            </Link>
            <Link to="/passport/4" className="btn-primary">
              Explore a passport <ArrowRight size={15} />
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Passports (production lots)" value={s.passports} sub={`${s.stage_records} signed stage records`} icon={<FileSignature size={16} />} />
        <Stat label="Embodied carbon tracked" value={`${s.total_carbon_t.toFixed(1)} t`} sub="CO₂e, each lot counted once" icon={<Factory size={16} />} />
        <Stat label="Offsets retired on-chain" value={`${s.total_offset_t.toFixed(1)} t`} sub={`${s.credit_batches} tokenised credit batches`} icon={<Leaf size={16} />} tone="good" />
        <Stat
          label="AI-verified records"
          value={`${Math.round((s.verdicts.Verified / totalRecords) * 100)}%`}
          sub={`${s.verdicts.Flagged} flagged · ${s.verdicts.Rejected} rejected`}
          icon={<ShieldCheck size={16} />}
          tone={s.verdicts.Rejected ? "warn" : "good"}
        />
        <Stat label="Fab water disclosed" value={`${fmtNum(s.total_water_m3)} m³`} sub={`${fmtNum(s.total_energy_mwh, 1)} MWh electricity`} icon={<Droplets size={16} />} />
        <Stat label="Circularity credits" value={`${s.circ_supply.toFixed(2)} CIRC`} sub="1 CIRC = 1 kg recovered metal" icon={<Recycle size={16} />} />
      </div>

      <div className="mt-5">
        <Tracks />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Section title="Embodied carbon by production lot" className="lg:col-span-2" right={<span className="text-xs muted">t CO₂e, incl. integrated components</span>}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 24 }} barCategoryGap={10}>
                <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
                <XAxis type="number" tick={{ fill: "var(--viz-axis)", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={190} tick={{ fill: "var(--viz-axis)", fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: "var(--viz-grid)", opacity: 0.4 }}
                  formatter={(v) => [`${Number(v).toFixed(2)} t CO₂e`, "Footprint"]}
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                />
                <Bar dataKey="total" name="Lot footprint" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="AI audit outcomes" right={<BrainCircuit size={16} className="text-violet-500" />}>
          <div className="space-y-3">
            {(["Verified", "Flagged", "Rejected", "Pending"] as const).map((v) => (
              <div key={v} className="flex items-center gap-3">
                <div className="w-24">
                  <VerdictBadge v={v} />
                </div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(s.verdicts[v] / totalRecords) * 100}%`,
                      background: { Verified: "var(--status-good)", Flagged: "var(--status-warning)", Rejected: "var(--status-critical)", Pending: "var(--viz-axis)" }[v],
                    }}
                  />
                </div>
                <span className="w-6 text-right text-sm tabular-nums">{s.verdicts[v]}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed muted">
            Each supplier record is scored by a physics model (ACT + imec.netzero), an IsolationForest anomaly detector and Claude. The verdict is written on-chain by the
            AI-auditor oracle; a language model can add scrutiny but never overrule a physics violation.
          </p>
        </Section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-5">
        <Section title="How a chip earns its passport" className="lg:col-span-3">
          <ol className="grid gap-3 sm:grid-cols-2">
            {[
              { icon: Factory, t: "1 · Design estimate", d: "Designers mint a lot passport with an ACT-based embodied-carbon estimate committed on-chain (design hash)." },
              { icon: FileSignature, t: "2 · Supplier attestations", d: "Fabs, OSATs and carriers sign EIP-712 disclosures; only a salted Merkle root and totals go on-chain." },
              { icon: BrainCircuit, t: "3 · AI audit", d: "Claude extracts figures from PDFs; physics, device-signed IoT meter data, ML and LLM verdicts flag greenwashing before it reaches a buyer's Scope 3." },
              { icon: Coins, t: "4 · Settle & circulate", d: "Chiplet carbon rolls up without double counting, credits are retired against lots, recyclers earn CIRC." },
            ].map(({ icon: Icon, t, d }) => (
              <li key={t} className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Icon size={16} className="text-brand-600" /> {t}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed muted">{d}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Live on-chain activity" className="lg:col-span-2" right={<Activity size={15} className="text-slate-400" />}>
          {!act.data ? (
            <Loading />
          ) : (
            <ul className="max-h-80 space-y-2.5 overflow-auto pr-1">
              {act.data.map((e, i) => (
                <li key={`${e.tx}-${i}`} className="flex gap-2.5 text-xs">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                  <div className="min-w-0">
                    <div className="text-slate-700 dark:text-slate-300">{EVENT_TEXT[e.event]?.(e.args) ?? e.event}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 muted">
                      <span>block {e.block}</span>
                      <Hash value={e.tx} n={4} />
                      {e.args.attester && <span className="truncate">{actorName(cfg, String(e.args.attester))}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
