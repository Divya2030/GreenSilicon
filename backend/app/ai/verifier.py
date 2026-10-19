"""Hybrid AI auditor for supplier stage disclosures.

Three independent layers, combined conservatively:
  1. Physics: expected footprint from the ACT-based model for this lot/stage,
     plus an energy x grid-intensity consistency floor.
  2. ML: IsolationForest trained on a reference population sampled from the
     physics model (honest-supplier variance) to score how anomalous the
     disclosure's intensity profile is.
  3. LLM: Claude reviews the disclosure and the signals above and writes the
     findings. Its verdict can add scrutiny but never overrule a physics
     violation (final verdict = the more severe of rule-based and Claude).
"""
from __future__ import annotations

import logging
import math
from functools import lru_cache

import numpy as np
from sklearn.ensemble import IsolationForest

from ..carbon import model as cm
from . import claude
from .schemas import StageDisclosure

log = logging.getLogger(__name__)

SEVERITY = {"Verified": 0, "Flagged": 1, "Rejected": 2}

# Freight emission factors, kg CO2e per tonne-km (approximate GLEC Framework /
# UK DEFRA conversion-factor defaults for long-haul freight).
FREIGHT_KG_PER_TKM = {"air": 0.60, "sea": 0.016, "road": 0.105, "rail": 0.028}
TEST_KWH_PER_UNIT = 0.02  # assumption: ATE + burn-in energy per packaged unit
RECYCLING_KG_PER_KG = 1.2  # assumption: hydrometallurgical recovery process emissions per kg recovered


RENEWABLE_CERT_KEYWORDS = ("i-rec", "irec", "rec", "go", "guarantee", "ppa", "re100", "t-rec")


def _certified(d: StageDisclosure) -> bool:
    certs = " ".join(d.certifications).lower()
    return any(k in certs for k in RENEWABLE_CERT_KEYWORDS)


def expected_stage_g(stage: str, d: StageDisclosure, design: cm.ChipDesign | None) -> tuple[float | None, str]:
    """Independent expectation for the stage, in grams, plus the basis used."""
    units = d.units or (design.units if design else None)
    if stage == "WaferFab" and design and units:
        dies = [x for x in design.dies if not d.process_node or x.node == d.process_node] or design.dies
        g = 0.0
        for x in dies:
            # Renewables only lower the expectation when certificates back them
            spec = x.model_copy(update={"fab_location": d.location if d.location in cm.ref()["grid"] else x.fab_location,
                                        "renewable_share": (d.renewable_share or 0.0) if _certified(d) else 0.0})
            g += cm.die_footprint(spec)["carbon_g"]["total"] * x.count
        power = f"{d.renewable_share:.0%} certified renewables" if _certified(d) and d.renewable_share else "grid-average power"
        if design.memory and (not design.dies or not d.process_node or not any(x.node == d.process_node for x in design.dies)):
            mem = sum(cm.memory_footprint(m) for m in design.memory)
            return mem * units, f"ACT DRAM model, {sum(m.capacity_gb for m in design.memory):.0f} GB {design.memory[0].kind}, {units} units"
        return g * units, f"ACT model, {', '.join(f'{x.node} {x.area_mm2:.0f}mm²' for x in dies)}, {power}, {units} units"
    if stage == "Assembly" and design and design.package and units:
        loc = d.location if d.location in cm.ref()["grid"] else design.package.assembly_location
        pkg = cm.package_footprint(design.package.model_copy(update={"assembly_location": loc}), design.dies, design.dies[0].fab_location)
        return (pkg["packaging_g"] + pkg["bonding_g"] + pkg["interposer_g"]) * units, f"3D-Carbon packaging model ({design.package.type}, {design.package.integration}, {design.package.interposer_type} interposer), {units} units"
    if stage == "Test" and units:
        loc = d.location if d.location in cm.ref()["grid"] else "world"
        return TEST_KWH_PER_UNIT * units * cm.grid_intensity(loc), f"{TEST_KWH_PER_UNIT} kWh/unit test energy x {loc} grid"
    if stage == "Logistics" and d.transport_mode and d.distance_km and d.shipment_mass_kg:
        f = FREIGHT_KG_PER_TKM[d.transport_mode]
        return d.shipment_mass_kg / 1000 * d.distance_km * f * 1000, f"{d.transport_mode} freight {f} kg/t·km (GLEC/DEFRA default)"
    if stage == "EndOfLife" and d.recovered_material_g:
        return d.recovered_material_g * RECYCLING_KG_PER_KG, "recovery process factor (assumption)"
    return None, "no independent model for this stage"


