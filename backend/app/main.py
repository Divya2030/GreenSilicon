from __future__ import annotations

import logging
import re

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import datacenter, service, telemetry
from .ai import claude
from .ai.schemas import StageDisclosure
from .carbon import model as cm
from .chain import chain
from .config import settings
from .store import store

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="GreenSilicon API",
    description="Blockchain + AI Digital Product Passports for semiconductors (IEEE ClimateChain 2026).",
    version="1.0.0",
)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])

MAX_UPLOAD = 15 * 1024 * 1024
HASH_RE = re.compile(r"^0x[0-9a-f]{64}$")


@app.exception_handler(service.ServiceError)
async def service_error(_: Request, e: service.ServiceError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


# ---------------------------------------------------------------- system


@app.get("/api/health")
def health():
    return {"ok": True, "chain": chain.connected(), "ai": claude.enabled()}


@app.get("/api/config")
def config():
    d = chain.deployment
    return {
        "chainId": d["chainId"], "network": d["network"], "rpcUrl": settings.rpc_url,
        "contracts": {k: v["address"] for k, v in d["contracts"].items()},
        "actors": d["actors"],
        "ai": {"enabled": claude.enabled(), "model": settings.claude_model if claude.enabled() else None},
    }


@app.get("/api/abi/{name}")
def abi(name: str):
    c = chain.deployment["contracts"].get(name)
    if not c:
        raise HTTPException(404)
    return c["abi"]


# ---------------------------------------------------------------- carbon


@app.get("/api/reference")
def reference():
    return cm.reference_summary()


@app.post("/api/carbon/estimate")
def estimate(design: cm.ChipDesign):
    try:
        return {"estimate": cm.estimate(design), "recommendations": cm.recommendations(design)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/carbon/explore")
def explore(design: cm.ChipDesign):
    return cm.explore(design)


ZONES = {"taiwan": "TW", "south_korea": "KR", "japan": "JP-TK", "usa": "US-SW-AZPS", "europe": "DE", "singapore": "SG", "india": "IN-WE"}


@app.get("/api/grid/{location}")
def grid(location: str):
    """Live grid intensity via Electricity Maps if a token is configured, else the 2023 annual average."""
    static = cm.ref()["grid"].get(location)
    if static is None:
        raise HTTPException(404, "unknown location")
    zone = ZONES.get(location)
    if settings.electricitymaps_token and zone:
        try:
            r = httpx.get("https://api.electricitymap.org/v3/carbon-intensity/latest", params={"zone": zone},
                          headers={"auth-token": settings.electricitymaps_token}, timeout=8)
            r.raise_for_status()
            j = r.json()
            return {"location": location, "zone": zone, "gco2_per_kwh": j["carbonIntensity"], "source": "Electricity Maps (live)", "datetime": j.get("datetime")}
        except Exception as e:
            logging.warning("electricity maps: %s", e)
    return {"location": location, "zone": zone, "gco2_per_kwh": static, "source": "Ember 2023 annual average"}


# ------------------------------------------------------------- passports


class CreatePassport(BaseModel):
    design: cm.ChipDesign
    lot_code: str = Field(..., max_length=64)
    kind: str = "product"


@app.get("/api/passports")
def passports():
    return service.list_passports()


@app.post("/api/passports")
def create(req: CreatePassport):
    return service.create_passport(req.design, req.lot_code, req.kind)


@app.get("/api/passports/{pid}")
def passport(pid: int):
    return service.passport_view(pid)


@app.get("/api/passports/{pid}/metadata")
def metadata(pid: int):
    """ERC-721 metadata (tokenURI target)."""
    p = service.passport_view(pid)
    return {
        "name": f"{p['product']} · lot {p.get('lot_code')}",
        "description": "GreenSilicon digital product passport for a semiconductor production lot.",
        "external_url": f"{settings.public_base_url}/passport/{pid}",
        "attributes": [
            {"trait_type": "Process node", "value": p["processNode"]},
            {"trait_type": "Units", "value": p["units"]},
            {"trait_type": "Carbon (kg CO2e)", "value": round(p["totalCarbonG"] / 1000, 1)},
            {"trait_type": "Verified share", "value": p["verifiedShareBps"] / 100},
            {"trait_type": "Status", "value": p["status"]},
        ],
    }


@app.get("/api/passports/{pid}/dpp")
def dpp(pid: int):
    return service.dpp_credential(pid)


@app.post("/api/passports/{pid}/stages")
def submit_stage(pid: int, actor: str, disclosure: StageDisclosure, evidence_hash: str | None = None):
    if evidence_hash and not HASH_RE.match(evidence_hash):
        raise HTTPException(400, "bad evidence hash")
    return service.submit_stage(pid, actor, disclosure, evidence_hash)


class WalletPrepare(BaseModel):
    wallet: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    organisation: str = Field("", max_length=120)
    disclosure: StageDisclosure
    evidence_hash: str | None = None


class WalletSubmit(BaseModel):
    draft: str = Field(pattern=r"^[0-9a-f]{32}$")
    signature: str = Field(pattern=r"^0x[0-9a-fA-F]{130}$")


@app.post("/api/passports/{pid}/stages/wallet/prepare")
def wallet_prepare(pid: int, req: WalletPrepare):
    from web3 import Web3
    if req.evidence_hash and not HASH_RE.match(req.evidence_hash):
        raise HTTPException(400, "bad evidence hash")
    return service.prepare_wallet_stage(pid, Web3.to_checksum_address(req.wallet), req.organisation, req.disclosure, req.evidence_hash)


@app.post("/api/stages/wallet/submit")
def wallet_submit(req: WalletSubmit):
    return service.submit_wallet_stage(req.draft, req.signature)


class DevRole(BaseModel):
    wallet: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    role: str


@app.post("/api/dev/grant-role")
def dev_grant_role(req: DevRole):
    """Local demo chain only: let a judge's own wallet act as a supplier."""
    if chain.deployment["chainId"] != 31337:
        raise HTTPException(403, "only available on the local demo chain")
    if req.role not in ("DESIGNER_ROLE", "FAB_ROLE", "OSAT_ROLE", "LOGISTICS_ROLE"):
        raise HTTPException(400, "unsupported role")
    return {"tx": chain.grant_role(req.role, req.wallet)}


@app.post("/api/passports/{pid}/stages/{idx}/reaudit")
def reaudit(pid: int, idx: int):
    return service.run_audit(pid, idx)


class Integrate(BaseModel):
    child_id: int
    units: int = Field(gt=0)


@app.post("/api/passports/{pid}/components")
def integrate(pid: int, req: Integrate):
    try:
        return service.integrate(pid, req.child_id, req.units)
    except Exception as e:
        raise HTTPException(400, f"integration rejected on-chain: {service._revert_reason(e)}")


class Recycle(BaseModel):
    units: int = Field(gt=0)
    disclosure: StageDisclosure
    evidence_hash: str | None = None


@app.post("/api/passports/{pid}/recycle")
def recycle(pid: int, req: Recycle):
    try:
        return service.recycle(pid, req.units, req.disclosure, req.evidence_hash)
    except service.ServiceError:
        raise
    except Exception as e:
        raise HTTPException(400, f"recycling rejected on-chain: {service._revert_reason(e)}")


@app.get("/api/passports/{pid}/stages/{idx}/disclose/{key}")
def disclose(pid: int, idx: int, key: str):
    return service.disclose(pid, idx, key)


class VerifyField(BaseModel):
    passportId: int
    index: int
    key: str
    value: str
    salt: str
    proof: list[str]


@app.post("/api/verify/field")
def verify_field(req: VerifyField):
    return service.verify_disclosure(req.passportId, req.index, req.key, req.value, req.salt, req.proof)


# -------------------------------------------------------------- evidence + AI


@app.post("/api/evidence")
async def upload_evidence(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "file too large")
    return {"evidence_hash": store.put_evidence(data, file.filename or "evidence"), "bytes": len(data), "filename": file.filename}


@app.get("/api/evidence/{h}")
def get_evidence(h: str):
    if not HASH_RE.match(h):
        raise HTTPException(400, "bad hash")
    got = store.evidence(h)
    if not got:
        raise HTTPException(404)
    data, name = got
    media = "application/pdf" if name.lower().endswith(".pdf") else "text/plain; charset=utf-8"
    return Response(data, media_type=media, headers={"Content-Disposition": f'inline; filename="{name}"'})


@app.post("/api/extract")
async def extract(file: UploadFile = File(...), stage: str | None = Form(None)):
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "file too large")
    h = store.put_evidence(data, file.filename or "evidence")
    out = service.extract(data, file.filename or "evidence.txt", stage)
    out["evidence_hash"] = h
    return out


class Ask(BaseModel):
    question: str = Field(..., max_length=1000)
    passport_id: int | None = None


@app.post("/api/copilot")
def ask(req: Ask):
    return service.copilot(req.passport_id, req.question)


# ---------------------------------------------------------------- credits


class Issue(BaseModel):
    to_actor: str = "oem"
    amount_kg: int = Field(gt=0)
    project: str
    methodology: str
    serial: str
    vintage: int
    evidence_hash: str | None = None


class Retire(BaseModel):
    actor: str = "oem"
    batch_id: int
    amount_kg: int = Field(gt=0)
    passport_id: int
    beneficiary: str


@app.get("/api/credits")
def credits():
    return service.credits_view()


@app.post("/api/credits/issue")
def issue(req: Issue):
    return service.issue_credits(req.to_actor, req.amount_kg, req.project, req.methodology, req.serial, req.vintage, req.evidence_hash)


@app.post("/api/credits/retire")
def retire(req: Retire):
    return service.retire_credits(req.actor, req.batch_id, req.amount_kg, req.passport_id, req.beneficiary)


# --------------------------------------------------------------- dashboard


@app.get("/api/stats")
def stats():
    return service.stats()


@app.get("/api/activity")
def activity(limit: int = 40):
    return chain.activity(min(limit, 200))


@app.get("/api/actors/{name}")
def actor(name: str):
    a = chain.actors.get(name)
    if not a:
        raise HTTPException(404)
    return {**a, "circ": chain.circ_balance(a["address"])}


# --------------------------------------------------------------- telemetry


def _device(address: str) -> str:
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        raise HTTPException(400, "bad device address")
    from web3 import Web3
    return Web3.to_checksum_address(address)


@app.get("/api/telemetry/devices")
def telemetry_devices():
    return {"devices": telemetry.devices_view(), "live": telemetry.live.running, "contract": chain.telemetry.address}


@app.get("/api/telemetry/series/{address}")
def telemetry_series(address: str, mode: str = "history", limit: int = 700):
    try:
        return telemetry.series(_device(address), "live" if mode == "live" else "history", min(limit, 2000))
    except KeyError:
        raise HTTPException(404, "unknown device")


@app.get("/api/telemetry/batches/{address}")
def telemetry_batches(address: str):
    return telemetry.batches(_device(address))


@app.get("/api/telemetry/alerts")
def telemetry_alerts(limit: int = 50):
    return telemetry.alerts(min(limit, 500))


@app.get("/api/telemetry/prove/{address}/{index}/{i}")
def telemetry_prove(address: str, index: int, i: int):
    try:
        return telemetry.prove(_device(address), index, i)
    except (KeyError, IndexError):
        raise HTTPException(404, "reading not found")


class Live(BaseModel):
    on: bool


@app.post("/api/telemetry/live")
def telemetry_live(req: Live):
    telemetry.live.start() if req.on else telemetry.live.stop()
    return {"live": req.on}


@app.post("/api/telemetry/fault/{address}")
def telemetry_fault(address: str):
    a = _device(address)
    if a not in store.db.get("telemetry", {}).get("devices", {}):
        raise HTTPException(404, "unknown device")
    telemetry.live.inject_fault(a)
    telemetry.live.start()
    return {"injected": a}


# ---------------------------------------------------------------- use phase


@app.get("/api/compute")
def compute_fleet():
    return datacenter.fleet_view()


@app.get("/api/compute/forecast")
def compute_forecast(hours: int = 48):
    return datacenter.forecast(min(max(hours, 1), 168))


class ScheduleReq(BaseModel):
    accelerators: int = Field(gt=0, le=10000)
    hours: int = Field(gt=0, le=720)
    window_hours: int = Field(ge=1, le=168)
    water_weight: float = Field(0.3, ge=0, le=1)
    home: str = "PHX-1"
    allowed: list[str] | None = None
    cache_hit_rate: float = Field(0.0, ge=0, lt=1)


@app.post("/api/compute/schedule")
def compute_schedule(req: ScheduleReq):
    try:
        return datacenter.schedule(req.accelerators, req.hours, max(req.window_hours, req.hours), req.water_weight, req.home, req.allowed,
                                   load=1 - req.cache_hit_rate)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


class RunReq(BaseModel):
    name: str = Field(..., max_length=120)
    cache_hit_rate: float = Field(0.0, ge=0, lt=1)
    parent_cert: int | None = Field(None, ge=0)
    model: str | None = Field(None, max_length=200)
    dataset: str | None = Field(None, max_length=200)
    params: str = Field("", max_length=300)
    customer: str = "lumen"
    code: str
    accelerators: int = Field(gt=0)
    hours: int = Field(gt=0, le=720)
    start: int
    baseline_g: float = Field(ge=0)
    scheduled: bool = True


@app.post("/api/compute/run")
def compute_run(req: RunReq):
    if req.customer not in datacenter.CUSTOMERS:
        raise HTTPException(400, "unknown customer")
    try:
        work = (req.model, req.dataset, req.params) if req.model and req.dataset else None
        return datacenter.certify(req.name, req.customer, req.code, req.accelerators, req.hours, req.start, req.baseline_g, req.scheduled,
                                  load=1 - req.cache_hit_rate, work=work, parent_cert=req.parent_cert)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"certification rejected on-chain: {service._revert_reason(e)}")


