import { BrowserProvider, Contract, formatEther, JsonRpcProvider, parseEther, type Log, type Provider, type Signer } from "ethers";

const MONAD_TESTNET_CHAIN_ID = 10143;
const ABI = [
  "function placeBet(uint256 roundId, bool gains) payable",
  "function claim(uint256 roundId)",
  "function claimMany(uint256[] roundIds)",
  "function rounds(uint256 roundId) view returns (uint64 closesAt, uint128 liquidatedPool, uint128 gainsPool, uint8 status, bool gainsWon)",
  "function liquidatedBets(uint256 roundId, address bettor) view returns (uint256)",
  "function gainsBets(uint256 roundId, address bettor) view returns (uint256)",
  "function claimed(uint256 roundId, address bettor) view returns (bool)",
  "function nextRoundId() view returns (uint256)",
  "event BetPlaced(uint256 indexed roundId, address indexed bettor, bool gains, uint256 amount)",
];

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
};

declare global {
  interface Window { ethereum?: EthereumProvider }
}

export interface WalletSession {
  address: string;
  provider: BrowserProvider;
}

export interface ChainRound {
  closesAt: number;
  liquidatedPool: string;
  gainsPool: string;
  status: number;
  gainsWon: boolean;
}

export interface ChainPosition {
  liquidatedStake: string;
  gainsStake: string;
  claimable: string;
  claimed: boolean;
}

export interface ClaimablePayout {
  contractAddress: string;
  roundId: number;
  amount: string;
}

export const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS ?? "";
export const legacyContractAddresses = (import.meta.env.VITE_LEGACY_CONTRACT_ADDRESSES ?? "")
  .split(",").map((address: string) => address.trim()).filter((address: string) => /^0x[a-fA-F0-9]{40}$/.test(address));
export const configuredRoundId = Number(import.meta.env.VITE_ROUND_ID ?? 1);
export const chainReady = Boolean(contractAddress && /^0x[a-fA-F0-9]{40}$/.test(contractAddress));
export const publicChainProvider = new JsonRpcProvider("https://testnet-rpc.monad.xyz", MONAD_TESTNET_CHAIN_ID);

async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await read(); }
    catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

function requireEthereum() {
  if (!window.ethereum) throw new Error("MetaMask veya EVM uyumlu cüzdan bulunamadı.");
  return window.ethereum;
}

export async function connectMonadWallet(): Promise<WalletSession> {
  const ethereum = requireEthereum();
  const provider = new BrowserProvider(ethereum as never, "any");
  await provider.send("eth_requestAccounts", []);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== MONAD_TESTNET_CHAIN_ID) {
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x279f",
          chainName: "Monad Testnet",
          nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
          rpcUrls: ["https://testnet-rpc.monad.xyz"],
          blockExplorerUrls: ["https://testnet.monadvision.com"],
        }],
      });
    }
  }
  const activeChainId = Number(await ethereum.request({ method: "eth_chainId" }));
  if (activeChainId !== MONAD_TESTNET_CHAIN_ID) throw new Error("Wallet Monad Testnet ağına geçmedi. Cüzdanda ağı seçip yeniden bağlanın.");
  const signer = await provider.getSigner();
  return { address: await signer.getAddress(), provider };
}

function getContract(provider: Provider, signer?: Signer, address = contractAddress) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Önce .env.local dosyasına geçerli kontrat adresini ekleyin.");
  return new Contract(address, ABI, signer ?? provider);
}

export async function readChainRound(provider: Provider, roundId = configuredRoundId): Promise<ChainRound> {
  const contract = getContract(provider);
  const round = await readWithRetry(() => contract.rounds(roundId));
  return {
    closesAt: Number(round.closesAt),
    liquidatedPool: formatEther(round.liquidatedPool),
    gainsPool: formatEther(round.gainsPool),
    status: Number(round.status),
    gainsWon: Boolean(round.gainsWon),
  };
}

