require("@nomicfoundation/hardhat-ethers");

const privateKey = process.env.MONAD_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    monadTestnet: {
      url: "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: privateKey ? [privateKey] : [],
    },
  },
};
