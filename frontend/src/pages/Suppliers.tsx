import { Building2, Radio, ShieldCheck } from "lucide-react";
import { useApi } from "../lib/hooks";
import { ErrorBox, Hash, Loading, Meter, PageHeader, Pill } from "../components/ui";

type Supplier = { key: string; name: string; address: string; roles: string[]; records: number; meters: number; verified: number; flagged: number; rejected: number; scoreBps: number };

const ROLE: Record<string, string> = { DESIGNER_ROLE: "Designer", FAB_ROLE: "Wafer fab", OSAT_ROLE: "Assembly & test", LOGISTICS_ROLE: "Logistics", RECYCLER_ROLE: "Recycler" };

export default function Suppliers() {
  const { data, error } = useApi<Supplier[]>("/suppliers");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="Supplier trust"
        subtitle="Each supplier's reputation is computed on-chain from the AI auditor's verdict history (supplierTrust): Verified counts 100 %, Flagged 40 %, Rejected 0 %, with a neutral prior so one good record can't buy a perfect score. Buyers can use it to prioritise supplier engagement and procurement."
      />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-800">
              <th className="px-5 py-3 font-medium">Supplier</th>
              <th className="px-3 py-3 font-medium">Role</th>
              <th className="px-3 py-3 text-right font-medium">Records</th>
              <th className="px-3 py-3 font-medium">Verdicts</th>
              <th className="px-3 py-3 font-medium">IoT meters</th>
              <th className="w-56 px-5 py-3 font-medium">Trust score (on-chain)</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => {
              const score = s.scoreBps / 100;
              return (
                <tr key={s.key} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2 font-medium">
                      <Building2 size={15} className="text-slate-400" /> {s.name}
                    </div>
                    <div className="mt-0.5 pl-6"><Hash value={s.address} n={4} /></div>
                  </td>
                  <td className="px-3 py-3">{s.roles.map((r) => <Pill key={r} tone="blue">{ROLE[r] ?? r}</Pill>)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.records}</td>
                  <td className="px-3 py-3 text-xs">
                    <span className="text-emerald-700 dark:text-emerald-400">{s.verified} verified</span>
                    {s.flagged > 0 && <span className="text-amber-700 dark:text-amber-400"> · {s.flagged} flagged</span>}
                    {s.rejected > 0 && <span className="text-red-700 dark:text-red-400"> · {s.rejected} rejected</span>}
                  </td>
                  <td className="px-3 py-3 text-xs">{s.meters ? <span className="inline-flex items-center gap-1"><Radio size={12} className="text-brand-600" /> {s.meters} signed meters</span> : <span className="muted">none</span>}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Meter value={score / 100} tone={score >= 65 ? "brand" : score >= 45 ? "amber" : "red"} />
                      <span className="w-12 text-right font-semibold tabular-nums">{score.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs muted">
        <ShieldCheck size={13} /> Scores update automatically whenever the AI-auditor oracle posts or revises a verdict; no off-chain database can edit them.
      </p>
    </>
  );
}