export async function readLatestChainRound(provider: Provider): Promise<{ roundId: number; round: ChainRound }> {
  const contract = getContract(provider);
  const nextRoundId = Number(await readWithRetry(() => contract.nextRoundId()));
  if (!Number.isSafeInteger(nextRoundId) || nextRoundId <= 1) {
    throw new Error("Kontratta henüz açılmış bir bahis turu yok.");
  }
  const roundId = nextRoundId - 1;
  return { roundId, round: await readChainRound(provider, roundId) };
}

export async function readChainPosition(provider: Provider, address: string, roundId = configuredRoundId): Promise<ChainPosition> {
  const contract = getContract(provider);
  const [liquidated, gains, round, hasClaimed] = await Promise.all([
    readWithRetry(() => contract.liquidatedBets(roundId, address)),
    readWithRetry(() => contract.gainsBets(roundId, address)),
    readWithRetry(() => contract.rounds(roundId)),
    readWithRetry(() => contract.claimed(roundId, address)),
  ]);
  const liquidatedStake = BigInt(liquidated);
  const gainsStake = BigInt(gains);
  const gainsPool = BigInt(round.gainsPool);
  const liquidatedPool = BigInt(round.liquidatedPool);
  const gainsWon = Boolean(round.gainsWon);
  const winningPool = gainsWon ? gainsPool : liquidatedPool;
  const losingPool = gainsWon ? liquidatedPool : gainsPool;
  const winningStake = gainsWon ? gainsStake : liquidatedStake;
  let payout = 0n;
  if (Number(round.status) === 3) {
    if (winningPool === 0n) payout = liquidatedStake + gainsStake;
    else if (winningStake > 0n) payout = winningStake + (winningStake * losingPool) / winningPool;
  }
  return {
    liquidatedStake: formatEther(liquidatedStake),
    gainsStake: formatEther(gainsStake),
    claimable: hasClaimed ? "0" : formatEther(payout),
    claimed: Boolean(hasClaimed),
  };
}

type ClaimScanState = {
  scannedThrough: number;
  pendingRounds: number[];
  payouts: Map<number, ClaimablePayout>;
};

const claimScanStates = new Map<string, ClaimScanState>();
const claimScanRequests = new Map<string, Promise<ClaimablePayout[]>>();

function claimScanKey(poolAddress: string, bettor: string) {
  return `flyordie-claim-scan-v1:${poolAddress.toLowerCase()}:${bettor.toLowerCase()}`;
}