@lru_cache
def _forest() -> IsolationForest:
    """Reference population of honest disclosures: claimed/expected ratio and
    intensity residuals vary log-normally around the physics model."""
    rng = np.random.default_rng(7)
    n = 2000
    X = np.column_stack([
        rng.normal(0, 0.15, n),                    # log(claimed / expected carbon)
        rng.normal(0, 0.12, n),                    # log(claimed / implied-by-energy floor) - margin
        rng.beta(2, 5, n),                         # renewable share
        rng.normal(0, 0.15, n),                    # log(water / expected water)
        np.clip(rng.normal(0.98, 0.012, n), 0.9, 0.999),  # abatement
    ])
    return IsolationForest(n_estimators=200, contamination=0.03, random_state=7).fit(X)


def anomaly_score(features: list[float]) -> float:
    """0 = typical, 1 = highly anomalous."""
    s = _forest().decision_function(np.array([features]))[0]  # >0 inlier, <0 outlier
    return float(1 / (1 + math.exp(12 * s)))


def _same_org(a: str, b: str) -> bool:
    """Compare the brand (first word) of two organisation names."""
    def brand(x: str) -> str:
        words = [w.strip(".,()").lower() for w in x.split() if w.strip(".,()").lower() not in ("the",)]
        return words[0] if words else ""
    return brand(a) == brand(b)


