"""Business logic: ties the carbon model, AI auditor, off-chain store and chain together."""
from __future__ import annotations

import json
import logging

from eth_account.messages import encode_defunct
from eth_utils import keccak

from . import merkle, telemetry
from .ai import cache as ai_cache
from .ai import claude, heuristic, verifier
from .ai.schemas import StageDisclosure
from .carbon import model as cm
from .chain import STAGE_ACTOR_ROLE, chain
from .config import settings
from .store import store

log = logging.getLogger(__name__)


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()


def _h(b: bytes) -> str:
    return "0x" + b.hex()


def _hex32(s: str) -> bytes:
    b = bytes.fromhex(s[2:] if s.startswith("0x") else s)
    if len(b) != 32:
        raise ServiceError("expected a 32-byte hex value")
    return b


def sync() -> None:
    store.reset_if_chain_changed(chain.chain_key())


# ------------------------------------------------------------------ passports


def create_passport(design: cm.ChipDesign, lot_code: str, kind: str = "product") -> dict:
    sync()
    est = cm.estimate(design)
    commitment = keccak(_canon(design.model_dump()))
    next_id = chain.next_id()
    uri = f"{settings.public_base_url.rstrip('/')}/api/passports/{next_id}/metadata"
    node = design.dies[0].node if design.dies else "n/a"
    pid, tx = chain.create_passport(design.product, node, design.units, commitment, uri)
    store.put_passport(pid, {
        "id": pid, "lot_code": lot_code, "kind": kind, "design": design.model_dump(), "estimate": est,
        "design_commitment": _h(commitment), "created_tx": tx,
    })
    return {"id": pid, "tx": tx, "estimate": est, "design_commitment": _h(commitment)}


def _disclosure_fields(d: StageDisclosure) -> dict:
    out = {}
    for k, v in d.model_dump().items():
        if v is None or k in ("evidence_quotes", "missing_or_unclear"):
            continue
        if isinstance(v, list):
            if not v:
                continue
            v = "; ".join(map(str, v))
        out[k] = v
    return out


def _design_for(pid: int) -> cm.ChipDesign | None:
    doc = store.passport(pid)
    return cm.ChipDesign(**doc["design"]) if doc.get("design") else None


def submit_stage(pid: int, actor: str, d: StageDisclosure, evidence_hash: str | None = None) -> dict:
    sync()
    stage = d.stage
    if stage == "EndOfLife":
        raise ServiceError("end-of-life records go through /recycle")
    if actor not in chain.keys:
        raise ServiceError(f"no signing key for actor '{actor}'")
    if STAGE_ACTOR_ROLE[stage] not in chain.actors[actor]["roles"]:
        raise ServiceError(f"actor '{actor}' does not hold {STAGE_ACTOR_ROLE[stage]} required for {stage}", 403)

    fields = _disclosure_fields(d)
    tree = merkle.FieldTree(fields)
    ev = _hex32(evidence_hash) if evidence_hash else keccak(_canon(d.model_dump()))
    res = chain.record_stage(
        actor, pid, stage, tree.root, ev,
        carbon_g=round(d.claimed_carbon_kgco2e * 1000),
        energy_wh=round((d.electricity_kwh or 0) * 1000),
        water_l=round(d.water_l or 0),
        facility=f"{d.facility} ({d.location})",
    )
    idx = res["index"]
    store.put_stage(pid, idx, {
        "disclosure": d.model_dump(), "fields": tree.values, "salts": {k: _h(v) for k, v in tree.salts.items()},
        "root": _h(tree.root), "evidence_hash": _h(ev), "evidence_file": bool(evidence_hash),
        "tx": res["tx"], "signature": res["signature"], "attester": res["attester"], "actor": actor,
    })
    audit = run_audit(pid, idx)
    return {"index": idx, "tx": res["tx"], "root": _h(tree.root), "signature": res["signature"], "audit": audit}


# ------------------------------------------------- wallet-signed attestations
# The supplier signs in their own wallet (MetaMask); the server never holds the key.


