import { Link } from "react-router-dom";
import { CheckCircle2, Star } from "lucide-react";

// IEEE ClimateChain 2026 tracks: challenge + the "Build" items GreenSilicon delivers.
export const TRACKS = [
  {
    name: "Sustainable Supply Chains",
    primary: true,
    challenge: "Increase transparency and accountability in supply chains: ethical sourcing and sustainability claims are hard to verify.",
    builds: [
      ["Product lifecycle tracking", "Lot passports from design → fab → assembly → logistics → data center → recycling", "/passport/4"],
      ["Digital product passports", "ERC-721 per production lot, chiplet → package composition, W3C VC export", "/passports"],
      ["Recycling traceability", "End-of-life records with recovered-material evidence", "/passport/5"],
      ["Circular economy incentives", "CIRC tokens per kg recovered; compute reuse credited on-chain", "/compute"],
    ],
  },
  {
    name: "Carbon Markets & Emissions Transparency",
    challenge: "Improve trust and transparency in carbon markets: double counting and complex verification reduce credibility.",
    builds: [
      ["Blockchain-based carbon credit verification", "Registry serials tokenised once; retirements bound to a chip lot", "/credits"],
      ["Smart contracts to prevent double counting", "Unit-capped carbon allocation, burn-on-retire, offsets ≤ footprint", "/credits"],
      ["Real-time emissions tracking", "Per-stage attestations and per-AI-job Green Compute Certificates", "/compute"],
    ],
  },
  {
    name: "Renewable Energy & Energy Trading",
    challenge: "Make renewable claims trustworthy and energy use efficient.",
    builds: [
      ["Renewable certificate tracking", "Renewable claims count only with I-REC / GO / PPA evidence", "/submit"],
      ["Clean-energy-aware operations", "Scheduler moves AI jobs to the cleanest grids and hours", "/compute"],
    ],
  },
  {
    name: "Climate Data & Environmental Monitoring",
    challenge: "Environmental data is fragmented and difficult to verify.",
    builds: [
      ["IoT environmental monitoring", "Device-signed fab meters (power, abatement, water) anchored on-chain", "/telemetry"],
      ["Climate data verification platform", "Hybrid AI auditor, public trustless verifier, selective disclosure", "/verify"],
      ["Tools for research and insights", "Design Lab, Scope 3 report, cooling and inference analyses", "/design"],
    ],
  },
];

export default function Tracks() {
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <h2 className="h-section">IEEE ClimateChain 2026 · track alignment</h2>
        <span className="text-xs muted">Primary track for judging + challenges also addressed</span>
      </div>
      <div className="grid gap-3 p-5 md:grid-cols-2">
        {TRACKS.map((t) => (
          <div key={t.name} className={`rounded-lg border p-4 ${t.primary ? "border-brand-500 bg-brand-50/60 dark:bg-brand-500/10" : "border-slate-200 dark:border-slate-800"}`}>
            <div className="flex flex-wrap items-center gap-2">
              {t.primary ? <Star size={15} className="text-brand-600" /> : <CheckCircle2 size={15} className="text-slate-400" />}
              <span className="text-sm font-semibold">{t.name}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${t.primary ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
                {t.primary ? "Primary track" : "Also addresses"}
              </span>
            </div>
            <p className="mt-1.5 text-xs muted">Challenge: {t.challenge}</p>
            <ul className="mt-2 space-y-1">
              {t.builds.map(([b, how, to]) => (
                <li key={b} className="text-xs">
                  <Link to={to} className="font-medium text-slate-800 hover:text-brand-700 dark:text-slate-200">{b}</Link>
                  <span className="muted"> · {how}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
