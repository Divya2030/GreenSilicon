from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

StageName = Literal["Design", "WaferFab", "Assembly", "Test", "Logistics", "EndOfLife"]


class StageDisclosure(BaseModel):
    """What a supplier discloses for one lifecycle stage of a production lot."""

    supplier_name: str = Field(description="Legal or trading name of the reporting supplier")
    facility: str = Field(description="Facility identifier or name, e.g. 'Fab 7, Hsinchu'")
    stage: StageName
    reporting_period: str = Field(description="Period or lot date range covered, e.g. '2026-Q3' or 'lot 24-118'")
    location: str = Field(description="Grid region of the facility: one of taiwan, south_korea, japan, usa, europe, singapore, india, australia, brazil, iceland, world")
    process_node: Optional[str] = Field(None, description="e.g. '5nm' (fab stages only)")
    units: Optional[int] = Field(None, description="Good units/dies covered by this disclosure")
    wafers_processed: Optional[int] = None
    electricity_kwh: Optional[float] = Field(None, description="Electricity attributed to this lot, kWh")
    renewable_share: Optional[float] = Field(None, description="Share of electricity from contracted renewables, 0..1")
    scope1_process_gas_kgco2e: Optional[float] = Field(None, description="Direct fluorinated-gas / N2O emissions after abatement, kg CO2e")
    abatement_rate: Optional[float] = Field(None, description="Point-of-use abatement destruction efficiency, 0..1")
    water_l: Optional[float] = Field(None, description="Total water withdrawn for this lot, litres")
    die_yield: Optional[float] = Field(None, description="Reported die yield, 0..1")
    claimed_carbon_kgco2e: float = Field(description="Total cradle-to-gate CO2e the supplier attributes to this stage of the lot, kg")
    transport_mode: Optional[Literal["air", "sea", "road", "rail"]] = None
    distance_km: Optional[float] = None
    shipment_mass_kg: Optional[float] = None
    recovered_material_g: Optional[float] = Field(None, description="End-of-life: mass of recovered metals, grams")
    certifications: list[str] = Field(default_factory=list, description="Certificates or standards cited (ISO 14064, I-REC, GO, RBA, ISO 14001 ...)")
    evidence_quotes: list[str] = Field(default_factory=list, description="Short verbatim quotes from the document that support the figures")
    missing_or_unclear: list[str] = Field(default_factory=list, description="Fields the document does not state or states ambiguously")


class AuditFinding(BaseModel):
    severity: Literal["info", "warning", "critical"]
    title: str
    detail: str


class ClaudeAudit(BaseModel):
    verdict: Literal["Verified", "Flagged", "Rejected"]
    confidence: float = Field(description="0..1")
    summary: str = Field(description="2-3 sentence plain-language conclusion for a sustainability analyst")
    findings: list[AuditFinding]
    recommended_actions: list[str]


class CopilotAnswer(BaseModel):
    answer: str
    cited_fields: list[str] = Field(default_factory=list)