def prepare_wallet_stage(pid: int, wallet: str, org: str, d: StageDisclosure, evidence_hash: str | None) -> dict:
    import secrets
    sync()
    if d.stage == "EndOfLife":
        raise ServiceError("end-of-life records go through /recycle")
    role = STAGE_ACTOR_ROLE[d.stage]
    if not chain.passport.functions.hasRole(getattr(chain.passport.functions, role)().call(), wallet).call():
        raise ServiceError(f"wallet {wallet} does not hold {role} required for {d.stage}", 403)
    tree = merkle.FieldTree(_disclosure_fields(d))
    ev = _hex32(evidence_hash) if evidence_hash else keccak(_canon(d.model_dump()))
    att = chain.build_attestation(wallet, pid, d.stage, tree.root, ev, round(d.claimed_carbon_kgco2e * 1000),
                                  round((d.electricity_kwh or 0) * 1000), round(d.water_l or 0), f"{d.facility} ({d.location})")
    draft = secrets.token_hex(16)
    store.db.setdefault("drafts", {})[draft] = {
        "pid": pid, "wallet": wallet, "org": org, "att": {k: (_h(v) if isinstance(v, bytes) else v) for k, v in att.items()},
        "disclosure": d.model_dump(), "fields": tree.values, "salts": {k: _h(v) for k, v in tree.salts.items()},
        "root": _h(tree.root), "evidence_hash": _h(ev), "evidence_file": bool(evidence_hash),
    }
    store.save()
    typed = chain.typed_attestation({k: (_h(v) if isinstance(v, bytes) else v) for k, v in att.items()})
    return {"draft": draft, "typedData": typed}


def submit_wallet_stage(draft_id: str, signature: str) -> dict:
    drafts = store.db.get("drafts", {})
    dr = drafts.pop(draft_id, None)
    if not dr:
        raise ServiceError("unknown or already used draft", 404)
    att = {k: (_hex32(v) if k in ("fieldsRoot", "evidenceHash") else v) for k, v in dr["att"].items()}
    try:
        res = chain.relay_stage(att, bytes.fromhex(signature[2:] if signature.startswith("0x") else signature))
    except Exception as e:
        raise ServiceError(f"attestation rejected on-chain: {_revert_reason(e)}") from e
    if res["attester"].lower() != dr["wallet"].lower():
        raise ServiceError("signature does not match the connected wallet", 400)
    idx = res["index"]
    store.put_stage(dr["pid"], idx, {
        "disclosure": dr["disclosure"], "fields": dr["fields"], "salts": dr["salts"], "root": dr["root"], "evidence_hash": dr["evidence_hash"],
        "evidence_file": dr["evidence_file"], "tx": res["tx"], "signature": res["signature"], "attester": res["attester"],
        "actor": None, "wallet_org": dr["org"],
    })
    audit = run_audit(dr["pid"], idx)
    return {"index": idx, "tx": res["tx"], "root": dr["root"], "signature": res["signature"], "audit": audit}


def run_audit(pid: int, idx: int) -> dict:
    s = store.stage(pid, idx)
    d = StageDisclosure(**s["disclosure"])
    p = chain.get_passport(pid)
    ctx = {"product": p["product"], "node": p["processNode"], "units": p["units"], "lot": store.passport(pid).get("lot_code")}
    onchain = chain.get_stages(pid)[idx]
    _, actor = chain.actor_for(onchain["attester"])
    signer_name = actor["name"] if actor else s.get("wallet_org")
    tel = telemetry.facility_summary(onchain["attester"], d.facility, until=onchain["timestamp"])
    design = _design_for(pid)
    k = ai_cache.key("audit", d.model_dump(), design.model_dump() if design else None, s.get("evidence_file", False), ctx, signer_name, tel,
                     settings.claude_model if claude.enabled() else "rules")
    report = ai_cache.get("audit", k)
    if report is None:
        report = verifier.audit_disclosure(d.stage, d, design, s.get("evidence_file", False), ctx, signer_name, tel)
        if not report.get("ai_error"):
            ai_cache.put("audit", k, report, claude.LAST_TOKENS if report["engine"] != "rules+ml" else 0)
    else:
        report["cached"] = True
    report["telemetry"] = tel
    report_hash = keccak(_canon(report))
    tx = chain.attest_ai(pid, idx, report["verdict"], int(report["score"] * 100), report_hash)
    report["report_hash"] = _h(report_hash)
    report["tx"] = tx
    store.update_stage(pid, idx, audit=report)
    return report


