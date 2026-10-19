import { Link } from "react-router-dom";
import { Download, FileBarChart, Info } from "lucide-react";
import { useApi } from "../lib/hooks";
import { ErrorBox, Loading, PageHeader, Pill, Section, Stat } from "../components/ui";
import { fmtNum, fmtPct } from "../lib/format";

type Row = {
  passportId: number; product: string; lot: string; units: number; status: string; emissions_t: number; per_unit_kg: number;
  primary_verified_share: number; carbon_at_risk_t: number; conservative_t: number; offsets_retired_t: number; data_quality: string;
};
type Report = {
  organisation: string; category: string; method: string; rows: Row[]; notes: string[];
  totals: { emissions_t: number; conservative_t: number; carbon_at_risk_t: number; offsets_retired_t: number; primary_verified_share: number };
};

export default function Report() {
  const { data, error } = useApi<Report>("/report/scope3");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  return (
    <>
      <PageHeader
        title="Scope 3 report (buyer view)"
        subtitle={<>{data.category}. Reporting organisation: <b>{data.organisation}</b>. {data.method}.</>}
        actions={
          <a className="btn-primary" href="/api/report/scope3.csv">
            <Download size={15} /> Export CSV
          </a>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gross Scope 3 Cat. 1 emissions" value={`${t.emissions_t.toFixed(1)} t`} sub="CO₂e, cradle-to-gate, supplier-specific" icon={<FileBarChart size={16} />} />
        <Stat label="AI-verified primary data" value={fmtPct(t.primary_verified_share, 1)} sub="emissions-weighted, incl. components" tone="good" />
        <Stat label="Conservative total" value={`${t.conservative_t.toFixed(1)} t`} sub={`+${t.carbon_at_risk_t.toFixed(2)} t carbon at risk`} tone={t.carbon_at_risk_t > 0 ? "warn" : undefined} />
        <Stat label="Offsets retired (separate)" value={`${t.offsets_retired_t.toFixed(1)} t`} sub="not netted from gross emissions" />
      </div>

      <Section title="Purchased lots" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-xs muted">
                <th className="pb-2 font-medium">Lot</th>
                <th className="px-3 pb-2 text-right font-medium">Units</th>
                <th className="px-3 pb-2 text-right font-medium">Emissions</th>
                <th className="px-3 pb-2 text-right font-medium">Per unit</th>
                <th className="px-3 pb-2 text-right font-medium">Verified data</th>
                <th className="px-3 pb-2 text-right font-medium">At risk</th>
                <th className="px-3 pb-2 text-right font-medium">Offsets</th>
                <th className="px-3 pb-2 font-medium">Data quality</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.passportId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2.5">
                    <Link to={`/passport/${r.passportId}`} className="font-medium hover:text-brand-700">#{r.passportId} {r.product}</Link>
                    <div className="font-mono text-xs muted">{r.lot}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(r.units)}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">{r.emissions_t.toFixed(2)} t</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.per_unit_kg.toFixed(1)} kg</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtPct(r.primary_verified_share, 1)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${r.carbon_at_risk_t > 0 ? "text-red-700 dark:text-red-400" : ""}`}>{r.carbon_at_risk_t.toFixed(2)} t</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.offsets_retired_t.toFixed(1)} t</td>
                  <td className="px-3 py-2.5">
                    <Pill tone={r.data_quality === "High" ? "brand" : r.data_quality === "Medium" ? "amber" : "red"}>{r.data_quality}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-4 space-y-1.5 text-xs muted">
          {data.notes.map((n) => (
            <li key={n} className="flex gap-1.5"><Info size={13} className="mt-px shrink-0" /> {n}</li>
          ))}
        </ul>
      </Section>
    </>
  );
}
