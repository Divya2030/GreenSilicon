export const kg = (g: number) => g / 1000;

export function fmtCarbon(g: number | null | undefined, digits = 1): string {
  if (g == null || Number.isNaN(g)) return "—";
  const a = Math.abs(g);
  if (a >= 1e9) return `${(g / 1e9).toFixed(digits)} kt`;
  if (a >= 1e6) return `${(g / 1e6).toFixed(digits)} t`;
  if (a >= 1e3) return `${(g / 1e3).toFixed(a >= 1e5 ? 0 : digits)} kg`;
  return `${g.toFixed(0)} g`;
}

export const fmtNum = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });

export const fmtPct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

export const short = (h?: string | null, n = 6) => (!h ? "—" : h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`);

export const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const STAGE_LABEL: Record<string, string> = {
  Design: "Design",
  WaferFab: "Wafer fab",
  Assembly: "Assembly",
  Test: "Test",
  Logistics: "Logistics",
  EndOfLife: "End of life",
};

export const LOCATION_LABEL: Record<string, string> = {
  taiwan: "Taiwan",
  south_korea: "South Korea",
  japan: "Japan",
  usa: "USA",
  europe: "Europe",
  singapore: "Singapore",
  india: "India",
  australia: "Australia",
  brazil: "Brazil",
  iceland: "Iceland",
  world: "World avg.",
};

export const BREAKDOWN_LABEL: Record<string, string> = {
  fab_electricity: "Fab electricity",
  process_gases: "Process gases (PFC/NF₃)",
  materials: "Materials",
  memory: "HBM / DRAM",
  interposer: "Interposer",
  packaging_and_bonding: "Packaging & bonding",
  assembly_yield_loss: "Assembly yield loss",
};
