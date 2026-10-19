# GreenSilicon architecture

## Components

| Layer | Path | Responsibility |
|---|---|---|
| Smart contracts | `contracts/contracts/` | Source of truth for passports, stage records, AI verdicts, composition, offsets, recycling rewards |
| Carbon model | `backend/app/carbon/` | ACT-based embodied carbon, energy and water; design-space sweep; decarbonisation levers |
| AI | `backend/app/ai/` | Claude extraction and audit reasoning, rule checks, IsolationForest, offline parser |
| Chain client | `backend/app/chain.py` | web3.py, EIP-712 signing per actor, relaying, event and activity reads |
| Service / API | `backend/app/service.py`, `main.py` | Orchestration, Merkle commitments, DPP credential, REST API, read-only RPC relay |
| UI | `frontend/src/` | Overview, Passports, Passport detail, Design Lab, Supplier Portal, Carbon Credits, Public Verifier |

## Contracts

### `GreenSiliconPassport` (ERC-721 + AccessControl + EIP-712)

- **Roles:** `DESIGNER`, `FAB`, `OSAT`, `LOGISTICS`, `RECYCLER`, `AI_VERIFIER`, `OFFSET_REGISTRY`.
- `createPassport(owner, product, node, units, designCommitment, uri)`: one token per production lot.
- `recordStage(StageAttestation, signature)`: EIP-712 typed data:
  `StageAttestation(passportId, stage, fieldsRoot, evidenceHash, carbonG, energyWh, waterL, facility, nonce, deadline)`.
  - The signer is recovered and must hold the stage's role; per-signer nonces and a deadline apply.
  - With an empty signature, `msg.sender` is the attester (for wallets such as MetaMask).
  - Stages must be non-decreasing: Design → WaferFab → Assembly → Test → Logistics → EndOfLife.
- `attestAI(id, index, verdict, score, reportHash)`: oracle-only.
- `integrateComponent(parent, child, units)`: pro-rata allocation of `totalCarbonG(child)`. It reverts with `ComponentOverAllocated` beyond the child's units, and the child must predate the parent (no cycles).
- `recordOffset(id, grams, retirementId)`: registry-only, capped by the footprint (`OffsetExceedsFootprint`).
- `recycle(...)`: records the EndOfLife stage and mints CIRC to the recycler.
- `verifyField(id, index, key, value, salt, proof)`: selective disclosure using OpenZeppelin `MerkleProof`. Leaf = `keccak256(keccak256(abi.encode(key, value, salt)))`, sorted-pair tree.
- Views: `getPassport`, `getStages`, `getComponents`, `totalCarbonG`, `carbonPerUnitG`, `verifiedShareBps`.

### `CarbonCreditRegistry` (ERC-1155)

- `issueBatch(...)` by `ISSUER_ROLE`. The registry serial is unique (`SerialAlreadyTokenized`).
- `retire(batchId, kg, passportId, beneficiary)` burns the credits, records the retirement and calls `GreenSiliconPassport.recordOffset`.

### `TelemetryRegistry` (IoT digital MRV)

- Fab operators (`OPERATOR_ROLE`) register meters: `Power` (Wh per reading), `Abatement` (destruction efficiency in bps), `Water` (litres).
- `anchorBatch(TelemetryBatch, signature)`: the **meter's own key** signs `TelemetryBatch(device, fromTs, toTs, count, root, total, alerts, nonce)`, and anyone may relay it. Batches must be contiguous (`fromTs == previous toTs`), so periods cannot be skipped or backfilled.
- `verifyReading(device, index, ts, value, proof)` proves any single reading. Leaf = `keccak256(keccak256(abi.encode(uint64 ts, uint256 value)))`.
- The backend simulator seeds 7 days of 15-minute readings (one batch per meter per day). It also streams live 1-second readings (one batch per 15 readings), supports fault injection, and flags anomalies (abatement below 95 %, power beyond 4σ).
- The auditor matches meters to a disclosure by fab identifier. It flags abatement claims above the metered average and electricity claims below 85 % of metered consumption, and estimates the extra process-gas emissions using ACT's 95/99 % abatement data points.

### `ComputeLedger` (use phase, ERC-721 Green Compute Certificates)

