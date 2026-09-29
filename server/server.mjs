import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createLiveBrain, decideWithConnectome, LIVE_BRAIN_INTERVAL_MS } from "./neural-brain.mjs";
import { createBtcMarketFeed } from "./btc-market.mjs";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8788);
const BET_SECONDS = Math.max(10, Math.min(300, Number(process.env.FLY_BET_SECONDS ?? 30)));
// Paper positions include a disclosed 5 bps simulated round-trip cost, so tiny
// raw price moves do not count as profitable trades.
const PAPER_TRADE_COST_PERCENT = 0.05;
const REVEAL_SECONDS = 4;
const SETTLED_SECONDS = 3;
const STATE_FILE = resolve(ROOT, ".flyordie-round.json");
// Keep the RPC endpoint that resolves in this user's environment. The
// rpc.testnet.monad.xyz alias currently fails DNS here, so it must not be
// selected as an automatic fallback.
const RPC_URLS = [
  "https://testnet-rpc.monad.xyz",
  "https://monad-testnet.drpc.org",
  "https://testnet-rpc2.monad.xyz",
];
const CHAIN_ID = 10143;
const clients = new Set();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const OPERATOR_ABI = [
  "function operator() view returns (address)",
  "function nextRoundId() view returns (uint256)",
  "function rounds(uint256 roundId) view returns (uint64 closesAt, uint128 liquidatedPool, uint128 gainsPool, uint8 status, bool gainsWon)",
  "function openRound(uint64 closesAt) returns (uint256 roundId)",
  "function lockRound(uint256 roundId)",
  "function resolveRound(uint256 roundId, bool gainsWon)",
];

// The server may load the local, git-ignored .env.local for server-only keys.
// Vite only exposes VITE_* variables to browser code.
function loadLocalEnv() {
  const envPath = resolve(ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(MONAD_PRIVATE_KEY|MONAD_CONTRACT_ADDRESS)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
loadLocalEnv();

function makeRound(id, deadline = Date.now() + BET_SECONDS * 1000, seed = randomBytes(4).readUInt32BE(0) || 1, trade = null) {
  const unit = (offset) => (((seed ^ (offset * 2246822519)) >>> 0) % 1000) / 1000;
  const scenario = { roundId: id, danger: 0.22 + unit(3) * 0.72, opportunity: 0.24 + unit(7) * 0.72, fatigue: 0.12 + unit(11) * 0.74, seed };
  const commitment = createHash("sha256").update(`${id}:${seed}:${scenario.danger}:${scenario.opportunity}:${scenario.fatigue}`).digest("hex");
  const now = Date.now();
  const brainSimulator = createLiveBrain(id, randomBytes(4).readUInt32BE(0) || 1);
  return {
    id, phase: trade ? "betting" : "waiting", deadline, scenario, commitment, trade,
    brainSimulator, brain: brainSimulator.initialFrame,
    decision: decideWithConnectome(scenario), bets: new Map(), pools: { liquidated: 0, gains: 0 },
    chat: [{ id: now, name: "swarm", text: `Shared round #${id} is open — fly brain is sealed.`, color: "#b7ff62" }],
    feed: [{ id: now + 1, text: `Shared round #${id} opened · ${BET_SECONDS}s betting window`, kind: "game" }],
  };
}

function saveRound() {
  try {
    const { id, phase, deadline, scenario, commitment, decision, trade } = round;
    writeFileSync(STATE_FILE, JSON.stringify({ id, phase, deadline, scenario, commitment, decision, trade }), "utf8");
  } catch (error) { console.error("Could not save round state:", error instanceof Error ? error.message : error); }
}

function loadRound(id, deadline) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (saved.id === id && saved.scenario?.seed) {
      const restored = makeRound(id, deadline, saved.scenario.seed);
      restored.scenario = saved.scenario;
      restored.commitment = saved.commitment;
      restored.decision = saved.decision ?? decideWithConnectome(saved.scenario);
      restored.trade = saved.trade ?? (saved.phase ? { side: null, entryPrice: null, entryAt: null, exitPrice: null, exitAt: null, pnlPercent: null, status: "legacy" } : null);
      restored.phase = saved.phase;
      restored.deadline = saved.deadline;
      return restored;
    }
  } catch { /* A new server starts with a fresh round state. */ }
  return makeRound(id, deadline);
}

