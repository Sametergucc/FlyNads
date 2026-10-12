import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const graphPath = resolve(process.cwd(), "src/data/flywire-vision-circuit.json");
const graph = JSON.parse(readFileSync(graphPath, "utf8"));

const STEP_MS = 0.1;
const DURATION_MS = 240;
const FRAME_MS = 5;
const MEMBRANE_TAU_MS = 20;
const SYNAPSE_TAU_MS = 5;
const REFRACTORY_MS = 2.2;
const RESTING_MV = -52;
const THRESHOLD_MV = -45;
const RESET_MV = -52;
const WEIGHT_PER_SYNAPSE_MV = 0.275;
const VISUAL_STIMULUS_SCALE = 220;
const SYNAPTIC_DELAY_STEPS = Math.round(1.8 / STEP_MS);
export const LIVE_BRAIN_INTERVAL_MS = 100;
const LIVE_SIMULATION_MS = 20;

const outgoing = Array.from({ length: graph.neurons.length }, () => []);
for (const edge of graph.edges) outgoing[edge.source]?.push(edge);
const STEERING_LEFT = graph.steering.filter((cell) => cell.side === "left").map((cell) => cell.index);
const STEERING_RIGHT = graph.steering.filter((cell) => cell.side === "right").map((cell) => cell.index);

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function ratesForMarket(features = {}) {
  const momentumPercent = Number.isFinite(features.momentumPercent) ? features.momentumPercent : 0;
  const volatilityPercent = Number.isFinite(features.volatilityPercent) ? features.volatilityPercent : 0.02;
  const normalizedMomentum = clamp(momentumPercent / Math.max(volatilityPercent, 0.003), -1, 1);
  const volatilityDrive = clamp(volatilityPercent / 0.08, 0, 1);
  const base = 30 + volatilityDrive * 28;
  return {
    left: Math.round(base + Math.max(0, -normalizedMomentum) * 68),
    right: Math.round(base + Math.max(0, normalizedMomentum) * 68),
    reward: Math.round(12 + Math.max(0, normalizedMomentum) * 18),
    punishment: Math.round(10 + volatilityDrive * 18 + Math.max(0, -normalizedMomentum) * 12),
    normalizedMomentum,
    volatilityDrive,
  };
}

// A connectome-constrained LIF population. Only neurons in the selected
// FlyWire subgraph are solved; the remaining anatomical cloud is context.
function createSimulator(seed) {
  const random = seededRandom(seed);
  const voltage = new Float64Array(graph.neurons.length).fill(RESTING_MV);
  const conductance = new Float64Array(graph.neurons.length);
  const refractoryUntil = new Float64Array(graph.neurons.length);
  const spikeCounts = new Uint32Array(graph.neurons.length);
  const delayed = Array.from({ length: SYNAPTIC_DELAY_STEPS + 1 }, () => []);
  const frameDecay = Math.exp(-STEP_MS / SYNAPSE_TAU_MS);
  let step = 0;
  let spikeCount = 0;
  let activeNeuronCount = 0;

  function emitSpike(index, active, external = false) {
    if (spikeCounts[index] === 0) activeNeuronCount += 1;
    spikeCounts[index] += 1;
    spikeCount += 1;
    active.add(index);
    voltage[index] = RESET_MV;
    conductance[index] = 0;
    if (!external) refractoryUntil[index] = step + Math.ceil(REFRACTORY_MS / STEP_MS);
    const slot = (step + SYNAPTIC_DELAY_STEPS) % delayed.length;
    for (const edge of outgoing[index]) delayed[slot].push([edge.target, edge.weight * WEIGHT_PER_SYNAPSE_MV]);
  }

  function advance(inputRates, durationMs = FRAME_MS) {
    const rates = [
      [graph.input.left, inputRates.left],
      [graph.input.right, inputRates.right],
      [graph.input.reward ?? [], inputRates.reward],
      [graph.input.punishment ?? [], inputRates.punishment],
    ];
    const active = new Set();
    const until = step + Math.round(durationMs / STEP_MS);
    for (; step < until; step++) {
      const pending = delayed[step % delayed.length];
      for (const [index, weight] of pending) conductance[index] += weight;
      pending.length = 0;

      for (let index = 0; index < conductance.length; index++) {
        conductance[index] *= frameDecay;
        if (step < refractoryUntil[index]) continue;
        voltage[index] += STEP_MS / MEMBRANE_TAU_MS * (RESTING_MV - voltage[index] + conductance[index]);
        if (voltage[index] >= THRESHOLD_MV) emitSpike(index, active);
      }

      for (const [stimulated, rate] of rates) {
        const poissonChance = rate * STEP_MS / 1000;
        for (const index of stimulated) {
          if (random() < poissonChance) {
            voltage[index] += WEIGHT_PER_SYNAPSE_MV * VISUAL_STIMULUS_SCALE;
            if (voltage[index] >= THRESHOLD_MV) emitSpike(index, active, true);
          }
        }
      }
    }
    return [...active];
  }

  function strongestPotentials() {
    const cells = [];
    for (let index = 0; index < voltage.length; index++) {
      if (voltage[index] > RESTING_MV + 0.01) cells.push({ index, millivolts: Math.round(voltage[index] * 100) / 100 });
    }
    return cells.sort((a, b) => b.millivolts - a.millivolts).slice(0, 12);
  }

  return {
    advance,
    strongestPotentials,
    spikeCounts,
    get simulatedMs() { return Math.round(step * STEP_MS); },
    get spikeCount() { return spikeCount; },
    get activeNeuronCount() { return activeNeuronCount; },
  };
}

