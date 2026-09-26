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
const NGROK_HEADERS: Record<string, string> = API_BASE ? { "ngrok-skip-browser-warning": "1" } : {};

export function subscribeToSharedGame(clientId: string, onState: (state: SharedGameSnapshot) => void, onStatus: (online: boolean) => void) {
  const url = `${API_BASE}/api/events?clientId=${encodeURIComponent(clientId)}`;
  // EventSource does not support custom headers; use fetch-based SSE for ngrok compatibility.
  if (API_BASE) {
    let aborted = false;
    const controller = new AbortController();
    const connect = async () => {
      while (!aborted) {
        try {
          const response = await fetch(url, { headers: NGROK_HEADERS, signal: controller.signal });
          if (!response.ok || !response.body) { onStatus(false); await new Promise((r) => setTimeout(r, 3000)); continue; }
          clearBrainStream(); onStatus(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              if (part.startsWith(": ")) continue;
              const eventMatch = part.match(/^event: (\w+)\ndata: (.+)$/s);
              const dataMatch = part.match(/^data: (.+)$/s);
              if (eventMatch && eventMatch[1] === "brain") {
                try { publishBrainFrame(JSON.parse(eventMatch[2]) as BrainLiveFrame); } catch {}
              } else if (dataMatch) {
                try {
                  const state = JSON.parse(dataMatch[1]) as SharedGameSnapshot;
                  publishBrainFrame(state.brain);
                  onState(state);
                  onStatus(true);
                } catch { onStatus(false); }
              }
            }
          }
        } catch {
          if (aborted) return;
          clearBrainStream(); onStatus(false);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void connect();
    return () => { aborted = true; controller.abort(); clearBrainStream(); };
  }
  const source = new EventSource(url);
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
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...NGROK_HEADERS }, body: JSON.stringify(data) });
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
