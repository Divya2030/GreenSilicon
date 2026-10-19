"""Off-chain store: full supplier disclosures (with salts), AI audit reports,
design specs and evidence files. Only hashes and roots go on-chain.

A JSON document store keeps the prototype dependency-free; swap for Postgres
or IPFS/Filecoin in production (evidence files are already content-addressed).
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from eth_utils import keccak

from .config import settings


class Store:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.evidence_dir = data_dir / "evidence"
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "db.json"
        self._lock = threading.RLock()
        self.db = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            return json.loads(self.path.read_text())
        return {"chain": None, "passports": {}, "stages": {}, "credits": {}}

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.db, indent=1, default=str))
            tmp.replace(self.path)

    def reset_if_chain_changed(self, chain_key: str) -> None:
        """A fresh local chain invalidates the off-chain index."""
        with self._lock:
            if self.db.get("chain") != chain_key:
                self.db = {"chain": chain_key, "passports": {}, "stages": {}, "credits": {}}
                self.save()

    # passports -----------------------------------------------------------
    def put_passport(self, pid: int, doc: dict) -> None:
        with self._lock:
            self.db["passports"][str(pid)] = doc
            self.save()

    def passport(self, pid: int) -> dict:
        return self.db["passports"].get(str(pid), {})

    # stage disclosures ----------------------------------------------------
    def put_stage(self, pid: int, index: int, doc: dict) -> None:
        with self._lock:
            self.db["stages"][f"{pid}:{index}"] = doc
            self.save()

    def stage(self, pid: int, index: int) -> dict:
        return self.db["stages"].get(f"{pid}:{index}", {})

    def update_stage(self, pid: int, index: int, **kw) -> None:
        with self._lock:
            self.db["stages"].setdefault(f"{pid}:{index}", {}).update(kw)
            self.save()

    def all_stages(self) -> dict:
        return self.db["stages"]

    # credits ----------------------------------------------------------------
    def put_credit(self, batch_id: int, doc: dict) -> None:
        with self._lock:
            self.db["credits"][str(batch_id)] = doc
            self.save()

    def credit(self, batch_id: int) -> dict:
        return self.db["credits"].get(str(batch_id), {})

    # evidence ---------------------------------------------------------------
    def put_evidence(self, data: bytes, filename: str) -> str:
        h = "0x" + keccak(data).hex()
        (self.evidence_dir / h).write_bytes(data)
        (self.evidence_dir / f"{h}.name").write_text(filename)
        return h

    def evidence(self, h: str) -> tuple[bytes, str] | None:
        p = self.evidence_dir / h
        if not p.exists():
            return None
        name = (self.evidence_dir / f"{h}.name")
        return p.read_bytes(), name.read_text() if name.exists() else h


store = Store(settings.data_dir)