function getClaimScanState(poolAddress: string, bettor: string): ClaimScanState {
  const key = claimScanKey(poolAddress, bettor);
  const cached = claimScanStates.get(key);
  if (cached) return cached;

  let state: ClaimScanState = { scannedThrough: 0, pendingRounds: [], payouts: new Map() };
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
      scannedThrough?: number;
      pendingRounds?: number[];
      payouts?: Array<{ roundId: number; amount: string }>;
    } | null;
    if (saved) {
      state.scannedThrough = Number.isSafeInteger(saved.scannedThrough) && Number(saved.scannedThrough) >= 0
        ? Number(saved.scannedThrough)
        : 0;
      state.pendingRounds = [...new Set((saved.pendingRounds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
      for (const payout of saved.payouts ?? []) {
        if (Number.isSafeInteger(payout.roundId) && payout.roundId > 0 && Number.isFinite(Number(payout.amount)) && Number(payout.amount) > 0) {
          state.payouts.set(payout.roundId, { contractAddress: poolAddress, roundId: payout.roundId, amount: payout.amount });
        }
      }
    }
  } catch { /* Storage can be disabled; the in-memory cache still works. */ }
  claimScanStates.set(key, state);
  return state;
}

function saveClaimScanState(poolAddress: string, bettor: string, state: ClaimScanState) {
  const key = claimScanKey(poolAddress, bettor);
  claimScanStates.set(key, state);
  try {
    window.localStorage.setItem(key, JSON.stringify({
      scannedThrough: state.scannedThrough,
      pendingRounds: state.pendingRounds,
      payouts: [...state.payouts.values()].map(({ roundId, amount }) => ({ roundId, amount })),
    }));
  } catch { /* Continue with the in-memory cache when storage is unavailable. */ }
}

async function inspectClaimRound(contract: Contract, poolAddress: string, bettor: string, roundId: number, state: ClaimScanState) {
  const round = await readWithRetry(() => contract.rounds(roundId));
  if (Number(round.status) !== 3) {
    if (!state.pendingRounds.includes(roundId)) state.pendingRounds.push(roundId);
    return;
  }

  const [liquidated, gains] = await Promise.all([
    readWithRetry(() => contract.liquidatedBets(roundId, bettor)),
    readWithRetry(() => contract.gainsBets(roundId, bettor)),
  ]);
  const liquidatedStake = BigInt(liquidated);
  const gainsStake = BigInt(gains);
  if (liquidatedStake === 0n && gainsStake === 0n) {
    state.pendingRounds = state.pendingRounds.filter((id) => id !== roundId);
    state.payouts.delete(roundId);
    return;
  }
  if (await readWithRetry(() => contract.claimed(roundId, bettor))) {
    state.pendingRounds = state.pendingRounds.filter((id) => id !== roundId);
    state.payouts.delete(roundId);
    return;
  }

  const gainsPool = BigInt(round.gainsPool);
  const liquidatedPool = BigInt(round.liquidatedPool);
  const winningPool = Boolean(round.gainsWon) ? gainsPool : liquidatedPool;
  const losingPool = Boolean(round.gainsWon) ? liquidatedPool : gainsPool;
  const winningStake = Boolean(round.gainsWon) ? gainsStake : liquidatedStake;
  const payout = winningPool === 0n
    ? liquidatedStake + gainsStake
    : winningStake > 0n ? winningStake + (winningStake * losingPool) / winningPool : 0n;
  state.pendingRounds = state.pendingRounds.filter((id) => id !== roundId);
  if (payout > 0n) state.payouts.set(roundId, { contractAddress: poolAddress, roundId, amount: formatEther(payout) });
  else state.payouts.delete(roundId);
}

async function scanClaimables(provider: Provider, bettor: string): Promise<ClaimablePayout[]> {
  const claimables: ClaimablePayout[] = [];
  const addresses = [...new Set([contractAddress, ...legacyContractAddresses].filter((value) => /^0x[a-fA-F0-9]{40}$/.test(value)))];
  for (const poolAddress of addresses) {
    const contract = getContract(provider, undefined, poolAddress);
    const nextRound = Number(await readWithRetry(() => contract.nextRoundId()));
    if (!Number.isSafeInteger(nextRound) || nextRound < 1 || nextRound > 10_000) {
      throw new Error(`Kontrattaki tur sayısı beklenmeyen bir değer döndürdü (${poolAddress}).`);
    }

    const lastRound = nextRound - 1;
    const state = getClaimScanState(poolAddress, bettor);
    if (state.scannedThrough > lastRound) {
      state.scannedThrough = 0;
      state.pendingRounds = [];
      state.payouts.clear();
    }
    state.pendingRounds = state.pendingRounds.filter((id) => id <= lastRound);

    // Only revisit rounds that are still open/locked and newly opened rounds.
    // Completed history is cached locally so every refresh does not rescan it.
    for (const roundId of [...state.pendingRounds]) {
      await inspectClaimRound(contract, poolAddress, bettor, roundId, state);
      saveClaimScanState(poolAddress, bettor, state);
    }
    while (state.scannedThrough < lastRound) {
      const roundId = state.scannedThrough + 1;
      await inspectClaimRound(contract, poolAddress, bettor, roundId, state);
      state.scannedThrough = roundId;
      saveClaimScanState(poolAddress, bettor, state);
    }

    // A payout can disappear if the wallet claims it from another tab/device.
    for (const [roundId, payout] of [...state.payouts]) {
      if (await readWithRetry(() => contract.claimed(roundId, bettor))) state.payouts.delete(roundId);
      else claimables.push(payout);
    }
    saveClaimScanState(poolAddress, bettor, state);
  }
  return claimables;
}

export function readAllClaimables(provider: Provider, bettor: string): Promise<ClaimablePayout[]> {
  const addresses = [...new Set([contractAddress, ...legacyContractAddresses].filter((value) => /^0x[a-fA-F0-9]{40}$/.test(value)))];
  const requestKey = `${bettor.toLowerCase()}:${addresses.map((address) => address.toLowerCase()).join(",")}`;
  const current = claimScanRequests.get(requestKey);
  if (current) return current;
  const request = scanClaimables(provider, bettor).finally(() => claimScanRequests.delete(requestKey));
  claimScanRequests.set(requestKey, request);
  return request;
}

export async function placeChainBet(session: WalletSession, gains: boolean, amount: string, roundId = configuredRoundId) {
  if (!chainReady) throw new Error("Kontrat adresi ayarlanmamış.");
  const network = await session.provider.getNetwork();
  if (Number(network.chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error("Cüzdan Monad Testnet üzerinde değil; ağ değiştiyse yeniden bağlanın.");
  const signer = await session.provider.getSigner();
  const contract = getContract(session.provider, signer);
  const tx = await contract.placeBet(roundId, gains, { value: parseEther(amount) });
  return tx.wait();
}

export async function claimChainPayout(session: WalletSession, payout: Pick<ClaimablePayout, "contractAddress" | "roundId">) {
  const network = await session.provider.getNetwork();
  if (Number(network.chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error("Cüzdan Monad Testnet üzerinde değil; ağ değiştiyse yeniden bağlanın.");
  const signer = await session.provider.getSigner();
  const contract = getContract(session.provider, signer, payout.contractAddress);
  const tx = await contract.claim(payout.roundId);
  return tx.wait();
}

export async function claimChainPayouts(session: WalletSession, payouts: Array<Pick<ClaimablePayout, "contractAddress" | "roundId">>) {
  if (payouts.length === 0) throw new Error("Claim edilecek kazanç yok.");
  const poolAddress = payouts[0].contractAddress;
  if (payouts.some((payout) => payout.contractAddress.toLowerCase() !== poolAddress.toLowerCase())) {
    throw new Error("Tek claim işlemi yalnızca aynı kontrattaki turları birleştirebilir.");
  }
  const network = await session.provider.getNetwork();
  if (Number(network.chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error("Cüzdan Monad Testnet üzerinde değil; ağ değiştiyse yeniden bağlanın.");
  const signer = await session.provider.getSigner();
  const contract = getContract(session.provider, signer, poolAddress);
  if (poolAddress.toLowerCase() === contractAddress.toLowerCase()) {
    const roundIds = payouts.map((payout) => payout.roundId);
    let batchSupported = true;
    try {
      await contract.claimMany.staticCall(roundIds);
    } catch {
      batchSupported = false;
    }
    if (batchSupported) {
      const tx = await contract.claimMany(roundIds);
      return tx.wait();
    }
    {
      // Existing testnet deployments predate claimMany; keep them usable by
      // processing each resolved round with the original claim method.
      const receipts = [];
      for (const roundId of roundIds) {
        const tx = await contract.claim(roundId);
        receipts.push(await tx.wait());
      }
      return receipts[receipts.length - 1];
    }
  }
  const tx = await contract.claim(payouts[0].roundId);
  return tx.wait();
}

export function watchChainBets(provider: Provider, onBet: (event: { roundId: string; bettor: string; gains: boolean; amount: string; txHash: string }) => void) {
  if (!chainReady) return () => undefined;
  const contract = getContract(provider);
  const listener = (roundId: bigint, bettor: string, gains: boolean, amount: bigint, event: { log: Log }) => {
    onBet({ roundId: roundId.toString(), bettor, gains, amount: formatEther(amount), txHash: event.log.transactionHash });
  };
  void contract.on("BetPlaced", listener);
  return () => { void contract.off("BetPlaced", listener); };
}
