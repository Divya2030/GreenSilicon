"""Deterministic extractor used when Claude is not configured (offline demo).
Understands 'Label: value unit' style supplier reports."""
from __future__ import annotations

import io
import re

from pypdf import PdfReader

from .schemas import StageDisclosure

LOCATIONS = {
    "taiwan": "taiwan", "hsinchu": "taiwan", "tainan": "taiwan", "korea": "south_korea", "japan": "japan",
    "usa": "usa", "united states": "usa", "arizona": "usa", "texas": "usa", "oregon": "usa", "new york": "usa",
    "germany": "europe", "netherlands": "europe", "ireland": "europe", "france": "europe", "europe": "europe", "dresden": "europe",
    "singapore": "singapore", "india": "india", "malaysia": "world", "penang": "world", "vietnam": "world", "china": "world",
}


RELEVANT = {
    "WaferFab": ("electricity", "renewable", "process gas", "abatement", "water", "yield", "units"),
    "Assembly": ("electricity", "units"),
    "Test": ("electricity", "units"),
    "Logistics": ("distance", "shipment mass"),
    "EndOfLife": ("recovered", "units"),
    "Design": ("electricity",),
}


def to_text(doc: bytes, filename: str) -> str:
    if filename.lower().endswith(".pdf"):
        return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(doc)).pages)
    return doc.decode("utf-8", errors="replace")


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _find(text: str, label: str) -> tuple[float, str] | None:
    m = re.search(rf"^\s*(?:{label})[^\n:]*:\s*(?P<num>[\d,]+(?:\.\d+)?)\s*(?P<unit>[A-Za-z%³0-9/ ]*)", text, re.I | re.M)
    return (_num(m.group("num")), m.group("unit").strip().lower()) if m else None


def _line(text: str, label: str) -> str | None:
    m = re.search(rf"^\s*(?:{label})[^\n:]*:\s*(?P<v>.+)", text, re.I | re.M)
    return m.group("v").strip() if m else None


def _scale(v: float, unit: str, table: dict[str, float]) -> float:
    for k, f in table.items():
        if unit.startswith(k):
            return v * f
    return v


def extract(doc: bytes, filename: str, stage_hint: str | None = None) -> StageDisclosure:
    t = to_text(doc, filename)
    missing = []

    def field(label, table=None, pct=False):
        r = _find(t, label)
        if not r:
            missing.append(label.split("|")[0].strip("()").strip())
            return None
        v, unit = r
        if pct or unit.startswith("%"):
            return v / 100 if v > 1 else v
        return _scale(v, unit, table or {})

    stage = stage_hint or "WaferFab"
    st = (_line(t, "stage") or "").lower().replace(" ", "")
    for s in ("design", "waferfab", "assembly", "test", "logistics", "endoflife"):
        if s in st:
            stage = {"waferfab": "WaferFab", "endoflife": "EndOfLife"}.get(s, s.title())

    loc_text = (_line(t, "(location|country|site)") or "").lower()
    location = next((v for k, v in LOCATIONS.items() if k in loc_text), "world")
    kg = {"t": 1000, "tonne": 1000, "kg": 1, "g": 0.001}
    mode = (_line(t, "transport mode|mode") or "").lower()
    certs = _line(t, "certification|certificates|standards") or ""
    units = field("(units|good dies|quantity)")

    return StageDisclosure(
        supplier_name=_line(t, "supplier") or "Unknown supplier",
        facility=_line(t, "facility") or "Unknown facility",
        stage=stage,
        reporting_period=_line(t, "(reporting period|period|lot)") or "unspecified",
        location=location,
        process_node=(re.search(r"(\d+)\s?nm", t).group(1) + "nm") if re.search(r"(\d+)\s?nm", t) else None,
        units=int(units) if units else None,
        wafers_processed=int(field("wafers") or 0) or None,
        electricity_kwh=field("electricity", {"mwh": 1000, "gwh": 1e6, "kwh": 1}),
        renewable_share=field("renewable", pct=True),
        scope1_process_gas_kgco2e=field("(process gas|scope 1|fluorinated)", kg),
        abatement_rate=field("abatement", pct=True),
        water_l=field("water", {"m3": 1000, "m³": 1000, "ml": 1e6, "l": 1}),
        die_yield=field("(die yield|yield)", pct=True),
        claimed_carbon_kgco2e=field("(total|claimed|product carbon footprint)", kg) or 0.0,
        transport_mode=next((m for m in ("air", "sea", "road", "rail") if m in mode), None),
        distance_km=field("distance"),
        shipment_mass_kg=field("(shipment mass|mass|weight)", {"t": 1000, "kg": 1}),
        recovered_material_g=field("recovered", {"kg": 1000, "g": 1, "t": 1e6}),
        certifications=[c.strip() for c in re.split(r"[;,]", certs) if c.strip()],
        evidence_quotes=[],
        missing_or_unclear=[m for m in missing if m in RELEVANT.get(stage, ())][:8],
    )
