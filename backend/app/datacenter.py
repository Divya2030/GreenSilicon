"""Use phase: AI accelerators in data centers.

Merges three ideas into one loop that runs on the chip passport:
  1. Footprint of every AI job = operational carbon + on-site cooling water +
     off-site water for electricity + embodied carbon amortised from the
     accelerator lot's passport (computed on-chain by ComputeLedger).
  2. Carbon- and water-aware scheduling: shift flexible training and batch
     inference across data centers and hours.
  3. Hardware refresh: is replacing older accelerators worth the new chips'
     embodied carbon? (carbon and water payback)

Sources
  PUE, on-site WUE, off-site EWIF: Li, Yang, Islam, Ren, "Making AI Less
  'Thirsty'", CACM 2025 / arXiv:2304.03271, Table 1.
  Grid carbon intensity: Ember 2023 annual averages (via ACT): USA 392.8,
  Ireland 283.8, Sweden 38.4 g/kWh.
Assumptions (documented, configurable)
  Hour-of-day profiles: solar dip on carbon intensity, wet-bulb-driven WUE
  peak at 15:00 local; water-stress weights 1-4 by WRI Aqueduct category;
  accelerator power and rated life below.
"""
from __future__ import annotations

import hashlib
import json
import math
import time

from eth_account import Account
from eth_utils import keccak

from .chain import chain
from .store import store

ACCEL_BOARD_KW = 0.75      # NX-7 board power at TDP (assumption, H100-SXM class)
ACCEL_UTIL = 0.85          # average board utilisation while running a job
HOST_KW = 0.15             # share of host CPU, memory, NIC per accelerator
IT_KW_PER_ACCEL = ACCEL_BOARD_KW * ACCEL_UTIL + HOST_KW   # ~0.79 kW
RATED_LIFE_HOURS = int(5 * 8760 * 0.7)                    # 5 years at 70 % duty
STRESS_LABEL = ["Low", "Low-medium", "Medium-high", "High", "Extremely high"]
STRESS_WEIGHT = [1.0, 1.5, 2.0, 3.0, 4.0]

# Data-center fleet (fictional operator, real locations and published parameters).
# HAM-1 PUE from Google's Hamina seawater-cooled site (DCD, 2011+); Finland grid from Ember 2023 (81.4 g/kWh);
# Finland EWIF from Li et al. Table 1.
DCS = [
    {"code": "PHX-1", "name": "Helios PHX-1", "region": "Phoenix, Arizona, USA", "pue": 1.18, "wue": 1.630, "ewif": 4.959, "ci": 392.8,
     "stress": 4, "tz": -7, "solar_dip": 0.22, "wue_sens": 0.6},
    {"code": "DFW-2", "name": "Helios DFW-2", "region": "Dallas, Texas, USA", "pue": 1.28, "wue": 0.250, "ewif": 1.287, "ci": 392.8,
     "stress": 3, "tz": -5, "solar_dip": 0.18, "wue_sens": 0.4},
    {"code": "IAD-3", "name": "Helios IAD-3", "region": "Ashburn, Virginia, USA", "pue": 1.14, "wue": 0.140, "ewif": 2.385, "ci": 392.8,
     "stress": 2, "tz": -4, "solar_dip": 0.08, "wue_sens": 0.3},
    {"code": "DUB-1", "name": "Helios DUB-1", "region": "Dublin, Ireland", "pue": 1.19, "wue": 0.020, "ewif": 1.476, "ci": 283.8,
     "stress": 0, "tz": 1, "solar_dip": 0.05, "wue_sens": 0.2},
    {"code": "STO-1", "name": "Helios STO-1", "region": "Stockholm, Sweden", "pue": 1.16, "wue": 0.090, "ewif": 6.019, "ci": 38.4,
     "stress": 0, "tz": 2, "solar_dip": 0.02, "wue_sens": 0.2},
    # Coastal site modelled on the seawater heat-exchange design used at Hamina (PUE 1.09, no freshwater for cooling).
    {"code": "HAM-1", "name": "Helios HAM-1", "region": "Hamina, Finland (coastal, seawater-cooled)", "pue": 1.09, "wue": 0.0, "ewif": 4.542,
     "ci": 81.4, "stress": 0, "tz": 3, "solar_dip": 0.02, "wue_sens": 0.0, "cooling": "seawater", "coastal": True},
]
COOLING_DEFAULTS = {"PHX-1": ("evaporative-potable", False), "DFW-2": ("evaporative-potable", False), "IAD-3": ("evaporative-potable", False),
                    "DUB-1": ("air-economiser", True), "STO-1": ("evaporative-potable", True)}
