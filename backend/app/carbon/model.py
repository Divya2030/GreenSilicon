"""Embodied-carbon model for semiconductor products.

Implements the ACT methodology (Gupta et al., ISCA 2022) for logic dies,
extended with:
  * wafer-edge loss (dies-per-wafer geometry) instead of area/yield only,
  * negative-binomial yield with per-node defect densities (3D-Carbon),
  * 2.5D/3D packaging: interposer, bonding energy and bonding yield (3D-Carbon),
  * HBM/DRAM memory per GB (ACT),
  * fab renewable-energy share and gas-abatement level,
  * water footprint (ITRS / imec trend),
  * an independent cross-check against imec.netzero carbon-per-area.

All outputs are grams CO2e, kWh and litres. See reference_data.yaml for sources.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

DATA_PATH = Path(__file__).with_name("reference_data.yaml")

Node = Literal["28nm", "20nm", "14nm", "10nm", "7nm", "5nm", "3nm"]
RETICLE_LIMIT_MM2 = 858.0


@lru_cache
def ref() -> dict:
    with DATA_PATH.open() as f:
        return yaml.safe_load(f)


# --------------------------------------------------------------------- inputs


class DieSpec(BaseModel):
    name: str = "compute die"
    node: Node = "5nm"
    area_mm2: float = Field(100.0, gt=0, le=RETICLE_LIMIT_MM2)
    count: int = Field(1, ge=1, le=64, description="dies of this type per package")
    fab_location: str = "taiwan"
    renewable_share: float = Field(0.0, ge=0, le=1)
    renewable_source: str = "solar"
    abatement: Literal["95", "99"] = "99"


class MemorySpec(BaseModel):
    kind: Literal["hbm3", "ddr4_10nm", "lpddr4"] = "hbm3"
    capacity_gb: float = Field(16, gt=0)
    stacks: int = Field(1, ge=1)


class PackageSpec(BaseModel):
    type: Literal["FCBGA", "WLCSP", "TSSOP"] = "FCBGA"
    area_mm2: float = Field(1600.0, gt=0)
    integration: Literal["monolithic", "2.5d", "3d"] = "monolithic"
    interposer_area_mm2: float = Field(0.0, ge=0)
    interposer_type: Literal["silicon", "rdl"] = "silicon"
    bonding: Literal["microbump", "hybrid", "tsv"] = "microbump"
    assembly_location: str = "world"


class ChipDesign(BaseModel):
    product: str = "Untitled chip"
    dies: list[DieSpec] = Field(default_factory=lambda: [DieSpec()])
    memory: list[MemorySpec] = Field(default_factory=list)
    package: PackageSpec | None = Field(default_factory=PackageSpec, description="None for bare-die / component lots")
    units: int = Field(1000, ge=1)


# -------------------------------------------------------------------- physics


def dies_per_wafer(area_mm2: float, wafer_d_mm: float | None = None) -> int:
    """Classic gross-die estimate with edge loss: pi r^2 / A - pi d / sqrt(2A)."""
    d = wafer_d_mm or ref()["wafer_diameter_mm"]
    n = math.pi * (d / 2) ** 2 / area_mm2 - math.pi * d / math.sqrt(2 * area_mm2)
    return max(1, int(n))


def nb_yield(area_mm2: float, d0_per_mm2: float, alpha: float) -> float:
    """Negative-binomial die yield (Stapper)."""
    return (1 + area_mm2 * d0_per_mm2 / alpha) ** (-alpha)


def grid_intensity(location: str) -> float:
    grid = ref()["grid"]
    key = location.lower().replace(" ", "_")
    if key not in grid:
        raise ValueError(f"unknown location '{location}'. Known: {sorted(grid)}")
    return float(grid[key])


def effective_intensity(location: str, renewable_share: float = 0.0, source: str = "solar") -> float:
    clean = float(ref()["sources"].get(source, ref()["sources"]["solar"]))
    return grid_intensity(location) * (1 - renewable_share) + clean * renewable_share


def die_footprint(d: DieSpec) -> dict:
    p = ref()["nodes"][d.node]
    wafer_area_cm2 = math.pi * (ref()["wafer_diameter_mm"] / 2) ** 2 / 100
    dpw = dies_per_wafer(d.area_mm2)
    y = nb_yield(d.area_mm2, p["d0"], p["alpha"])
    good = max(dpw * y, 1e-9)
    ci = effective_intensity(d.fab_location, d.renewable_share, d.renewable_source)

    # Per-cm2 of processed wafer (ACT "CPA" components)
    elec_cpa = ci * p["epa"]
    gas_cpa = p["gpa99"] if d.abatement == "99" else p["gpa95"]
    mat_cpa = p["mpa"]
    per_good_die = wafer_area_cm2 / good  # cm2 of wafer consumed per good die

    electricity = elec_cpa * per_good_die
    gases = gas_cpa * per_good_die
    materials = mat_cpa * per_good_die
    total = electricity + gases + materials
    return {
        "name": d.name,
        "node": d.node,
        "area_mm2": d.area_mm2,
        "count": d.count,
        "fab_location": d.fab_location,
        "dies_per_wafer": dpw,
        "yield": round(y, 4),
        "good_dies_per_wafer": round(good, 1),
        "grid_gco2_per_kwh": round(ci, 1),
        "wafer_cm2_per_good_die": per_good_die,
        "energy_kwh": p["epa"] * per_good_die,
        "water_l": p["water"] * per_good_die,
        "carbon_g": {"electricity": electricity, "process_gases": gases, "materials": materials, "total": total},
        # ACT's original area/yield formulation, no edge loss
        "act_simple_g": (elec_cpa + gas_cpa + mat_cpa) * (d.area_mm2 / 100) / y,
        # Independent reference: imec.netzero carbon/area (its own fab assumptions)
        "imec_reference_g": p["imec_cpa"] * 1000 * per_good_die,
    }


def gas_per_cm2(node: str, efficiency: float) -> float:
    """Process-gas emissions (g CO2e/cm2) at a given abatement efficiency:
    linear interpolation/extrapolation of ACT's 95 % and 99 % data points,
    floored at the 99 % value (residual non-abatable emissions)."""
    p = ref()["nodes"][node]
    eff = min(efficiency, 0.99)
    return p["gpa99"] + (p["gpa95"] - p["gpa99"]) * (0.99 - eff) / 0.04


def package_footprint(pkg: PackageSpec, dies: list[DieSpec], fab_location: str) -> dict:
    R = ref()
    ci_asm = grid_intensity(pkg.assembly_location)
    pkg_kwh = R["packaging"][pkg.type] * pkg.area_mm2
    out = {"packaging_g": pkg_kwh * ci_asm, "energy_kwh": pkg_kwh, "interposer_g": 0.0, "bonding_g": 0.0, "water_l": 0.0, "assembly_yield": 1.0}

    n_bonded = sum(d.count for d in dies)
    if pkg.integration in ("2.5d", "3d") and n_bonded > 0:
        b = R["bonding"][pkg.bonding]
        die_area = sum(d.area_mm2 * d.count for d in dies)
        bond_kwh = b["epa"] * die_area
        out["bonding_g"] = bond_kwh * ci_asm
        out["energy_kwh"] += bond_kwh
        out["assembly_yield"] = b["yield"] ** n_bonded

    if pkg.integration == "2.5d" and pkg.interposer_area_mm2 > 0 and pkg.interposer_type == "rdl":
        # Organic RDL interposer: substrate energy per mm2 and RDL yield [3DC]
        y = nb_yield(pkg.interposer_area_mm2, *R["rdl"]["yield"])
        kwh = R["rdl"]["epa"] * pkg.interposer_area_mm2 / y
        out["interposer_g"] = kwh * ci_asm
        out["energy_kwh"] += kwh
    elif pkg.integration == "2.5d" and pkg.interposer_area_mm2 > 0:
        ip = R["interposer"]
        wafer_area_cm2 = math.pi * (R["wafer_diameter_mm"] / 2) ** 2 / 100
        dpw = dies_per_wafer(pkg.interposer_area_mm2)
        y = nb_yield(pkg.interposer_area_mm2, ip["d0"], ip["alpha"])
        per = wafer_area_cm2 / max(dpw * y, 1e-9)
        ci = grid_intensity(fab_location)
        out["interposer_g"] = (ci * ip["epa"] + ip["gpa99"] + ip["mpa"]) * per
        out["energy_kwh"] += ip["epa"] * per
        out["water_l"] += ip["water"] * per
    return out


def memory_footprint(m: MemorySpec) -> float:
    R = ref()
    g = R["dram"][m.kind] * m.capacity_gb
    if m.kind == "hbm3":
        g *= R["hbm_stack_overhead"]
    return g


def estimate(design: ChipDesign) -> dict:
    dies = [die_footprint(d) for d in design.dies]
    fab_loc = design.dies[0].fab_location if design.dies else "taiwan"
    pkg = (package_footprint(design.package, design.dies, fab_loc) if design.package else
           {"packaging_g": 0.0, "bonding_g": 0.0, "interposer_g": 0.0, "energy_kwh": 0.0, "water_l": 0.0, "assembly_yield": 1.0})
    mem_g = sum(memory_footprint(m) for m in design.memory)

    silicon_g = sum(d["carbon_g"]["total"] * d["count"] for d in dies)
    # Known-good dies lost at assembly scale the upstream footprint
    upstream = silicon_g + pkg["interposer_g"] + mem_g
    assembly_loss_g = upstream * (1 / pkg["assembly_yield"] - 1)
    per_unit = upstream + assembly_loss_g + pkg["packaging_g"] + pkg["bonding_g"]

    breakdown = {
        "fab_electricity": sum(d["carbon_g"]["electricity"] * d["count"] for d in dies),
        "process_gases": sum(d["carbon_g"]["process_gases"] * d["count"] for d in dies),
        "materials": sum(d["carbon_g"]["materials"] * d["count"] for d in dies),
        "memory": mem_g,
        "interposer": pkg["interposer_g"],
        "packaging_and_bonding": pkg["packaging_g"] + pkg["bonding_g"],
        "assembly_yield_loss": assembly_loss_g,
    }
    energy = sum(d["energy_kwh"] * d["count"] for d in dies) + pkg["energy_kwh"]
    water = sum(d["water_l"] * d["count"] for d in dies) + pkg["water_l"]
    imec_ref = sum(d["imec_reference_g"] * d["count"] for d in dies)

    return {
        "product": design.product,
        "units": design.units,
        "per_unit": {
            "carbon_g": per_unit,
            "energy_kwh": energy,
            "water_l": water,
            "breakdown_g": breakdown,
        },
        "per_lot": {
            "carbon_kg": per_unit * design.units / 1000,
            "energy_mwh": energy * design.units / 1000,
            "water_m3": water * design.units / 1000,
        },
        "dies": dies,
        "package": pkg,
        "cross_check": {
            "imec_silicon_g": imec_ref,
            "model_silicon_g": silicon_g,
            "ratio": silicon_g / imec_ref if imec_ref else None,
        },
        "hotspots": sorted(({"source": k, "g": v, "share": v / per_unit if per_unit else 0} for k, v in breakdown.items() if v > 0), key=lambda x: -x["g"]),
    }


# ----------------------------------------------------------- what-if advisor


def recommendations(design: ChipDesign) -> list[dict]:
    """Quantified levers a design / sourcing team can pull, best first."""
    base = estimate(design)["per_unit"]["carbon_g"]
    recs: list[dict] = []

    def trial(label: str, category: str, d: ChipDesign) -> None:
        try:
            g = estimate(d)["per_unit"]["carbon_g"]
        except ValueError:
            return
        if g < base * 0.995:
            recs.append({"lever": label, "category": category, "carbon_g": g, "saving_g": base - g, "saving_pct": (base - g) / base * 100})

    if any(d.renewable_share < 1 for d in design.dies):
        d2 = design.model_copy(deep=True)
        for d in d2.dies:
            d.renewable_share = 1.0
            d.renewable_source = "wind"
        trial("Source 100% wind power at the wafer fab (24/7 matched PPAs)", "energy", d2)
    if any(d.abatement == "95" for d in design.dies):
        d2 = design.model_copy(deep=True)
        for d in d2.dies:
            d.abatement = "99"
        trial("Require 99% point-of-use abatement for PFC/NF3 process gases", "process-gases", d2)
    for loc in ("usa", "europe", "japan"):
        d2 = design.model_copy(deep=True)
        for d in d2.dies:
            d.fab_location = loc
        trial(f"Dual-source wafers from a fab on the {loc.upper() if loc == 'usa' else loc.title()} grid", "sourcing", d2)
    # Chiplet split for large monolithic dies
    for i, d in enumerate(design.dies):
        if d.area_mm2 >= 300 and d.count == 1:
            d2 = design.model_copy(deep=True)
            d2.dies[i] = d.model_copy(update={"area_mm2": d.area_mm2 / 2 * 1.08, "count": 2, "name": d.name + " (2 chiplets)"})
            if d2.package and d2.package.integration == "monolithic":
                d2.package.integration = "2.5d"
                d2.package.interposer_area_mm2 = max(d2.package.interposer_area_mm2, d.area_mm2 * 1.3)
            trial(f"Split the {d.area_mm2:.0f} mm² {d.name} into 2 chiplets (8% interface overhead)", "architecture", d2)
    if design.package and design.package.integration == "2.5d" and design.package.interposer_type == "silicon" and design.package.interposer_area_mm2 > 0:
        d2 = design.model_copy(deep=True)
        d2.package.interposer_type = "rdl"
        trial(f"Replace the {design.package.interposer_area_mm2:.0f} mm² silicon interposer with an organic RDL interposer / local bridges", "packaging", d2)
    # Mature node for non-critical dies
    order = ["3nm", "5nm", "7nm", "10nm", "14nm", "20nm", "28nm"]
    for i, d in enumerate(design.dies):
        if "io" in d.name.lower() and d.node in order[:4]:
            d2 = design.model_copy(deep=True)
            d2.dies[i] = d.model_copy(update={"node": "14nm", "area_mm2": min(d.area_mm2 * 1.6, RETICLE_LIMIT_MM2)})
            trial(f"Move the {d.name} to 14nm (I/O scales poorly; +60% area)", "architecture", d2)
    return sorted(recs, key=lambda r: -r["saving_g"])


def explore(design: ChipDesign, nodes: list[str] | None = None, locations: list[str] | None = None) -> list[dict]:
    """Design-space sweep of the first die across nodes x fab locations."""
    nodes = nodes or list(ref()["nodes"].keys())
    locations = locations or ["taiwan", "south_korea", "usa", "japan", "europe"]
    first = design.dies[0]
    # Approximate logic-area scaling relative to 7nm (assumption: blended logic/SRAM/analog density)
    density = {"28nm": 3.3, "20nm": 2.4, "14nm": 1.9, "10nm": 1.35, "7nm": 1.0, "5nm": 0.62, "3nm": 0.47}
    base_density = density[first.node]
    rows = []
    for n in nodes:
        area = first.area_mm2 * density[n] / base_density
        if area > RETICLE_LIMIT_MM2:
            continue
        for loc in locations:
            d2 = design.model_copy(deep=True)
            d2.dies[0] = first.model_copy(update={"node": n, "area_mm2": area, "fab_location": loc})
            e = estimate(d2)
            rows.append({"node": n, "location": loc, "area_mm2": round(area, 1), "carbon_g": e["per_unit"]["carbon_g"],
                         "water_l": e["per_unit"]["water_l"], "yield": e["dies"][0]["yield"]})
    return rows


def reference_summary() -> dict:
    R = ref()
    return {
        "nodes": list(R["nodes"].keys()),
        "locations": sorted(R["grid"].keys()),
        "grid": R["grid"],
        "sources": R["sources"],
        "packages": list(R["packaging"].keys()),
        "memory": list(R["dram"].keys()),
        "node_params": R["nodes"],
    }
