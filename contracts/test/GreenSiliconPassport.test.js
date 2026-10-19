const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const Stage = { Design: 0, WaferFab: 1, Assembly: 2, Test: 3, Logistics: 4, EndOfLife: 5 };
const Verdict = { Pending: 0, Verified: 1, Flagged: 2, Rejected: 3 };
const ZERO = ethers.ZeroHash;

const ATTESTATION_TYPES = {
  StageAttestation: [
    { name: "passportId", type: "uint256" },
    { name: "stage", type: "uint8" },
    { name: "fieldsRoot", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "carbonG", type: "uint256" },
    { name: "energyWh", type: "uint256" },
    { name: "waterL", type: "uint256" },
    { name: "facility", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// Sorted-pair Merkle tree, same construction as backend/app/merkle.py
const coder = ethers.AbiCoder.defaultAbiCoder();
const leafOf = (k, v, salt) => ethers.keccak256(ethers.keccak256(coder.encode(["string", "string", "bytes32"], [k, v, salt])));
const hashPair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));
function merkle(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const proof = (idx) => {
    const out = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = idx ^ 1;
      if (sib < layers[l].length) out.push(layers[l][sib]);
      idx >>= 1;
    }
    return out;
  };
  return { root: layers[layers.length - 1][0], proof };
}

async function deploy() {
  const [admin, designer, fab, osat, logistics, verifier, recycler, issuer, oem, outsider] = await ethers.getSigners();
  const circ = await ethers.deployContract("CircularityToken");
  const passport = await ethers.deployContract("GreenSiliconPassport", [await circ.getAddress()]);
  const registry = await ethers.deployContract("CarbonCreditRegistry", [await passport.getAddress()]);

  await circ.grantRole(await circ.MINTER_ROLE(), await passport.getAddress());
  await passport.grantRole(await passport.OFFSET_REGISTRY_ROLE(), await registry.getAddress());
  await passport.grantRole(await passport.DESIGNER_ROLE(), designer.address);
  await passport.grantRole(await passport.FAB_ROLE(), fab.address);
  await passport.grantRole(await passport.OSAT_ROLE(), osat.address);
  await passport.grantRole(await passport.LOGISTICS_ROLE(), logistics.address);
  await passport.grantRole(await passport.AI_VERIFIER_ROLE(), verifier.address);
  await passport.grantRole(await passport.RECYCLER_ROLE(), recycler.address);
  await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address);

  const domain = {
    name: "GreenSilicon",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await passport.getAddress(),
  };

  async function mint(units = 1000n, product = "NX-7 compute die") {
    await passport.connect(designer).createPassport(oem.address, product, "5nm", units, ethers.id("rtl-v1"), "ipfs://meta");
    return (await passport.nextId()) - 1n;
  }

  async function signStage(signer, att) {
    const nonce = await passport.nonces(signer.address);
    const deadline = BigInt(await time.latest()) + 3600n;
    const full = { fieldsRoot: ZERO, evidenceHash: ZERO, energyWh: 0n, waterL: 0n, facility: "FAB-TW-01", ...att, nonce, deadline };
    const sig = await signer.signTypedData(domain, ATTESTATION_TYPES, full);
    return { full, sig };
  }

  return { admin, designer, fab, osat, logistics, verifier, recycler, issuer, oem, outsider, circ, passport, registry, mint, signStage };
}

