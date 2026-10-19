"""Content-addressed cache for AI work: the same document, audit context or
question is never sent to the model twice. Keys are keccak-256 hashes of the
exact inputs (document bytes, canonical audit context), so a hit is provably
the same computation, the same idea as on-chain compute reuse, applied to
GreenSilicon's own AI pipeline."""
from __future__ import annotations

import copy
import json
import threading

from eth_utils import keccak

from ..store import store

_lock = threading.Lock()


def key(*parts) -> str:
    blob = b"".join(p if isinstance(p, bytes) else json.dumps(p, sort_keys=True, default=str).encode() for p in parts)
    return "0x" + keccak(blob).hex()


def _db() -> dict:
    return store.db.setdefault("ai_cache", {"entries": {}, "stats": {}})


def get(kind: str, k: str):
    with _lock:
        db = _db()
        e = db["entries"].get(f"{kind}:{k}")
        st = db["stats"].setdefault(kind, {"hits": 0, "misses": 0, "tokens_saved": 0, "llm_calls_saved": 0})
        if e is None:
            st["misses"] += 1
            return None
        st["hits"] += 1
        st["tokens_saved"] += e.get("tokens", 0)
        st["llm_calls_saved"] += 1 if e.get("tokens") else 0
        return copy.deepcopy(e["value"])


def put(kind: str, k: str, value, tokens: int = 0) -> None:
    with _lock:
        _db()["entries"][f"{kind}:{k}"] = {"value": copy.deepcopy(value), "tokens": tokens}
        store.save()


def stats() -> dict:
    s = _db()["stats"]
    tot = {"hits": sum(v["hits"] for v in s.values()), "misses": sum(v["misses"] for v in s.values()),
           "tokens_saved": sum(v["tokens_saved"] for v in s.values()), "llm_calls_saved": sum(v["llm_calls_saved"] for v in s.values())}
    tot["hit_rate"] = tot["hits"] / (tot["hits"] + tot["misses"]) if (tot["hits"] + tot["misses"]) else 0
    return {"by_kind": s, "total": tot, "entries": len(_db()["entries"])}