const marketFeed = createBtcMarketFeed();
let round = makeRound(1);
let connectedCount = 0;
let operatorContract = null;
let operatorProvider = null;
let operatorWallet = null;
let operatorContractAddress = "";
let activeRpcIndex = 0;
let operatorStatus = {
  configured: Boolean(process.env.MONAD_PRIVATE_KEY && process.env.MONAD_CONTRACT_ADDRESS),
  ready: false,
  address: "",
  message: process.env.MONAD_PRIVATE_KEY && process.env.MONAD_CONTRACT_ADDRESS
    ? "Operator is connecting to Monad Testnet…"
    : "Operator key and contract address are missing from the server environment.",
};
let automationBusy = false;
let operatorValidated = false;
let operatorSetupBusy = false;
let retryAt = 0;
let rpcFailureCount = 0;

function nextRpcRetryDelay() {
  rpcFailureCount += 1;
  return Math.min(30_000, 5_000 * (2 ** Math.min(rpcFailureCount - 1, 3)));
}

function selectRpcEndpoint(index) {
  const previousProvider = operatorProvider;
  activeRpcIndex = index;
  operatorProvider = new JsonRpcProvider(RPC_URLS[activeRpcIndex], CHAIN_ID, { staticNetwork: true });
  if (previousProvider && previousProvider !== operatorProvider) previousProvider.destroy();
  if (operatorWallet && operatorContractAddress) {
    operatorContract = new Contract(operatorContractAddress, OPERATOR_ABI, operatorWallet.connect(operatorProvider));
  }
}

function snapshot(clientId) {
  const timeLeft = round.phase === "waiting" ? 0 : Math.max(0, Math.ceil((round.deadline - Date.now()) / 1000));
  const hiddenScene = { roundId: round.id, danger: 0.52, opportunity: 0.5, fatigue: 0.4, seed: round.id };
  const myBet = round.bets.get(clientId) ?? null;
  return {
    roundId: round.id,
    phase: round.phase,
    seconds: timeLeft,
    scenario: round.phase === "betting" || round.phase === "waiting" ? hiddenScene : round.scenario,
    decision: round.phase === "betting" || round.phase === "waiting" ? null : round.decision,
    trade: round.trade,
    market: marketFeed.snapshot(),
    brain: round.brain,
    commitment: round.commitment,
    pools: { ...round.pools },
    participants: round.bets.size,
    connected: connectedCount,
    myBet,
    operator: { ...operatorStatus },
    chat: round.chat.slice(-8),
    feed: round.feed.slice(-8),
  };
}

function sendSnapshot(client) {
  if (client.res.destroyed) return;
  client.res.write(`data: ${JSON.stringify(snapshot(client.id))}\n\n`);
}

function broadcast() {
  for (const client of clients) sendSnapshot(client);
}

function broadcastBrain() {
  if (clients.size === 0) return;
  const message = `event: brain\ndata: ${JSON.stringify(round.brain)}\n\n`;
  for (const client of clients) {
    // A slow/disconnected viewer drops visual samples instead of building an
    // unbounded buffer. The next sample contains the full current frame.
    if (client.res.destroyed || client.res.writableEnded || client.res.writableNeedDrain) continue;
    try { client.res.write(message); }
    catch { client.res.destroy(); }
  }
}

function advanceLiveBrain() {
  if (round.brain.status === "error") return;
  try {
    round.brain = round.brainSimulator.advance();
  } catch (error) {
    console.error(`Live neural simulation stopped for round #${round.id}:`, error instanceof Error ? error.message : error);
    round.brain = {
      ...round.brain,
      sequence: round.brain.sequence + 1,
      active: [],
      potentials: [],
      status: "error",
      message: "Neural simulation stopped. A fresh simulation starts with the next round.",
    };
  }
  broadcastBrain();
}

// Advance a bounded 5 ms of modeled time per tick even with no viewers. Do not
// replay old frames or run catch-up loops that could delay the operator's RPCs.
setInterval(advanceLiveBrain, LIVE_BRAIN_INTERVAL_MS).unref();

