"""Salted-field Merkle commitments, byte-compatible with OpenZeppelin MerkleProof
and GreenSiliconPassport.verifyField:

    leaf = keccak256(keccak256(abi.encode(string key, string value, bytes32 salt)))
    node = keccak256(sorted(a, b))

Each field gets a random 32-byte salt so low-entropy values (yields, abatement
rates) cannot be brute-forced from the public root.
"""
from __future__ import annotations

import os

from eth_abi import encode
from eth_utils import keccak


def canonical(value) -> str:
    if isinstance(value, float):
        return repr(round(value, 6))
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def leaf(key: str, value: str, salt: bytes) -> bytes:
    return keccak(keccak(encode(["string", "string", "bytes32"], [key, value, salt])))


def _pair(a: bytes, b: bytes) -> bytes:
    return keccak(a + b) if a < b else keccak(b + a)


class FieldTree:
    def __init__(self, fields: dict, salts: dict[str, bytes] | None = None):
        self.keys = sorted(fields)
        self.values = {k: canonical(fields[k]) for k in self.keys}
        self.salts = salts or {k: os.urandom(32) for k in self.keys}
        self.leaves = [leaf(k, self.values[k], self.salts[k]) for k in self.keys]
        self.layers = [self.leaves]
        while len(self.layers[-1]) > 1:
            prev = self.layers[-1]
            self.layers.append([_pair(prev[i], prev[i + 1]) if i + 1 < len(prev) else prev[i] for i in range(0, len(prev), 2)])

    @property
    def root(self) -> bytes:
        return self.layers[-1][0] if self.leaves else b"\x00" * 32

    def proof(self, key: str) -> list[bytes]:
        idx = self.keys.index(key)
        out = []
        for layer in self.layers[:-1]:
            sib = idx ^ 1
            if sib < len(layer):
                out.append(layer[sib])
            idx >>= 1
        return out

    def disclosure(self, key: str) -> dict:
        return {
            "key": key,
            "value": self.values[key],
            "salt": "0x" + self.salts[key].hex(),
            "proof": ["0x" + p.hex() for p in self.proof(key)],
            "root": "0x" + self.root.hex(),
        }


def verify(key: str, value: str, salt: bytes, proof: list[bytes], root: bytes) -> bool:
    h = leaf(key, value, salt)
    for p in proof:
        h = _pair(h, p)
    return h == root


class LeafTree:
    """Sorted-pair Merkle tree over precomputed leaves (OpenZeppelin-compatible)."""

    def __init__(self, leaves: list[bytes]):
        self.layers = [list(leaves)]
        while len(self.layers[-1]) > 1:
            prev = self.layers[-1]
            self.layers.append([_pair(prev[i], prev[i + 1]) if i + 1 < len(prev) else prev[i] for i in range(0, len(prev), 2)])

    @property
    def root(self) -> bytes:
        return self.layers[-1][0] if self.layers[0] else b"\x00" * 32

    def proof(self, idx: int) -> list[bytes]:
        out = []
        for layer in self.layers[:-1]:
            sib = idx ^ 1
            if sib < len(layer):
                out.append(layer[sib])
            idx >>= 1
        return out


def reading_leaf(ts: int, value: int) -> bytes:
    return keccak(keccak(encode(["uint64", "uint256"], [ts, value])))