def integrate(parent: int, child: int, units: int) -> dict:
    sync()
    return chain.integrate(parent, child, units)


def recycle(pid: int, units: int, d: StageDisclosure, evidence_hash: str | None = None) -> dict:
    sync()
    fields = _disclosure_fields(d)
    tree = merkle.FieldTree(fields)
    ev = _hex32(evidence_hash) if evidence_hash else keccak(_canon(d.model_dump()))
    res = chain.recycle(pid, units, round(d.recovered_material_g or 0), round(d.claimed_carbon_kgco2e * 1000), tree.root, ev,
                        f"{d.facility} ({d.location})")
    store.put_stage(pid, res["index"], {
        "disclosure": d.model_dump(), "fields": tree.values, "salts": {k: _h(v) for k, v in tree.salts.items()},
        "root": _h(tree.root), "evidence_hash": _h(ev), "evidence_file": bool(evidence_hash), "tx": res["tx"], "actor": "recycler",
    })
    res["audit"] = run_audit(pid, res["index"])
    return res


# -------------------------------------------------------------------- credits


def issue_credits(to_actor: str, amount_kg: int, project: str, methodology: str, serial: str, vintage: int, evidence_hash: str | None) -> dict:
    sync()
    ev = _hex32(evidence_hash) if evidence_hash else keccak(serial.encode())
    try:
        return chain.issue_credits(to_actor, amount_kg, project, methodology, serial, vintage, ev)
    except Exception as e:
        raise ServiceError(f"issuance rejected on-chain: {_revert_reason(e)}") from e


def retire_credits(actor: str, batch_id: int, amount_kg: int, pid: int, beneficiary: str) -> dict:
    sync()
    try:
        return chain.retire(actor, batch_id, amount_kg, pid, beneficiary)
    except Exception as e:
        raise ServiceError(f"retirement rejected on-chain: {_revert_reason(e)}") from e


def credits_view() -> dict:
    batches = chain.batches()
    for b in batches:
        b["holders"] = {a: chain.credit_balance(a, b["batchId"]) for a in ("oem", "designer")}
    return {"batches": batches, "retirements": chain.retirements()}


def _revert_reason(e: Exception) -> str:
    msg = str(e)
    for name in ("OffsetExceedsFootprint", "SerialAlreadyTokenized", "ERC1155InsufficientBalance", "ComponentOverAllocated", "NotActive",
                 "BadNonce", "NotAuthorizedAttester", "Expired", "StageOutOfOrder", "ComponentMustPredateParent", "RecycleExceedsUnits"):
        if name in msg:
            return name
    data = getattr(e, "data", None) or (e.args[1] if len(e.args) > 1 else None)
    if isinstance(data, str) and data.startswith("0x") and len(data) >= 10:
        abis = chain.passport.abi + chain.registry.abi
        from eth_utils import function_signature_to_4byte_selector
        for item in abis:
            if item.get("type") == "error":
                sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
                if _h(function_signature_to_4byte_selector(sig)) == data[:10]:
                    return item["name"]
    return msg[:200]


# ---------------------------------------------------------------------- views


def _verify_stage_integrity(s: dict, onchain_root: str) -> bool:
    if not s.get("fields"):
        return False
    tree = merkle.FieldTree(s["fields"], {k: _hex32(v) for k, v in s["salts"].items()})
    return _h(tree.root) == onchain_root