function pushFeed(text, kind = "game") {
  round.feed.unshift({ id: Date.now() + Math.random(), text, kind });
  round.feed = round.feed.slice(0, 8);
}

function openPreviewRound(id) {
  const trade = prepareFlyTrade();
  const deadline = Date.now() + BET_SECONDS * 1000;
  if (trade) trade.closeAt = deadline;
  return makeRound(id, deadline, undefined, trade);
}

function prepareFlyTrade() {
  const trade = marketFeed.prepareTrade();
  if (trade) trade.costPercent = PAPER_TRADE_COST_PERCENT;
  return trade;
}

function settleMarketTrade(targetTime, recoveredTick = null) {
  if (!round.trade || round.trade.status === "legacy") return true;
  if (round.trade.status === "closed") return true;
  const tick = recoveredTick ?? marketFeed.priceAt(targetTime);
  if (!tick || !round.trade.entryPrice || !round.trade.side) return false;
  const marketMove = ((tick.price - round.trade.entryPrice) / round.trade.entryPrice) * 100;
  const grossPnlPercent = round.trade.side === "long" ? marketMove : -marketMove;
  const costPercent = round.trade.costPercent ?? 0;
  const pnlPercent = grossPnlPercent - costPercent;
  round.trade = { ...round.trade, exitPrice: tick.price, exitAt: tick.time, exitSource: tick.source === "candle" ? "candle" : "ticker", grossPnlPercent, costPercent, pnlPercent, status: "closed" };
  round.decision.action = round.trade.side === "long" ? "dive" : "dodge";
  round.decision.outcome = pnlPercent > 0 ? "epic_gains" : "liquidated";
  round.decision.multiplier = pnlPercent > 0 ? Number((1 + Math.abs(pnlPercent) * 10).toFixed(2)) : 0;
  saveRound();
  return true;
}

function advancePreviewRound() {
  if (operatorStatus.configured) return;
  const now = Date.now();
  if (round.phase === "waiting") {
    const trade = prepareFlyTrade();
    if (!trade) return;
    trade.closeAt = now + BET_SECONDS * 1000;
    round = makeRound(round.id, trade.closeAt, round.scenario.seed, trade);
    pushFeed(`BTC-USD market live · fly entered ${trade.side.toUpperCase()} at $${trade.entryPrice.toFixed(2)}`);
    saveRound();
    broadcast();
    return;
  }
  if (now < round.deadline) return;
  if (round.phase === "betting") {
    if (!settleMarketTrade(round.deadline)) return;
    round.phase = "reveal";
    round.deadline = now + REVEAL_SECONDS * 1000;
    pushFeed(`BTC-USD position closed · ${round.decision.outcome.replace("_", " ").toUpperCase()}`);
  } else if (round.phase === "reveal") {
    round.phase = "settled";
    round.deadline = now + SETTLED_SECONDS * 1000;
    pushFeed(`Round #${round.id} result · ${round.decision.outcome.replace("_", " ").toUpperCase()}`);
  } else {
    round = openPreviewRound(round.id + 1);
    if (round.trade) pushFeed(`BTC-USD market live · fly entered ${round.trade.side.toUpperCase()} at $${round.trade.entryPrice.toFixed(2)}`);
  }
  broadcast();
}

setInterval(() => { advancePreviewRound(); broadcast(); }, 1000).unref();

function restoreOnchainRound(roundId, closesAt, phase, chainTimestamp) {
  if (round.id !== roundId) round = loadRound(roundId, closesAt * 1000);
  round.phase = phase;
  if (phase === "betting") {
    const remaining = chainTimestamp === undefined
      ? closesAt * 1000 - Date.now()
      : Math.max(0, closesAt - chainTimestamp) * 1000;
    round.deadline = Date.now() + Math.max(0, remaining);
  }
  if (phase === "reveal" && round.deadline <= Date.now()) round.deadline = Date.now() + REVEAL_SECONDS * 1000;
  if (phase === "settled" && round.deadline <= Date.now()) round.deadline = Date.now() + SETTLED_SECONDS * 1000;
  saveRound();
}