for _d in DCS:
    _d.setdefault("cooling", COOLING_DEFAULTS.get(_d["code"], ("evaporative-potable", False))[0])
    _d.setdefault("coastal", COOLING_DEFAULTS.get(_d["code"], ("", False))[1])

COOLING_LABEL = {"evaporative-potable": "Evaporative towers, potable water", "air-economiser": "Outside-air economiser",
                 "seawater": "Seawater heat exchange", "reclaimed": "Evaporative, reclaimed wastewater", "dry": "Closed-loop dry coolers"}
# Freshwater share of on-site cooling water by cooling design
FRESH_SHARE = {"evaporative-potable": 1.0, "air-economiser": 1.0, "seawater": 0.0, "reclaimed": 0.0, "dry": 0.0}

CUSTOMERS = {"lumen": ("Lumen AI Labs", 30), "aurora": ("Aurora Silicon ML team", 31)}


def customer_address(key: str) -> str:
    return Account.from_mnemonic(chain.mnemonic, account_path=f"m/44'/60'/0'/0/{CUSTOMERS[key][1]}").address


def _db() -> dict:
    return store.db.setdefault("compute", {"dcs": {}, "deployments": {}, "jobs": []})


# ------------------------------------------------------------------ profiles


def _solar(h: float) -> float:
    return max(0.0, math.sin(math.pi * (h - 6) / 12)) if 6 <= h <= 18 else 0.0


_SOLAR_MEAN = sum(_solar(h + 0.5) for h in range(24)) / 24


def _noise(code: str, ts: int, amp: float) -> float:
    d = hashlib.sha256(f"{code}:{ts // 3600}".encode()).digest()
    return 1 + amp * (d[0] / 255 * 2 - 1)


def intensity(dc: dict, ts: int) -> float:
    """Grid carbon intensity (g/kWh) at hour ts; daily mean equals the annual average."""
    h = ((ts / 3600) + dc["tz"]) % 24
    return dc["ci"] * (1 - dc["solar_dip"] * _solar(h)) / (1 - dc["solar_dip"] * _SOLAR_MEAN) * _noise(dc["code"], ts, 0.04)


def wue(dc: dict, ts: int) -> float:
    """On-site WUE (L/kWh IT) at hour ts; rises with afternoon wet-bulb temperature."""
    h = ((ts / 3600) + dc["tz"]) % 24
    return dc["wue"] * (1 + dc["wue_sens"] * math.cos(2 * math.pi * (h - 15) / 24)) * _noise(dc["code"] + "w", ts, 0.05)


def forecast(hours: int = 48, start: int | None = None) -> list[dict]:
    start = (start or int(time.time())) // 3600 * 3600
    return [{"code": dc["code"], "points": [{"ts": start + i * 3600, "ci": intensity(dc, start + i * 3600), "wue": wue(dc, start + i * 3600)}
                                             for i in range(hours)]} for dc in DCS]


# ----------------------------------------------------------------- footprint


def work_hash(model: str, dataset: str, params: str) -> bytes:
    """Fingerprint of a computation: identical model, data version and parameters give an identical result."""
    return keccak(f"{model.strip()}|{dataset.strip()}|{params.strip()}".encode())


