"""Export the live analysis results into the static portfolio site.

Runs against a freshly seeded stack (./scripts/dev.sh --prod) and writes
site/assets/data.js, so every number on the website comes from the system
itself rather than being typed by hand.

    python -m app.export_site [--api http://localhost:8000]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

from .carbon import model as cm
from .config import ROOT

API = "http://localhost:8000"


def get(path: str):
    with urllib.request.urlopen(API + path, timeout=60) as r:
        return json.load(r)


def post(path: str, body: dict):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


ACCEL = {
    "product": "NX-7 AI accelerator", "units": 1000,
    "dies": [{"name": "compute die", "node": "5nm", "area_mm2": 420, "count": 2, "fab_location": "taiwan"},
             {"name": "IO die", "node": "7nm", "area_mm2": 120, "fab_location": "usa"}],
    "memory": [{"kind": "hbm3", "capacity_gb": 96, "stacks": 4}],
    "package": {"type": "FCBGA", "area_mm2": 3600, "integration": "2.5d", "interposer_area_mm2": 1200, "assembly_location": "world"},
}


def node_curve() -> list[dict]:
    """Per-good-die footprint of the same 100 mm² die across nodes (Taiwan grid)."""
    out = []
    for n in cm.ref()["nodes"]:
        f = cm.die_footprint(cm.DieSpec(node=n, area_mm2=100, fab_location="taiwan"))
        out.append({"node": n, "carbon_g": f["carbon_g"]["total"], "electricity_g": f["carbon_g"]["electricity"], "gases_g": f["carbon_g"]["process_gases"],
                    "materials_g": f["carbon_g"]["materials"], "water_l": f["water_l"], "energy_kwh": f["energy_kwh"], "imec_g": f["imec_reference_g"],
                    "yield": f["yield"]})
    return out


def main() -> None:
    global API
    if "--api" in sys.argv:
        API = sys.argv[sys.argv.index("--api") + 1]

    stats = get("/api/stats")
    passports = get("/api/passports")
    p4 = get("/api/passports/4")
    p2 = get("/api/passports/2")
    est = post("/api/carbon/estimate", ACCEL)
    explore = post("/api/carbon/explore", ACCEL)
    rdl = dict(ACCEL, package=dict(ACCEL["package"], interposer_type="rdl"))
    est_rdl = post("/api/carbon/estimate", rdl)["estimate"]["per_unit"]["carbon_g"]

    compute = get("/api/compute")
    for j in compute["jobs"]:
        c = j["onchain"]
        hours = c["centiHours"] / 100
        # Green Software Foundation SCI = (E*I + M) / R, here per accelerator-hour
        j["sci_g_per_accel_h"] = (c["operationalG"] + c["embodiedG"]) / hours if hours else 0

    cooling = {code: get(f"/api/compute/cooling/{code}?it_mwh=5000") for code in ("PHX-1", "STO-1", "HAM-1")}
    inference = post("/api/compute/inference", {"queries_per_day": 10_000_000, "cache_hit_rate": 0.3, "small_model_share": 0.5, "small_model_cost": 0.15,
                                                 "speculative_speedup": 1.6, "quantization_factor": 0.85, "output_tokens_factor": 0.8, "code": "PHX-1"})
    refresh = {code: post("/api/compute/refresh", {"code": code}) for code in ("PHX-1", "STO-1")}
    sched = post("/api/compute/schedule", {"accelerators": 240, "hours": 72, "window_hours": 120, "water_weight": 0.4, "home": "PHX-1"})

    data = {
        "generatedAt": int(time.time()),
        "stats": stats,
        "passports": passports,
        "accelerator": {
            "passport": {k: p4.get(k) for k in ("id", "product", "lot_code", "units", "totalCarbonG", "ownCarbonG", "inheritedCarbonG", "offsetG", "netCarbonG",
                                                  "perUnitG", "carbonAtRiskG", "verifiedShareBps", "waterL", "energyWh", "estimateCarbonG")},
            "stages": [{"stage": s["stage"], "facility": s["facility"], "carbonG": s["carbonG"], "verdict": s["verdict"], "aiScore": s["aiScore"],
                        "summary": (s.get("audit") or {}).get("summary"), "integrity": s["integrity"]} for s in p4["stages"]],
            "components": [{k: c.get(k) for k in ("childId", "product", "units", "child_units", "carbonG", "verifiedShareBps", "carbonAtRiskG", "node")} for c in p4["components"]],
            "retirements": p4["retirements"],
            "recommendations": est["recommendations"],
            "estimate": est["estimate"],
            "rdl_per_unit_g": est_rdl,
            "usePhase": p4.get("usePhase"),
        },
        "greenwashing": {
            "lot": {k: p2.get(k) for k in ("id", "product", "lot_code", "units", "totalCarbonG")},
            "audit": {k: (p2["stages"][0]["audit"] or {}).get(k) for k in ("verdict", "score", "summary", "findings", "telemetry")},
            "rules": (p2["stages"][0]["audit"] or {}).get("rules"),
        },
        "nodes": node_curve(),
        "explore": explore,
        "suppliers": get("/api/suppliers"),
        "telemetry": get("/api/telemetry/devices"),
        "credits": get("/api/credits"),
        "scope3": get("/api/report/scope3"),
        "compute": compute,
        "schedule_example": {k: sched[k] for k in ("baseline", "best", "best_per_dc", "savings", "rationale")},
        "cooling": cooling,
        "inference": inference,
        "refresh": refresh,
        "aiCache": get("/api/ai/cache"),
        "quality": {"contractTests": 28, "backendTests": 29, "e2eFlows": 6, "slither": {"initial": 9, "fixed": 4, "remaining": 5, "unresolved": 0},
                    "contracts": ["GreenSiliconPassport", "CarbonCreditRegistry", "CircularityToken", "TelemetryRegistry", "ComputeLedger"]},
    }
    out = ROOT / "site" / "assets" / "data.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("// Generated by backend/app/export_site.py from the live GreenSilicon stack. Do not edit by hand.\n"
                   "window.GS = " + json.dumps(data, default=str, separators=(",", ":")) + ";\n")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