class RefreshReq(BaseModel):
    old_units: int = Field(1000, gt=0)
    old_kw: float = Field(0.45, gt=0)
    old_perf: float = Field(0.3, gt=0)
    new_kw: float = Field(datacenter.IT_KW_PER_ACCEL, gt=0)
    new_perf: float = Field(1.0, gt=0)
    code: str = "PHX-1"


@app.post("/api/compute/refresh")
def compute_refresh(req: RefreshReq):
    try:
        return datacenter.refresh(req.old_units, req.old_kw, req.old_perf, req.new_kw, req.new_perf, req.code)
    except KeyError:
        raise HTTPException(404, "unknown data center")


class ReuseReq(BaseModel):
    model: str = Field(..., max_length=200)
    dataset: str = Field(..., max_length=200)
    params: str = Field("", max_length=300)
    customer: str = "lumen"
    name: str = Field("Reused result", max_length=120)


@app.post("/api/compute/reuse/check")
def compute_reuse_check(req: ReuseReq):
    return datacenter.check_reuse(req.model, req.dataset, req.params)


@app.post("/api/compute/reuse")
def compute_reuse(req: ReuseReq):
    if req.customer not in datacenter.CUSTOMERS:
        raise HTTPException(400, "unknown customer")
    try:
        return datacenter.reuse(req.model, req.dataset, req.params, req.customer, req.name)
    except Exception as e:
        raise HTTPException(400, f"reuse rejected on-chain: {service._revert_reason(e)}")