def job_footprint(dc: dict, accelerators: int, hours: int, start: int, embodied_per_unit_g: float, load: float = 1.0) -> dict:
    """load < 1 models an inference result cache: only cache misses reach the accelerators."""
    it_kwh = carbon = onsite = 0.0
    for i in range(hours):
        ts = start + i * 3600
        e = accelerators * IT_KW_PER_ACCEL * load
        it_kwh += e
        carbon += e * dc["pue"] * intensity(dc, ts)
        onsite += e * wue(dc, ts)
    facility = it_kwh * dc["pue"]
    offsite = facility * dc["ewif"]
    water = onsite + offsite
    fresh = onsite * FRESH_SHARE[dc["cooling"]] + offsite  # grid water is freshwater; seawater/reclaimed cooling is not
    embodied = embodied_per_unit_g * accelerators * hours * load / RATED_LIFE_HOURS
    return {
        "it_kwh": it_kwh, "facility_kwh": facility, "operational_g": carbon, "embodied_g": embodied, "total_g": carbon + embodied,
        "water_onsite_l": onsite, "water_offsite_l": offsite, "water_l": water, "freshwater_l": fresh,
        "scarcity_water_l": fresh * STRESS_WEIGHT[dc["stress"]],
    }


def _dc(code: str) -> dict:
    d = next((x for x in DCS if x["code"] == code), None)
    if not d:
        raise KeyError(code)
    return d


def _embodied_per_unit(pid: int) -> float:
    """Cradle-to-gate carbon per accelerator, read from the chip passport on-chain."""
    return chain.passport.functions.carbonPerUnitG(pid).call()


def schedule(accelerators: int, hours: int, window_hours: int, water_weight: float, home: str = "PHX-1",
             allowed: list[str] | None = None, start: int | None = None, passport_id: int = 4, load: float = 1.0) -> dict:
    """Pick the data center and start hour minimising a blend of carbon and
    scarcity-weighted water, relative to running now at the home site without caching."""
    start = (start or int(time.time())) // 3600 * 3600
    emb = _embodied_per_unit(passport_id)
    base = job_footprint(_dc(home), accelerators, hours, start, emb)
    capacity = deployed_capacity()
    cands = []
    for dc in DCS:
        if allowed and dc["code"] not in allowed:
            continue
        if capacity.get(dc["code"], 0) < accelerators:
            continue
        for off in range(0, max(1, window_hours - hours + 1)):
            f = job_footprint(dc, accelerators, hours, start + off * 3600, emb, load)
            score = (1 - water_weight) * f["operational_g"] / base["operational_g"] + water_weight * f["scarcity_water_l"] / base["scarcity_water_l"]
            cands.append({"code": dc["code"], "offset_h": off, "start": start + off * 3600, "score": score, **f})
    if not cands:
        raise ValueError("no data center has enough deployed accelerators for this job")
    cands.sort(key=lambda c: c["score"])
    best = cands[0]
    per_dc = {}
    for c in cands:
        if c["code"] not in per_dc:
            per_dc[c["code"]] = c
    return {
        "job": {"accelerators": accelerators, "hours": hours, "window_hours": window_hours, "water_weight": water_weight, "home": home, "load": load},
        "baseline": {"code": home, "start": start, **base},
        "best": best,
        "best_per_dc": sorted(per_dc.values(), key=lambda c: c["score"]),
        "savings": {
            "carbon_g": base["operational_g"] - best["operational_g"],
            "carbon_pct": (1 - best["operational_g"] / base["operational_g"]) * 100,
            "water_l": base["water_l"] - best["water_l"],
            "scarcity_water_pct": (1 - best["scarcity_water_l"] / base["scarcity_water_l"]) * 100,
        },
        "rationale": _rationale(base, best, home),
    }


def _rationale(base: dict, best: dict, home: str) -> str:
    dc = _dc(best["code"])
    when = "immediately" if best["offset_h"] == 0 else f"in {best['offset_h']} h"
    parts = [f"Run at {dc['name']} ({dc['region']}) {when}."]
    if best["code"] != home:
        h = _dc(home)
        parts.append(f"Its grid averages {dc['ci']:.0f} g/kWh vs {h['ci']:.0f} at {home}, and water stress is {STRESS_LABEL[dc['stress']].lower()} vs {STRESS_LABEL[h['stress']].lower()}.")
    elif best["offset_h"]:
        parts.append("Waiting shifts the job into lower-carbon, cooler hours (solar peak and lower wet-bulb temperature).")
    parts.append(f"Operational CO₂e falls {base['operational_g'] / 1000 - best['operational_g'] / 1000:,.0f} kg and total water {base['water_l'] - best['water_l']:,.0f} L.")
    if best["embodied_g"] > 0.1 * best["operational_g"]:
        parts.append(f"On this clean grid, amortised embodied carbon ({best['embodied_g'] / 1000:,.0f} kg) becomes a material share, which is why the chip passport matters.")
    return " ".join(parts)