describe("GreenSiliconPassport", () => {
  it("mints a passport for a production lot", async () => {
    const { passport, mint, oem } = await loadFixture(deploy);
    const id = await mint(500n);
    expect(await passport.ownerOf(id)).to.equal(oem.address);
    const p = await passport.getPassport(id);
    expect(p.units).to.equal(500n);
    expect(p.processNode).to.equal("5nm");
    expect(await passport.tokenURI(id)).to.equal("ipfs://meta");
  });

  it("only designers can mint", async () => {
    const { passport, outsider } = await loadFixture(deploy);
    await expect(passport.connect(outsider).createPassport(outsider.address, "x", "7nm", 1, ZERO, "")).to.be.reverted;
  });

  it("relays an EIP-712 signed fab attestation and accumulates carbon", async () => {
    const { passport, mint, fab, outsider, signStage } = await loadFixture(deploy);
    const id = await mint();
    const { full, sig } = await signStage(fab, { passportId: id, stage: Stage.WaferFab, carbonG: 1_250_000n, energyWh: 900_000n, waterL: 4200n });
    await expect(passport.connect(outsider).recordStage(full, sig))
      .to.emit(passport, "StageRecorded")
      .withArgs(id, 0, Stage.WaferFab, fab.address, 1_250_000n, ZERO, ZERO);
    const p = await passport.getPassport(id);
    expect(p.ownCarbonG).to.equal(1_250_000n);
    expect(p.waterL).to.equal(4200n);
    expect(await passport.carbonPerUnitG(id)).to.equal(1250n);
  });

  it("rejects replayed signatures", async () => {
    const { passport, mint, fab, signStage } = await loadFixture(deploy);
    const id = await mint();
    const { full, sig } = await signStage(fab, { passportId: id, stage: Stage.WaferFab, carbonG: 1n });
    await passport.recordStage(full, sig);
    await expect(passport.recordStage(full, sig)).to.be.revertedWithCustomError(passport, "BadNonce");
  });

  it("rejects attestations from the wrong role (a fab cannot sign assembly)", async () => {
    const { passport, mint, fab, signStage } = await loadFixture(deploy);
    const id = await mint();
    const { full, sig } = await signStage(fab, { passportId: id, stage: Stage.Assembly, carbonG: 1n });
    await expect(passport.recordStage(full, sig)).to.be.revertedWithCustomError(passport, "NotAuthorizedAttester");
  });

  it("rejects tampered payloads", async () => {
    const { passport, mint, fab, signStage } = await loadFixture(deploy);
    const id = await mint();
    const { full, sig } = await signStage(fab, { passportId: id, stage: Stage.WaferFab, carbonG: 1_000_000n });
    const tampered = { ...full, carbonG: 10n }; // under-report after signing
    await expect(passport.recordStage(tampered, sig)).to.be.revertedWithCustomError(passport, "NotAuthorizedAttester");
  });

  it("rejects expired attestations", async () => {
    const { passport, mint, fab, signStage } = await loadFixture(deploy);
    const id = await mint();
    const { full, sig } = await signStage(fab, { passportId: id, stage: Stage.WaferFab, carbonG: 1n });
    await time.increase(7200);
    await expect(passport.recordStage(full, sig)).to.be.revertedWithCustomError(passport, "Expired");
  });

  it("enforces lifecycle order", async () => {
    const { passport, mint, osat, fab } = await loadFixture(deploy);
    const id = await mint();
    const base = { passportId: id, fieldsRoot: ZERO, evidenceHash: ZERO, carbonG: 1n, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n };
    await passport.connect(osat).recordStage({ ...base, stage: Stage.Assembly }, "0x");
    await expect(passport.connect(fab).recordStage({ ...base, stage: Stage.WaferFab }, "0x")).to.be.revertedWithCustomError(passport, "StageOutOfOrder");
  });

  it("records AI verdicts and computes verified share", async () => {
    const { passport, mint, fab, osat, verifier, outsider } = await loadFixture(deploy);
    const id = await mint();
    const base = { passportId: id, fieldsRoot: ZERO, evidenceHash: ZERO, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n };
    await passport.connect(fab).recordStage({ ...base, stage: Stage.WaferFab, carbonG: 750n }, "0x");
    await passport.connect(osat).recordStage({ ...base, stage: Stage.Assembly, carbonG: 250n }, "0x");
    await expect(passport.connect(outsider).attestAI(id, 0, Verdict.Verified, 9100, ethers.id("r"))).to.be.reverted;
    await passport.connect(verifier).attestAI(id, 0, Verdict.Verified, 9100, ethers.id("r"));
    await passport.connect(verifier).attestAI(id, 1, Verdict.Flagged, 3200, ethers.id("r2"));
    expect(await passport.verifiedShareBps(id)).to.equal(7500n);
    const stages = await passport.getStages(id);
    expect(stages[1].verdict).to.equal(Verdict.Flagged);
    expect(stages[1].aiScore).to.equal(3200n);
  });

  it("verifies a selectively disclosed field via Merkle proof", async () => {
    const { passport, mint, fab } = await loadFixture(deploy);
    const id = await mint();
    const fields = [["scope1_gas_kgco2e", "412.5"], ["die_yield", "0.83"], ["grid_location", "taiwan"], ["abatement", "0.99"], ["recipe", "secret"]];
    const salts = fields.map((_, i) => ethers.id("salt" + i));
    const leaves = fields.map(([k, v], i) => leafOf(k, v, salts[i]));
    const tree = merkle(leaves);
    const base = { passportId: id, stage: Stage.WaferFab, fieldsRoot: tree.root, evidenceHash: ZERO, carbonG: 1n, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n };
    await passport.connect(fab).recordStage(base, "0x");
    expect(await passport.verifyField(id, 0, "scope1_gas_kgco2e", "412.5", salts[0], tree.proof(0))).to.equal(true);
    expect(await passport.verifyField(id, 0, "scope1_gas_kgco2e", "100.0", salts[0], tree.proof(0))).to.equal(false);
    expect(await passport.verifyField(id, 0, "recipe", "secret", salts[4], tree.proof(4))).to.equal(true);
  });

  describe("chiplet composition", () => {
    it("allocates component carbon pro-rata and blocks over-allocation", async () => {
      const { passport, mint, fab, osat } = await loadFixture(deploy);
      const chiplet = await mint(100n, "compute chiplet");
      const pkg = await mint(50n, "accelerator package");
      const base = { fieldsRoot: ZERO, evidenceHash: ZERO, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n };
      await passport.connect(fab).recordStage({ ...base, passportId: chiplet, stage: Stage.WaferFab, carbonG: 100_000n }, "0x");

      await expect(passport.connect(osat).integrateComponent(pkg, chiplet, 60n))
        .to.emit(passport, "ComponentIntegrated")
        .withArgs(pkg, chiplet, 60n, 60_000n);
      await expect(passport.connect(osat).integrateComponent(pkg, chiplet, 41n)).to.be.revertedWithCustomError(passport, "ComponentOverAllocated");
      await passport.connect(osat).integrateComponent(pkg, chiplet, 40n);

      expect(await passport.totalCarbonG(pkg)).to.equal(100_000n);
      expect((await passport.getPassport(chiplet)).status).to.equal(1); // Integrated
      expect((await passport.getComponents(pkg)).length).to.equal(2);
    });

    it("requires components to predate the assembly (no cycles)", async () => {
      const { passport, mint, osat } = await loadFixture(deploy);
      const a = await mint();
      const b = await mint();
      await expect(passport.connect(osat).integrateComponent(a, b, 1n)).to.be.revertedWithCustomError(passport, "ComponentMustPredateParent");
    });
  });

  describe("carbon credits", () => {
    async function withFootprint() {
      const f = await deploy();
      const id = await f.mint();
      await f.passport.connect(f.fab).recordStage(
        { passportId: id, stage: Stage.WaferFab, fieldsRoot: ZERO, evidenceHash: ZERO, carbonG: 2_000_000n, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n },
        "0x"
      );
      await f.registry.connect(f.issuer).issueBatch(f.oem.address, 5000n, "Solar PV Gujarat", "VM0042", "VCS-1234-2025", 2025, ZERO);
      return { ...f, id };
    }

    it("retires credits against a passport and burns them", async () => {
      const { registry, passport, oem, id } = await loadFixture(withFootprint);
      await expect(registry.connect(oem).retire(1, 1500n, id, "NX-7 lot 1")).to.emit(passport, "OffsetApplied").withArgs(id, 1_500_000n, 0);
      expect(await registry.balanceOf(oem.address, 1)).to.equal(3500n);
      expect((await passport.getPassport(id)).offsetG).to.equal(1_500_000n);
      expect((await registry.getBatch(1)).retiredKg).to.equal(1500n);
    });

    it("prevents offsetting more than the footprint", async () => {
      const { registry, passport, oem, id } = await loadFixture(withFootprint);
      await expect(registry.connect(oem).retire(1, 2001n, id, "x")).to.be.revertedWithCustomError(passport, "OffsetExceedsFootprint");
    });

    it("prevents tokenizing the same registry serial twice", async () => {
      const { registry, issuer, oem } = await loadFixture(withFootprint);
      await expect(registry.connect(issuer).issueBatch(oem.address, 1n, "dup", "VM0042", "VCS-1234-2025", 2025, ZERO))
        .to.be.revertedWithCustomError(registry, "SerialAlreadyTokenized");
    });

    it("blocks direct offset writes that bypass the registry", async () => {
      const { passport, oem, id } = await loadFixture(withFootprint);
      await expect(passport.connect(oem).recordOffset(id, 1n, 0)).to.be.reverted;
    });
  });

  describe("end of life", () => {
    it("records recycling and mints CIRC to the recycler", async () => {
      const { passport, circ, mint, recycler } = await loadFixture(deploy);
      const id = await mint(10n);
      await expect(passport.connect(recycler).recycle(id, 10n, 2500n, 800n, ZERO, ZERO, "RECY-NL-02"))
        .to.emit(passport, "Recycled")
        .withArgs(id, recycler.address, 10n, 2500n, ethers.parseEther("2.5"));
      expect(await circ.balanceOf(recycler.address)).to.equal(ethers.parseEther("2.5"));
      expect((await passport.getPassport(id)).status).to.equal(2); // Recycled
      await expect(passport.connect(recycler).recycle(id, 1n, 1n, 0n, ZERO, ZERO, "x")).to.be.revertedWithCustomError(passport, "RecycleExceedsUnits");
    });
  });
});