async function openNextOnchainRound() {
  const id = Number(await readRpcWithRetry(() => operatorContract.nextRoundId()));
  const trade = prepareFlyTrade();
  if (!trade) throw new Error("Waiting for a fresh Coinbase BTC-USD price before opening the next round.");
  const latestBlock = await readRpcWithRetry(() => operatorProvider.getBlock("latest"));
  if (!latestBlock) throw new Error("Could not read the latest Monad block timestamp.");
  const closesAt = latestBlock.timestamp + BET_SECONDS;
  const tx = await operatorContract.openRound(closesAt);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Monad did not return a receipt for the new round.");
  let openedBlock = null;
  try { openedBlock = await readRpcWithRetry(() => operatorProvider.getBlock(receipt.blockNumber)); } catch { /* Use the latest block read as a safe fallback. */ }
  const chainTimestamp = openedBlock?.timestamp ?? latestBlock.timestamp;
  trade.closeAt = closesAt * 1000;
  round = makeRound(id, Date.now() + Math.max(0, closesAt - chainTimestamp) * 1000, undefined, trade);
  saveRound();
  rpcFailureCount = 0;
  operatorStatus = { ...operatorStatus, ready: true, message: `Round #${id} open · betting closes in ${BET_SECONDS}s.` };
  pushFeed(`Monad round #${id} opened · BTC-USD ${trade.side.toUpperCase()} at $${trade.entryPrice.toFixed(2)}`);
  broadcast();
}

async function settleLockedRound(roundId, closesAt) {
  const closeTime = closesAt * 1000;
  let settled = settleMarketTrade(closeTime);
  if (!settled) {
    const recoveredTick = await marketFeed.recoverPriceAt(closeTime);
    if (recoveredTick) {
      settled = settleMarketTrade(closeTime, recoveredTick);
      if (settled) pushFeed(`Round #${roundId} close recovered from Coinbase 1m candle`);
    }
  }
  if (!settled) {
    operatorStatus = { ...operatorStatus, ready: false, message: `Round #${roundId} is locked · waiting for the BTC-USD closing price.` };
    broadcast();
    return false;
  }
  const gainsWon = round.decision.outcome === "epic_gains";
  const tx = await operatorContract.resolveRound(roundId, gainsWon);
  await tx.wait();
  rpcFailureCount = 0;
  operatorStatus = { ...operatorStatus, ready: true, message: `Round #${roundId} resolved · opening the next round automatically.` };
  pushFeed(`Round #${roundId} resolved · ${gainsWon ? "EPIC GAINS" : "LIQUIDATED"}`);
  broadcast();
  return true;
}