# -------------------------------------------------------------- chain writes


def deployed_capacity() -> dict:
    out: dict[str, int] = {}
    for d in _db()["deployments"].values():
        out[d["code"]] = out.get(d["code"], 0) + d["units"]
    return out


def register_fleet() -> None:
    db = _db()
    for dc in DCS:
        dc_id = chain.register_dc(dc["name"], dc["region"], round(dc["pue"] * 1000), round(dc["wue"] * 1000), round(dc["ewif"] * 1000), dc["stress"])
        db["dcs"][dc["code"]] = dc_id
    store.save()


def deploy(passport_id: int, code: str, units: int, lifetime_hours: int = RATED_LIFE_HOURS) -> dict:
    db = _db()
    res = chain.deploy_lot(passport_id, db["dcs"][code], units, lifetime_hours)
    db["deployments"][str(res["deployment_id"])] = {"passportId": passport_id, "code": code, "units": units, "lifetime": lifetime_hours, "tx": res["tx"]}
    store.save()
    return res


def check_reuse(model: str, dataset: str, params: str) -> dict:
    wh = work_hash(model, dataset, params)
    src = chain.reusable_cert(wh)
    out = {"workHash": "0x" + wh.hex(), "sourceCertId": src}
    if src is not None:
        c = next(x for x in chain.compute_certificates() if x["certId"] == src)
        out["source"] = {"operationalG": c["operationalG"], "embodiedG": c["embodiedG"], "waterL": c["waterOnsiteL"] + c["waterOffsiteL"],
                         "centiHours": c["centiHours"], "jobHash": c["jobHash"],
                         "name": next((j["manifest"]["name"] for j in _db()["jobs"] if j["certId"] == src), None)}
    return out


def reuse(model: str, dataset: str, params: str, customer: str, name: str) -> dict:
    wh = work_hash(model, dataset, params)
    res = chain.certify_reuse(wh, customer_address(customer))
    job = {"certId": res["cert_id"], "tx": res["tx"], "jobHash": None, "customerName": CUSTOMERS[customer][0], "reuseOf": res["source_cert_id"],
           "manifest": {"name": name, "customer": customer, "dc": "cache", "accelerators": 0, "hours": 0, "start": int(time.time()),
                        "scheduled": False, "model": model, "dataset": dataset, "params": params, "mode": "reuse"}}
    _db()["jobs"].append(job)
    store.save()
    return {**job, "avoided_g": res["avoided_g"]}


def certify(name: str, customer: str, code: str, accelerators: int, hours: int, start: int, baseline_g: float, scheduled: bool,
            passport_id: int = 4, load: float = 1.0, work: tuple[str, str, str] | None = None, parent_cert: int | None = None) -> dict:
    db = _db()
    dep_id = next((int(k) for k, v in db["deployments"].items() if v["code"] == code and v["passportId"] == passport_id), None)
    if dep_id is None:
        raise ValueError(f"lot #{passport_id} is not deployed at {code}")
    f = job_footprint(_dc(code), accelerators, hours, start, _embodied_per_unit(passport_id), load)
    manifest = {"name": name, "customer": customer, "dc": code, "accelerators": accelerators, "hours": hours, "start": start,
                "scheduled": scheduled, "it_kwh": round(f["it_kwh"], 3), "cache_hit_rate": round(1 - load, 3),
                "mode": "incremental" if parent_cert is not None else "cached-inference" if load < 1 else "full"}
    wh = b"\x00" * 32
    if work:
        wh = work_hash(*work)
        manifest.update({"model": work[0], "dataset": work[1], "params": work[2]})
    job_hash = keccak(json.dumps(manifest, sort_keys=True).encode())
    centi = max(1, round(accelerators * hours * load * 100))
    res = chain.certify_job(dep_id, start, start + hours * 3600, centi, round(f["it_kwh"] * 1000),
                            round(f["operational_g"]), round(f["water_onsite_l"]), round(baseline_g), job_hash, customer_address(customer),
                            wh, (parent_cert + 1) if parent_cert is not None else 0)
    job = {"certId": res["cert_id"], "tx": res["tx"], "manifest": manifest, "jobHash": "0x" + job_hash.hex(), "footprint": f,
           "baseline_g": baseline_g, "customerName": CUSTOMERS[customer][0], "parentCert": parent_cert}
    db["jobs"].append(job)
    store.save()
    return job