def passport_view(pid: int, depth: int = 0) -> dict:
    sync()
    try:
        p = chain.get_passport(pid)
    except Exception as e:
        raise ServiceError(f"passport {pid} not found", 404) from e
    doc = store.passport(pid)
    stages = chain.get_stages(pid)
    for st in stages:
        s = store.stage(pid, st["index"])
        st["disclosure"] = s.get("disclosure")
        st["audit"] = s.get("audit")
        st["tx"] = s.get("tx")
        st["signature"] = s.get("signature")
        st["actor"] = s.get("actor")
        st["evidence_file"] = s.get("evidence_file")
        st["integrity"] = _verify_stage_integrity(s, st["fieldsRoot"]) if s else None
        st["disclosable_fields"] = sorted(s.get("fields", {}).keys())
    components = chain.get_components(pid)
    if depth < 3:
        for c in components:
            sub = passport_view(c["childId"], depth + 1)
            c["product"] = sub["product"]
            c["node"] = sub["processNode"]
            c["lot_code"] = sub.get("lot_code")
            c["child_units"] = sub["units"]
            c["verifiedShareBps"] = sub["verifiedShareBps"]
            c["components"] = sub["components"]
            c["carbonAtRiskG"] = sub["carbonAtRiskG"]
    # Carbon at risk: where the AI auditor flagged/rejected a record whose
    # independent estimate exceeds the claim, the gap is unverified carbon that
    # also flows pro-rata into every product that integrates this lot.
    at_risk = 0.0
    for st in stages:
        rules = (st.get("audit") or {}).get("rules") or {}
        if st["verdict"] in ("Flagged", "Rejected") and rules.get("expected_g"):
            at_risk += max(0.0, rules["expected_g"] - st["carbonG"])
    for c in components:
        if "carbonAtRiskG" in c:
            at_risk += c["carbonAtRiskG"] * c["units"] / c["child_units"]
    retirements = [r for r in chain.retirements() if r["passportId"] == pid]
    total = p["totalCarbonG"]
    est = doc.get("estimate")
    p.update({
        "id": pid,
        "lot_code": doc.get("lot_code"),
        "kind": doc.get("kind"),
        "design": doc.get("design"),
        "estimate": est,
        "created_tx": doc.get("created_tx"),
        "stages": stages,
        "components": components,
        "retirements": retirements,
        "perUnitG": total / p["units"] if p["units"] else 0,
        "carbonAtRiskG": at_risk,
        "netCarbonG": total - p["offsetG"],
        "estimateCarbonG": est["per_unit"]["carbon_g"] * p["units"] if est else None,
        "contract": chain.passport.address,
        "chainId": chain.deployment["chainId"],
    })
    if depth == 0:
        p["recommendations"] = cm.recommendations(cm.ChipDesign(**doc["design"])) if doc.get("design") else []
        from . import datacenter
        try:
            use = datacenter.lifecycle(pid)
            p["usePhase"] = use if use["unitsDeployed"] else None
        except Exception:  # ledger not deployed (older deployments)
            p["usePhase"] = None
    return p


def list_passports() -> list[dict]:
    sync()
    out = []
    for pid in range(1, chain.next_id()):
        p = chain.get_passport(pid)
        stages = chain.get_stages(pid)
        doc = store.passport(pid)
        out.append({
            "id": pid, "product": p["product"], "processNode": p["processNode"], "units": p["units"], "status": p["status"],
            "lot_code": doc.get("lot_code"), "kind": doc.get("kind"), "totalCarbonG": p["totalCarbonG"], "offsetG": p["offsetG"],
            "waterL": p["waterL"], "energyWh": p["energyWh"], "verifiedShareBps": p["verifiedShareBps"], "stageCount": len(stages),
            "lastStage": stages[-1]["stage"] if stages else None, "flags": sum(1 for s in stages if s["verdict"] in ("Flagged", "Rejected")),
            "unitsAllocated": p["unitsAllocated"], "createdAt": p["createdAt"],
        })
    return out