def rule_checks(stage: str, d: StageDisclosure, design: cm.ChipDesign | None, has_evidence: bool, signer_name: str | None = None,
                telemetry: dict | None = None) -> dict:
    findings: list[dict] = []
    claimed_g = d.claimed_carbon_kgco2e * 1000
    expected_g, basis = expected_stage_g(stage, d, design)
    score = 100.0

    def add(sev, title, detail, penalty):
        nonlocal score
        findings.append({"severity": sev, "title": title, "detail": detail})
        score -= penalty

    ratio = claimed_g / expected_g if expected_g else None
    if ratio is not None:
        if ratio < 0.4:
            add("critical", "Footprint far below physical model", f"Claimed {d.claimed_carbon_kgco2e:,.0f} kg is {ratio:.0%} of the independent estimate ({expected_g / 1000:,.0f} kg; {basis}).", 55)
        elif ratio < 0.7:
            add("warning", "Footprint below expected band", f"Claimed is {ratio:.0%} of the model estimate ({expected_g / 1000:,.0f} kg). Requires evidence of cleaner power or better abatement.", 25)
        elif ratio > 2.0:
            add("warning", "Footprint well above model", f"Claimed is {ratio:.1f}x the estimate; possible unit error or allocation of facility-wide emissions.", 15)
        else:
            findings.append({"severity": "info", "title": "Consistent with physics model", "detail": f"Claimed is {ratio:.2f}x the independent estimate ({basis})."})

    # Energy floor: the electricity alone implies a minimum footprint
    floor_g = None
    if d.electricity_kwh and d.location in cm.ref()["grid"]:
        ci = cm.effective_intensity(d.location, d.renewable_share or 0.0, "solar")
        floor_g = d.electricity_kwh * ci
        if claimed_g < floor_g * 0.95:
            add("critical", "Total below electricity-only emissions", f"{d.electricity_kwh:,.0f} kWh on the {d.location} grid (renewables {d.renewable_share or 0:.0%}) implies ≥ {floor_g / 1000:,.0f} kg, but only {d.claimed_carbon_kgco2e:,.0f} kg is claimed.", 45)

    if (d.renewable_share or 0) > 0.2 and not _certified(d):
        add("warning", "Renewable claim lacks certificates", f"{d.renewable_share:.0%} renewable electricity is claimed without I-REC/GO/PPA evidence (GHG Protocol Scope 2 quality criteria).", 20)
    if d.abatement_rate is not None and d.abatement_rate > 0.995:
        add("warning", "Abatement rate implausibly high", f"{d.abatement_rate:.1%} destruction efficiency exceeds best-available point-of-use abatement (~99%).", 15)
    if stage == "WaferFab" and design and d.die_yield and design.dies:
        x = design.dies[0]
        p = cm.ref()["nodes"][x.node]
        y_model = cm.nb_yield(x.area_mm2, p["d0"], p["alpha"])
        if d.die_yield > min(0.99, y_model + 0.25):
            add("warning", "Reported yield above model", f"Reported yield {d.die_yield:.0%} vs {y_model:.0%} expected for {x.area_mm2:.0f} mm² at {x.node}; inflated yield lowers per-die carbon.", 10)
    if signer_name and not _same_org(d.supplier_name, signer_name):
        add("critical", "Signer is not the reporting supplier", f"The record was signed by '{signer_name}' but the document is issued by '{d.supplier_name}'. A supplier may only attest its own disclosures.", 40)
    if telemetry:
        _telemetry_checks(stage, d, design, telemetry, add, findings)
    if not has_evidence:
        add("warning", "No evidence document", "No source document was anchored; figures cannot be traced.", 10)
    if d.missing_or_unclear:
        add("info", "Gaps in disclosure", "Not stated: " + ", ".join(d.missing_or_unclear[:6]), min(10, 2 * len(d.missing_or_unclear)))

    # ML anomaly over the intensity profile
    water_exp = None
    if stage == "WaferFab" and design and design.dies and (d.units or design.units):
        water_exp = sum(cm.die_footprint(x)["water_l"] * x.count for x in design.dies) * (d.units or design.units)
    feats = [
        math.log(ratio) if ratio else 0.0,
        math.log(claimed_g / floor_g) - 0.4 if floor_g else 0.0,
        d.renewable_share or 0.0,
        math.log(d.water_l / water_exp) if (d.water_l and water_exp) else 0.0,
        d.abatement_rate if d.abatement_rate is not None else 0.98,
    ]
    anomaly = anomaly_score(feats)
    if anomaly > 0.7:
        add("warning", "Statistical anomaly", f"IsolationForest anomaly score {anomaly:.2f}: this intensity profile is unusual versus the reference population.", 15)

    score = max(0.0, min(100.0, score))
    worst = max((f["severity"] for f in findings), key=lambda s: {"info": 0, "warning": 1, "critical": 2}[s], default="info")
    verdict = "Rejected" if worst == "critical" and score < 50 else "Flagged" if worst in ("critical", "warning") and score < 85 else "Verified"
    return {
        "score": round(score, 1),
        "verdict": verdict,
        "findings": findings,
        "expected_g": expected_g,
        "expected_basis": basis,
        "claimed_g": claimed_g,
        "ratio": ratio,
        "energy_floor_g": floor_g,
        "anomaly": round(anomaly, 3),
    }


def _telemetry_checks(stage, d: StageDisclosure, design, t: dict, add, findings) -> None:
    """Cross-check the disclosure against device-signed, on-chain-anchored meter data."""
    src = f"{t['devices']} device-signed meter(s), {t['batches']} on-chain batches, {t['window_days']}-day window"
    avg = t.get("abatement_avg")
    if avg is not None and d.abatement_rate is not None:
        gap = d.abatement_rate - avg
        extra = ""
        if stage == "WaferFab" and design and design.dies and (d.units or design.units) and gap > 0.005:
            units = d.units or design.units
            g = sum((cm.gas_per_cm2(x.node, avg) - cm.gas_per_cm2(x.node, d.abatement_rate)) * cm.die_footprint(x)["wafer_cm2_per_good_die"] * x.count
                    for x in design.dies) * units
            extra = f" At the metered efficiency, ACT's abatement data implies ≈{g / 1000:,.0f} kg more process-gas CO₂e than claimed."
        msg = f"{t.get('abatement_device', 'Abatement analyser')} measured {avg:.1%} average destruction efficiency ({t['abatement_uptime']:.0%} uptime) vs {d.abatement_rate:.1%} claimed ({src}).{extra}"
        if gap > 0.03:
            add("critical", "Telemetry contradicts abatement claim", msg, 35)
        elif gap > 0.005:
            add("warning", "Abatement claim above metered value", msg, 10)
        else:
            findings.append({"severity": "info", "title": "Metered abatement corroborates claim", "detail": msg})
    kwh = t.get("power_kwh")
    if kwh and d.electricity_kwh:
        r = d.electricity_kwh / kwh
        msg = f"Claimed {d.electricity_kwh:,.0f} kWh vs {kwh:,.0f} kWh on the line sub-meter ({src})."
        if r < 0.85:
            add("critical", "Metered electricity exceeds claim", msg + " Electricity appears under-reported.", 35)
        else:
            findings.append({"severity": "info", "title": "Metered electricity corroborates claim", "detail": msg})


