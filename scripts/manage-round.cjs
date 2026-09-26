const { ethers } = require("ethers");

const ABI = [
  "function openRound(uint64 closesAt) returns (uint256 roundId)",
  "function lockRound(uint256 roundId)",
  "function resolveRound(uint256 roundId, bool gainsWon)",
  "function nextRoundId() view returns (uint256)",
  "function rounds(uint256 roundId) view returns (uint64 closesAt, uint128 liquidatedPool, uint128 gainsPool, uint8 status, bool gainsWon)",
];

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const key = process.env.MONAD_PRIVATE_KEY;
  const address = process.env.MONAD_CONTRACT_ADDRESS;
  if (!key || !address) throw new Error("Set MONAD_PRIVATE_KEY and MONAD_CONTRACT_ADDRESS in your shell.");
  const provider = new ethers.JsonRpcProvider("https://testnet-rpc.monad.xyz", 10143);
  const signer = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, ABI, signer);

  if (command === "open") {
    const seconds = Number(args[0] ?? 10);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) throw new Error("Bet window must be 5–300 seconds.");
    const closesAt = Math.floor(Date.now() / 1000) + seconds;
    const tx = await contract.openRound(closesAt);
    await tx.wait();
    const id = (await contract.nextRoundId()) - 1n;
    console.log(`Opened round ${id}; betting closes at ${closesAt}. Tx: ${tx.hash}`);
  } else if (command === "lock") {
    const id = BigInt(args[0] ?? "0");
    if (id <= 0n) throw new Error("Usage: npm run contract:round -- lock <roundId>");
    const tx = await contract.lockRound(id);
    await tx.wait();
    console.log(`Locked round ${id}. Tx: ${tx.hash}`);
  } else if (command === "resolve") {
    const id = BigInt(args[0] ?? "0");
    const outcome = args[1];
    if (id <= 0n || !["gains", "liquidated"].includes(outcome)) throw new Error("Usage: npm run contract:round -- resolve <roundId> <gains|liquidated>");
    const tx = await contract.resolveRound(id, outcome === "gains");
    await tx.wait();
    console.log(`Resolved round ${id} as ${outcome}. Tx: ${tx.hash}`);
  } else if (command === "show") {
    const id = BigInt(args[0] ?? "0");
    if (id <= 0n) throw new Error("Usage: npm run contract:round -- show <roundId>");
    const r = await contract.rounds(id);
    console.log(JSON.stringify({ roundId: id.toString(), closesAt: Number(r.closesAt), liquidatedMON: ethers.formatEther(r.liquidatedPool), gainsMON: ethers.formatEther(r.gainsPool), status: ["None", "Open", "Locked", "Resolved"][Number(r.status)], gainsWon: r.gainsWon }, null, 2));
  } else {
    throw new Error("Commands: open [seconds] | lock <roundId> | resolve <roundId> <gains|liquidated> | show <roundId>");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