def stats() -> dict:
    ps = list_passports()
    # Avoid double counting in totals: only count each lot's own footprint
    own = sum(chain.get_passport(p["id"])["ownCarbonG"] for p in ps)
    stages = [s for p in ps for s in chain.get_stages(p["id"])]
    verdicts = {v: sum(1 for s in stages if s["verdict"] == v) for v in ("Verified", "Flagged", "Rejected", "Pending")}
    return {
        "passports": len(ps),
        "stage_records": len(stages),
        "total_carbon_t": own / 1e6,
        "total_offset_t": sum(p["offsetG"] for p in ps) / 1e6,
        "total_water_m3": sum(p["waterL"] for p in ps) / 1000,
        "total_energy_mwh": sum(p["energyWh"] for p in ps) / 1e6,
        "verdicts": verdicts,
        "circ_supply": chain.circ.functions.totalSupply().call() / 1e18,
        "credit_batches": chain.registry.functions.batchCount().call(),
    }


def disclose(pid: int, idx: int, key: str) -> dict:
    s = store.stage(pid, idx)
    if not s or key not in s.get("fields", {}):
        raise ServiceError("field not found", 404)
    tree = merkle.FieldTree(s["fields"], {k: _hex32(v) for k, v in s["salts"].items()})
    out = tree.disclosure(key)
    out.update({"passportId": pid, "index": idx, "contract": chain.passport.address, "chainId": chain.deployment["chainId"]})
    return out


def verify_disclosure(pid: int, idx: int, key: str, value: str, salt: str, proof: list[str]) -> dict:
    ok = chain.verify_field(pid, idx, key, value, _hex32(salt), [_hex32(x) for x in proof])
    return {"valid": ok, "checked_on_chain": True, "contract": chain.passport.address}


def dpp_credential(pid: int) -> dict:
    """Digital Product Passport as a W3C Verifiable-Credential-shaped document,
    signed by the registrar key and anchored to on-chain records."""
    p = passport_view(pid)
    subject = {
        "id": f"did:pkh:eip155:{p['chainId']}:{p['contract']}#{pid}",
        "product": p["product"], "lot": p.get("lot_code"), "processNode": p["processNode"], "units": p["units"],
        "status": p["status"],
        "carbonFootprint": {"totalKgCO2e": p["totalCarbonG"] / 1000, "perUnitGCO2e": round(p["perUnitG"], 1),
                            "offsetKgCO2e": p["offsetG"] / 1000, "verifiedShare": p["verifiedShareBps"] / 10000,
                            "standard": "ISO 14067 cradle-to-gate; GHG Protocol Product Standard"},
        "waterLitres": p["waterL"], "energyKWh": p["energyWh"] / 1000,
        "lifecycle": [{"stage": s["stage"], "facility": s["facility"], "attester": s["attester"], "carbonKg": s["carbonG"] / 1000,
                       "verdict": s["verdict"], "fieldsRoot": s["fieldsRoot"], "evidenceHash": s["evidenceHash"]} for s in p["stages"]],
        "components": [{"passport": c["childId"], "product": c.get("product"), "units": c["units"], "carbonKg": c["carbonG"] / 1000} for c in p["components"]],
    }
    vc = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "type": ["VerifiableCredential", "DigitalProductPassport", "SemiconductorCarbonPassport"],
        "issuer": f"did:pkh:eip155:{p['chainId']}:{chain.actors['registrar']['address']}",
        "credentialSubject": subject,
    }
    digest = keccak(_canon(vc))
    sig = chain.keys["registrar"].sign_message(encode_defunct(primitive=digest)).signature.hex() if "registrar" in chain.keys else None
    vc["proof"] = {"type": "EthereumPersonalSignature", "digest": _h(digest), "signature": sig if not sig or sig.startswith("0x") else "0x" + sig,
                   "verificationMethod": vc["issuer"]}
    return vc