async function syncOnchainGame() {
  if (!operatorContract || !operatorValidated || automationBusy || Date.now() < retryAt) return;
  automationBusy = true;
  try {
    const nextRound = Number(await readRpcWithRetry(() => operatorContract.nextRoundId()));
    if (nextRound === 1) {
      await openNextOnchainRound();
      return;
    }

    const roundId = nextRound - 1;
    const chainRound = await readRpcWithRetry(() => operatorContract.rounds(roundId));
    const closesAt = Number(chainRound.closesAt);
    const status = Number(chainRound.status);
    const liquidated = Number(formatEther(chainRound.liquidatedPool));
    const gains = Number(formatEther(chainRound.gainsPool));
    if (round.id !== roundId) round = loadRound(roundId, closesAt * 1000);
    round.pools = { liquidated, gains };

    if (status === 1) {
      const latestBlock = await readRpcWithRetry(() => operatorProvider.getBlock("latest"));
      if (!latestBlock) throw new Error("Could not read the latest Monad block timestamp.");
      restoreOnchainRound(roundId, closesAt, "betting", latestBlock.timestamp);
      if (latestBlock.timestamp >= closesAt) {
        const tx = await operatorContract.lockRound(roundId);
        await tx.wait();
        round.phase = "reveal";
        round.deadline = Date.now() + REVEAL_SECONDS * 1000;
        pushFeed(`Round #${roundId} locked · revealing the fly's reflex`);
        saveRound();
        rpcFailureCount = 0;
        operatorStatus = { ...operatorStatus, ready: true, message: `Round #${roundId} locked · resolving outcome.` };
      } else {
        rpcFailureCount = 0;
        operatorStatus = { ...operatorStatus, ready: true, message: `Round #${roundId} open · ${Math.max(0, closesAt - latestBlock.timestamp)}s left.` };
      }
      broadcast();
      return;
    }

    if (status === 2) {
      restoreOnchainRound(roundId, closesAt, "reveal");
      await settleLockedRound(roundId, closesAt);
      return;
    }

    if (status === 3) {
      if (round.phase === "betting") {
        round.phase = "reveal";
        round.deadline = Date.now() + REVEAL_SECONDS * 1000;
        pushFeed(`Round #${roundId} result received · revealing the fly's reflex`);
      } else if (round.phase === "reveal" && Date.now() >= round.deadline) {
        round.phase = "settled";
        round.deadline = Date.now() + SETTLED_SECONDS * 1000;
        pushFeed(`Round #${roundId} settled · next round starts automatically`);
      }
      saveRound();
      rpcFailureCount = 0;
      operatorStatus = { ...operatorStatus, ready: true, message: round.phase === "settled" ? `Round #${roundId} settled · next round starts in ${Math.max(0, Math.ceil((round.deadline - Date.now()) / 1000))}s.` : `Round #${roundId} resolved · showing result.` };
      broadcast();
      if (round.phase === "settled" && Date.now() >= round.deadline) await openNextOnchainRound();
      return;
    }

    operatorStatus = { ...operatorStatus, ready: false, message: `Round #${roundId} has an unexpected on-chain status (${status}).` };
    broadcast();
  } catch (error) {
    const retryDelay = nextRpcRetryDelay();
    retryAt = Date.now() + retryDelay;
    const retrySeconds = Math.ceil(retryDelay / 1000);
    operatorStatus = { ...operatorStatus, ready: false, message: error instanceof Error ? `Operator action failed; retrying in ${retrySeconds}s: ${error.message}` : `Operator action failed; retrying in ${retrySeconds}s.` };
    console.error(operatorStatus.message);
    broadcast();
  } finally {
    automationBusy = false;
  }
}

