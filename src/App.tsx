import { useEffect, useMemo, useState, type FormEvent } from "react";
import LiveFly, { type FlyMotion } from "./LiveFly";
import FlyBrainPanel from "./FlyBrainPanel";
import BtcCandlestickChart from "./BtcCandlestickChart";
import { decideFly, type Scenario } from "./game-engine";
import type { FlyTradeSnapshot } from "./market-types";
import { chainReady, contractAddress, connectMonadWallet, configuredRoundId, placeChainBet, readLatestChainRound, readChainPosition, readAllClaimables, publicChainProvider, claimChainPayout, claimChainPayouts, watchChainBets, type ChainPosition, type ChainRound, type ClaimablePayout, type WalletSession } from "./chain";
import { getSharedClientId, sendSharedChat, subscribeToSharedGame, type SharedGameSnapshot } from "./shared-game";

type Side = "liquidated" | "gains";
type Phase = "waiting" | "betting" | "reveal" | "settled";
type FeedItem = { id: number; text: string; kind: "tx" | "game" };
type FlyRoundResult = { roundId: number; side: "long" | "short"; entryPrice: number; exitPrice: number; exitSource?: "ticker" | "candle"; grossPnlPercent: number; costPercent: number; pnlPercent: number };

const CHAT_START = [
  { name: "0xDegen", text: "that fly is either alpha or lunch 🪰", color: "#b9ff62" },
  { name: "speedrun", text: "this fly is already front-running me", color: "#b690ff" },
  { name: "bughunter", text: "all in on fly's survival. trust the compound eyes", color: "#ff9b79" },
];

type UncertainBet = { address: string; roundId: number; side: Side; amount: number; createdAt: number };

function uncertainBetStorageKey(address: string, roundId: number) {
  return `flyordie-pending-bet-v1:${address.toLowerCase()}:${roundId}`;
}

function loadUncertainBet(address: string, roundId: number): UncertainBet | null {
  try {
    const saved = localStorage.getItem(uncertainBetStorageKey(address, roundId));
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Partial<UncertainBet>;
    if (parsed.address?.toLowerCase() !== address.toLowerCase() || parsed.roundId !== roundId || (parsed.side !== "gains" && parsed.side !== "liquidated") || !Number.isFinite(parsed.amount) || !Number.isFinite(parsed.createdAt)) return null;
    return parsed as UncertainBet;
  } catch { return null; }
}

function isAmbiguousBetError(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "string") { parts.push(current); break; }
    if (typeof current !== "object") break;
    const item = current as Record<string, unknown>;
    for (const field of ["message", "shortMessage", "code"]) if (typeof item[field] === "string") parts.push(item[field] as string);
    current = item.error ?? item.info ?? item.cause;
  }
  return /rate.?limit|could not coalesce|unknown_error|timeout|timed out|network error/i.test(parts.join(" "));
}

function makeScenario(id: number): Scenario {
  const seed = (id * 2654435761) >>> 0;
  const unit = (offset: number) => (((seed ^ (offset * 2246822519)) >>> 0) % 1000) / 1000;
  return {
    roundId: id,
    danger: 0.22 + unit(3) * 0.72,
    opportunity: 0.24 + unit(7) * 0.72,
    fatigue: 0.12 + unit(11) * 0.74,
    seed,
  };
}

