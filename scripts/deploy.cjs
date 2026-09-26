const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Set MONAD_PRIVATE_KEY in your shell before deploying.");
  const factory = await hre.ethers.getContractFactory("FlyOrDiePool");
  const contract = await factory.deploy(deployer.address);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`FlyOrDiePool deployed to ${address}`);
  console.log(`Operator: ${deployer.address}`);
  console.log(`Set VITE_CONTRACT_ADDRESS=${address} and MONAD_CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