def copilot(pid: int | None, question: str) -> dict:
    if pid:
        p = passport_view(pid)
        ctx = {k: p[k] for k in ("id", "product", "lot_code", "processNode", "units", "status", "totalCarbonG", "perUnitG", "offsetG",
                                 "netCarbonG", "waterL", "energyWh", "verifiedShareBps", "estimateCarbonG", "components", "retirements")}
        ctx["stages"] = [{k: s.get(k) for k in ("stage", "facility", "carbonG", "verdict", "aiScore")} | {"audit_summary": (s.get("audit") or {}).get("summary")} for s in p["stages"]]
        ctx["hotspots"] = (p.get("estimate") or {}).get("hotspots")
        ctx["recommendations"] = p.get("recommendations", [])[:4]
    else:
        ctx = {"fleet": stats(), "passports": list_passports()}
    k = ai_cache.key("copilot", ctx, question.strip().lower(), settings.claude_model if claude.enabled() else "offline")
    hit = ai_cache.get("copilot", k)
    if hit:
        return {**hit, "cached": True}
    if claude.enabled():
        try:
            ans, model = claude.copilot(question, ctx)
            out = {"answer": ans.answer, "cited_fields": ans.cited_fields, "engine": model}
            ai_cache.put("copilot", k, out, claude.LAST_TOKENS)
            return out
        except Exception as e:
            log.warning("copilot failed: %s", e)
    return {"answer": _offline_answer(question, ctx), "cited_fields": [], "engine": "offline"}


def _offline_answer(q: str, ctx: dict) -> str:
    if "product" not in ctx:
        s = ctx["fleet"]
        return (f"The registry tracks {s['passports']} passports with {s['total_carbon_t']:.1f} t CO2e of embodied carbon, "
                f"{s['total_offset_t']:.1f} t offset via retired credits, and {s['verdicts']['Flagged'] + s['verdicts']['Rejected']} stage records needing review. "
                "Set ANTHROPIC_API_KEY for conversational answers.")
    parts = [f"{ctx['product']} (lot {ctx.get('lot_code')}) carries {ctx['totalCarbonG'] / 1000:,.0f} kg CO2e ({ctx['perUnitG'] / 1000:,.2f} kg per unit)."]
    flagged = [s for s in ctx["stages"] if s["verdict"] in ("Flagged", "Rejected")]
    if flagged:
        parts.append("Needs review: " + ", ".join(f"{s['stage']} at {s['facility']} ({s['verdict']})" for s in flagged) + ".")
    if ctx.get("recommendations"):
        r = ctx["recommendations"][0]
        parts.append(f"Biggest lever: {r['lever']} (−{r['saving_pct']:.0f}%).")
    return " ".join(parts)


def extract(doc: bytes, filename: str, stage_hint: str | None) -> dict:
    engine = settings.claude_model if claude.enabled() else "heuristic"
    k = ai_cache.key(doc, stage_hint or "", engine)
    hit = ai_cache.get("extract", k)
    if hit:
        return {**hit, "cached": True}
    out = _extract(doc, filename, stage_hint)
    if not out.get("ai_error"):
        ai_cache.put("extract", k, out, claude.LAST_TOKENS if out["engine"] != "heuristic" else 0)
    return out


def _extract(doc: bytes, filename: str, stage_hint: str | None) -> dict:
    if claude.enabled():
        try:
            d, model = claude.extract_disclosure(doc, filename, stage_hint)
            return {"disclosure": d.model_dump(), "engine": model}
        except Exception as e:
            log.warning("Claude extraction failed, using heuristic parser: %s", e)
            err = str(e)[:200]
    else:
        err = None
    d = heuristic.extract(doc, filename, stage_hint)
    return {"disclosure": d.model_dump(), "engine": "heuristic", "ai_error": err}


# ------------------------------------------------------------------ suppliers


def suppliers() -> list[dict]:
    """Every attesting organisation with its on-chain trust score and activity."""
    records: dict[str, int] = {}
    for p in range(1, chain.next_id()):
        for st in chain.get_stages(p):
            records[st["attester"].lower()] = records.get(st["attester"].lower(), 0) + 1
    devices = telemetry.devices_view() if store.db.get("telemetry") else []
    out = []
    for key, a in chain.actors.items():
        roles = [r for r in a["roles"] if r in ("DESIGNER_ROLE", "FAB_ROLE", "OSAT_ROLE", "LOGISTICS_ROLE", "RECYCLER_ROLE")]
        if not roles:
            continue
        t = chain.supplier_trust(a["address"])
        out.append({"key": key, "name": a["name"], "address": a["address"], "roles": roles, "records": records.get(a["address"].lower(), 0),
                    "meters": sum(1 for d in devices if d["operator"] == key), **t})
    return sorted(out, key=lambda x: (-x["scoreBps"], -x["records"]))