function App() {
  useEffect(() => {
    let activePanel: HTMLElement | null = null;
    const leavePanel = () => {
      activePanel?.classList.remove("spotlight-active");
      activePanel = null;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".panel") : null;
      if (target !== activePanel) {
        leavePanel();
        activePanel = target;
        activePanel?.classList.add("spotlight-active");
      }
      if (!activePanel) return;
      const bounds = activePanel.getBoundingClientRect();
      activePanel.style.setProperty("--spotlight-x", `${event.clientX - bounds.left}px`);
      activePanel.style.setProperty("--spotlight-y", `${event.clientY - bounds.top}px`);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (activePanel && !(event.relatedTarget instanceof Element && event.relatedTarget.closest(".panel") === activePanel)) leavePanel();
    };
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      leavePanel();
    };
  }, []);

  const [phase, setPhase] = useState<Phase>("betting");
  const [seconds, setSeconds] = useState(10);
  const [roundId, setRoundId] = useState(2407);
  const [scenario, setScenario] = useState(() => makeScenario(2407));
  const [selected, setSelected] = useState<Side | null>(null);
  const [confirmedLocalBet, setConfirmedLocalBet] = useState<{ roundId: number; side: Side; amount: number } | null>(null);
  const [amount, setAmount] = useState("0.05");
  const [pools, setPools] = useState({ liquidated: 1.42, gains: 1.76 });
  const [chat, setChat] = useState(CHAT_START);
  const [chatDraft, setChatDraft] = useState("");
  const [feed, setFeed] = useState<FeedItem[]>([
    { id: 1, text: "Round #2407 betting opened", kind: "game" },
    { id: 2, text: "0x8f2a bet 0.12 MON on EPIC GAINS", kind: "tx" },
    { id: 3, text: "Neuron cluster connected · 40 Hz", kind: "game" },
  ]);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [chainRound, setChainRound] = useState<ChainRound | null>(null);
  const [chainRoundId, setChainRoundId] = useState(configuredRoundId);
  const [chainPosition, setChainPosition] = useState<ChainPosition | null>(null);
  const [claimables, setClaimables] = useState<ClaimablePayout[]>([]);
  const [lastFlyResult, setLastFlyResult] = useState<FlyRoundResult | null>(null);
  const [chainClock, setChainClock] = useState(Math.floor(Date.now() / 1000));
  const [sharedState, setSharedState] = useState<SharedGameSnapshot | null>(null);
  const [sharedOnline, setSharedOnline] = useState(false);
  const [clientId, setClientId] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [betBusy, setBetBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [uncertainBet, setUncertainBet] = useState<UncertainBet | null>(null);

  const decision = useMemo(() => decideFly(scenario), [scenario]);
  const sharedActive = sharedOnline && sharedState !== null;
  const chainMode = Boolean(chainReady && chainRound);
  const chainBetExpired = Boolean(chainMode && chainRound!.status === 1 && chainRound!.closesAt <= chainClock);
  const sharedChainRound = Boolean(chainMode && sharedActive && sharedState.operator?.configured && sharedState.roundId === chainRoundId);
  const sharedPhaseReady = Boolean(sharedChainRound && sharedState?.trade?.status !== "legacy");
  const settlementPricePending = Boolean(sharedActive && !sharedState.operator.ready && sharedState.operator.message.includes("waiting for the BTC-USD closing price"));
  const activeDecision = sharedActive && (!chainMode || sharedChainRound) ? sharedState.decision ?? decision : decision;
  const activeRoundId = sharedActive ? sharedState.roundId : roundId;
  const activeTrade: FlyTradeSnapshot | null = sharedActive ? sharedState.trade : null;
  const currentTradeHasOldTerms = activeTrade?.status === "open" && activeTrade.costPercent == null;
  const activeMarket = sharedActive ? sharedState.market : null;
  const demoPhase: Phase = sharedActive ? sharedState.phase : phase;
  const displayedPhase: Phase = chainMode
    ? sharedPhaseReady ? sharedState?.phase ?? "waiting" : chainRound!.status === 0 || chainBetExpired || chainRound!.status === 1 ? "waiting" : chainRound!.status === 2 ? "reveal" : "settled"
    : demoPhase;
  const operatorWaiting = Boolean(chainMode && displayedPhase === "waiting" && (!sharedActive || !sharedState.operator.ready));
  const marketWaiting = Boolean(chainMode && displayedPhase === "waiting" && !operatorWaiting);
  const displayedSeconds = chainMode && sharedChainRound
    ? sharedState?.seconds ?? 0
    : chainMode && chainRound!.status === 1
      ? Math.max(0, chainRound!.closesAt - chainClock)
    : chainMode ? 0 : sharedActive ? sharedState.seconds : seconds;
  const displayedOutcome = chainMode && chainRound!.status === 3
    ? chainRound!.gainsWon ? "epic_gains" : "liquidated"
    : activeDecision?.outcome ?? decision.outcome;
  const displayedPools = chainReady
    ? chainRound ? { liquidated: Number(chainRound.liquidatedPool), gains: Number(chainRound.gainsPool) } : { liquidated: 0, gains: 0 }
    : sharedActive ? sharedState.pools : pools;
  const chainStake = chainPosition ? Number(chainPosition.liquidatedStake) + Number(chainPosition.gainsStake) : 0;
  const chainSide: Side = chainPosition && Number(chainPosition.gainsStake) > Number(chainPosition.liquidatedStake) ? "gains" : "liquidated";
  const displayedBet = chainMode
    ? session && chainStake > 0 ? { side: chainSide, amount: chainStake } : confirmedLocalBet?.roundId === chainRoundId ? confirmedLocalBet : null
    : sharedActive ? sharedState.myBet : null;
  const uncertainBetForCurrentRound = Boolean(session && uncertainBet && uncertainBet.address.toLowerCase() === session.address.toLowerCase() && uncertainBet.roundId === chainRoundId);
  const uncertainBetCheckDelay = uncertainBet ? Math.max(0, 8_000 - (Date.now() - uncertainBet.createdAt)) : 0;
  const displayedChat = sharedActive ? sharedState.chat : chat;
  const displayedFeed = sharedActive && (!chainMode || sharedChainRound) ? sharedState.feed : feed;
  const totalPool = displayedPools.liquidated + displayedPools.gains;
  const claimableTotal = claimables.reduce((total, payout) => total + Number(payout.amount), 0);
  const liquidatedPercent = totalPool ? Math.round((displayedPools.liquidated / totalPool) * 100) : 50;
  useEffect(() => {
    const id = getSharedClientId();
    setClientId(id);
    return subscribeToSharedGame(id, setSharedState, setSharedOnline);
  }, []);

  useEffect(() => { setSelected(null); }, [chainRoundId]);

  useEffect(() => {
    if (!session) { setUncertainBet(null); return; }
    setUncertainBet(loadUncertainBet(session.address, chainRoundId));
  }, [session?.address, chainRoundId]);

  useEffect(() => {
    if (chainReady || sharedActive) return;
    const timer = window.setInterval(() => {
      setSeconds((left) => {
        if (left > 1) return left - 1;
        if (phase === "betting") {
          setPhase("reveal");
          setNotice("Bets locked. The fly is making its move.");
          setFeed((items) => [{ id: Date.now(), text: `Round #${roundId}: bets locked`, kind: "game" as const }, ...items].slice(0, 8));
          return 3;
        }
        if (phase === "reveal") {
          setPhase("settled");
          setNotice(decision.outcome === "epic_gains" ? "TO THE MOON! The fly survived the round." : "REKT! The fly got liquidated.");
          setFeed((items) => [{ id: Date.now(), text: `Round #${roundId} resolved · ${decision.outcome.replace("_"," ").toUpperCase()}`, kind: "game" as const }, ...items].slice(0, 8));
          return 3;
        }
        const next = roundId + 1;
        setRoundId(next);
        setScenario(makeScenario(next));
        setPhase("betting");
        setSelected(null);
        setPools({ liquidated: 0.65 + (next % 7) * 0.18, gains: 0.8 + (next % 5) * 0.21 });
        setNotice("");
        setFeed((items) => [{ id: Date.now(), text: `Round #${next} betting opened`, kind: "game" as const }, ...items].slice(0, 8));
        return 10;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase, roundId, decision, session, sharedActive]);

  useEffect(() => {
    if (!chainReady) return;
    let active = true;
    let refreshing = false;
    let lastRoundId = -1;
    let lastStatus = -1;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const provider = session?.provider ?? publicChainProvider;
        const latest = await readLatestChainRound(provider);
        const roundChanged = latest.roundId !== lastRoundId;
        const statusChanged = latest.round.status !== lastStatus;
        const position = session && (roundChanged || statusChanged)
          ? await readChainPosition(provider, session.address, latest.roundId)
          : null;
        if (active) {
          setChainRoundId(latest.roundId);
          setChainRound(latest.round);
          if (session && (roundChanged || statusChanged)) setChainPosition(position);
          setNotice((current) => current.startsWith("Game data is temporarily unavailable") ? "" : current);
        }
        lastRoundId = latest.roundId;
        lastStatus = latest.round.status;
      } catch (error) {
        if (active) {
          console.warn("Could not refresh the active round.", error);
          setNotice("Game data is temporarily unavailable. Retrying…");
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const poll = window.setInterval(() => { void refresh(); }, 6000);
    const clock = window.setInterval(() => setChainClock(Math.floor(Date.now() / 1000)), 1000);
    return () => { active = false; window.clearInterval(poll); window.clearInterval(clock); };
  }, [session]);

  useEffect(() => {
    if (!session || !chainReady) { setClaimables([]); return; }
    let active = true;
    const refreshClaimables = async () => {
      try {
        const available = await readAllClaimables(session.provider, session.address);
        if (active) {
          setClaimables(available);
          setNotice((current) => current.startsWith("Claim bakiyesi okunamadı:") ? "" : current);
        }
      } catch (error) {
        if (active) {
          console.warn("Could not refresh claimable winnings.", error);
          setNotice("Winnings could not be loaded. Retrying…");
        }
      }
    };
    void refreshClaimables();
    const poll = window.setInterval(() => { void refreshClaimables(); }, 30_000);
    return () => { active = false; window.clearInterval(poll); };
  }, [session]);

  useEffect(() => {
    if (!chainReady) return;
    return watchChainBets(session?.provider ?? publicChainProvider, (event) => {
      if (event.roundId !== String(chainRoundId)) return;
      const shortAddress = `${event.bettor.slice(0, 6)}…${event.bettor.slice(-4)}`;
      setFeed((items) => [{
        id: Date.now(),
        text: `${shortAddress} bet ${event.amount} MON on ${event.gains ? "EPIC GAINS" : "LIQUIDATED"} · ${event.txHash.slice(0, 10)}`,
        kind: "tx" as const,
      }, ...items].slice(0, 8));
    });
  }, [session, chainRoundId]);

  const flyMotion: FlyMotion = displayedPhase === "waiting" || displayedPhase === "betting"
    ? "hover"
    : displayedPhase === "reveal"
      ? activeDecision?.action ?? decision.action
      : displayedOutcome === "epic_gains" ? "gains" : "liquidated";
  const flyPositionLabel = activeTrade?.status === "open" ? activeTrade.side?.toUpperCase() ?? "READY" : activeTrade?.status === "closed" ? displayedOutcome.replace("_", " ").toUpperCase() : activeMarket?.status === "live" ? "TRADE PREPARING" : "BTC/USD CONNECTING";
  const tradeDuration = (activeTrade?.closeAt ?? 0) - (activeTrade?.entryAt ?? 0);
  const tradeProgress = tradeDuration > 0 ? Math.max(0, Math.min(100, ((tradeDuration - displayedSeconds * 1000) / tradeDuration) * 100)) : 0;

  useEffect(() => {
    if (activeTrade?.status !== "closed" || !activeTrade.side || activeTrade.entryPrice == null || activeTrade.exitPrice == null || activeTrade.pnlPercent == null) return;
    setLastFlyResult({
      roundId: activeRoundId,
      side: activeTrade.side,
      entryPrice: activeTrade.entryPrice,
      exitPrice: activeTrade.exitPrice,
      exitSource: activeTrade.exitSource,
      grossPnlPercent: activeTrade.grossPnlPercent ?? activeTrade.pnlPercent,
      costPercent: activeTrade.costPercent ?? 0,
      pnlPercent: activeTrade.pnlPercent,
    });
  }, [activeRoundId, activeTrade?.status, activeTrade?.side, activeTrade?.entryPrice, activeTrade?.exitPrice, activeTrade?.exitSource, activeTrade?.pnlPercent]);

  async function connectWallet() {
    setWalletBusy(true);
    setNotice("");
    try {
      const next = await connectMonadWallet();
      setSession(next);
      if (chainReady) {
        const latest = await readLatestChainRound(next.provider);
        setChainRoundId(latest.roundId);
        setChainRound(latest.round);
        setPools({ liquidated: Number(latest.round.liquidatedPool), gains: Number(latest.round.gainsPool) });
      }
      setNotice(`Wallet connected: ${next.address.slice(0, 6)}…${next.address.slice(-4)}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally { setWalletBusy(false); }
  }

  async function placeBet(side: Side) {
    if (displayedPhase !== "betting" || displayedBet || betBusy || uncertainBetForCurrentRound) return;
    if (!session) {
      await connectWallet();
      return;
    }
    if (!chainReady || !chainRound) { setNotice("Game is syncing. No bet was sent."); return; }
    const normalizedAmount = amount.trim().replace(",", ".");
    const value = Number(normalizedAmount);
    if (!Number.isFinite(value) || value <= 0) { setNotice("Enter a bet amount greater than zero."); return; }
    setBetBusy(true);
    try {
      if (chainRound.status !== 1 || displayedSeconds <= 0) {
        throw new Error("Betting is closed for this round.");
      }
      await placeChainBet(session, side === "gains", normalizedAmount, chainRoundId);
      // The receipt confirms the bet. Keep it visible even if a subsequent
      // public-RPC read is temporarily throttled or unavailable.
      setConfirmedLocalBet({ roundId: chainRoundId, side, amount: value });
      setSelected(side);
      setFeed((items) => [{ id: Date.now(), text: `Bet confirmed · ${normalizedAmount} MON · ${side.toUpperCase()} · #${chainRoundId}`, kind: "tx" as const }, ...items].slice(0, 8));
      setNotice("Bet confirmed. Claim winnings after the round ends.");
      try {
        const latest = await readLatestChainRound(session.provider);
        if (latest.roundId === chainRoundId) {
          setChainRound(latest.round);
          setChainPosition(await readChainPosition(session.provider, session.address, chainRoundId));
          setConfirmedLocalBet(null);
        } else {
          setChainRoundId(latest.roundId);
          setChainRound(latest.round);
        }
      } catch {
        setNotice("Bet confirmed. Round data is syncing; don't submit the bet again.");
      }
    } catch (error) {
      console.warn("Bet transaction failed.", error);
      if (isAmbiguousBetError(error)) {
        const pending: UncertainBet = { address: session.address, roundId: chainRoundId, side, amount: value, createdAt: Date.now() };
        try { localStorage.setItem(uncertainBetStorageKey(session.address, chainRoundId), JSON.stringify(pending)); } catch { /* Keep the in-memory safety lock if storage is unavailable. */ }
        setUncertainBet(pending);
        setNotice(`RPC is rate limited. The status of your #${chainRoundId} bet is unknown; do not submit it again until chain status is checked.`);
      } else {
        setNotice(error instanceof Error ? error.message : "Bet could not be placed. Try again.");
      }
    } finally { setBetBusy(false); }
  }

  async function verifyUncertainBet() {
    const pending = uncertainBet;
    if (!session || !pending || pending.address.toLowerCase() !== session.address.toLowerCase() || betBusy) return;
    setBetBusy(true);
    try {
      const latest = await readLatestChainRound(publicChainProvider);
      const position = await readChainPosition(publicChainProvider, session.address, pending.roundId);
      const liquidated = Number(position.liquidatedStake);
      const gains = Number(position.gainsStake);
      const total = liquidated + gains;
      try { localStorage.removeItem(uncertainBetStorageKey(session.address, pending.roundId)); } catch { /* Storage cleanup is best effort. */ }
      setUncertainBet((current) => current?.roundId === pending.roundId && current.address.toLowerCase() === session.address.toLowerCase() ? null : current);
      if (total > 0) {
        const actualSide: Side = gains > liquidated ? "gains" : "liquidated";
        setConfirmedLocalBet({ roundId: pending.roundId, side: actualSide, amount: total });
        setSelected(actualSide);
        if (latest.roundId === pending.roundId) {
          setChainRoundId(latest.roundId);
          setChainRound(latest.round);
          setChainPosition(position);
        }
        setNotice(`On-chain bet found for round #${pending.roundId}: ${total.toFixed(4)} MON on ${actualSide.toUpperCase()}.`);
        return;
      }
      const roundStillOpen = latest.roundId === pending.roundId && latest.round.status === 1 && latest.round.closesAt > Math.floor(Date.now() / 1000);
      setNotice(roundStillOpen
        ? `No bet is recorded for round #${pending.roundId}. It is safe to submit once now.`
        : `No bet is recorded for round #${pending.roundId}, and that round is no longer open. Wait for the next round.`);
    } catch (error) {
      console.warn("Could not verify the uncertain bet.", error);
      setNotice("Could not verify the bet because the RPC is still busy. Keep this lock and check again in a few seconds; do not resubmit yet.");
    } finally { setBetBusy(false); }
  }

  async function claimAllPayouts() {
    if (!session || claimables.length === 0 || betBusy) return;
    const pending = [...claimables];
    setBetBusy(true);
    try {
      const receipts = [];
      const currentPool = pending.filter((payout) => payout.contractAddress.toLowerCase() === contractAddress.toLowerCase());
      const legacyPools = pending.filter((payout) => payout.contractAddress.toLowerCase() !== contractAddress.toLowerCase());
      for (let i = 0; i < currentPool.length; i += 50) {
        receipts.push(await claimChainPayouts(session, currentPool.slice(i, i + 50)));
      }
      for (const payout of legacyPools) {
        receipts.push(await claimChainPayout(session, payout));
      }
      const [position, remaining] = await Promise.all([
        readChainPosition(session.provider, session.address),
        readAllClaimables(session.provider, session.address),
      ]);
      setChainPosition(position);
      setClaimables(remaining);
      const lastReceipt = receipts[receipts.length - 1];
      setFeed((items) => [{ id: Date.now(), text: `Claimed ${pending.length} rounds · ${lastReceipt?.hash?.slice(0,10) ?? "TX"}`, kind: "tx" as const }, ...items].slice(0, 8));
      setNotice(`Claimed ${pending.length} round${pending.length === 1 ? "" : "s"}. New rounds continue independently of claims.`);
    } catch (error) {
      try { setClaimables(await readAllClaimables(session.provider, session.address)); } catch { /* Keep last known claim list visible. */ }
      console.warn("Claim All did not complete.", error);
      setNotice("Claim All did not complete. You can safely retry the remaining claims.");
    } finally { setBetBusy(false); }
  }

  async function claimOnePayout(payout: ClaimablePayout) {
    if (!session || betBusy) return;
    setBetBusy(true);
    try {
      const receipt = await claimChainPayout(session, payout);
      const remaining = await readAllClaimables(session.provider, session.address);
      setClaimables(remaining);
      setFeed((items) => [{ id: Date.now(), text: `Claimed round #${payout.roundId} · ${receipt?.hash?.slice(0,10) ?? "TX"}`, kind: "tx" as const }, ...items].slice(0, 8));
      setNotice(`Round #${payout.roundId} kazancı cüzdanına aktarıldı.`);
    } catch (error) {
      console.warn("Claim transaction failed.", error);
      setNotice("Claim failed. Please try again.");
    } finally { setBetBusy(false); }
  }

  function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    const name = session ? `${session.address.slice(0,4)}…` : `degen-${clientId.slice(0,4) || "anon"}`;
    if (sharedActive) void sendSharedChat(clientId, text, name).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Chat message failed."));
    else setChat((items) => [...items.slice(-5), { name, text, color: "#84d9ff" }]);
    setChatDraft("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FlyOrDie home"><span className="brand-mark">F<span>✳</span></span><span>FLY<span className="brand-dim">OR</span>DIE</span></a>
        <div className={`round-live ${operatorWaiting || marketWaiting ? "round-live-waiting" : ""}`}><i />{operatorWaiting ? "WAITING FOR OPERATOR" : marketWaiting ? "WAITING FOR BTC/USD" : displayedPhase === "betting" ? "BETTING LIVE" : displayedPhase === "reveal" ? activeTrade?.status === "closed" ? "ROUND RESULT" : "TRADE SETTLING" : displayedPhase === "settled" ? "ROUND COMPLETE" : "NEXT ROUND"}<b>#{chainReady ? chainRoundId : activeRoundId}</b></div>
        <button className="wallet-button" onClick={connectWallet} disabled={walletBusy}>{session ? `${session.address.slice(0,6)}…${session.address.slice(-4)}` : walletBusy ? "CONNECTING…" : "CONNECT WALLET ↗"}</button>
      </header>

      <section className="game-grid" id="top">
        <div className="play-column">
          <section className="panel sim-panel">
            <div className="sim-heading">
              <div><span className="eyebrow">ONE FLY · ONE SHARED ROUND</span><h1>REKT <em>OR</em> RICH<span>.</span></h1></div>
              <div className="sim-countdown"><small>{operatorWaiting ? "ROUND OPERATOR" : marketWaiting ? "BTC/USD POSITION" : displayedPhase === "betting" ? "BETTING CLOSES" : displayedPhase === "reveal" ? activeTrade?.status === "closed" ? "ROUND RESULT" : "TRADE SETTLEMENT" : displayedPhase === "settled" ? "TRADE RESULT" : "NEXT ROUND"}</small><b>{operatorWaiting ? "OFFLINE" : marketWaiting ? "SYNCING" : displayedPhase === "betting" ? `00:${String(displayedSeconds).padStart(2,"0")}` : activeTrade?.status === "closed" && activeTrade.pnlPercent != null ? `${activeTrade.pnlPercent >= 0 ? "+" : ""}${activeTrade.pnlPercent.toFixed(3)}%` : displayedPhase.toUpperCase()}</b></div>
            </div>
            <div className={`flight-field field-${displayedPhase}`}>
              <div className="field-grid" />
              <BtcCandlestickChart market={activeMarket} trade={activeTrade} />
              <div className={`fly-position-chip ${activeTrade?.side === "short" ? "is-short" : "is-long"}`}><span>SİNEK POZİSYONU</span><b>{activeTrade?.side?.toUpperCase() ?? "—"}</b>{activeTrade?.entryPrice != null && <small>GİRİŞ {activeTrade.entryPrice.toLocaleString("en-US", { style: "currency", currency: "USD" })}</small>}</div>
              <LiveFly motion={flyMotion} className="main-fly" label={flyPositionLabel} />
              <div className="field-progress"><i style={{width:`${displayedPhase === "betting" ? tradeProgress : displayedPhase === "reveal" ? 88 : displayedPhase === "waiting" ? 0 : 100}%`}} /></div>
            </div>
            {lastFlyResult && <section className={`round-result ${lastFlyResult.pnlPercent > 0 ? "round-result-win" : "round-result-loss"}`} aria-live="polite">
              <div className="round-result-heading">
                <div><span className="eyebrow">SON TUR · #{lastFlyResult.roundId}</span><h2>{lastFlyResult.pnlPercent > 0 ? "SİNEK KAZANDI" : "SİNEK KAYBETTİ"}</h2></div>
                <b className="round-result-outcome">{lastFlyResult.pnlPercent > 0 ? "KÂRLI İŞLEM" : "ZARARLI İŞLEM"}</b>
              </div>
              <div className="round-result-stats">
                <div><span>SİNEĞİN HAMLESİ</span><b className={lastFlyResult.side === "long" ? "result-long" : "result-short"}>{lastFlyResult.side.toUpperCase()}</b></div>
                <div><span>GİRİŞ</span><b>${lastFlyResult.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                <div><span>ÇIKIŞ</span><b>${lastFlyResult.exitPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                <div><span>NET SONUÇ</span><b className="result-pnl">{lastFlyResult.pnlPercent > 0 ? "+" : ""}{lastFlyResult.pnlPercent.toFixed(3)}%</b></div>
              </div>
              <p className="round-result-source">Brüt fiyat getirisi {lastFlyResult.grossPnlPercent > 0 ? "+" : ""}{lastFlyResult.grossPnlPercent.toFixed(3)}% · simüle maliyet −{lastFlyResult.costPercent.toFixed(3)}% · net getiri {lastFlyResult.pnlPercent > 0 ? "+" : ""}{lastFlyResult.pnlPercent.toFixed(3)}%</p>
              {lastFlyResult.exitSource === "candle" && <p className="round-result-source">Kapanış fiyatı Coinbase 1 dakikalık mumundan kurtarıldı.</p>}
            </section>}
            <div className="sim-footer"><span><i className="pulse-dot"/>{sharedActive ? `${sharedState.connected} watching` : "shared game offline"}</span><span>{activeTrade?.status === "open" && activeTrade.pnlPercent != null ? `P&L ${activeTrade.pnlPercent >= 0 ? "+" : ""}${activeTrade.pnlPercent.toFixed(3)}%` : activeTrade?.status === "closed" ? `BTC-USD · ${displayedOutcome.replace("_"," ").toUpperCase()}` : "PAPER TRADE · NO BTC ORDER"}</span></div>
          </section>

          <section className="panel bet-panel">
            <div className="bet-topline"><div><span className="eyebrow">PREDICT THE BTC TRADE</span><h2>{displayedPhase === "waiting" ? operatorWaiting ? "Round operator is offline" : marketWaiting ? "Waiting for BTC/USD position" : "Next round is opening" : displayedPhase === "betting" ? "Will the fly make a profit?" : displayedPhase === "reveal" && activeTrade?.status !== "closed" ? "Closing the fly’s position" : "Trade result"}</h2></div><span className={`phase-tag phase-${displayedPhase}`}>{displayedPhase === "betting" ? "OPEN" : activeTrade?.status === "closed" && displayedPhase === "reveal" ? "RESULT" : displayedPhase.toUpperCase()}</span></div>
            <div className="pool-summary"><span>POOL <b>{totalPool.toFixed(4)} {chainReady ? "MON" : "PTS"}</b></span><span>{liquidatedPercent}% / {100-liquidatedPercent}%</span></div>
            <div className="pool-track"><i style={{width:`${liquidatedPercent}%`}} /></div>
            <p className="trade-rule">{currentTradeHasOldTerms ? "BU TUR ESKİ KURALLA AÇILDI; EK SİMÜLE MALİYET UYGULANMAZ." : `SİNEK, %${(activeTrade?.costPercent ?? 0.05).toLocaleString("tr-TR", { minimumFractionDigits: 2 })} simüle maliyet sonrası net getirisi pozitifse kazanır.`}</p>
            <div className="bet-buttons">
              <button className={`bet-choice liquidated ${selected === "liquidated" ? "selected" : ""}`} onClick={() => placeBet("liquidated")} disabled={!chainReady || !chainRound || displayedPhase !== "betting" || displayedSeconds <= 0 || !!displayedBet || betBusy || uncertainBetForCurrentRound || chainRound.status !== 1}>
                <span className="choice-emoji">☠</span><span className="choice-copy"><b>FLY LOSES</b><small>POSITION LIQUIDATED</small></span><span className="choice-percent">{liquidatedPercent}%</span>
              </button>
              <button className={`bet-choice gains ${selected === "gains" ? "selected" : ""}`} onClick={() => placeBet("gains")} disabled={!chainReady || !chainRound || displayedPhase !== "betting" || displayedSeconds <= 0 || !!displayedBet || betBusy || uncertainBetForCurrentRound || chainRound.status !== 1}>
                <span className="choice-emoji">↗</span><span className="choice-copy"><b>FLY WINS</b><small>PROFITABLE BTC TRADE</small></span><span className="choice-percent">{100-liquidatedPercent}%</span>
              </button>
            </div>
            <div className="bet-controls"><label htmlFor="bet-amount">BET AMOUNT</label><div className="amount-control"><input id="bet-amount" aria-label="Bet amount" inputMode="decimal" autoComplete="off" maxLength={16} placeholder="0.05" value={amount} onChange={(e)=>setAmount(e.target.value)} type="text" disabled={!!displayedBet || betBusy || uncertainBetForCurrentRound}/><span>MON</span><button type="button" onClick={()=>setAmount("0.10")} disabled={!!displayedBet || betBusy || uncertainBetForCurrentRound}>0.10</button></div><span className="balance-text">{uncertainBetForCurrentRound ? "Bet status uncertain · check chain before retrying" : !session ? "Enter amount now · connect wallet before betting" : displayedBet ? "Your call is locked for this round" : displayedPhase !== "betting" ? "Amount ready · betting opens next round" : chainMode ? "Choose a side before the timer ends" : "Preview mode · no real bet"}</span></div>
            {displayedBet && <div className="bet-receipt">✓ YOUR {displayedBet.side.toUpperCase()} CALL · {displayedBet.amount.toFixed(2)} {chainMode ? "MON" : "PTS"}</div>}

            <div className="claim-area">
              <div className="claim-summary"><span>UNCLAIMED <b>{claimableTotal.toFixed(4)} MON</b></span><button className="claim-button" onClick={claimAllPayouts} disabled={!session || claimables.length === 0 || betBusy}>{betBusy ? "PROCESSING…" : `CLAIM ALL${claimables.length ? ` · ${claimables.length}` : ""} ↗`}</button></div>
              {claimables.length > 0 ? <div className="claim-list">{claimables.map((payout) => <div className="claim-row" key={`${payout.contractAddress}-${payout.roundId}`}><span>ROUND #{payout.roundId}</span><b>{Number(payout.amount).toFixed(4)} MON</b><button onClick={() => void claimOnePayout(payout)} disabled={betBusy}>{betBusy ? "…" : "CLAIM"}</button></div>)}</div> : <p className="claim-empty">{session ? "Winnings show here after a round is settled." : "Connect wallet to view winnings."}</p>}
            </div>
            {notice && <div className="notice" role="status">{notice}</div>}
            {uncertainBetForCurrentRound && uncertainBet && <button className="verify-bet-button" onClick={() => void verifyUncertainBet()} disabled={betBusy || uncertainBetCheckDelay > 0}>{betBusy ? "CHECKING CHAIN…" : uncertainBetCheckDelay > 0 ? `CHECK STATUS IN ${Math.ceil(uncertainBetCheckDelay / 1000)}s` : `CHECK ROUND #${uncertainBet.roundId} BET STATUS ↗`}</button>}
            {chainReady && sharedActive && !sharedState.operator?.ready && <p className={`operator-status ${settlementPricePending ? "operator-pending" : "operator-error"}`}>{!sharedState.operator.configured ? "Sunucuda Monad operatör anahtarı ayarlı değil. Test cüzdanı anahtarını yalnızca sunucu PowerShell penceresinde tanımlayıp sunucuyu yeniden başlatın." : settlementPricePending ? `Tur #${sharedState.roundId} Monad'da kilitli. Sunucu BTC/USD kapanış fiyatını bekliyor; fiyat gelince turu otomatik sonuçlandıracak. Bu sırada tekrar bahis göndermeyin.` : `Monad operatör işlemi tamamlanamadı: ${sharedState.operator.message}`}</p>}
          </section>
        </div>

        <aside className="right-column">
          <FlyBrainPanel phase={displayedPhase} roundId={activeRoundId} decision={activeDecision} streamOnline={sharedOnline} />
          <section className="panel social-panel">
            <div className="side-heading"><div><span className="eyebrow">THE SWARM</span><h2>Chat <span className="online-count">{sharedActive ? `${sharedState.connected} online` : "offline"}</span></h2></div><span className="chat-live"><i/>{sharedActive ? "LIVE" : "OFFLINE"}</span></div>
            <div className="chat-feed" aria-live="polite">{displayedChat.map((item,i)=><div className="chat-message" key={`${item.name}-${i}`}><span className="chat-name" style={{color:item.color}}>{item.name}</span><p>{item.text}</p></div>)}</div>
            <form className="chat-form" onSubmit={sendChat}><input value={chatDraft} onChange={(e)=>setChatDraft(e.target.value)} placeholder="Message the swarm…" aria-label="Chat message" maxLength={120}/><button aria-label="Send message">↗</button></form>
          </section>
          <section className="panel tx-panel">
            <div className="side-heading"><div><span className="eyebrow">LIVE</span><h2>Recent activity</h2></div><span className="block-badge">#{chainReady ? chainRoundId : activeRoundId}</span></div>
            <div className="tx-feed">{displayedFeed.map((item)=><div className="tx-row" key={item.id}><span className={`tx-icon ${item.kind}`}>{item.kind === "tx" ? "↗" : "◈"}</span><div><p>{item.text}</p><small>{item.kind === "tx" ? "TRANSACTION" : "ROUND EVENT"}</small></div><span className="tx-status">●</span></div>)}</div>
          </section>
        </aside>
      </section>
      <footer className="page-footer">DEMO · TOKENS HAVE NO REAL VALUE</footer>
    </main>
  );
}

export default App;
