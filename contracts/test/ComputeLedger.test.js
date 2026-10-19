const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ZERO = ethers.ZeroHash;

async function deploy() {
  const [admin, designer, fab, dcOp, customer, outsider] = await ethers.getSigners();
  const circ = await ethers.deployContract("CircularityToken");
  const passport = await ethers.deployContract("GreenSiliconPassport", [await circ.getAddress()]);
  const ledger = await ethers.deployContract("ComputeLedger", [await passport.getAddress()]);
  await passport.grantRole(await passport.DESIGNER_ROLE(), designer.address);
  await passport.grantRole(await passport.FAB_ROLE(), fab.address);
  await ledger.grantRole(await ledger.DATACENTER_ROLE(), dcOp.address);

  // Accelerator lot: 100 units, 10 kg embodied each (1,000 kg total)
  await passport.connect(designer).createPassport(customer.address, "NX-7", "5nm", 100, ZERO, "");
  await passport.connect(fab).recordStage(
    { passportId: 1, stage: 1, fieldsRoot: ZERO, evidenceHash: ZERO, carbonG: 1_000_000n, energyWh: 0n, waterL: 0n, facility: "x", nonce: 0n, deadline: 0n }, "0x");
  // Arizona-like DC: PUE 1.18, WUE 1.63 L/kWh, EWIF 4.959 L/kWh, extremely high water stress
  await ledger.connect(dcOp).registerDataCenter("Helios PHX-1", "Arizona, USA", 1180, 1630, 4959, 4);
  const job = (o = {}) => ({ deploymentId: 0, startTs: 1000, endTs: 4600, centiHours: 800n * 100n, itEnergyWh: 600_000n, operationalG: 260_000n,
    waterOnsiteL: 980n, baselineG: 300_000n, jobHash: ethers.id("job"), workHash: ZERO, parentCertPlusOne: 0n, ...o });
  return { passport, ledger, dcOp, customer, outsider, job };
}

describe("ComputeLedger", () => {
  it("amortises embodied carbon from the passport on-chain and mints a certificate", async () => {
    const { ledger, dcOp, customer, job } = await loadFixture(deploy);
    await expect(ledger.connect(dcOp).deploy(1, 0, 40, 10_000)).to.emit(ledger, "Deployed").withArgs(0, 1, 0, 40, 10_000n);
    await ledger.connect(dcOp).certify(job(), customer.address);
    const c = await ledger.getCertificate(0);
    expect(c.embodiedG).to.equal(800n);                       // 10,000 g x 800 h / 10,000 h
    expect(c.facilityEnergyWh).to.equal(708_000n);            // 600 kWh x 1.18
    expect(c.waterOffsiteL).to.equal((708_000n * 4959n) / 1_000_000n); // 3,510 L
    expect(await ledger.ownerOf(0)).to.equal(customer.address);
    const l = await ledger.lifecycle(1);
    expect([l.unitsDeployed, l.embodiedAllocatedG, l.certificates]).to.deep.equal([40n, 800n, 1n]);
  });

  it("never allocates more embodied carbon than the deployed hardware carries", async () => {
    const { ledger, dcOp, customer, job } = await loadFixture(deploy);
    await ledger.connect(dcOp).deploy(1, 0, 1, 1_000); // one accelerator, 1,000 h rated life
    await ledger.connect(dcOp).certify(job({ centiHours: 900n * 100n }), customer.address);
    await expect(ledger.connect(dcOp).certify(job({ centiHours: 200n * 100n }), customer.address)).to.be.revertedWithCustomError(ledger, "LifetimeExceeded");
  });

  it("deploys each passported unit only once", async () => {
    const { ledger, dcOp } = await loadFixture(deploy);
    await ledger.connect(dcOp).deploy(1, 0, 70, 10_000);
    await expect(ledger.connect(dcOp).deploy(1, 0, 31, 10_000)).to.be.revertedWithCustomError(ledger, "DeployExceedsUnits");
  });

  it("only the data center's operator can deploy and certify", async () => {
    const { ledger, dcOp, outsider, customer, job } = await loadFixture(deploy);
    await expect(ledger.connect(outsider).deploy(1, 0, 1, 1)).to.be.revertedWithCustomError(ledger, "NotOperator");
    await ledger.connect(dcOp).deploy(1, 0, 1, 1_000);
    await expect(ledger.connect(outsider).certify(job(), customer.address)).to.be.revertedWithCustomError(ledger, "NotOperator");
    await expect(ledger.connect(outsider).registerDataCenter("x", "y", 1100, 0, 0, 0)).to.be.reverted;
  });

  it("reuses an identical computation with zero new energy and trustless avoided carbon", async () => {
    const { ledger, dcOp, customer, outsider, job } = await loadFixture(deploy);
    await ledger.connect(dcOp).deploy(1, 0, 40, 10_000);
    const work = ethers.id("model:llm-7b|data:v3|params:lr=2e-5");
    await ledger.connect(dcOp).certify(job({ workHash: work }), customer.address);
    await expect(ledger.connect(dcOp).certifyReuse(work, outsider.address)).to.emit(ledger, "ComputeReused").withArgs(1, 0, outsider.address, work, 260_800n);
    const c = await ledger.getCertificate(1);
    expect([c.reused, c.itEnergyWh, c.operationalG, c.avoidedG]).to.deep.equal([true, 0n, 0n, 260_800n]);
    expect(await ledger.totalAvoidedG()).to.equal(260_800n);
    await expect(ledger.connect(dcOp).certifyReuse(ethers.id("never-computed"), outsider.address)).to.be.revertedWithCustomError(ledger, "NoReusableResult");
  });

  it("credits incremental runs against the from-scratch parent", async () => {
    const { ledger, dcOp, customer, job } = await loadFixture(deploy);
    await ledger.connect(dcOp).deploy(1, 0, 40, 10_000);
    await ledger.connect(dcOp).certify(job(), customer.address); // full run: 260 kg
    await ledger.connect(dcOp).certify(job({ centiHours: 80n * 100n, operationalG: 26_000n, parentCertPlusOne: 1n }), customer.address);
    expect((await ledger.getCertificate(1)).avoidedG).to.equal(234_000n);
    expect((await ledger.lifecycle(1)).avoidedG).to.equal(234_000n);
  });
});
