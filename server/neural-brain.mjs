import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const graphPath = resolve(process.cwd(), "src/data/flywire-vision-circuit.json");
const graph = JSON.parse(readFileSync(graphPath, "utf8"));

const STEP_MS = 0.1;
const DURATION_MS = 160;
const FRAME_MS = 5;
const MEMBRANE_TAU_MS = 20;
const SYNAPSE_TAU_MS = 5;
const REFRACTORY_MS = 2.2;
const RESTING_MV = -52;
const THRESHOLD_MV = -45;
const RESET_MV = -52;
const WEIGHT_PER_SYNAPSE_MV = 0.275;
const VISUAL_STIMULUS_SCALE = 250;
// Game readout cutoff; this is a gameplay rule, not a parameter claimed by the paper.
const STEERING_READOUT_THRESHOLD_HZ = 455;
const SYNAPTIC_DELAY_STEPS = Math.round(1.8 / STEP_MS);
const FRAME_STEPS = Math.round(FRAME_MS / STEP_MS);
export const LIVE_BRAIN_INTERVAL_MS = 100;

const outgoing = Array.from({ length: graph.neurons.length }, () => []);
for (const edge of graph.edges) outgoing[edge.source].push(edge);

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function sensoryRate(danger, fatigue) {
  return Math.round(Math.max(15, Math.min(150, 30 + Math.max(0, Math.min(1, danger)) * 110 - Math.max(0, Math.min(1, fatigue)) * 35)));
}

// One persistent solver serves both the sealed round readout and live sensory
// activity. Membranes, synaptic currents, delays and PRNG state survive advances.
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
    if (external) {
      voltage[index] = RESET_MV;
      conductance[index] = 0;
    } else {
      voltage[index] = RESET_MV;
      conductance[index] = 0;
      refractoryUntil[index] = step + Math.ceil(REFRACTORY_MS / STEP_MS);
    }
    const slot = (step + SYNAPTIC_DELAY_STEPS) % delayed.length;
    for (const edge of outgoing[index]) {
      delayed[slot].push([edge.target, edge.weight * WEIGHT_PER_SYNAPSE_MV]);
    }
  }

  function advance(sourceSide, inputRateHz) {
    const stimulated = graph.input[sourceSide];
    const poissonChance = inputRateHz * STEP_MS / 1000;
    const active = new Set();
    const until = step + FRAME_STEPS;
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

      for (const index of stimulated) {
        if (random() < poissonChance) {
          voltage[index] += WEIGHT_PER_SYNAPSE_MV * VISUAL_STIMULUS_SCALE;
          if (voltage[index] >= THRESHOLD_MV) emitSpike(index, active, true);
        }
      }
    }
    return [...active];
  }

  function strongestPotentials() {
    const cells = [];
    for (let index = 0; index < voltage.length; index++) {
      if (!Number.isFinite(voltage[index]) || !Number.isFinite(conductance[index])) {
        throw new Error(`Non-finite LIF state at neuron ${index}.`);
      }
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

function simulate(scenario) {
  const simulator = createSimulator(scenario.seed);
  const sourceSide = (scenario.seed & 1) === 0 ? "left" : "right";
  const inputRateHz = sensoryRate(scenario.danger, scenario.fatigue);
  const frames = [];
  for (let elapsed = 0; elapsed < DURATION_MS; elapsed += FRAME_MS) {
    frames.push(simulator.advance(sourceSide, inputRateHz));
  }
  const { spikeCounts } = simulator;
  const steering = graph.steering.map(({ index, type, side }) => ({
    type,
    side,
    spikes: spikeCounts[index],
  }));
  const leftSteeringHz = steering.filter((cell) => cell.side === "left").reduce((sum, cell) => sum + cell.spikes, 0) * 1000 / DURATION_MS;
  const rightSteeringHz = steering.filter((cell) => cell.side === "right").reduce((sum, cell) => sum + cell.spikes, 0) * 1000 / DURATION_MS;
  const escapeDriveHz = leftSteeringHz + rightSteeringHz;
  const allActive = [...spikeCounts]
    .map((spikes, index) => ({ index, spikes }))
    .filter((cell) => cell.spikes > 0)
    .sort((a, b) => b.spikes - a.spikes);
  const active = allActive
    .slice(0, 18)
    .map(({ index, spikes }) => ({ index, id: graph.neurons[index].id, spikes, type: graph.neurons[index].type, side: graph.neurons[index].side }));

  return {
    sourceSide,
    inputRateHz,
    durationMs: DURATION_MS,
    activeNeuronCount: allActive.length,
    active,
    frames,
    readout: { leftSteeringHz, rightSteeringHz, escapeDriveHz },
  };
}

// This stream models an ongoing, moving visual stimulus independently of the
// sealed game scenario. Never seed it from scenario.seed: public activity must
// not publish the precomputed outcome trace while betting is open.
export function createLiveBrain(roundId, seed) {
  const simulator = createSimulator(seed);
  const phase = ((seed >>> 0) % 6283) / 1000;
  let sequence = 0;
  let sourceSide = (seed & 1) === 0 ? "left" : "right";
  let inputRateHz = 65;
  function frame(active) {
    return {
      roundId,
      sequence,
      simulatedMs: simulator.simulatedMs,
      frameMs: FRAME_MS,
      playbackRate: FRAME_MS / LIVE_BRAIN_INTERVAL_MS,
      sourceSide,
      inputRateHz,
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
      // Slow visual input changes evoke fresh, propagating responses each frame.
      const stimulusPosition = Math.sin(simulator.simulatedMs / 210 + phase);
      sourceSide = stimulusPosition >= 0 ? "left" : "right";
      inputRateHz = Math.round(55 + Math.abs(stimulusPosition) * 65);
      const active = simulator.advance(sourceSide, inputRateHz);
      sequence += 1;
      return frame(active);
    },
  };
}

export function decideWithConnectome(scenario) {
  const neural = simulate(scenario);
  const action = neural.readout.escapeDriveHz >= STEERING_READOUT_THRESHOLD_HZ ? "dodge" : "dive";
  const survived = action === "dodge" ? scenario.danger < 0.9 : scenario.danger < 0.46;
  const profitable = action === "dive" && scenario.opportunity >= 0.56;
  const outcome = survived && (action === "dodge" || profitable) ? "epic_gains" : "liquidated";
  return {
    action,
    outcome,
    multiplier: outcome === "epic_gains" ? Number((1 + scenario.opportunity * 4.5).toFixed(2)) : 0,
    neural,
  };
}
