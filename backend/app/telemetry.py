"""IoT digital MRV for fabs.

Simulated smart meters (tool-line power sub-meters, abatement-unit gas
analysers, ultrapure-water meters) each hold their own key and sign batches
of readings, which are anchored on-chain in TelemetryRegistry. Readings are
kept off-chain and any single one can be proven against its batch root.

Includes:
  * history generation (7 days at 15-minute resolution) for the seed,
  * a live feed (1 reading/second/device, anchored every 15 readings),
  * fault injection (abatement bypass) for the demo,
  * real-time anomaly detection (abatement below 95 %, power > 4 sigma),
  * facility summaries consumed by the AI auditor.
"""
from __future__ import annotations

import logging
import math
import re
import random
import threading
import time
from collections import deque

from eth_account import Account

from . import merkle
from .chain import chain
from .store import store

log = logging.getLogger(__name__)

KIND_CODE = {"Power": 0, "Abatement": 1, "Water": 2}
ABATEMENT_ALERT_BPS = 9500
HISTORY_DAYS = 7
HISTORY_STEP = 900  # 15 minutes
LIVE_BATCH = 15

# Demo meter fleet. base: Power in kW, Abatement in bps, Water in L per 15 min.
DEVICES = [
    {"key": "tw_power", "operator": "fab_tw", "kind": "Power", "facility": "Northbay Fab 7 · N5 line sub-meter", "base": 270.0},
    {"key": "tw_abate", "operator": "fab_tw", "kind": "Abatement", "facility": "Northbay Fab 7 · abatement unit LSC-2", "base": 9905},
    {"key": "tw_water", "operator": "fab_tw", "kind": "Water", "facility": "Northbay Fab 7 · UPW meter", "base": 277.0},
    {"key": "us_power", "operator": "fab_us", "kind": "Power", "facility": "Mesa Fab 3 · 7nm line sub-meter", "base": 19.3},
    {"key": "us_abate", "operator": "fab_us", "kind": "Abatement", "facility": "Mesa Fab 3 · abatement unit B", "base": 9900,
     "outages": [(1.4, 5.0), (3.7, 6.0), (5.2, 4.5)]},  # (day offset, hours) of bypassed abatement
    {"key": "kr_power", "operator": "fab_kr", "kind": "Power", "facility": "Hanul Fab M3 · HBM line sub-meter", "base": 58.3},
]


def device_account(i: int):
    return Account.from_mnemonic(chain.mnemonic, account_path=f"m/44'/60'/0'/0/{20 + i}")


def _db() -> dict:
    return store.db.setdefault("telemetry", {"devices": {}, "alerts": []})


def _spec(address: str) -> dict | None:
    d = _db()["devices"].get(address)
    return next((x for x in DEVICES if x["key"] == d["key"]), None) if d else None


# ------------------------------------------------------------------ readings


def _value(spec: dict, ts: int, step: int, rng: random.Random, outage: bool = False) -> int:
    hour = (ts % 86400) / 3600
    if spec["kind"] == "Power":
        kw = spec["base"] * (1 + 0.05 * math.sin((hour - 9) / 24 * 2 * math.pi) + rng.gauss(0, 0.02))
        return max(0, round(kw * 1000 * step / 3600))  # Wh in this interval
    if spec["kind"] == "Abatement":
        if outage:
            return rng.randint(0, 300)
        return int(min(9970, max(9850, rng.gauss(spec["base"], 18))))
    litres = spec["base"] * step / HISTORY_STEP * (1 + rng.gauss(0, 0.04))
    return max(0, round(litres))


def _alerts_for(spec: dict, address: str, readings: list[list[int]], step: int) -> list[dict]:
    out = []
    if spec["kind"] == "Abatement":
        for ts, v in readings:
            if v < ABATEMENT_ALERT_BPS:
                out.append({"ts": ts, "device": address, "severity": "critical", "facility": spec["facility"],
                            "message": f"Abatement bypass: destruction efficiency {v / 100:.1f}% (< {ABATEMENT_ALERT_BPS / 100:.0f}%)"})
    elif spec["kind"] == "Power" and len(readings) > 8:
        vals = [v for _, v in readings]
        mu = sum(vals) / len(vals)
        sd = (sum((x - mu) ** 2 for x in vals) / len(vals)) ** 0.5 or 1
        for ts, v in readings:
            if abs(v - mu) > 4 * sd:
                out.append({"ts": ts, "device": address, "severity": "warning", "facility": spec["facility"],
                            "message": f"Power excursion: {v * 3600 / step / 1000:.1f} kW vs {mu * 3600 / step / 1000:.1f} kW mean"})
    return out