@app.get("/api/compute/cooling/{code}")
def compute_cooling(code: str, it_mwh: float = 5000.0):
    try:
        return datacenter.cooling_options(code, min(max(it_mwh, 1), 1e6))
    except KeyError:
        raise HTTPException(404, "unknown data center")


class InferenceReq(BaseModel):
    queries_per_day: float = Field(10_000_000, gt=0, le=1e11)
    cache_hit_rate: float = Field(0.3, ge=0, lt=1)
    small_model_share: float = Field(0.5, ge=0, le=1)
    small_model_cost: float = Field(0.15, gt=0, le=1)
    speculative_speedup: float = Field(1.6, ge=1, le=4)
    quantization_factor: float = Field(0.85, gt=0, le=1)
    output_tokens_factor: float = Field(0.8, gt=0, le=1)
    code: str = "PHX-1"


@app.post("/api/compute/inference")
def compute_inference(req: InferenceReq):
    try:
        return datacenter.inference_plan(**req.model_dump())
    except KeyError:
        raise HTTPException(404, "unknown data center")


@app.get("/api/ai/cache")
def ai_cache_stats():
    from .ai import cache as ai_cache
    return ai_cache.stats()


@app.get("/api/passports/{pid}/lifecycle")
def passport_lifecycle(pid: int):
    return datacenter.lifecycle(pid)