# --------------------------------------------------------------------- views


def fleet_view() -> dict:
    db = _db()
    now = int(time.time()) // 3600 * 3600
    cap = deployed_capacity()
    certs = {c["certId"]: c for c in chain.compute_certificates()}
    dcs = []
    for dc in DCS:
        jobs = [j for j in db["jobs"] if j["manifest"]["dc"] == dc["code"]]
        dcs.append({**{k: dc[k] for k in ("code", "name", "region", "pue", "wue", "ewif", "ci", "stress", "cooling", "coastal")},
                    "coolingLabel": COOLING_LABEL[dc["cooling"]], "stressLabel": STRESS_LABEL[dc["stress"]],
                    "ciNow": intensity(dc, now), "wueNow": wue(dc, now), "accelerators": cap.get(dc["code"], 0), "dcId": db["dcs"].get(dc["code"]),
                    "jobs": len(jobs), "operational_g": sum(certs[j["certId"]]["operationalG"] for j in jobs if j["certId"] in certs)})
    jobs = []
    for j in reversed(db["jobs"]):
        c = certs.get(j["certId"], {})
        jobs.append({**j, "onchain": c})
    totals = {
        "certificates": len(certs),
        "accelerator_hours": sum(c["centiHours"] for c in certs.values()) / 100,
        "operational_g": sum(c["operationalG"] for c in certs.values()),
        "embodied_g": sum(c["embodiedG"] for c in certs.values()),
        "water_l": sum(c["waterOnsiteL"] + c["waterOffsiteL"] for c in certs.values()),
        "saved_g": sum(max(0, c["baselineG"] - c["operationalG"]) for c in certs.values() if not c["reused"]),
        "avoided_g": chain.compute.functions.totalAvoidedG().call(),
        "reused": sum(1 for c in certs.values() if c["reused"]),
        "incremental": sum(1 for c in certs.values() if c["parentCertPlusOne"] and not c["reused"]),
    }
    return {"dcs": dcs, "jobs": jobs, "totals": totals, "assumptions": {
        "it_kw_per_accelerator": IT_KW_PER_ACCEL, "rated_life_hours": RATED_LIFE_HOURS, "stress_weights": STRESS_WEIGHT}}


def lifecycle(passport_id: int) -> dict:
    """Cradle-to-grave view for an accelerator lot: embodied (passport) plus use phase."""
    l = chain.compute_lifecycle(passport_id)
    p = chain.get_passport(passport_id)
    deps = [d for d in _db()["deployments"].values() if d["passportId"] == passport_id]
    # Projection: every deployed unit runs its rated life at its data center's average intensity
    proj_op = proj_water = 0.0
    for d in deps:
        dc = _dc(d["code"])
        kwh = d["units"] * d["lifetime"] * IT_KW_PER_ACCEL
        proj_op += kwh * dc["pue"] * dc["ci"]
        proj_water += kwh * dc["wue"] + kwh * dc["pue"] * dc["ewif"]
    embodied = p["totalCarbonG"]
    est = (store.passport(passport_id).get("estimate") or {}).get("per_lot", {})
    fab_water = max(p["waterL"], est.get("water_m3", 0) * 1000)  # components' fab water is modelled, not attested here
    return {
        **l,
        "embodied_total_g": embodied,
        "fab_water_l": fab_water,
        "deployments": deps,
        "projection": {"operational_g": proj_op, "water_l": proj_water,
                       "embodied_share": embodied / (embodied + proj_op) if (embodied + proj_op) else None},
    }


