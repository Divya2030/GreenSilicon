require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");
const path = require("path");

// Load ../.env (no dependency): KEY=value lines, existing env vars win.
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { TESTNET_MNEMONIC, DEPLOYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL, SEPOLIA_RPC_URL, AMOY_RPC_URL } = process.env;
// Every demo actor (designer, fabs, OSAT, auditor, data-center operator, ...) is its own
// HD account derived from TESTNET_MNEMONIC, with the same indices as the local chain.
const accounts = TESTNET_MNEMONIC ? { mnemonic: TESTNET_MNEMONIC, count: 40 } : DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    baseSepolia: { url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", accounts, chainId: 84532 },
    ...(SEPOLIA_RPC_URL && { sepolia: { url: SEPOLIA_RPC_URL, accounts, chainId: 11155111 } }),
    ...(AMOY_RPC_URL && { amoy: { url: AMOY_RPC_URL, accounts, chainId: 80002 } }),
  },
  // Contract verification on Blockscout (no API key needed)
  etherscan: {
    apiKey: { baseSepolia: "blockscout" },
    customChains: [
      { network: "baseSepolia", chainId: 84532, urls: { apiURL: "https://base-sepolia.blockscout.com/api", browserURL: "https://base-sepolia.blockscout.com" } },
    ],
  },
  sourcify: { enabled: false },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};
