require("@nomicfoundation/hardhat-toolbox");

const { SEPOLIA_RPC_URL, AMOY_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(SEPOLIA_RPC_URL && { sepolia: { url: SEPOLIA_RPC_URL, accounts, chainId: 11155111 } }),
    ...(AMOY_RPC_URL && { amoy: { url: AMOY_RPC_URL, accounts, chainId: 80002 } }),
  },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};