- `registerDataCenter(name, region, pueMilli, wueMl, ewifMl, waterStress)` by `DATACENTER_ROLE`.
- `deploy(passportId, dcId, units, lifetimeHours)` snapshots `carbonPerUnitG` from the passport. Each passport unit can be deployed only once (`DeployExceedsUnits`).
- `certify(CertInput, customer)` computes facility energy (×PUE), off-site water (×EWIF) and **amortised embodied carbon = per-unit embodied × accelerator-hours / rated life** on-chain. Certified hours are capped at units × rated life (`LifetimeExceeded`), so embodied carbon is never over-allocated. The certificate is minted to the customer.
- **Compute reuse:** each certificate stores a `workHash` (model + dataset version + params). `certifyReuse(workHash, customer)` serves an identical computation from the first certificate that computed it. It mints a zero-energy certificate whose `avoidedG` is copied from the source, so it cannot be inflated. Incremental runs set `parentCertPlusOne`, and `avoidedG = parent.operationalG − this.operationalG`.
- `lifecycle(passportId)` returns use-phase totals per chip lot (hours, operational, embodied allocated, water, avoided).

Off-chain, `backend/app/datacenter.py` provides hour-of-day grid and WUE profiles, the scheduler (minimise a blend of operational CO₂e and scarcity-weighted freshwater, relative to running now at the home site), cooling-source comparisons (potable, reclaimed, dry, seawater heat exchange, desalination), the green-inference planner and the hardware-refresh payback.

### AI cache

`backend/app/ai/cache.py` keys extraction, audit and copilot results by keccak-256 of the exact inputs, so identical requests never reach the model twice. It reports hits and the tokens and calls avoided.

### Supplier trust

`supplierTrust(attester)` returns verdict counts and a Bayesian score: (100·V + 40·F + 2·50) / (V + F + R + 2). It updates on every `attestAI`, including re-audits.

### `CircularityToken` (ERC-20, CIRC)

- Minted only by `GreenSiliconPassport` on recycling (1 CIRC per kg recovered).

## Data flow: one supplier attestation

```mermaid
sequenceDiagram
  participant S as Supplier (UI)
  participant API as Backend
  participant C as Claude
  participant K as Supplier key
  participant P as GreenSilicon
  S->>API: upload report (PDF/text)
  API->>API: keccak256(document) -> evidence store
  API->>C: extract StageDisclosure (structured output, doc as untrusted data)
  C-->>API: JSON fields + evidence quotes + gaps
  API-->>S: review / edit
  S->>API: sign & anchor
  API->>API: salted Merkle tree over fields -> root
  API->>K: sign EIP-712 StageAttestation
  API->>P: recordStage(attestation, signature)  [relayed; or signed in the supplier's own wallet]
  API->>API: physics expectation + energy floor + IsolationForest
  API->>C: audit reasoning with signals
  API->>API: final verdict = max severity(rules, Claude)
  API->>P: attestAI(verdict, score, keccak(report))
```

## Hybrid auditor

1. **Physics expectation per stage**
   - WaferFab: the ACT die model at the reported grid. Renewables count only if certificates are cited.
   - Assembly: packaging, bonding and interposer (3D-Carbon).
   - Test: kWh per unit × grid intensity.
   - Logistics: tonne-km × freight factor.
   - EndOfLife: recovery factor.
2. **Energy floor:** reported kWh × grid intensity is a lower bound on the claim.
3. **IoT telemetry:** claims are checked against the facility's device-signed, on-chain-anchored meter data (abatement efficiency and uptime, metered electricity).
4. **Rule checks:** renewables without certificates, abatement above 99.5 %, yield above the model, missing evidence, signer ≠ reporting supplier, disclosure gaps.
5. **IsolationForest:** trained on a synthetic honest-supplier population around the physics model (log-ratio residuals, renewable share, water residual, abatement).
6. **Claude:** reviews the disclosure and all signals, returns verdict, confidence, findings and actions. It cannot downgrade a rules verdict.

The score (0–100) and verdict go on-chain. The full report is stored off-chain and committed by hash.

## Carbon at risk

For Flagged or Rejected records, `max(0, expected − claimed)` is unverified carbon. It propagates pro-rata through component allocations, so a buyer sees how much of the product footprint rests on unverified supplier data.

## Deployment modes

- **Local** (`scripts/dev.sh`): Hardhat node, actors map to dev accounts, keys derived from the public test mnemonic.
- **Testnet** (Sepolia or Polygon Amoy): `npm run deploy:sepolia`. Roles default to the deployer unless `ROLE_<ACTOR>` addresses are set, and the backend uses `ACTOR_KEY_<ACTOR>` keys.
- **Single container:** `Dockerfile` runs the local chain, seed, API and UI on port 8000.