describe("Supplier trust", () => {
  it("scores attesters from AI verdict history and handles re-audits", async () => {
    const { passport, mint, fab, verifier } = await loadFixture(deploy);
    const id = await mint();
    const base = { passportId: id, stage: Stage.WaferFab, fieldsRoot: ZERO, evidenceHash: ZERO, carbonG: 1n, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n };
    let t = await passport.supplierTrust(fab.address);
    expect(t.scoreBps).to.equal(5000n); // neutral prior
    for (let i = 0; i < 3; i++) await passport.connect(fab).recordStage(base, "0x");
    await passport.connect(verifier).attestAI(id, 0, Verdict.Verified, 9000, ZERO);
    await passport.connect(verifier).attestAI(id, 1, Verdict.Verified, 9000, ZERO);
    await passport.connect(verifier).attestAI(id, 2, Verdict.Rejected, 500, ZERO);
    t = await passport.supplierTrust(fab.address);
    expect([t.verified, t.flagged, t.rejected]).to.deep.equal([2n, 0n, 1n]);
    expect(t.scoreBps).to.equal((2n * 10000n + 2n * 5000n) / 5n); // 6000
    await passport.connect(verifier).attestAI(id, 2, Verdict.Flagged, 4000, ZERO); // re-audit
    t = await passport.supplierTrust(fab.address);
    expect([t.verified, t.flagged, t.rejected]).to.deep.equal([2n, 1n, 0n]);
  });
});