# ---------------------------------------------------------- suppliers + report


@app.get("/api/suppliers")
def suppliers():
    return service.suppliers()


@app.get("/api/report/scope3")
def scope3(owner: str = "oem"):
    if owner not in chain.actors:
        raise HTTPException(404)
    return service.scope3_report(owner)


@app.get("/api/report/scope3.csv")
def scope3_csv(owner: str = "oem"):
    if owner not in chain.actors:
        raise HTTPException(404)
    return Response(service.scope3_csv(owner), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="greensilicon-scope3-cat1.csv"'})


# ------------------------------------------------------------ demo samples

SAMPLES_DIR = settings.data_dir.parent.parent / "demo" / "documents"


@app.get("/api/samples")
def samples():
    if not SAMPLES_DIR.exists():
        return []
    return sorted(p.name for p in SAMPLES_DIR.iterdir() if p.suffix in (".txt", ".pdf"))


@app.get("/api/samples/{name}")
def sample(name: str):
    if not re.fullmatch(r"[\w.\-]+", name) or name not in samples():
        raise HTTPException(404)
    p = SAMPLES_DIR / name
    media = "application/pdf" if p.suffix == ".pdf" else "text/plain; charset=utf-8"
    return Response(p.read_bytes(), media_type=media)


# ------------------------------------------------------------ read-only RPC relay
# Lets the browser verifier talk to the chain when it runs behind this server.
# Only read methods are forwarded; the verifier can also point at any public RPC.

READ_METHODS = {"eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getLogs", "eth_getBlockByNumber", "eth_getTransactionReceipt"}


@app.post("/rpc")
async def rpc(request: Request):
    body = await request.json()
    calls = body if isinstance(body, list) else [body]
    if len(calls) > 50 or any(not isinstance(c, dict) or c.get("method") not in READ_METHODS for c in calls):
        raise HTTPException(403, "only read-only JSON-RPC methods are relayed")
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(settings.rpc_url, json=body)
    return JSONResponse(r.json(), status_code=r.status_code)


# ------------------------------------------------------------ static frontend
# In production the built React app is served from the same origin.

from pathlib import Path  # noqa: E402

from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = (DIST / path).resolve()
        if path and f.is_file() and DIST in f.parents:
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