def refresh(old_units: int, old_kw: float, old_perf: float, new_kw: float, new_perf: float, code: str, passport_id: int = 4) -> dict:
    """Replace old_units accelerators with enough new ones to deliver the same throughput."""
    import math as _m
    dc = _dc(code)
    emb_unit = chain.passport.functions.carbonPerUnitG(passport_id).call()
    new_units = _m.ceil(old_units * old_perf / new_perf)
    hours = 8760 * 0.7
    old_kwh = old_units * old_kw * hours * dc["pue"]
    new_kwh = new_units * new_kw * hours * dc["pue"]
    saved_kwh = old_kwh - new_kwh
    saved_g = saved_kwh * dc["ci"]
    saved_water = saved_kwh / dc["pue"] * dc["wue"] + saved_kwh * dc["ewif"]
    embodied = new_units * emb_unit
    return {
        "new_units": new_units, "embodied_new_g": embodied, "annual_kwh_old": old_kwh, "annual_kwh_new": new_kwh,
        "annual_saved_g": saved_g, "annual_saved_water_l": saved_water,
        "payback_months": (embodied / saved_g * 12) if saved_g > 0 else None,
        "five_year_net_g": saved_g * 5 - embodied,
        "dc": code, "ci": dc["ci"],
        "verdict": ("Refresh pays back its embodied carbon in under a year" if saved_g > 0 and embodied / saved_g < 1 else
                    "Refresh pays back within the 5-year life" if saved_g > 0 and embodied / saved_g < 5 else
                    "Keep the existing fleet: the new chips' embodied carbon is not recovered within 5 years"),
    }


# -------------------------------------------------------------- cooling source

SEAWATER_RO_KWH_PER_M3 = 3.5    # seawater reverse-osmosis energy (typical 3-4 kWh/m3)
DRY_COOLER_PUE_PENALTY = 0.06   # assumption: fans replace evaporation
SEAWATER_HX_PUE = 1.10          # assumption anchored on Hamina (1.09) and Natick (1.07)


def cooling_options(code: str, it_mwh_per_year: float = 5000.0) -> dict:
    """Compare cooling-water strategies for one site at a fixed IT load."""
    dc = _dc(code)
    it_kwh = it_mwh_per_year * 1000

    def row(key, label, pue, onsite_l_per_kwh, fresh_share, extra_kwh=0.0, feasible=True, notes=""):
        facility = it_kwh * pue + extra_kwh
        onsite = it_kwh * onsite_l_per_kwh
        offsite = facility * dc["ewif"]
        fresh = onsite * fresh_share + offsite
        return {"key": key, "label": label, "feasible": feasible, "pue": pue, "facility_mwh": facility / 1000,
                "carbon_t": facility * dc["ci"] / 1e6, "onsite_m3": onsite / 1000, "offsite_m3": offsite / 1000,
                "freshwater_m3": fresh / 1000, "scarcity_m3": fresh * STRESS_WEIGHT[dc["stress"]] / 1000, "notes": notes}

    base_wue = dc["wue"] if dc["cooling"] != "seawater" else 1.0
    rows = [
        row("current", f"Current: {COOLING_LABEL[dc['cooling']]}", dc["pue"], dc["wue"], FRESH_SHARE[dc["cooling"]], notes="Published site parameters."),
        row("reclaimed", "Evaporative with reclaimed wastewater", dc["pue"], base_wue, 0.0,
            notes="Same cooling, but uses treated municipal wastewater instead of drinking water. Needs a local reuse supply."),
        row("dry", "Closed-loop dry coolers (no evaporation)", dc["pue"] + DRY_COOLER_PUE_PENALTY, 0.0, 0.0,
            notes="Zero cooling water, but fans use more electricity, so grid water and CO₂ rise."),
        row("seawater_hx", "Seawater heat exchange (Hamina-style)", SEAWATER_HX_PUE, 0.0, 0.0, feasible=dc["coastal"],
            notes="Cold seawater in titanium/fiberglass heat exchangers; no freshwater and lower PUE. Coastal sites only; "
                  "manage biofouling, corrosion and warm-water discharge (temper before return)." + ("" if dc["coastal"] else " Not feasible: inland site.")),
        row("seawater_ro", "Desalinate seawater for evaporative towers", dc["pue"], base_wue, 0.0,
            extra_kwh=it_kwh * base_wue / 1000 * SEAWATER_RO_KWH_PER_M3, feasible=dc["coastal"],
            notes=f"Reverse osmosis costs ~{SEAWATER_RO_KWH_PER_M3} kWh per m³ and brine disposal; usually worse than heat exchange."),
    ]
    cur = rows[0]
    for r in rows:
        r["freshwater_saved_pct"] = (1 - r["freshwater_m3"] / cur["freshwater_m3"]) * 100 if cur["freshwater_m3"] else 0
        r["carbon_delta_pct"] = (r["carbon_t"] / cur["carbon_t"] - 1) * 100
    return {"code": code, "name": dc["name"], "region": dc["region"], "it_mwh_per_year": it_mwh_per_year, "coastal": dc["coastal"],
            "stress": STRESS_LABEL[dc["stress"]], "options": rows,
            "insight": ("Most of this site's water is consumed off-site by power plants "
                        f"({cur['offsite_m3'] / (cur['onsite_m3'] + cur['offsite_m3']) * 100:.0f}% of the total). Cleaner, low-water electricity (wind, solar) "
                        "reduces it; cooling changes alone cannot.") if cur["offsite_m3"] > cur["onsite_m3"] else
                       "On-site cooling dominates this site's water use, so changing the cooling source has a large effect."}