function decodeSteering(spikeCounts, rates) {
  const mean = (indices) => indices.length ? indices.reduce((sum, index) => sum + spikeCounts[index], 0) / indices.length : 0;
  const leftSteeringHz = mean(STEERING_LEFT) * 1000 / DURATION_MS;
  const rightSteeringHz = mean(STEERING_RIGHT) * 1000 / DURATION_MS;
  const steeringMarginHz = leftSteeringHz - rightSteeringHz;
  // The game's paper mapping treats a right-biased descending output as LONG
  // and a left-biased output as SHORT. If neither output fires, the stronger
  // market-sensory channel breaks the tie in the same direction.
  const usedSensoryFallback = Math.abs(steeringMarginHz) < 0.001;
  const side = usedSensoryFallback
    ? (rates.right >= rates.left ? "long" : "short")
    : (steeringMarginHz > 0 ? "short" : "long");
  return { side, leftSteeringHz, rightSteeringHz, steeringMarginHz, usedSensoryFallback };
}

function runDecision(seed, features = {}) {
  const simulator = createSimulator(seed);
  const rates = ratesForMarket(features);
  const frames = [];
  for (let elapsed = 0; elapsed < DURATION_MS; elapsed += FRAME_MS) frames.push(simulator.advance(rates));
  const neuralReadout = decodeSteering(simulator.spikeCounts, rates);
  const allActive = [...simulator.spikeCounts]
    .map((spikes, index) => ({ index, spikes }))
    .filter((cell) => cell.spikes > 0)
    .sort((a, b) => b.spikes - a.spikes);
  const active = allActive.slice(0, 28).map(({ index, spikes }) => ({
    index, id: graph.neurons[index].id, spikes, type: graph.neurons[index].type, side: graph.neurons[index].side,
  }));
  const side = neuralReadout.side;
  const action = side === "long" ? "dive" : "dodge";
  return {
    side,
    action,
    outcome: "liquidated",
    multiplier: 0,
    neural: {
      side,
      sourceSide: rates.left === rates.right ? "bilateral" : rates.left > rates.right ? "left" : "right",
      inputRatesHz: { left: rates.left, right: rates.right, reward: rates.reward, punishment: rates.punishment },
      marketInput: {
        momentumPercent: Number((features.momentumPercent ?? 0).toFixed(5)),
        volatilityPercent: Number((features.volatilityPercent ?? 0).toFixed(5)),
        normalizedMomentum: Number(rates.normalizedMomentum.toFixed(3)),
      },
      durationMs: DURATION_MS,
      activeNeuronCount: allActive.length,
      active,
      frames,
      readout: neuralReadout,
    },
  };
}

// Public activity is deliberately unrelated to the sealed trade-side trace.
export function createLiveBrain(roundId, seed) {
  const simulator = createSimulator(seed);
  let sequence = 0;
  const inputRatesHz = ratesForMarket({ momentumPercent: 0.01, volatilityPercent: 0.03 });
  const sourceSide = inputRatesHz.left === inputRatesHz.right ? "bilateral" : inputRatesHz.left > inputRatesHz.right ? "left" : "right";
  function frame(active) {
    return {
      roundId,
      sequence,
      simulatedMs: simulator.simulatedMs,
      frameMs: LIVE_SIMULATION_MS,
      playbackRate: LIVE_SIMULATION_MS / LIVE_BRAIN_INTERVAL_MS,
      sourceSide,
      inputRateHz: Math.round((inputRatesHz.left + inputRatesHz.right) / 2),
      active,
      potentials: simulator.strongestPotentials(),
      spikeCount: simulator.spikeCount,
      activeNeuronCount: simulator.activeNeuronCount,
      status: "live",
    };
  }
  return {
    initialFrame: frame([]),
    advance() {
      const active = simulator.advance(inputRatesHz, LIVE_SIMULATION_MS);
      sequence += 1;
      return frame(active);
    },
  };
}

export function decideWithConnectome(scenario, marketFeatures = {}) {
  return runDecision(scenario.seed, marketFeatures);
}