# ------------------------------------------------------------- Scope 3 report


def _verified_carbon(p: dict) -> float:
    """Carbon backed by AI-verified primary data, including components pro-rata."""
    own = sum(s["carbonG"] for s in p["stages"] if s["verdict"] == "Verified")
    inherited = sum(c["carbonG"] * (c.get("verifiedShareBps") or 0) / 10000 for c in p["components"])
    return own + inherited


def scope3_report(owner_actor: str = "oem") -> dict:
    """GHG Protocol Scope 3, Category 1 (purchased goods) view for a hardware buyer.
    Offsets are reported separately and never netted, per the GHG Protocol."""
    sync()
    owner = chain.actors[owner_actor]["address"].lower()
    rows = []
    for pid in range(1, chain.next_id()):
        doc = store.passport(pid)
        if doc.get("kind") != "product":
            continue
        p = passport_view(pid)
        if p["owner"].lower() != owner:
            continue
        total = p["totalCarbonG"]
        verified = _verified_carbon(p)
        share = verified / total if total else 0
        quality = "High" if share >= 0.9 and p["carbonAtRiskG"] == 0 else "Medium" if share >= 0.7 else "Low"
        rows.append({
            "passportId": pid, "product": p["product"], "lot": p.get("lot_code"), "units": p["units"], "status": p["status"],
            "emissions_t": total / 1e6, "per_unit_kg": p["perUnitG"] / 1000, "primary_verified_share": share,
            "carbon_at_risk_t": p["carbonAtRiskG"] / 1e6, "conservative_t": (total + p["carbonAtRiskG"]) / 1e6,
            "offsets_retired_t": p["offsetG"] / 1e6, "data_quality": quality,
            "stages": len(p["stages"]), "components": len(p["components"]),
        })
    tot = lambda k: sum(r[k] for r in rows)
    em = tot("emissions_t")
    return {
        "organisation": chain.actors[owner_actor]["name"],
        "category": "Scope 3 Category 1 - Purchased goods and services (semiconductors)",
        "method": "Supplier-specific, cradle-to-gate (ISO 14067) primary data anchored on-chain; AI-verified share reported as data-quality indicator",
        "rows": rows,
        "totals": {
            "emissions_t": em, "conservative_t": tot("conservative_t"), "carbon_at_risk_t": tot("carbon_at_risk_t"),
            "offsets_retired_t": tot("offsets_retired_t"),
            "primary_verified_share": (sum(r["emissions_t"] * r["primary_verified_share"] for r in rows) / em) if em else 0,
        },
        "notes": [
            "Offsets are disclosed separately and are not deducted from gross Scope 3 emissions (GHG Protocol).",
            "Conservative total adds carbon at risk: the gap between independent estimates and under-reported, flagged supplier records.",
            "Each figure is traceable to a GreenSilicon passport, its signed stage records and evidence hashes.",
        ],
    }


def scope3_csv(owner_actor: str = "oem") -> str:
    import csv
    import io
    r = scope3_report(owner_actor)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["# " + r["category"]])
    w.writerow(["# Reporting organisation: " + r["organisation"]])
    cols = ["passportId", "product", "lot", "units", "emissions_t", "per_unit_kg", "primary_verified_share", "carbon_at_risk_t",
            "conservative_t", "offsets_retired_t", "data_quality"]
    w.writerow(cols)
    for row in r["rows"]:
        w.writerow([round(row[c], 4) if isinstance(row[c], float) else row[c] for c in cols])
    t = r["totals"]
    w.writerow(["TOTAL", "", "", "", round(t["emissions_t"], 4), "", round(t["primary_verified_share"], 4), round(t["carbon_at_risk_t"], 4),
                round(t["conservative_t"], 4), round(t["offsets_retired_t"], 4), ""])
    for n in r["notes"]:
        w.writerow(["# " + n])
    return buf.getvalue()