async function readRpcWithRetry(read) {
  let lastError;
  const maxAttempts = RPC_URLS.length * 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await read(); }
    catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        const nextIndex = (activeRpcIndex + 1) % RPC_URLS.length;
        if (nextIndex !== activeRpcIndex) {
          selectRpcEndpoint(nextIndex);
          console.warn(`Monad RPC read failed; retrying via ${RPC_URLS[nextIndex]}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  throw lastError;
}

async function initializeOperator() {
  const key = process.env.MONAD_PRIVATE_KEY;
  const address = process.env.MONAD_CONTRACT_ADDRESS;
  if (!key || !address || operatorSetupBusy || Date.now() < retryAt) return;
  operatorSetupBusy = true;
  try {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("MONAD_CONTRACT_ADDRESS is not a valid EVM address.");
    operatorContractAddress = address;
    operatorWallet = new Wallet(key);
    selectRpcEndpoint(0);
    const walletAddress = await operatorWallet.getAddress();
    await readRpcWithRetry(async () => {
      const bytecode = await operatorProvider.getCode(address);
      if (!bytecode || bytecode === "0x") throw new Error(`No contract bytecode returned by ${RPC_URLS[activeRpcIndex]} for ${address}.`);
      return bytecode;
    });
    const configuredOperator = await readRpcWithRetry(() => operatorContract.operator());
    if (String(configuredOperator).toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(`The server wallet ${walletAddress} is not the contract operator ${configuredOperator}.`);
    }
    operatorValidated = true;
    rpcFailureCount = 0;
    operatorStatus = { configured: true, ready: true, address: walletAddress, message: "Operator connected; automatic Monad rounds are enabled." };
    await syncOnchainGame();
    broadcast();
  } catch (error) {
    operatorValidated = false;
    if (error instanceof Error && error.message.includes("is not the contract operator")) operatorContract = null;
    operatorStatus = { configured: true, ready: false, address: "", message: error instanceof Error ? error.message : "Operator setup failed." };
    const retryDelay = nextRpcRetryDelay();
    retryAt = Date.now() + retryDelay;
    console.error(`Monad operator setup failed: ${operatorStatus.message}`);
    broadcast();
  } finally {
    operatorSetupBusy = false;
  }
}
void initializeOperator();
if (operatorStatus.configured) setInterval(() => {
  if (operatorValidated) void syncOnchainGame();
  else void initializeOperator();
}, 4000).unref();

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request too large.");
  }
  return body ? JSON.parse(body) : {};
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function setCors(res, req) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  setCors(res, req);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && url.pathname === "/api/health") {
    const market = marketFeed.snapshot();
    return json(res, 200, { ok: true, roundId: round.id, phase: round.phase, connected: connectedCount, rpc: RPC_URLS[activeRpcIndex], operator: operatorStatus, market: { status: market.status, productId: market.productId, price: market.price, updatedAt: market.updatedAt } });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, snapshot(url.searchParams.get("clientId") ?? "anonymous"));
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    const id = url.searchParams.get("clientId") ?? "anonymous";
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const client = { id, res };
    clients.add(client); connectedCount = clients.size;
    res.write(": connected\n\n");
    sendSnapshot(client); broadcast();
    res.on("close", () => { clients.delete(client); connectedCount = clients.size; broadcast(); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/bet") {
    try {
      const body = await readJson(req);
      const id = String(body.clientId ?? "").slice(0, 100);
      const side = body.side;
      const amount = Number(body.amount);
      if (!id || !["liquidated", "gains"].includes(side) || !Number.isFinite(amount) || amount < 0.001 || amount > 10) return json(res, 400, { error: "Invalid demo bet." });
      if (operatorStatus.configured) return json(res, 403, { error: "Demo bets are disabled while Monad contract rounds are active." });
      if (round.phase !== "betting" || Date.now() >= round.deadline) return json(res, 409, { error: "This shared round is locked." });
      if (round.bets.has(id)) return json(res, 409, { error: "You already bet in this round." });
      const bet = { side, amount };
      round.bets.set(id, bet);
      round.pools[side] += amount;
      pushFeed(`${id.slice(0, 6)} bet ${amount.toFixed(3)} demo MON on ${side === "gains" ? "EPIC GAINS" : "LIQUIDATED"}`, "tx");
      broadcast();
      return json(res, 200, { ok: true, state: snapshot(id) });
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid request." }); }
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readJson(req);
      const text = String(body.text ?? "").trim().slice(0, 140);
      const id = String(body.clientId ?? "anon").slice(0, 8);
      if (!text) return json(res, 400, { error: "Message is empty." });
      round.chat.push({ id: Date.now(), name: String(body.name ?? `degen-${id}`).slice(0, 20), text, color: "#84d9ff" });
      round.chat = round.chat.slice(-20);
      broadcast();
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid request." }); }
  }

  // In production the same Node process can serve the Vite build and shared API.
  const dist = resolve(ROOT, "dist");
  if (req.method === "GET" && existsSync(dist)) {
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(dist, requested);
    if (!file.startsWith(dist + sep) && file !== resolve(dist, "index.html")) return json(res, 403, { error: "Forbidden." });
    const target = existsSync(file) && statSync(file).isFile() ? file : resolve(dist, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(target).pipe(res);
    return;
  }
  json(res, 404, { error: "Not found." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FlyOrDie shared game server on http://localhost:${PORT} (round #${round.id})`);

  // Keep-alive self-ping: prevents Render free tier from sleeping (every 14 min)
  if (process.env.RENDER_EXTERNAL_URL) {
    const KEEP_ALIVE_MS = 14 * 60 * 1000;
    setInterval(() => {
      fetch(`${process.env.RENDER_EXTERNAL_URL}/api/state`)
        .then(() => console.log("[keep-alive] pinged self"))
        .catch(() => {});
    }, KEEP_ALIVE_MS);
    console.log(`[keep-alive] will ping ${process.env.RENDER_EXTERNAL_URL} every 14 min`);
  }
});
