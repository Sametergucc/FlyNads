import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import cloudUrl from "./data/flywire-brain-cloud.json?url";
import circuitUrl from "./data/flywire-vision-circuit.json?url";
import BrainCloudCanvas, { type BrainCloudControls, type BrainCloudData, type NeuralCircuit } from "./BrainCloudCanvas";
import { getBrainSample, getEmptyBrainSample, subscribeBrainStream } from "./brain-stream";
import type { FlyDecision } from "./game-engine";

type Props = {
  phase: "waiting" | "betting" | "reveal" | "settled";
  roundId: number;
  decision: FlyDecision | null;
  streamOnline: boolean;
};

type IconName = "play" | "pause" | "reset" | "plus" | "minus" | "expand" | "collapse";
const GROUP_LABELS: Record<string, string> = {
  visual: "Visual neurons",
  olfactory: "Olfactory circuit",
  mushroom: "Mushroom body",
  central_complex: "Central complex",
  lateral_horn: "Lateral horn",
  other: "Other neurons",
};
const formatCount = (value: number) => value.toLocaleString("en-US");

function ControlIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    play: "M8 5l10 7-10 7Z",
    pause: "M8 5v14M16 5v14",
    reset: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    expand: "M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    collapse: "M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

async function fetchAsset<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export default function FlyBrainPanel({ phase, roundId, decision, streamOnline }: Props) {
  const sample = useSyncExternalStore(subscribeBrainStream, getBrainSample, getEmptyBrainSample);
  const [now, setNow] = useState(Date.now);
  const [assets, setAssets] = useState<{ cloud: BrainCloudData; circuit: NeuralCircuit } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [activeGroups, setActiveGroups] = useState<boolean[]>([]);
  const [autoRotate, setAutoRotate] = useState(() => typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [showConnections, setShowConnections] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const controlRef = useRef<BrainCloudControls>(null);
  const stopRotation = useCallback(() => setAutoRotate(false), []);

  useEffect(() => {
    // The sealed decision has 5 ms simulation frames; refresh often enough to
    // replay them evenly. Outside the reveal, freshness checks need less work.
    const replaying = phase === "reveal" || phase === "settled";
    const timer = window.setInterval(() => setNow(Date.now()), replaying ? 40 : 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => { if (preference.matches) setAutoRotate(false); };
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    Promise.all([
      fetchAsset<BrainCloudData>(cloudUrl, controller.signal),
      fetchAsset<NeuralCircuit>(circuitUrl, controller.signal),
    ]).then(([cloud, circuit]) => {
      if (!Array.isArray(cloud.points) || !cloud.points.length || !Array.isArray(cloud.groups) || !cloud.groups.length
        || !Array.isArray(circuit.neurons) || !Array.isArray(circuit.edges)
        || cloud.circuitPositions?.length !== circuit.neurons.length || cloud.circuitGroups?.length !== circuit.neurons.length) {
        throw new Error("FlyWire data is incomplete.");
      }
      if (controller.signal.aborted) return;
      setActiveGroups(cloud.groups.map(() => true));
      setAssets({ cloud, circuit });
    }).catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [attempt]);

  const leaveExpanded = useCallback(() => {
    if (document.fullscreenElement === panelRef.current) {
      void document.exitFullscreen().catch(() => setExpanded(false));
    } else {
      setExpanded(false);
    }
    expandButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const fullscreenChanged = () => setExpanded(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", fullscreenChanged);
    return () => document.removeEventListener("fullscreenchange", fullscreenChanged);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    expandButtonRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); leaveExpanded(); return; }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], summary, [tabindex='0']");
      if (!focusable?.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", keydown); };
  }, [expanded, leaveExpanded]);

  const toggleExpanded = () => {
    if (expanded) { leaveExpanded(); return; }
    setExpanded(true);
    const panel = panelRef.current;
    if (panel?.requestFullscreen) void panel.requestFullscreen().catch(() => { /* Fixed overlay is the fallback. */ });
  };

  const matchesRound = sample?.frame.roundId === roundId;
  const fresh = Boolean(sample && now - sample.receivedAt < 2000);
  const neural = decision?.neural;
  const showSummary = (phase === "reveal" || phase === "settled") && Boolean(neural);
  const replayIndex = neural?.frames.length ? Math.floor(now / 120) % neural.frames.length : -1;
  const replayFrame = showSummary && neural && replayIndex >= 0 ? {
    roundId,
    sequence: Math.floor(now / 120),
    simulatedMs: Math.round(replayIndex * neural.durationMs / neural.frames.length),
    frameMs: neural.durationMs / neural.frames.length,
    playbackRate: 1,
    sourceSide: neural.sourceSide,
    inputRateHz: Math.round(((neural.inputRatesHz?.left ?? 0) + (neural.inputRatesHz?.right ?? 0)) / 2),
    active: neural.frames[replayIndex],
    potentials: [] as Array<{ index: number; millivolts: number }>,
    spikeCount: neural.frames[replayIndex].length,
    activeNeuronCount: neural.activeNeuronCount,
    status: "live" as const,
  } : null;
  const streamError = matchesRound && sample?.frame.status === "error";
  const liveFrame = streamOnline && matchesRound && fresh && sample?.frame.status === "live" ? sample.frame : null;
  const frame = replayFrame ?? liveFrame;
  const activeIndices = [...new Set(frame?.active ?? [])].filter((index) => Boolean(assets?.circuit.neurons[index]));
  const selectedCell = selectedIndex !== null ? assets?.circuit.neurons[selectedIndex] : null;
  const potential = selectedIndex !== null ? frame?.potentials.find((entry) => entry.index === selectedIndex)?.millivolts : undefined;
  const selectedGroup = selectedIndex !== null && assets ? assets.cloud.groups[assets.cloud.circuitGroups[selectedIndex]] : undefined;
  const status = replayFrame ? "DECISION REPLAY" : liveFrame ? "LIVE" : streamError ? "SIGNAL ERROR" : !streamOnline ? "OFFLINE" : "WAITING FOR SIGNAL";

  return (
    <section ref={panelRef} className={`panel neural-panel ${expanded ? "is-expanded" : ""}`} role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label="Fruit fly brain 3D neuron view">
      <div className="side-heading neural-heading">
        <div><h2>Brain <span className="neural-version">3D</span></h2></div>
        <span className={`neural-state ${frame ? "is-live" : streamError ? "is-error" : "is-waiting"}`}><i />{status}</span>
      </div>

      <div className="neural-cloud-scene">
        {assets && <BrainCloudCanvas cloud={assets.cloud} circuit={assets.circuit} frame={frame} activeGroups={activeGroups} autoRotate={autoRotate} showConnections={showConnections} selectedIndex={selectedIndex} onSelect={setSelectedIndex} onInteract={stopRotation} controlRef={controlRef} />}

        <div className="neural-toolbar" role="group" aria-label="Brain view controls">
          <button type="button" onClick={() => setAutoRotate((value) => !value)} disabled={!assets} aria-label={autoRotate ? "Stop auto-rotation" : "Auto-rotate"} title={autoRotate ? "Stop rotation" : "Auto-rotate"} aria-pressed={autoRotate}><ControlIcon name={autoRotate ? "pause" : "play"} /></button>
          <button type="button" onClick={() => controlRef.current?.reset()} disabled={!assets} aria-label="Reset view" title="Reset view"><ControlIcon name="reset" /></button>
          <button type="button" onClick={() => controlRef.current?.zoom(1.15)} disabled={!assets} aria-label="Zoom in" title="Zoom in"><ControlIcon name="plus" /></button>
          <button type="button" onClick={() => controlRef.current?.zoom(1 / 1.15)} disabled={!assets} aria-label="Zoom out" title="Zoom out"><ControlIcon name="minus" /></button>
          <button ref={expandButtonRef} type="button" onClick={toggleExpanded} aria-label={expanded ? "Exit fullscreen" : "Open brain fullscreen"} title={expanded ? "Close · Esc" : "Fullscreen"}><ControlIcon name={expanded ? "collapse" : "expand"} /></button>
        </div>

        {!assets && <div className="neural-load-state" role="status">{loadError ? <><b>Brain data could not be loaded.</b><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></> : <><i /><span>Loading FlyWire neurons…</span></>}</div>}

        {assets && <div className="neural-region-legend" role="group" aria-label="Show or hide neuron groups">
          {assets.cloud.groups.map((group, index) => { const label = GROUP_LABELS[group.id] ?? group.label; return <button type="button" key={group.id} className={activeGroups[index] ? "is-visible" : "is-hidden"} aria-pressed={Boolean(activeGroups[index])} aria-label={`${label}: ${activeGroups[index] ? "hide" : "show"}`} title={`${formatCount(group.count)} neurons · click to toggle`} onClick={() => setActiveGroups((current) => current.map((value, groupIndex) => groupIndex === index ? !value : value))}><i style={{ background: group.color }} /><span>{label}</span></button>; })}
        </div>}

        <button type="button" className={`neural-connections-toggle ${showConnections ? "is-active" : ""}`} aria-pressed={showConnections} onClick={() => setShowConnections((value) => !value)} disabled={!assets}>{showConnections ? "✓ " : ""}Connections</button>
      </div>

      <div className="neural-readout">
        <div className="neural-stat"><span>FIRING</span><b>{frame ? activeIndices.length : "—"}<small> / {assets ? formatCount(assets.circuit.neurons.length) : "—"}</small></b></div>
      </div>

      <div className="neural-active-list" aria-label="Neurons firing in this frame">
        <div className="neural-firing-cells">{activeIndices.slice(0, 5).map((index) => {
          const cell = assets!.circuit.neurons[index];
          return <button type="button" className={`neural-cell ${selectedIndex === index ? "is-selected" : ""}`} key={index} onClick={() => setSelectedIndex(index)} aria-pressed={selectedIndex === index} title={`FlyWire ${cell.id}`}><i /><span>{cell.type}</span></button>;
        })}
          {!activeIndices.length && <span className="neural-empty">{frame ? "No firing in this frame" : streamError ? "Could not refresh simulation signal" : "Waiting for live server signal"}</span>}
          {activeIndices.length > 5 && <span className="neural-more">+{activeIndices.length - 5}</span>}
        </div>
      </div>

      {selectedCell ? <div className="neural-selected-cell">
        <div><i style={{ background: selectedGroup?.color ?? "#b7ff62" }} /><b>{selectedCell.type}</b><span>{selectedCell.side === "left" ? "Left" : selectedCell.side === "right" ? "Right" : selectedCell.side} · {selectedCell.transmitter}</span><button type="button" aria-label="Clear neuron selection" onClick={() => setSelectedIndex(null)}>×</button></div>
        <code title="FlyWire root ID">{selectedCell.id}</code>
        <p>Membrane potential <strong>{typeof potential === "number" && Number.isFinite(potential) ? `${potential.toFixed(1)} mV` : "not measured in this frame"}</strong></p>
      </div> : <p className="neural-selection-hint">Select a glowing neuron to view its cell ID and membrane potential.</p>}

      <p className="neural-source-note">{assets ? formatCount(assets.cloud.points.length) : "139,248"} cell locations · {assets ? formatCount(assets.circuit.neurons.length) : "—"} decision-circuit neurons</p>
      <details className="neural-data-details"><summary>Circuit details</summary><p>Each point is a measured soma or reference location from FlyWire annotations. Only the selected subcircuit, whose real connections are verified, is simulated with an LIF model.</p><p>LC10 visual neurons → AOTU → central complex → descending neurons · {assets ? formatCount(assets.circuit.edges.length) : "—"} verified connections. Decision replay starts after betting closes.</p>{showSummary && neural && <p>Round decision: <b>{(neural.side ?? neural.readout.side ?? (decision?.action === "dive" ? "long" : "short")).toUpperCase()}</b> · {neural.activeNeuronCount} neurons fired · left/right motor output {(neural.readout.leftSteeringHz ?? 0).toFixed(1)} / {(neural.readout.rightSteeringHz ?? 0).toFixed(1)} Hz{neural.readout.usedSensoryFallback ? " · sensory input broke a motor-output tie" : ""}.</p>}<a href="https://github.com/flyconnectome/flywire_annotations" target="_blank" rel="noreferrer">FlyWire source data ↗</a></details>
    </section>
  );
}