# --------------------------------------------------------- green inference

BASE_WH_PER_QUERY = 0.3   # typical chatbot query on a frontier model (Epoch AI, 2025)


def inference_plan(queries_per_day: float, cache_hit_rate: float, small_model_share: float, small_model_cost: float,
                   speculative_speedup: float, quantization_factor: float, output_tokens_factor: float, code: str) -> dict:
    """Energy per query after efficiency levers, then carbon and water at a site.
    Multipliers: cache (1-h); routing (1 - r + r*k); speculative decoding (1/s, 1.34-2.51x reported
    for EAGLE-style methods); quantization (factor); shorter answers (output tokens scale decode energy)."""
    dc = _dc(code)
    steps = [("Baseline frontier-model query", 1.0)]
    m = 1.0
    for label, f in [
        ("Semantic / result cache hits", 1 - cache_hit_rate),
        ("Route easy queries to a distilled small model", 1 - small_model_share + small_model_share * small_model_cost),
        ("Speculative decoding", 1 / max(speculative_speedup, 1.0)),
        ("FP8 / INT8 quantization", quantization_factor),
        ("Concise answers (fewer output tokens)", output_tokens_factor),
    ]:
        m *= f
        steps.append((label, m))
    wh = BASE_WH_PER_QUERY * m

    def at(whq):
        it_kwh = whq * queries_per_day / 1000
        fac = it_kwh * dc["pue"]
        on = it_kwh * dc["wue"]
        off = fac * dc["ewif"]
        return {"wh_per_query": whq, "daily_mwh": fac / 1000, "daily_carbon_kg": fac * dc["ci"] / 1000,
                "daily_water_m3": (on + off) / 1000, "ml_per_query": (on + off) / queries_per_day * 1000 if queries_per_day else 0,
                "daily_freshwater_m3": (on * FRESH_SHARE[dc["cooling"]] + off) / 1000}

    base, opt = at(BASE_WH_PER_QUERY), at(wh)
    return {"site": code, "multiplier": m, "steps": [{"label": l, "wh_per_query": BASE_WH_PER_QUERY * v, "multiplier": v} for l, v in steps],
            "baseline": base, "optimised": opt, "annual_saved_mwh": (base["daily_mwh"] - opt["daily_mwh"]) * 365,
            "annual_saved_carbon_t": (base["daily_carbon_kg"] - opt["daily_carbon_kg"]) * 365 / 1000,
            "annual_saved_water_m3": (base["daily_water_m3"] - opt["daily_water_m3"]) * 365,
            "references": {"baseline": "Epoch AI (2025): ~0.3 Wh per typical GPT-4o query; Google (2025): 0.24 Wh and 0.26 mL water per median Gemini text prompt",
                           "speculative": "EAGLE-style speculative decoding: 1.34-2.51x energy reduction (arXiv 2602.09113)",
                           "quantization": "Quantization saves energy mainly in prefill; decoding gains are smaller (arXiv 2601.22362)"}}
