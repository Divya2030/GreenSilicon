const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const leafOf = (ts, v) => ethers.keccak256(ethers.keccak256(coder.encode(["uint64", "uint256"], [ts, v])));
const hashPair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));
function merkle(leaves) {
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const p = layers.at(-1), n = [];
    for (let i = 0; i < p.length; i += 2) n.push(i + 1 < p.length ? hashPair(p[i], p[i + 1]) : p[i]);
    layers.push(n);
  }
  return {
    root: layers.at(-1)[0],
    proof: (idx) => layers.slice(0, -1).flatMap((l) => { const s = idx ^ 1; idx >>= 1; return s < l.length ? [l[s]] : []; }),
  };
}

const TYPES = {
  TelemetryBatch: [
    { name: "device", type: "address" }, { name: "fromTs", type: "uint64" }, { name: "toTs", type: "uint64" },
    { name: "count", type: "uint32" }, { name: "root", type: "bytes32" }, { name: "total", type: "uint256" },
    { name: "alerts", type: "uint32" }, { name: "nonce", type: "uint256" },
  ],
};

async function deploy() {
  const [admin, operator, outsider] = await ethers.getSigners();
  const meter = ethers.Wallet.createRandom();
  const reg = await ethers.deployContract("TelemetryRegistry");
  await reg.grantRole(await reg.OPERATOR_ROLE(), operator.address);
  await reg.connect(operator).registerDevice(meter.address, 1, "Fab 3 abatement unit A");
  const domain = { name: "GreenSilicon Telemetry", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await reg.getAddress() };

  async function batch(fromTs, readings, signer = meter, nonce) {
    const leaves = readings.map(([t, v]) => leafOf(t, v));
    const tree = merkle(leaves);
    const msg = {
      device: meter.address, fromTs, toTs: readings.at(-1)[0], count: readings.length, root: tree.root,
      total: readings.reduce((a, [, v]) => a + BigInt(v), 0n), alerts: readings.filter(([, v]) => v < 9000).length,
      nonce: nonce ?? (await reg.nonces(meter.address)),
    };
    return { msg, sig: await signer.signTypedData(domain, TYPES, msg), tree };
  }
  return { reg, operator, outsider, meter, batch };
}

describe("TelemetryRegistry", () => {
  it("anchors a meter-signed batch and proves single readings", async () => {
    const { reg, outsider, meter, batch } = await loadFixture(deploy);
    const readings = [[1000, 9910], [1900, 9905], [2800, 0], [3700, 9900]];
    const { msg, sig, tree } = await batch(1000, readings);
    await expect(reg.connect(outsider).anchorBatch(msg, sig)).to.emit(reg, "BatchAnchored").withArgs(meter.address, 0, 1000, 3700, 4, 29715, 1, tree.root);
    expect(await reg.verifyReading(meter.address, 0, 2800, 0, tree.proof(2))).to.equal(true);
    expect(await reg.verifyReading(meter.address, 0, 2800, 9900, tree.proof(2))).to.equal(false); // cannot hide the outage
  });

  it("rejects batches not signed by the device itself", async () => {
    const { reg, batch } = await loadFixture(deploy);
    const { msg, sig } = await batch(0, [[0, 1]], ethers.Wallet.createRandom());
    await expect(reg.anchorBatch(msg, sig)).to.be.revertedWithCustomError(reg, "BadSignature");
  });

  it("enforces contiguous time so periods cannot be skipped or backfilled", async () => {
    const { reg, batch } = await loadFixture(deploy);
    const a = await batch(0, [[0, 1], [900, 1]]);
    await reg.anchorBatch(a.msg, a.sig);
    const gap = await batch(5000, [[5000, 1]]);
    await expect(reg.anchorBatch(gap.msg, gap.sig)).to.be.revertedWithCustomError(reg, "NonContiguous");
    const ok = await batch(900, [[1800, 1]]);
    await reg.anchorBatch(ok.msg, ok.sig);
    expect(await reg.batchCount((await reg.getDevices())[0])).to.equal(2n);
  });

  it("rejects replays, unknown and deactivated devices", async () => {
    const { reg, operator, outsider, meter, batch } = await loadFixture(deploy);
    const a = await batch(0, [[0, 1]]);
    await reg.anchorBatch(a.msg, a.sig);
    await expect(reg.anchorBatch(a.msg, a.sig)).to.be.revertedWithCustomError(reg, "BadNonce");
    await expect(reg.connect(outsider).setActive(meter.address, false)).to.be.revertedWithCustomError(reg, "NotOperator");
    await reg.connect(operator).setActive(meter.address, false);
    const b = await batch(0, [[0, 1]]);
    await expect(reg.anchorBatch(b.msg, b.sig)).to.be.revertedWithCustomError(reg, "Inactive");
    await expect(reg.connect(outsider).registerDevice(outsider.address, 0, "x")).to.be.reverted;
  });
});
