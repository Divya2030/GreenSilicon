# Devpost submission: GreenSilicon

> Copy each section into the matching Devpost field. Replace `<…>` placeholders (repo URL, video URL, live demo URL) before submitting.

## Project name
GreenSilicon

## Tagline (short)
AI-audited blockchain passports that follow every chip from the fab to the AI jobs it runs: verifiable carbon, water and recycling, with nothing counted twice and no work computed twice.

## Team
Divya Kohli, third-year PhD student, University of California, Santa Cruz (UCSC), CA, USA. Background in chip design.

## Track
**Sustainable Supply Chains**: product lifecycle tracking, digital product passports, recycling traceability and circular-economy incentives, applied to the semiconductor industry. The project also contributes to Carbon Markets (offsets that can't be double-claimed) and Climate Data (verifiable supplier data).

## Inspiration
AI's growth runs on chips, and most of a chip's lifetime carbon is emitted in the fab, before it is ever switched on. Fabs consume huge amounts of electricity and ultrapure water and emit fluorinated gases thousands of times more potent than CO₂. Every new node needs more of each per cm². Yet companies buying hardware report its Scope 3 footprint using industry averages or unverifiable PDFs. Chiplets now combine dies from several fabs into one package, which makes the picture even more fragmented. With the EU introducing Digital Product Passports, we asked: what would a trustworthy passport for a chip look like?

## What it does
GreenSilicon gives every semiconductor **production lot** an on-chain passport that follows it from design to recycling:

1. **Design Lab:** before tape-out, designers estimate embodied carbon, energy and water with a physics model built on published fab data (ACT/Meta-Harvard, imec.netzero, 3D-Carbon). They compare nodes, fab locations and packaging, see ranked decarbonisation levers, and mint a passport that commits to the design hash.
2. **Supplier Portal:** fabs, packaging houses, carriers and recyclers upload the reports they already produce. **Claude** extracts the figures into a structured disclosure. The supplier reviews them and signs an **EIP-712** attestation, which is relayed on-chain gas-free. Only totals and a **salted Merkle root** go on-chain, so confidential process data stays private but any single field can later be proven.
3. **AI auditor:** every record is checked by a **hybrid auditor**: a physics expectation, an electricity-floor consistency check, an **IsolationForest** anomaly detector and Claude's reasoning. The verdict (Verified, Flagged or Rejected) and a hash of the report are written on-chain. A language model can add scrutiny but never overrule a physics violation, which makes the auditor resistant to prompt injection.
4. **Composition without double counting:** chiplet and HBM lots are integrated into product lots. Carbon is allocated pro-rata, and the contract makes it impossible to allocate a lot beyond its unit count. "Carbon at risk" from rejected supplier records propagates up the bill of materials.
5. **Carbon credits:** credits are tokenised once per registry serial, burned on retirement and capped at the lot's attested footprint. Double issuance, double use and over-claiming are all blocked on-chain.
6. **Circularity:** recyclers record end-of-life recovery and earn CIRC tokens per kg of recovered metal.
7. **IoT digital MRV:** fab power sub-meters, abatement-unit gas analysers and water meters sign their own readings. Batches are anchored on-chain and must be contiguous in time, so an abatement outage cannot be hidden. The AI auditor checks supplier claims against this metered evidence, and the live dashboard flags bypass events in real time.
8. **Supplier trust and Scope 3 reporting:** each supplier's reputation is computed on-chain from its verdict history. Buyers get a GHG Protocol Scope 3 Category 1 report with data-quality indicators and offsets reported separately, exportable as CSV.
9. **Bring your own wallet:** suppliers can sign attestations in MetaMask, so the server never holds their keys.
10. **From fab to inference:** accelerator lots are deployed to data centers with published PUE, cooling water and grid water. Every AI job gets a Green Compute Certificate (ERC-721) with operational carbon, cooling and grid water, and the chip's **embodied carbon amortised on-chain from its passport**. A carbon- and water-aware scheduler moves flexible jobs to the cleanest, least water-stressed site and hour (−90 % CO₂e for the seeded LLM training run).
11. **Don't compute twice:** identical work (same model, data and parameters) reuses the stored result with zero new energy. Incremental runs continue from checkpoints. Avoided carbon is credited by the contract from the original certificate. GreenSilicon's own AI calls are cached the same way.
12. **Less energy and freshwater per AI question:** a green-inference planner (caching, small-model routing, speculative decoding, quantization, concise answers), plus a cooling-source comparison showing where **seawater heat exchange** (as proven at Hamina and in Project Natick) removes freshwater use, where it isn't feasible, and why off-site power-plant water often dominates.
13. **Public Verifier:** anyone can scan a QR code and verify a lot directly against the contract from their browser, including recomputing document hashes and checking Merkle proofs. They don't need to trust our servers.
14. **Exports:** the passport exports as a W3C Verifiable-Credential-shaped Digital Product Passport, signed and anchored to on-chain records.

## How we built it
- **Smart contracts** (Solidity 0.8.24, OpenZeppelin 5, Hardhat): `GreenSiliconPassport` (ERC-721 + AccessControl + EIP-712 + MerkleProof + on-chain supplier trust), `CarbonCreditRegistry` (ERC-1155), `CircularityToken` (ERC-20), `TelemetryRegistry` (device-signed IoT batches), `ComputeLedger` (ERC-721 compute certificates with on-chain embodied amortisation and reuse). 28 tests cover signature forgery, replay, tampering, role and order enforcement, selective disclosure, every double-counting guard, trust scoring and telemetry integrity. Slither static analysis leaves no unresolved findings (see docs/SECURITY.md).
- **Carbon model** (Python): the ACT methodology extended with wafer-edge loss, negative-binomial yield, 2.5D/3D packaging, HBM and water. Every parameter cites its source, and it is cross-checked against imec.netzero.
- **AI:** Claude (`claude-opus-5`) through the Anthropic SDK with **structured outputs** (Pydantic schemas) for extraction, auditing and the passport copilot, with server-side refusal fallbacks. scikit-learn IsolationForest for anomalies. Offline fallbacks keep the demo working without an API key.
- **Backend:** FastAPI and web3.py. Per-actor EIP-712 signing, relaying, content-addressed evidence store, DPP credential export, and a read-only RPC relay.
- **Frontend:** React, TypeScript, Tailwind, Recharts, ethers.js. Responsive, with light and dark themes and a colour-blind-validated chart palette.
- **Data-center model:** PUE, WUE and EWIF from "Making AI Less Thirsty" (Li et al.), Ember grid data, hourly profiles, scarcity weighting, scheduler, cooling-source and inference-efficiency calculators.
- **IoT simulator:** meters with their own keys, 7 days of history, a live 1 Hz stream with fault injection and real-time anomaly rules.
- One command (`./scripts/dev.sh`) starts the chain, deploys, seeds a realistic AI-accelerator supply chain and launches the app.

## Challenges we ran into
- **Getting the physics right.** Real fab data is proprietary, so we built on peer-reviewed public datasets and documented every assumption. The model surfaced a non-obvious insight: for a 2.5D AI accelerator, the **silicon interposer** can rival the compute dies in embodied carbon.
- **Privacy vs. verifiability.** Suppliers won't publish yields or gas mixes. Salted Merkle commitments with on-chain `verifyField` let them prove one field without revealing the rest.
- **Trusting an AI auditor.** LLMs can be manipulated by the documents they read. We made the LLM one layer of several and combined the verdicts conservatively, then tested it with a prompt-injection document.
- **Double counting across a bill of materials.** We solved it with contract-level invariants rather than off-chain bookkeeping.

## Accomplishments that we're proud of
- An end-to-end working prototype: from a supplier PDF to an on-chain, AI-audited, independently verifiable passport.
- The seeded scenario catches a greenwashing supplier (70 % renewables claimed without certificates, 31 % of the physically plausible footprint, and 99.9 % abatement contradicted by its own on-chain meter at 90 %) and shows exactly how much carbon is at risk in the final product.
- Every number in the carbon model is traceable to a published source.

## What we learned
How much of computing's footprint sits in manufacturing; how GHG Protocol Scope 2 quality criteria apply to renewable claims; how to design LLM pipelines that are robust to adversarial inputs; and how EIP-712 relaying removes the wallet barrier for industrial suppliers.

## What's next for GreenSilicon
Registry API bridges (Verra, Gold Standard) · hourly 24/7 carbon-free-energy matching with Electricity Maps · zero-knowledge threshold proofs ("Scope 1 < X") · board- and server-level passports for data centres · a decentralised AI-auditor oracle (Chainlink Functions) · pilots with university fabs and OSAT partners.

## Target users, scalability and adoption
- **Users:** fabless designers, foundries and memory makers, OSATs, logistics providers, recyclers, hardware buyers (cloud providers, OEMs) reporting Scope 3, auditors and regulators.
- **Adoption:** suppliers keep producing their existing reports and AI handles the data entry. Relayed signatures mean no gas or crypto UX. Exports follow ERC-721 metadata and W3C VC formats.
- **Scale:** passports are per lot (thousands of units), so on-chain cost is negligible on an L2. Passports nest, so the same model extends to boards, servers and racks.

## Built with
solidity · openzeppelin · iot · slither · hardhat · ethereum · eip-712 · erc-721 · erc-1155 · python · fastapi · web3.py · anthropic-claude · scikit-learn · react · typescript · tailwindcss · recharts · ethers.js

## Links
- Code: `<GitHub URL>`
- Demo video: `<YouTube/Vimeo URL>`
- Live prototype: `<URL>` (or run `./scripts/dev.sh` locally)