def _anchor(address: str, acct, readings: list[list[int]], step: int, alerts: list[dict]) -> dict:
    dev = _db()["devices"][address]
    tree = merkle.LeafTree([merkle.reading_leaf(t, v) for t, v in readings])
    from_ts = dev["batches"][-1]["toTs"] if dev["batches"] else readings[0][0]
    total = sum(v for _, v in readings)
    res = chain.anchor_batch(acct, from_ts, readings[-1][0], len(readings), tree.root, total, len(alerts))
    batch = {"index": res["index"], "fromTs": from_ts, "toTs": readings[-1][0], "count": len(readings), "total": total,
             "alerts": len(alerts), "root": "0x" + tree.root.hex(), "tx": res["tx"], "step": step, "readings": readings}
    dev["batches"].append(batch)
    return batch


# --------------------------------------------------------------------- seed


def seed_history(now: int | None = None) -> dict:
    """Register the meter fleet and anchor 7 days of 15-minute readings (one batch per day)."""
    now = now or int(time.time())
    now -= now % HISTORY_STEP
    start = now - HISTORY_DAYS * 86400
    rng = random.Random(42)
    db = _db()
    counts = {}
    for i, spec in enumerate(DEVICES):
        acct = device_account(i)
        chain.register_device(spec["operator"], acct.address, KIND_CODE[spec["kind"]], spec["facility"])
        db["devices"][acct.address] = {"key": spec["key"], "index": i, "operator": spec["operator"], "kind": spec["kind"],
                                       "facility": spec["facility"], "batches": [], "live": []}
        outages = [(start + int(d * 86400), start + int(d * 86400 + h * 3600)) for d, h in spec.get("outages", [])]
        for day in range(HISTORY_DAYS):
            readings = []
            for ts in range(start + day * 86400 + HISTORY_STEP, start + (day + 1) * 86400 + 1, HISTORY_STEP):
                readings.append([ts, _value(spec, ts, HISTORY_STEP, rng, any(a <= ts < b for a, b in outages))])
            alerts = _alerts_for(spec, acct.address, readings, HISTORY_STEP)
            db["alerts"].extend(alerts)
            _anchor(acct.address, acct, readings, HISTORY_STEP, alerts)
        counts[spec["key"]] = len(db["devices"][acct.address]["batches"])
    store.save()
    return counts


# ---------------------------------------------------------------- live feed


class LiveFeed:
    def __init__(self) -> None:
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.faults: dict[str, int] = {}  # device -> remaining faulty readings
        self.buffers: dict[str, list[list[int]]] = {}
        self.recent: dict[str, deque] = {}
        self.started_at: int | None = None
        self.rng = random.Random()

    @property
    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def start(self) -> None:
        if self.running:
            return
        self.stop_event.clear()
        self.started_at = int(time.time())
        self.thread = threading.Thread(target=self._run, daemon=True, name="telemetry-live")
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def inject_fault(self, address: str, readings: int = 8) -> None:
        self.faults[address] = readings

    def _run(self) -> None:
        devices = _db()["devices"]
        last_ts = 0
        while not self.stop_event.is_set():
            ts = max(int(time.time()), last_ts + 1)
            last_ts = ts
            for address, dev in list(devices.items()):
                spec = _spec(address)
                if not spec:
                    continue
                faulty = self.faults.get(address, 0) > 0
                if faulty:
                    self.faults[address] -= 1
                v = _value(spec, ts, 1, self.rng, outage=faulty)
                self.buffers.setdefault(address, []).append([ts, v])
                self.recent.setdefault(address, deque(maxlen=300)).append([ts, v])
                if len(self.buffers[address]) >= LIVE_BATCH:
                    batch = self.buffers.pop(address)
                    alerts = _alerts_for(spec, address, batch, 1)
                    try:
                        _anchor(address, device_account(dev["index"]), batch, 1, alerts)
                        _db()["alerts"].extend(alerts)
                        store.save()
                    except Exception as e:  # keep streaming even if one anchor fails
                        log.warning("live anchor failed for %s: %s", address, e)
            self.stop_event.wait(1.0)


live = LiveFeed()


# ------------------------------------------------------------------- views


def _display(kind: str, value: int, step: int) -> float:
    if kind == "Power":
        return value * 3600 / step / 1000  # kW
    if kind == "Abatement":
        return value / 100  # %
    return value * HISTORY_STEP / step  # L per 15 min equivalent