def audit_disclosure(stage: str, d: StageDisclosure, design: cm.ChipDesign | None, has_evidence: bool, passport_ctx: dict | None = None,
                     signer_name: str | None = None, telemetry: dict | None = None) -> dict:
    rules = rule_checks(stage, d, design, has_evidence, signer_name, telemetry)
    report = {
        "engine": "rules+ml",
        "model": None,
        "score": rules["score"],
        "verdict": rules["verdict"],
        "rules": rules,
        "summary": None,
        "findings": rules["findings"],
        "recommended_actions": [],
    }
    if claude.enabled():
        try:
            ctx = {
                "stage": stage,
                "disclosure": d.model_dump(),
                "passport": passport_ctx or {},
                "independent_checks": {k: rules[k] for k in ("expected_g", "expected_basis", "claimed_g", "ratio", "energy_floor_g", "anomaly", "score")},
                "rule_findings": rules["findings"],
                "iot_telemetry": telemetry,
            }
            ai, model_used = claude.audit(ctx)
            final = max(rules["verdict"], ai.verdict, key=lambda v: SEVERITY[v])
            report.update({
                "engine": "claude+rules+ml",
                "model": model_used,
                "verdict": final,
                "claude_verdict": ai.verdict,
                "confidence": ai.confidence,
                "summary": ai.summary,
                "findings": [f.model_dump() for f in ai.findings] or rules["findings"],
                "recommended_actions": ai.recommended_actions,
                # Blend: physics/ML score, scaled by Claude's agreement
                "score": round(rules["score"] * (0.6 + 0.4 * (ai.confidence if ai.verdict == "Verified" else 1 - ai.confidence)), 1),
            })
        except Exception as e:  # network, auth, refusal: fall back to rules
            log.warning("Claude audit failed, using rules only: %s", e)
            report["ai_error"] = str(e)[:300]
    if not report["summary"]:
        report["summary"] = _template_summary(stage, d, rules)
        report["recommended_actions"] = _template_actions(rules)
    return report


def _template_summary(stage: str, d: StageDisclosure, r: dict) -> str:
    base = f"{d.supplier_name} disclosed {d.claimed_carbon_kgco2e:,.0f} kg CO2e for the {stage} stage."
    if r["ratio"]:
        base += f" That is {r['ratio']:.2f}x the independent model estimate of {r['expected_g'] / 1000:,.0f} kg."
    crit = [f["title"] for f in r["findings"] if f["severity"] != "info"]
    base += (" Issues: " + "; ".join(crit) + ".") if crit else " No material inconsistencies were found."
    return base


def _template_actions(r: dict) -> list[str]:
    acts = []
    for f in r["findings"]:
        t = f["title"]
        if "certificates" in t:
            acts.append("Upload I-REC / Guarantee-of-Origin certificates matching the claimed renewable MWh.")
        elif "below" in t.lower():
            acts.append("Provide metered electricity and abatement logs for the lot; re-attest with corrected totals.")
        elif "evidence" in t.lower():
            acts.append("Anchor the source report (PDF) so auditors can trace every figure.")
        elif "yield" in t.lower():
            acts.append("Provide wafer-sort yield data for the lot.")
        elif "anomaly" in t.lower():
            acts.append("Route to a human verifier for a desk review.")
    return acts or ["No action required."]
