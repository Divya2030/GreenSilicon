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


# Structured-output schema used for extraction. The API limits schema
# complexity (each nullable field adds a union), so every field is required
# and -1 / "none" mean "not stated"; to_disclosure() maps them back to None.
NUMERIC = ["units", "wafers_processed", "electricity_kwh", "renewable_share", "scope1_process_gas_kgco2e", "abatement_rate",
           "water_l", "die_yield", "distance_km", "shipment_mass_kg", "recovered_material_g"]


class ExtractedDisclosure(BaseModel):
    supplier_name: str
    facility: str
    stage: StageName
    reporting_period: str
    location: str = Field(description="Grid region: taiwan, south_korea, japan, usa, europe, singapore, india, australia, brazil, iceland or world")
    process_node: str = Field(description="e.g. '5nm', or 'none'")
    claimed_carbon_kgco2e: float = Field(description="Supplier's own total for this stage, kg CO2e")
    units: float = Field(description="-1 if not stated")
    wafers_processed: float = Field(description="-1 if not stated")
    electricity_kwh: float = Field(description="kWh; -1 if not stated")
    renewable_share: float = Field(description="0..1; -1 if not stated")
    scope1_process_gas_kgco2e: float = Field(description="kg CO2e after abatement; -1 if not stated")
    abatement_rate: float = Field(description="0..1; -1 if not stated")
    water_l: float = Field(description="litres; -1 if not stated")
    die_yield: float = Field(description="0..1; -1 if not stated")
    transport_mode: Literal["air", "sea", "road", "rail", "none"]
    distance_km: float = Field(description="-1 if not stated")
    shipment_mass_kg: float = Field(description="-1 if not stated")
    recovered_material_g: float = Field(description="-1 if not stated")
    certifications: list[str]
    evidence_quotes: list[str]
    missing_or_unclear: list[str]

    def to_disclosure(self) -> StageDisclosure:
        d = self.model_dump()
        for k in NUMERIC:
            d[k] = None if d[k] is None or d[k] < 0 else d[k]
        for k in ("units", "wafers_processed"):
            d[k] = int(d[k]) if d[k] is not None else None
        d["process_node"] = None if d["process_node"].strip().lower() in ("none", "", "n/a") else d["process_node"]
        d["transport_mode"] = None if d["transport_mode"] == "none" else d["transport_mode"]
        return StageDisclosure(**d)