def devices_view() -> list[dict]:
    db = _db()
    onchain = {d["address"]: d for d in chain.telemetry_devices()}
    out = []
    for address, dev in db["devices"].items():
        readings = [r for b in dev["batches"] for r in b["readings"]]
        vals = [_display(dev["kind"], v, b["step"]) for b in dev["batches"] for _, v in b["readings"]]
        stats = {"readings": len(readings)}
        if vals:
            stats["mean"] = sum(vals) / len(vals)
            stats["last"] = vals[-1]
            if dev["kind"] == "Abatement":
                stats["uptime"] = sum(1 for _, v in readings if v >= ABATEMENT_ALERT_BPS) / len(readings)
        oc = onchain.get(address, {})
        out.append({"address": address, "key": dev["key"], "kind": dev["kind"], "facility": dev["facility"], "operator": dev["operator"],
                    "operatorName": chain.actors[dev["operator"]]["name"], "batches": oc.get("batches", len(dev["batches"])), "active": oc.get("active", True),
                    "lastRoot": dev["batches"][-1]["root"] if dev["batches"] else None, "alerts": sum(b["alerts"] for b in dev["batches"]), **stats})
    return out


def series(address: str, mode: str = "history", limit: int = 700) -> dict:
    dev = _db()["devices"].get(address)
    if not dev:
        raise KeyError(address)
    if mode == "live":
        pts = list(live.recent.get(address, []))[-limit:]
        return {"kind": dev["kind"], "points": [{"ts": t, "v": _display(dev["kind"], v, 1)} for t, v in pts], "running": live.running}
    pts = [(t, v, b["step"]) for b in dev["batches"] if b["step"] == HISTORY_STEP for t, v in b["readings"]][-limit:]
    return {"kind": dev["kind"], "points": [{"ts": t, "v": _display(dev["kind"], v, s)} for t, v, s in pts], "running": live.running}


def batches(address: str) -> list[dict]:
    dev = _db()["devices"].get(address) or {"batches": []}
    return [{k: v for k, v in b.items() if k != "readings"} for b in dev["batches"]][::-1]


def alerts(limit: int = 50) -> list[dict]:
    return sorted(_db()["alerts"], key=lambda a: -a["ts"])[:limit]


def prove(address: str, index: int, i: int) -> dict:
    dev = _db()["devices"][address]
    b = dev["batches"][index]
    ts, v = b["readings"][i]
    tree = merkle.LeafTree([merkle.reading_leaf(t, x) for t, x in b["readings"]])
    proof = tree.proof(i)
    ok = chain.verify_reading(address, index, ts, v, proof)
    tampered = chain.verify_reading(address, index, ts, v + 1, proof)
    return {"device": address, "index": index, "ts": ts, "value": v, "display": _display(dev["kind"], v, b["step"]), "kind": dev["kind"],
            "proof": ["0x" + p.hex() for p in proof], "root": b["root"], "valid": ok, "tampered_valid": tampered}


def fab_token(text: str) -> str | None:
    m = re.search(r"fab\s*([a-z0-9]+)", (text or "").lower())
    return m.group(1) if m else None


def facility_summary(operator_address: str, facility: str | None = None, until: int | None = None, days: int = HISTORY_DAYS) -> dict | None:
    """Metered evidence for one operator's facility over a window, used by the AI auditor.
    Meters are matched to the disclosure by fab identifier (e.g. 'Fab 3')."""
    until = until or int(time.time())
    since = until - days * 86400
    tok = fab_token(facility) if facility else None
    devs = [(a, d) for a, d in _db()["devices"].items()
            if chain.actors[d["operator"]]["address"].lower() == operator_address.lower() and (tok is None or fab_token(d["facility"]) == tok)]
    if not devs:
        return None
    out: dict = {"devices": len(devs), "batches": 0, "window_days": days}
    for address, d in devs:
        rs = [(t, v, b["step"]) for b in d["batches"] for t, v in b["readings"] if since <= t <= until]
        out["batches"] += sum(1 for b in d["batches"] if b["toTs"] >= since and b["fromTs"] <= until)
        if not rs:
            continue
        if d["kind"] == "Abatement":
            out["abatement_avg"] = sum(v for _, v, _ in rs) / len(rs) / 10000
            out["abatement_uptime"] = sum(1 for _, v, _ in rs if v >= ABATEMENT_ALERT_BPS) / len(rs)
            out["abatement_device"] = d["facility"]
        elif d["kind"] == "Power":
            out["power_kwh"] = sum(v for _, v, _ in rs) / 1000
        else:
            out["water_l"] = sum(v for _, v, _ in rs)
    return out
