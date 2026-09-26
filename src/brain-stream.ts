/** Latest shared sensory simulation sample, delivered separately from the game clock. */
export interface BrainLiveFrame {
  roundId: number;
  sequence: number;
  simulatedMs: number;
  frameMs: number;
  playbackRate: number;
  sourceSide: "left" | "right";
  inputRateHz: number;
  active: number[];
  potentials: Array<{ index: number; millivolts: number }>;
  spikeCount: number;
  activeNeuronCount: number;
  status: "live" | "error";
  message?: string;
}

type Sample = { frame: BrainLiveFrame; receivedAt: number } | null;
let latest: Sample = null;
const subscribers = new Set<() => void>();

export function publishBrainFrame(frame: BrainLiveFrame | null | undefined) {
  if (!frame || !Number.isFinite(frame.roundId) || !Number.isFinite(frame.sequence) || !Array.isArray(frame.active)) return;
  if (latest?.frame.roundId === frame.roundId && latest.frame.sequence >= frame.sequence && latest.frame.status === frame.status) return;
  latest = { frame, receivedAt: Date.now() };
  for (const subscriber of subscribers) subscriber();
}

export function clearBrainStream() {
  latest = null;
  for (const subscriber of subscribers) subscriber();
}

export function subscribeBrainStream(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
}

export function getBrainSample() { return latest; }
export function getEmptyBrainSample(): Sample { return null; }
