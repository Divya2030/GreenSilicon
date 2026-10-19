// Deploys GreenSiliconPassport + CarbonCreditRegistry + CircularityToken + TelemetryRegistry + ComputeLedger, wires roles
// for the demo supply-chain actors and writes ../shared/deployment.json
// (addresses + ABIs) for the backend and frontend.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

// Demo actors map to Hardhat dev accounts by index (the backend derives the
// same keys from the public test mnemonic). On a public testnet every role
// defaults to the deployer unless overridden via ROLE_<NAME> env vars.
const ACTORS = [
  { key: "registrar", name: "GreenSilicon Registrar", index: 0, roles: [] },
  { key: "designer", name: "Aurora Silicon (fabless designer)", index: 1, roles: ["DESIGNER_ROLE"] },
  { key: "fab_tw", name: "Northbay Foundry Fab 7 (Hsinchu, Taiwan)", index: 2, roles: ["FAB_ROLE"] },
  { key: "fab_us", name: "Mesa Foundry Fab 3 (Arizona, USA)", index: 3, roles: ["FAB_ROLE"] },
  { key: "osat", name: "Penang Advanced Packaging (Malaysia)", index: 4, roles: ["OSAT_ROLE"] },
  { key: "logistics", name: "GreenFreight Logistics", index: 5, roles: ["LOGISTICS_ROLE"] },
  { key: "ai_auditor", name: "GreenSilicon AI Auditor (oracle)", index: 6, roles: ["AI_VERIFIER_ROLE"] },
  { key: "recycler", name: "Circular Metals Recovery (Netherlands)", index: 7, roles: ["RECYCLER_ROLE"] },
  { key: "credit_issuer", name: "Verified Credit Bridge", index: 8, roles: [], registryRoles: ["ISSUER_ROLE"] },
  { key: "oem", name: "Helios Cloud (buyer & data-center operator)", index: 9, roles: [], computeRoles: ["DATACENTER_ROLE"] },
  { key: "fab_kr", name: "Hanul Memory Fab M3 (Icheon, South Korea)", index: 10, roles: ["FAB_ROLE"] },
];

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const net = await ethers.provider.getNetwork();
  console.log(`Deploying to ${hre.network.name} (chainId ${net.chainId}) from ${deployer.address}`);
  const local = Number(net.chainId) === 31337;
  if (!local) {
    const bal = await ethers.provider.getBalance(deployer.address);
    console.log(`Deployer balance: ${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) throw new Error(`Fund ${deployer.address} from a faucet first`);
  }

  const circ = await ethers.deployContract("CircularityToken");
  await circ.waitForDeployment();
  const passport = await ethers.deployContract("GreenSiliconPassport", [await circ.getAddress()]);
  await passport.waitForDeployment();
  const registry = await ethers.deployContract("CarbonCreditRegistry", [await passport.getAddress()]);
  await registry.waitForDeployment();

  const telemetry = await ethers.deployContract("TelemetryRegistry");
  await telemetry.waitForDeployment();
  const compute = await ethers.deployContract("ComputeLedger", [await passport.getAddress()]);
  await compute.waitForDeployment();

  await (await circ.grantRole(await circ.MINTER_ROLE(), await passport.getAddress())).wait();
  await (await passport.grantRole(await passport.OFFSET_REGISTRY_ROLE(), await registry.getAddress())).wait();

  const actors = {};
  for (const a of ACTORS) {
    const override = process.env[`ROLE_${a.key.toUpperCase()}`];
    const address = override || (signers[a.index] || deployer).address;
    for (const r of a.roles) await (await passport.grantRole(await passport[r](), address)).wait();
    for (const r of a.registryRoles || []) await (await registry.grantRole(await registry[r](), address)).wait();
    for (const r of a.computeRoles || []) await (await compute.grantRole(await compute[r](), address)).wait();
    // Fabs operate their own IoT meters
    if (a.roles.includes("FAB_ROLE")) await (await telemetry.grantRole(await telemetry.OPERATOR_ROLE(), address)).wait();
    actors[a.key] = { name: a.name, address, index: a.index, roles: [...a.roles, ...(a.registryRoles || []), ...(a.computeRoles || [])] };
  }

  const abi = (n) => hre.artifacts.readArtifactSync(n).abi;
  const out = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployBlock: await ethers.provider.getBlockNumber(),
    contracts: {
      GreenSiliconPassport: { address: await passport.getAddress(), abi: abi("GreenSiliconPassport") },
      CarbonCreditRegistry: { address: await registry.getAddress(), abi: abi("CarbonCreditRegistry") },
      CircularityToken: { address: await circ.getAddress(), abi: abi("CircularityToken") },
      TelemetryRegistry: { address: await telemetry.getAddress(), abi: abi("TelemetryRegistry") },
      ComputeLedger: { address: await compute.getAddress(), abi: abi("ComputeLedger") },
    },
    actors,
  };
  if (hre.network.name === "hardhat" && !process.env.WRITE_DEPLOYMENT) {
    console.log("In-process network: deployment file not written (use --network localhost)");
    return;
  }
  // Public networks: every actor sends some transactions itself, so top each one up with gas money.
  if (!local) {
    const topUp = ethers.parseEther(process.env.ACTOR_GAS_ETH || "0.0015");
    for (const a of Object.values(actors)) {
      if (a.address.toLowerCase() === deployer.address.toLowerCase()) continue;
      const bal = await ethers.provider.getBalance(a.address);
      if (bal < topUp / 2n) {
        await (await deployer.sendTransaction({ to: a.address, value: topUp - bal })).wait();
        console.log(`funded ${a.name}: ${a.address}`);
      }
    }
    out.explorer = { 84532: "https://base-sepolia.blockscout.com", 11155111: "https://sepolia.etherscan.io", 80002: "https://amoy.polygonscan.com" }[Number(net.chainId)] || null;
    out.deployTxs = {
      GreenSiliconPassport: passport.deploymentTransaction()?.hash, CarbonCreditRegistry: registry.deploymentTransaction()?.hash,
      CircularityToken: circ.deploymentTransaction()?.hash, TelemetryRegistry: telemetry.deploymentTransaction()?.hash, ComputeLedger: compute.deploymentTransaction()?.hash,
    };
  }
  const dir = path.join(__dirname, "..", "..", "shared");
  fs.mkdirSync(dir, { recursive: true });
  const file = local ? "deployment.json" : `deployment.${hre.network.name}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(out, null, 2));
  console.log("GreenSiliconPassport        ", out.contracts.GreenSiliconPassport.address);
  console.log("CarbonCreditRegistry", out.contracts.CarbonCreditRegistry.address);
  console.log("CircularityToken    ", out.contracts.CircularityToken.address);
  console.log("TelemetryRegistry   ", out.contracts.TelemetryRegistry.address);
  console.log("ComputeLedger       ", out.contracts.ComputeLedger.address);
  console.log(`Wrote shared/${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
