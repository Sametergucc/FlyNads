import type { FlyDecision } from "./game-engine";
import type { Scenario } from "./game-engine";
import { clearBrainStream, publishBrainFrame, type BrainLiveFrame } from "./brain-stream";
import type { BtcMarketSnapshot, FlyTradeSnapshot } from "./market-types";

export interface SharedGameSnapshot {
  roundId: number;
  phase: "waiting" | "betting" | "reveal" | "settled";
  seconds: number;
  scenario: Scenario;
  decision: FlyDecision | null;
  brain?: BrainLiveFrame | null;
  market: BtcMarketSnapshot;
  trade: FlyTradeSnapshot | null;
  commitment: string;
  pools: { liquidated: number; gains: number };
  participants: number;
  connected: number;
  operator: { configured: boolean; ready: boolean; address: string; message: string };
  myBet: { side: "liquidated" | "gains"; amount: number } | null;
  chat: Array<{ id: number; name: string; text: string; color: string }>;
  feed: Array<{ id: number; text: string; kind: "tx" | "game" }>;
}

export function getSharedClientId() {
  const key = "flyordie-client-id";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = window.crypto?.randomUUID?.() ?? `guest-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, id);
  }
  return id;
}

const API_BASE = import.meta.env.VITE_SERVER_URL ?? "";

export function subscribeToSharedGame(clientId: string, onState: (state: SharedGameSnapshot) => void, onStatus: (online: boolean) => void) {
  const source = new EventSource(`${API_BASE}/api/events?clientId=${encodeURIComponent(clientId)}`);
  source.onopen = () => { clearBrainStream(); onStatus(true); };
  source.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data) as SharedGameSnapshot;
      publishBrainFrame(state.brain);
      onState(state);
      onStatus(true);
    } catch { onStatus(false); }
  };
  source.addEventListener("brain", (event) => {
    try { publishBrainFrame(JSON.parse((event as MessageEvent<string>).data) as BrainLiveFrame); }
    catch { /* Keep the latest valid sample; the next streamed sample can recover. */ }
  });
  source.onerror = () => { clearBrainStream(); onStatus(false); };
  return () => { source.close(); clearBrainStream(); };
}

async function post(path: string, data: Record<string, unknown>) {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Shared game request failed.");
  return result;
}

export function placeSharedDemoBet(clientId: string, side: "liquidated" | "gains", amount: number) {
  return post("/api/bet", { clientId, side, amount });
}

export function sendSharedChat(clientId: string, text: string, name: string) {
  return post("/api/chat", { clientId, text, name });
}
