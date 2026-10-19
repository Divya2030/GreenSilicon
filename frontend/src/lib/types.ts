export type Verdict = "Pending" | "Verified" | "Flagged" | "Rejected";

export interface Finding {
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
}

export interface Audit {
  engine: string;
  model: string | null;
  score: number;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  recommended_actions: string[];
  rules: { expected_g: number | null; expected_basis: string; claimed_g: number; ratio: number | null; energy_floor_g: number | null; anomaly: number; score: number; verdict: Verdict };
  report_hash?: string;
  tx?: string;
  confidence?: number;
  claude_verdict?: Verdict;
  ai_error?: string;
}

export interface Disclosure {
  supplier_name: string;
  facility: string;
  stage: string;
  reporting_period: string;
  location: string;
  process_node?: string | null;
  units?: number | null;
  wafers_processed?: number | null;
  electricity_kwh?: number | null;
  renewable_share?: number | null;
  scope1_process_gas_kgco2e?: number | null;
  abatement_rate?: number | null;
  water_l?: number | null;
  die_yield?: number | null;
  claimed_carbon_kgco2e: number;
  transport_mode?: string | null;
  distance_km?: number | null;
  shipment_mass_kg?: number | null;
  recovered_material_g?: number | null;
  certifications: string[];
  evidence_quotes: string[];
  missing_or_unclear: string[];
}

export interface StageRec {
  index: number;
  stage: string;
  attester: string;
  timestamp: number;
  fieldsRoot: string;
  evidenceHash: string;
  carbonG: number;
  energyWh: number;
  waterL: number;
  facility: string;
  verdict: Verdict;
  aiScore: number;
  aiReportHash: string;
  disclosure: Disclosure | null;
  audit: Audit | null;
  tx: string | null;
  signature: string | null;
  actor: string | null;
  integrity: boolean | null;
  evidence_file: boolean | null;
  disclosable_fields: string[];
}

export interface Component {
  childId: number;
  units: number;
  carbonG: number;
  product?: string;
  node?: string;
  lot_code?: string;
  child_units?: number;
  verifiedShareBps?: number;
  carbonAtRiskG?: number;
  components?: Component[];
}

export interface Recommendation {
  lever: string;
  category: string;
  carbon_g: number;
  saving_g: number;
  saving_pct: number;
}

export interface Estimate {
  product: string;
  units: number;
  per_unit: { carbon_g: number; energy_kwh: number; water_l: number; breakdown_g: Record<string, number> };
  per_lot: { carbon_kg: number; energy_mwh: number; water_m3: number };
  dies: { name: string; node: string; area_mm2: number; count: number; dies_per_wafer: number; yield: number; good_dies_per_wafer: number; grid_gco2_per_kwh: number; carbon_g: Record<string, number>; imec_reference_g: number; act_simple_g: number }[];
  cross_check: { imec_silicon_g: number; model_silicon_g: number; ratio: number | null };
  hotspots: { source: string; g: number; share: number }[];
}

export interface Retirement {
  retirementId: number;
  batchId: number;
  passportId: number;
  amountKg: number;
  retiree: string;
  beneficiary: string;
  timestamp: number;
}

export interface Passport {
  id: number;
  product: string;
  processNode: string;
  units: number;
  unitsAllocated: number;
  unitsRecycled: number;
  status: "Active" | "Integrated" | "Recycled";
  owner: string;
  designCommitment: string;
  metadataURI: string;
  createdAt: number;
  ownCarbonG: number;
  inheritedCarbonG: number;
  totalCarbonG: number;
  energyWh: number;
  waterL: number;
  offsetG: number;
  netCarbonG: number;
  perUnitG: number;
  carbonAtRiskG: number;
  verifiedShareBps: number;
  lot_code: string;
  kind: string;
  design: unknown;
  estimate: Estimate | null;
  estimateCarbonG: number | null;
  created_tx: string;
  stages: StageRec[];
  components: Component[];
  retirements: Retirement[];
  recommendations: Recommendation[];
  usePhase: UsePhase | null;
  contract: string;
  chainId: number;
}

export interface PassportSummary {
  id: number;
  product: string;
  processNode: string;
  units: number;
  status: string;
  lot_code: string;
  kind: string;
  totalCarbonG: number;
  offsetG: number;
  waterL: number;
  energyWh: number;
  verifiedShareBps: number;
  stageCount: number;
  lastStage: string | null;
  flags: number;
  unitsAllocated: number;
  createdAt: number;
}

export interface Actor {
  name: string;
  address: string;
  index: number;
  roles: string[];
}

export interface AppConfig {
  chainId: number;
  network: string;
  rpcUrl: string;
  contracts: Record<string, string>;
  actors: Record<string, Actor>;
  ai: { enabled: boolean; model: string | null };
}

export interface Stats {
  passports: number;
  stage_records: number;
  total_carbon_t: number;
  total_offset_t: number;
  total_water_m3: number;
  total_energy_mwh: number;
  verdicts: Record<Verdict, number>;
  circ_supply: number;
  credit_batches: number;
}

export interface ActivityItem {
  event: string;
  block: number;
  tx: string;
  timestamp: number;
  args: Record<string, string | number>;
}

export interface UsePhase {
  unitsDeployed: number;
  centiHours: number;
  embodiedAllocatedG: number;
  operationalG: number;
  waterL: number;
  energyWh: number;
  certificates: number;
  avoidedG: number;
  embodied_total_g: number;
  fab_water_l: number;
  deployments: { passportId: number; code: string; units: number; lifetime: number }[];
  projection: { operational_g: number; water_l: number; embodied_share: number | null };
}
