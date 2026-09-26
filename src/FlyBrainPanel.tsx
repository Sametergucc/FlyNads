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
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

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
  const streamError = matchesRound && sample?.frame.status === "error";
  const frame = streamOnline && matchesRound && fresh && sample?.frame.status === "live" ? sample.frame : null;
  const activeIndices = [...new Set(frame?.active ?? [])].filter((index) => Boolean(assets?.circuit.neurons[index]));
  const selectedCell = selectedIndex !== null ? assets?.circuit.neurons[selectedIndex] : null;
  const potential = selectedIndex !== null ? frame?.potentials.find((entry) => entry.index === selectedIndex)?.millivolts : undefined;
  const selectedGroup = selectedIndex !== null && assets ? assets.cloud.groups[assets.cloud.circuitGroups[selectedIndex]] : undefined;
  const showSummary = (phase === "reveal" || phase === "settled") && decision?.neural;
  const status = frame ? "CANLI" : streamError ? "SİNYAL HATASI" : !streamOnline ? "BAĞLANTI YOK" : "SİNYAL BEKLENİYOR";

  return (
    <section ref={panelRef} className={`panel neural-panel ${expanded ? "is-expanded" : ""}`} role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label="Meyve sineği beyninin üç boyutlu nöron görünümü">
      <div className="side-heading neural-heading">
        <div><span className="eyebrow">FLYWIRE · FAFB V783</span><h2>Sineğin beyni <span className="neural-version">3D</span></h2></div>
        <span className={`neural-state ${frame ? "is-live" : streamError ? "is-error" : "is-waiting"}`}><i />{status}</span>
      </div>

      <div className="neural-cloud-scene">
        {assets && <BrainCloudCanvas cloud={assets.cloud} circuit={assets.circuit} frame={frame} activeGroups={activeGroups} autoRotate={autoRotate} showConnections={showConnections} selectedIndex={selectedIndex} onSelect={setSelectedIndex} onInteract={stopRotation} controlRef={controlRef} />}

        <div className="neural-scene-caption"><span>Duyusal LIF · 20× yavaş</span><small>Sürükle · döndür / tekerlek · yakınlaştır</small></div>
        <div className="neural-toolbar" role="group" aria-label="Beyin görünümü kontrolleri">
          <button type="button" onClick={() => setAutoRotate((value) => !value)} disabled={!assets} aria-label={autoRotate ? "Otomatik dönüşü durdur" : "Otomatik döndür"} title={autoRotate ? "Dönüşü durdur" : "Otomatik döndür"} aria-pressed={autoRotate}><ControlIcon name={autoRotate ? "pause" : "play"} /></button>
          <button type="button" onClick={() => controlRef.current?.reset()} disabled={!assets} aria-label="Görünümü sıfırla" title="Görünümü sıfırla"><ControlIcon name="reset" /></button>
          <button type="button" onClick={() => controlRef.current?.zoom(1.15)} disabled={!assets} aria-label="Yakınlaştır" title="Yakınlaştır"><ControlIcon name="plus" /></button>
          <button type="button" onClick={() => controlRef.current?.zoom(1 / 1.15)} disabled={!assets} aria-label="Uzaklaştır" title="Uzaklaştır"><ControlIcon name="minus" /></button>
          <button ref={expandButtonRef} type="button" onClick={toggleExpanded} aria-label={expanded ? "Tam ekrandan çık" : "Beyni tam ekranda aç"} title={expanded ? "Kapat · Esc" : "Tam ekran"}><ControlIcon name={expanded ? "collapse" : "expand"} /></button>
        </div>

        {!assets && <div className="neural-load-state" role="status">{loadError ? <><b>Beyin verisi yüklenemedi.</b><button type="button" onClick={() => setAttempt((value) => value + 1)}>Yeniden yükle</button></> : <><i /><span>FlyWire nöronları yükleniyor…</span></>}</div>}

        {assets && <div className="neural-region-legend" role="group" aria-label="Nöron gruplarını göster veya gizle">
          {assets.cloud.groups.map((group, index) => <button type="button" key={group.id} className={activeGroups[index] ? "is-visible" : "is-hidden"} aria-pressed={Boolean(activeGroups[index])} aria-label={`${group.label}: ${activeGroups[index] ? "gizle" : "göster"}`} title={`${group.count.toLocaleString("tr-TR")} nöron · göstermek/gizlemek için tıkla`} onClick={() => setActiveGroups((current) => current.map((value, groupIndex) => groupIndex === index ? !value : value))}><i style={{ background: group.color }} /><span>{group.label}</span></button>)}
        </div>}

        <button type="button" className={`neural-connections-toggle ${showConnections ? "is-active" : ""}`} aria-pressed={showConnections} onClick={() => setShowConnections((value) => !value)} disabled={!assets}>{showConnections ? "✓ " : ""}Bağlantılar</button>
      </div>

      <div className="neural-readout">
        <div className="neural-stat"><span>BU KAREDE ATEŞLEYEN</span><b>{frame ? activeIndices.length : "—"}<small> / {assets?.circuit.neurons.length ?? 699}</small></b></div>
        <div className="neural-stat"><span>SİMÜLASYON ZAMANI</span><b>{frame ? `${(frame.simulatedMs / 1000).toFixed(2)} s` : "—"}</b></div>
      </div>

      <div className="neural-active-list" aria-label="Bu karede ateşleyen nöronlar">
        <span className="neural-list-label">Aktif hücreyi seç</span>
        <div className="neural-firing-cells">{activeIndices.slice(0, 5).map((index) => {
          const cell = assets!.circuit.neurons[index];
          return <button type="button" className={`neural-cell ${selectedIndex === index ? "is-selected" : ""}`} key={index} onClick={() => setSelectedIndex(index)} aria-pressed={selectedIndex === index} title={`FlyWire ${cell.id}`}><i /><span>{cell.type}</span></button>;
        })}
          {!activeIndices.length && <span className="neural-empty">{frame ? "Bu karede ateşleme yok" : streamError ? "Simülasyon sinyali yenilenemedi" : "Canlı sunucu sinyali bekleniyor"}</span>}
          {activeIndices.length > 5 && <span className="neural-more">+{activeIndices.length - 5}</span>}
        </div>
      </div>

      {selectedCell ? <div className="neural-selected-cell">
        <div><i style={{ background: selectedGroup?.color ?? "#b7ff62" }} /><b>{selectedCell.type}</b><span>{selectedCell.side === "left" ? "Sol" : selectedCell.side === "right" ? "Sağ" : selectedCell.side} · {selectedCell.transmitter}</span><button type="button" aria-label="Nöron seçimini kaldır" onClick={() => setSelectedIndex(null)}>×</button></div>
        <code title="FlyWire root ID">{selectedCell.id}</code>
        <p>Membran potansiyeli <strong>{typeof potential === "number" && Number.isFinite(potential) ? `${potential.toFixed(1)} mV` : "bu karede ölçüm yok"}</strong></p>
      </div> : <p className="neural-selection-hint">Parlayan bir nörona dokun; hücre kimliğini ve iletilen membran potansiyelini gör.</p>}

      <p className="neural-source-note">{assets?.cloud.points.length.toLocaleString("tr-TR") ?? "6.300"} ölçülmüş hücre / referans konumu. Parlayan noktalar {assets?.circuit.neurons.length ?? 699} nöronlu canlı devreyi gösterir.</p>
      <details className="neural-data-details"><summary>Veri ve model</summary><p>Renkler FlyWire hücre sınıflarıdır. Konumlar soma veya işaretlenmiş hücre referans noktalarıdır. Duyusal LIF akışı sunucuda ilerler; tüm beyin simüle edilmez.</p><p>LC10a → AOTU → DNa · {assets?.circuit.edges.length.toLocaleString("tr-TR") ?? "4.199"} bağlantı. Bahis kararından bağımsız canlı duyusal aktivite.</p>{showSummary && <p>Bu turun karar devresi: {decision.neural!.activeNeuronCount} hücre ateşledi.</p>}<a href="https://github.com/flyconnectome/flywire_annotations" target="_blank" rel="noreferrer">FlyWire kaynak verisi ↗</a></details>
    </section>
  );
}
