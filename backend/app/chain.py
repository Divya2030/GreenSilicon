"""web3 client for the GreenSilicon contracts.

Supply-chain actors sign EIP-712 stage attestations with their own keys; the
registrar relays them (suppliers never need gas or a wallet integration).
"""
from __future__ import annotations

import json
import os
import threading
import time
from functools import cached_property

from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3
from web3.logs import DISCARD

from .config import HARDHAT_MNEMONIC, settings

Account.enable_unaudited_hdwallet_features()

STAGES = ["Design", "WaferFab", "Assembly", "Test", "Logistics", "EndOfLife"]
VERDICTS = ["Pending", "Verified", "Flagged", "Rejected"]
STATUSES = ["Active", "Integrated", "Recycled"]
STAGE_ACTOR_ROLE = {"Design": "DESIGNER_ROLE", "WaferFab": "FAB_ROLE", "Assembly": "OSAT_ROLE", "Test": "OSAT_ROLE", "Logistics": "LOGISTICS_ROLE"}


class Chain:
    def __init__(self) -> None:
        self.w3 = Web3(Web3.HTTPProvider(settings.rpc_url, request_kwargs={"timeout": 30}))
        self._send_lock = threading.Lock()  # API requests and the live telemetry feed share signer nonces

    # ------------------------------------------------------------ setup
    @cached_property
    def deployment(self) -> dict:
        return json.loads(settings.deployment_file.read_text())

    def reload(self) -> None:
        for k in ("deployment", "passport", "registry", "circ", "telemetry", "compute", "keys"):
            self.__dict__.pop(k, None)

    def _contract(self, name: str):
        c = self.deployment["contracts"][name]
        return self.w3.eth.contract(address=Web3.to_checksum_address(c["address"]), abi=c["abi"])

    @cached_property
    def passport(self):
        return self._contract("GreenSiliconPassport")

    @cached_property
    def registry(self):
        return self._contract("CarbonCreditRegistry")

    @cached_property
    def circ(self):
        return self._contract("CircularityToken")

    @cached_property
    def telemetry(self):
        return self._contract("TelemetryRegistry")

    @cached_property
    def compute(self):
        return self._contract("ComputeLedger")

    @property
    def actors(self) -> dict:
        return self.deployment["actors"]

    @cached_property
    def keys(self) -> dict:
        """Private keys per actor: env ACTOR_KEY_<NAME>, else the Hardhat dev mnemonic on a local chain."""
        local = self.deployment["chainId"] == 31337
        out = {}
        for name, a in self.actors.items():
            k = os.getenv(f"ACTOR_KEY_{name.upper()}") or os.getenv("DEPLOYER_PRIVATE_KEY")
            if not k and local:
                k = Account.from_mnemonic(HARDHAT_MNEMONIC, account_path=f"m/44'/60'/0'/0/{a['index']}").key.hex()
            if k:
                acct = Account.from_key(k)
                if acct.address.lower() == a["address"].lower():
                    out[name] = acct
        return out

    def chain_key(self) -> str:
        d = self.deployment
        return f"{d['chainId']}:{d['contracts']['GreenSiliconPassport']['address']}:{d['deployedAt']}"

    def connected(self) -> bool:
        try:
            return self.w3.is_connected() and self.w3.eth.get_code(self.passport.address) not in (b"", None)
        except Exception:
            return False

    # ------------------------------------------------------------ tx helpers
    def send(self, actor: str, fn) -> dict:
        with self._send_lock:
            return self._send(actor, fn)

    def _send(self, actor: str, fn) -> dict:
        acct = self.keys[actor]
        tx = fn.build_transaction({
            "from": acct.address,
            "nonce": self.w3.eth.get_transaction_count(acct.address, "pending"),
            "chainId": self.deployment["chainId"],
        })
        signed = acct.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h, timeout=120)
        if rcpt.status != 1:
            raise RuntimeError(f"transaction reverted: {h.hex()}")
        return rcpt

    def _event(self, contract, rcpt, name: str) -> dict:
        logs = getattr(contract.events, name)().process_receipt(rcpt, errors=DISCARD)
        return dict(logs[0]["args"]) if logs else {}

    @staticmethod
    def tx_hash(rcpt) -> str:
        h = rcpt["transactionHash"].hex()
        return h if h.startswith("0x") else "0x" + h

    # ------------------------------------------------------------ writes
    def create_passport(self, product: str, node: str, units: int, design_commitment: bytes, uri: str, owner: str | None = None) -> tuple[int, str]:
        owner = owner or self.actors["oem"]["address"]
        rcpt = self.send("designer", self.passport.functions.createPassport(Web3.to_checksum_address(owner), product, node, units, design_commitment, uri))
        ev = self._event(self.passport, rcpt, "PassportCreated")
        return int(ev["id"]), self.tx_hash(rcpt)

    def typed_attestation(self, att: dict) -> dict:
        return {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "StageAttestation": [
                    {"name": "passportId", "type": "uint256"}, {"name": "stage", "type": "uint8"},
                    {"name": "fieldsRoot", "type": "bytes32"}, {"name": "evidenceHash", "type": "bytes32"},
                    {"name": "carbonG", "type": "uint256"}, {"name": "energyWh", "type": "uint256"},
                    {"name": "waterL", "type": "uint256"}, {"name": "facility", "type": "string"},
                    {"name": "nonce", "type": "uint256"}, {"name": "deadline", "type": "uint256"},
                ],
            },
            "primaryType": "StageAttestation",
            "domain": {"name": "GreenSilicon", "version": "1", "chainId": self.deployment["chainId"], "verifyingContract": self.passport.address},
            "message": att,
        }

    def build_attestation(self, signer: str, pid: int, stage: str, fields_root: bytes, evidence_hash: bytes,
                          carbon_g: int, energy_wh: int, water_l: int, facility: str) -> dict:
        return {
            "passportId": pid, "stage": STAGES.index(stage), "fieldsRoot": fields_root, "evidenceHash": evidence_hash,
            "carbonG": int(carbon_g), "energyWh": int(energy_wh), "waterL": int(water_l), "facility": facility,
            "nonce": self.passport.functions.nonces(Web3.to_checksum_address(signer)).call(),
            "deadline": int(time.time()) + 3600,
        }

    def relay_stage(self, att: dict, sig: bytes) -> dict:
        """Relay an attestation signed elsewhere (server-held key or the supplier's own wallet)."""
        args = (att["passportId"], att["stage"], att["fieldsRoot"], att["evidenceHash"], att["carbonG"], att["energyWh"],
                att["waterL"], att["facility"], att["nonce"], att["deadline"])
        rcpt = self.send("registrar", self.passport.functions.recordStage(args, sig))
        ev = self._event(self.passport, rcpt, "StageRecorded")
        sig_hex = sig.hex()
        return {"index": int(ev["index"]), "tx": self.tx_hash(rcpt), "signature": sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex,
                "attester": ev["attester"]}

    def record_stage(self, actor: str, pid: int, stage: str, fields_root: bytes, evidence_hash: bytes,
                     carbon_g: int, energy_wh: int, water_l: int, facility: str) -> dict:
        """Actor signs an EIP-712 attestation off-chain; the registrar relays it."""
        acct = self.keys[actor]
        att = self.build_attestation(acct.address, pid, stage, fields_root, evidence_hash, carbon_g, energy_wh, water_l, facility)
        sig = acct.sign_message(encode_typed_data(full_message=self.typed_attestation(att))).signature
        return self.relay_stage(att, sig)

    def actor_for(self, address: str) -> tuple[str | None, dict | None]:
        for k, a in self.actors.items():
            if a["address"].lower() == address.lower():
                return k, a
        return None, None

    def grant_role(self, role: str, address: str) -> str:
        fn = self.passport.functions.grantRole(getattr(self.passport.functions, role)().call(), Web3.to_checksum_address(address))
        return self.tx_hash(self.send("registrar", fn))

    def attest_ai(self, pid: int, index: int, verdict: str, score: int, report_hash: bytes) -> str:
        rcpt = self.send("ai_auditor", self.passport.functions.attestAI(pid, index, VERDICTS.index(verdict), int(score), report_hash))
        return self.tx_hash(rcpt)

    def integrate(self, parent: int, child: int, units: int) -> dict:
        rcpt = self.send("osat", self.passport.functions.integrateComponent(parent, child, units))
        ev = self._event(self.passport, rcpt, "ComponentIntegrated")
        return {"tx": self.tx_hash(rcpt), "carbon_g": int(ev["carbonG"])}

    def recycle(self, pid: int, units: int, recovered_g: int, process_carbon_g: int, fields_root: bytes, evidence_hash: bytes, facility: str) -> dict:
        rcpt = self.send("recycler", self.passport.functions.recycle(pid, units, recovered_g, process_carbon_g, fields_root, evidence_hash, facility))
        ev = self._event(self.passport, rcpt, "Recycled")
        st = self._event(self.passport, rcpt, "StageRecorded")
        return {"tx": self.tx_hash(rcpt), "reward_circ": int(ev["reward"]) / 1e18, "index": int(st["index"])}

    def issue_credits(self, to_actor: str, amount_kg: int, project: str, methodology: str, serial: str, vintage: int, evidence_hash: bytes) -> dict:
        to = self.actors[to_actor]["address"]
        rcpt = self.send("credit_issuer", self.registry.functions.issueBatch(to, amount_kg, project, methodology, serial, vintage, evidence_hash))
        ev = self._event(self.registry, rcpt, "BatchIssued")
        return {"batch_id": int(ev["batchId"]), "tx": self.tx_hash(rcpt)}

    def retire(self, actor: str, batch_id: int, amount_kg: int, pid: int, beneficiary: str) -> dict:
        rcpt = self.send(actor, self.registry.functions.retire(batch_id, amount_kg, pid, beneficiary))
        ev = self._event(self.registry, rcpt, "CreditsRetired")
        return {"retirement_id": int(ev["retirementId"]), "tx": self.tx_hash(rcpt)}

    # ------------------------------------------------------------ telemetry
    def register_device(self, operator: str, device: str, kind: int, facility: str) -> str:
        return self.tx_hash(self.send(operator, self.telemetry.functions.registerDevice(Web3.to_checksum_address(device), kind, facility)))

    def typed_batch(self, msg: dict) -> dict:
        return {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "TelemetryBatch": [
                    {"name": "device", "type": "address"}, {"name": "fromTs", "type": "uint64"}, {"name": "toTs", "type": "uint64"},
                    {"name": "count", "type": "uint32"}, {"name": "root", "type": "bytes32"}, {"name": "total", "type": "uint256"},
                    {"name": "alerts", "type": "uint32"}, {"name": "nonce", "type": "uint256"},
                ],
            },
            "primaryType": "TelemetryBatch",
            "domain": {"name": "GreenSilicon Telemetry", "version": "1", "chainId": self.deployment["chainId"], "verifyingContract": self.telemetry.address},
            "message": msg,
        }

    def anchor_batch(self, device_acct, from_ts: int, to_ts: int, count: int, root: bytes, total: int, alerts: int) -> dict:
        """The meter signs the batch with its own key; the registrar relays it."""
        msg = {"device": device_acct.address, "fromTs": from_ts, "toTs": to_ts, "count": count, "root": root, "total": int(total),
               "alerts": alerts, "nonce": self.telemetry.functions.nonces(device_acct.address).call()}
        sig = device_acct.sign_message(encode_typed_data(full_message=self.typed_batch(msg))).signature
        args = (msg["device"], from_ts, to_ts, count, root, msg["total"], alerts, msg["nonce"])
        rcpt = self.send("registrar", self.telemetry.functions.anchorBatch(args, sig))
        ev = self._event(self.telemetry, rcpt, "BatchAnchored")
        return {"index": int(ev["index"]), "tx": self.tx_hash(rcpt)}

    def telemetry_devices(self) -> list[dict]:
        out = []
        for addr in self.telemetry.functions.getDevices().call():
            d = self.telemetry.functions.getDevice(addr).call()
            out.append({"address": addr, "operator": d[0], "kind": ["Power", "Abatement", "Water"][d[1]], "active": d[2],
                        "registeredAt": d[3], "facility": d[4], "batches": self.telemetry.functions.batchCount(addr).call()})
        return out

    def telemetry_batches(self, device: str) -> list[dict]:
        return [{"index": i, "fromTs": b[0], "toTs": b[1], "count": b[2], "alerts": b[3], "root": "0x" + b[4].hex(), "total": b[5], "anchoredAt": b[6]}
                for i, b in enumerate(self.telemetry.functions.getBatches(Web3.to_checksum_address(device)).call())]

    def verify_reading(self, device: str, index: int, ts: int, value: int, proof: list[bytes]) -> bool:
        return self.telemetry.functions.verifyReading(Web3.to_checksum_address(device), index, ts, value, proof).call()

    # ------------------------------------------------------------ use phase
    def register_dc(self, name: str, region: str, pue_milli: int, wue_ml: int, ewif_ml: int, stress: int) -> int:
        rcpt = self.send("oem", self.compute.functions.registerDataCenter(name, region, pue_milli, wue_ml, ewif_ml, stress))
        return int(self._event(self.compute, rcpt, "DataCenterRegistered")["dcId"])

    def deploy_lot(self, pid: int, dc_id: int, units: int, lifetime_hours: int) -> dict:
        rcpt = self.send("oem", self.compute.functions.deploy(pid, dc_id, units, lifetime_hours))
        ev = self._event(self.compute, rcpt, "Deployed")
        return {"deployment_id": int(ev["deploymentId"]), "tx": self.tx_hash(rcpt), "embodied_per_unit_g": int(ev["embodiedPerUnitG"])}

    def certify_job(self, dep_id: int, start: int, end: int, centi_hours: int, it_wh: int, operational_g: int, water_onsite_l: int,
                    baseline_g: int, job_hash: bytes, customer: str, work_hash: bytes = b"\x00" * 32, parent_plus_one: int = 0) -> dict:
        args = (dep_id, start, end, centi_hours, it_wh, operational_g, water_onsite_l, baseline_g, job_hash, work_hash, parent_plus_one)
        rcpt = self.send("oem", self.compute.functions.certify(args, Web3.to_checksum_address(customer)))
        ev = self._event(self.compute, rcpt, "ComputeCertified")
        return {"cert_id": int(ev["certId"]), "tx": self.tx_hash(rcpt)}

    def certify_reuse(self, work_hash: bytes, customer: str) -> dict:
        rcpt = self.send("oem", self.compute.functions.certifyReuse(work_hash, Web3.to_checksum_address(customer)))
        ev = self._event(self.compute, rcpt, "ComputeReused")
        return {"cert_id": int(ev["certId"]), "source_cert_id": int(ev["sourceCertId"]), "avoided_g": int(ev["avoidedG"]), "tx": self.tx_hash(rcpt)}

    def reusable_cert(self, work_hash: bytes) -> int | None:
        v = self.compute.functions.workCertPlusOne(work_hash).call()
        return v - 1 if v else None

    def compute_certificates(self) -> list[dict]:
        keys = ["deploymentId", "startTs", "endTs", "centiHours", "itEnergyWh", "facilityEnergyWh", "operationalG", "embodiedG",
                "waterOnsiteL", "waterOffsiteL", "baselineG", "jobHash", "workHash", "parentCertPlusOne", "avoidedG", "reused"]
        out = []
        for i in range(self.compute.functions.certificateCount().call()):
            c = dict(zip(keys, self.compute.functions.getCertificate(i).call()))
            c["jobHash"] = "0x" + c["jobHash"].hex()
            c["workHash"] = "0x" + c["workHash"].hex()
            c["certId"] = i
            c["owner"] = self.compute.functions.ownerOf(i).call()
            out.append(c)
        return out

    def compute_lifecycle(self, pid: int) -> dict:
        keys = ["unitsDeployed", "centiHours", "embodiedAllocatedG", "operationalG", "waterL", "energyWh", "certificates", "avoidedG"]
        return dict(zip(keys, self.compute.functions.lifecycle(pid).call()))

    def supplier_trust(self, address: str) -> dict:
        v, f, r, score = self.passport.functions.supplierTrust(Web3.to_checksum_address(address)).call()
        return {"verified": v, "flagged": f, "rejected": r, "scoreBps": score}

    # ------------------------------------------------------------ reads
    def next_id(self) -> int:
        return self.passport.functions.nextId().call()

    def get_passport(self, pid: int) -> dict:
        p = self.passport.functions.getPassport(pid).call()
        keys = ["product", "processNode", "metadataURI", "designCommitment", "units", "unitsAllocated", "unitsRecycled",
                "createdAt", "status", "ownCarbonG", "inheritedCarbonG", "energyWh", "waterL", "offsetG"]
        d = dict(zip(keys, p))
        d["designCommitment"] = "0x" + d["designCommitment"].hex()
        d["status"] = STATUSES[d["status"]]
        d["owner"] = self.passport.functions.ownerOf(pid).call()
        d["totalCarbonG"] = d["ownCarbonG"] + d["inheritedCarbonG"]
        d["verifiedShareBps"] = self.passport.functions.verifiedShareBps(pid).call()
        return d

    def get_stages(self, pid: int) -> list[dict]:
        out = []
        for i, r in enumerate(self.passport.functions.getStages(pid).call()):
            out.append({
                "index": i, "stage": STAGES[r[0]], "attester": r[1], "timestamp": r[2],
                "fieldsRoot": "0x" + r[3].hex(), "evidenceHash": "0x" + r[4].hex(),
                "carbonG": r[5], "energyWh": r[6], "waterL": r[7], "facility": r[8],
                "verdict": VERDICTS[r[9]], "aiScore": r[10], "aiReportHash": "0x" + r[11].hex(),
            })
        return out

    def get_components(self, pid: int) -> list[dict]:
        return [{"childId": c[0], "units": c[1], "carbonG": c[2]} for c in self.passport.functions.getComponents(pid).call()]

    def verify_field(self, pid: int, index: int, key: str, value: str, salt: bytes, proof: list[bytes]) -> bool:
        return self.passport.functions.verifyField(pid, index, key, value, salt, proof).call()

    def batches(self) -> list[dict]:
        n = self.registry.functions.batchCount().call()
        out = []
        for i in range(1, n + 1):
            b = self.registry.functions.getBatch(i).call()
            out.append({"batchId": i, "projectName": b[0], "methodology": b[1], "registrySerial": b[2], "vintage": b[3],
                        "issuedKg": b[4], "retiredKg": b[5], "evidenceHash": "0x" + b[6].hex(), "issuer": b[7]})
        return out

    def retirements(self) -> list[dict]:
        return [{"retirementId": i, "batchId": r[0], "passportId": r[1], "amountKg": r[2], "retiree": r[3], "beneficiary": r[4], "timestamp": r[5]}
                for i, r in enumerate(self.registry.functions.getRetirements().call())]

    def credit_balance(self, actor: str, batch_id: int) -> int:
        return self.registry.functions.balanceOf(self.actors[actor]["address"], batch_id).call()

    def circ_balance(self, address: str) -> float:
        return self.circ.functions.balanceOf(Web3.to_checksum_address(address)).call() / 1e18

    def activity(self, limit: int = 40) -> list[dict]:
        """Recent contract events across all three contracts, newest first."""
        start = self.deployment.get("deployBlock", 0)
        items = []
        specs = [
            (self.passport, ["PassportCreated", "StageRecorded", "AIVerdict", "ComponentIntegrated", "OffsetApplied", "Recycled"]),
            (self.registry, ["BatchIssued", "CreditsRetired"]),
        ]
        for c, names in specs:
            for n in names:
                for log in getattr(c.events, n)().get_logs(from_block=start):
                    args = {k: (("0x" + v.hex()) if isinstance(v, bytes) else v) for k, v in dict(log["args"]).items()}
                    if n == "StageRecorded":
                        args["stage"] = STAGES[args["stage"]]
                    if n == "AIVerdict":
                        args["verdict"] = VERDICTS[args["verdict"]]
                    items.append({"event": n, "block": log["blockNumber"], "logIndex": log["logIndex"], "tx": self.tx_hash(log), "args": args})
        items.sort(key=lambda x: (x["block"], x["logIndex"]), reverse=True)
        blocks = {}
        for it in items[:limit]:
            b = it["block"]
            if b not in blocks:
                blocks[b] = self.w3.eth.get_block(b)["timestamp"]
            it["timestamp"] = blocks[b]
        return items[:limit]


chain = Chain()
