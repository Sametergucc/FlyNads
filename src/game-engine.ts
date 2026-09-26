/**
 * Framework-agnostic demo game logic for FlyOrDie.
 * This small weighted decision model is a connectome-inspired placeholder,
 * not a full biological connectome simulation.
 */

export type FlyAction = "dodge" | "dive";
export type RoundOutcome = "liquidated" | "epic_gains";

export interface Scenario {
  /** Stable identifier supplied by the round coordinator. */
  roundId: number;
  /** Obstacle danger, normalized to 0..1. */
  danger: number;
  /** Opportunity value, normalized to 0..1. */
  opportunity: number;
  /** Fly fatigue, normalized to 0..1. */
  fatigue: number;
  /** Public after resolution; use a committed seed while bets are open. */
  seed: number;
}

export interface BrainTrace {
  dangerNeuron: number;
  rewardNeuron: number;
  motorDodgeNeuron: number;
  motorDiveNeuron: number;
}

/** Connectome simulation trace returned by the shared round server after lock. */
export interface NeuralActivity {
  sourceSide: "left" | "right";
  inputRateHz: number;
  durationMs: number;
  activeNeuronCount: number;
  active: Array<{ index: number; id: string; spikes: number; type: string; side: string }>;
  /** Each frame contains FlyWire node indexes that spiked during that interval. */
  frames: number[][];
  readout: { leftSteeringHz: number; rightSteeringHz: number; escapeDriveHz: number };
}

export interface FlyDecision {
  action: FlyAction;
  outcome: RoundOutcome;
  multiplier: number;
  trace?: BrainTrace;
  neural?: NeuralActivity;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Small seeded PRNG so a committed scenario can be replayed after reveal. */
function random01(seed: number): number {
  let x = seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 0x1_0000_0000;
}

/**
 * Produce a reproducible stylized fly decision from the scenario sensors.
 * Outcome is derived from both scene conditions and the fly's action.
 */
export function decideFly(scenario: Scenario): FlyDecision {
  const danger = clamp01(scenario.danger);
  const opportunity = clamp01(scenario.opportunity);
  const fatigue = clamp01(scenario.fatigue);
  const noise = random01(scenario.seed) * 0.16;

  // A compact weighted neural-style readout for the MVP's activity display.
  const dangerNeuron = clamp01(danger * 0.78 + fatigue * 0.12 + noise * 0.1);
  const rewardNeuron = clamp01(opportunity * 0.76 + (1 - fatigue) * 0.12 + noise * 0.12);
  const motorDodgeNeuron = clamp01(dangerNeuron * 0.82 - rewardNeuron * 0.18 + 0.08);
  const motorDiveNeuron = clamp01(rewardNeuron * 0.76 - dangerNeuron * 0.22 + noise * 0.12);
  const action: FlyAction = motorDiveNeuron > motorDodgeNeuron ? "dive" : "dodge";

  const survived = action === "dodge" ? danger < 0.86 : danger < 0.48;
  const profitable = action === "dive" && opportunity >= 0.56;
  const outcome: RoundOutcome = survived && (action === "dodge" || profitable)
    ? "epic_gains"
    : "liquidated";

  const multiplier = outcome === "epic_gains"
    ? Number((1 + opportunity * 4.5).toFixed(2))
    : 0;

  return {
    action,
    outcome,
    multiplier,
    trace: { dangerNeuron, rewardNeuron, motorDodgeNeuron, motorDiveNeuron },
  };
}

/**
 * Convert an outcome to the Solidity contract's boolean convention:
 * true = Epic Gains, false = Liquidated.
 */
export function outcomeToContractFlag(outcome: RoundOutcome): boolean {
  return outcome === "epic_gains";
}
