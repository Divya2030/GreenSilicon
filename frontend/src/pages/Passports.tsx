import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useApi } from "../lib/hooks";
import type { PassportSummary } from "../lib/types";
import { ErrorBox, Loading, Meter, PageHeader, Pill } from "../components/ui";
import { STAGE_LABEL, fmtCarbon, fmtNum } from "../lib/format";

const KIND_TONE: Record<string, "brand" | "blue" | "amber" | "slate"> = { product: "brand", chiplet: "blue", memory: "amber" };

export default function Passports() {
  const { data, error } = useApi<PassportSummary[]>("/passports");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="Passports"
        subtitle="One ERC-721 passport per production lot. Chiplet and memory lots are integrated into product lots, carrying their carbon with them exactly once."
        actions={
          <Link to="/design" className="btn-primary">
            Mint a new passport
          </Link>
        }
      />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-800">
              <th className="px-5 py-3 font-medium">Lot</th>
              <th className="px-3 py-3 font-medium">Node</th>
              <th className="px-3 py-3 text-right font-medium">Units</th>
              <th className="px-3 py-3 text-right font-medium">Footprint</th>
              <th className="px-3 py-3 text-right font-medium">Per unit</th>
              <th className="px-3 py-3 font-medium">Lifecycle</th>
              <th className="w-40 px-3 py-3 font-medium">AI-verified</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
                <td className="px-5 py-3">
                  <Link to={`/passport/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700 dark:text-white">
                    #{p.id} {p.product}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-xs muted">
                    <span className="font-mono">{p.lot_code}</span>
                    <Pill tone={KIND_TONE[p.kind] ?? "slate"}>{p.kind}</Pill>
                  </div>
                </td>
                <td className="px-3 py-3">{p.processNode}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtNum(p.units)}</td>
                <td className="px-3 py-3 text-right font-medium tabular-nums">{fmtCarbon(p.totalCarbonG)}</td>
                <td className="px-3 py-3 text-right tabular-nums muted">{fmtCarbon(p.totalCarbonG / p.units)}</td>
                <td className="px-3 py-3">
                  <span className="text-xs">{p.stageCount} records</span>
                  {p.lastStage && <div className="text-xs muted">last: {STAGE_LABEL[p.lastStage]}</div>}
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <Meter value={p.verifiedShareBps / 10000} tone={p.flags ? "amber" : "brand"} />
                    <span className="w-10 text-right text-xs tabular-nums">{Math.round(p.verifiedShareBps / 100)}%</span>
                  </div>
                  {p.flags > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={12} /> {p.flags} need review
                    </div>
                  )}
                </td>
                <td className="px-3 py-3">
                  <Pill tone={p.status === "Active" ? "brand" : p.status === "Recycled" ? "amber" : "blue"}>{p.status}</Pill>
                </td>
                <td className="pr-4">
                  <Link to={`/passport/${p.id}`} aria-label="Open">
                    <ChevronRight size={16} className="text-slate-400" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
