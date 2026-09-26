import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { BrainLiveFrame } from "./brain-stream";

export interface BrainCloudData {
  groups: Array<{ id: string; label: string; color: string; count: number }>;
  points: Array<[number, number, number, number]>;
  circuitPositions: Array<[number, number, number]>;
  circuitGroups: number[];
}

export interface NeuralCircuit {
  neurons: Array<{ id: string; type: string; side: string; transmitter: string }>;
  edges: Array<{ source: number; target: number; synapses: number; weight: number }>;
}

export interface BrainCloudControls { zoom: (factor: number) => void; reset: () => void }

interface Props {
  cloud: BrainCloudData;
  circuit: NeuralCircuit;
  frame: BrainLiveFrame | null;
  activeGroups: boolean[];
  autoRotate: boolean;
  showConnections: boolean;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onInteract: () => void;
  controlRef: Ref<BrainCloudControls>;
}

type Projection = { x: number; y: number; z: number; depth: number };
type Pulse = { source: number; target: number; start: number; inhibitory: boolean };
type View = { yaw: number; pitch: number; zoom: number };
const INITIAL_VIEW: View = { yaw: -0.24, pitch: -0.22, zoom: 1 };
const limit = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function makeSprite(color: string) {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 32;
  const context = sprite.getContext("2d")!;
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, `${color}ff`);
  gradient.addColorStop(0.16, `${color}eb`);
  gradient.addColorStop(0.32, `${color}70`);
  gradient.addColorStop(0.68, `${color}18`);
  gradient.addColorStop(1, `${color}00`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  return sprite;
}

/** Perspective projection of measured XYZ positions; no synthetic neuron geometry. */
class CloudRenderer {
  private context: CanvasRenderingContext2D;
  private animation = 0;
  private observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private view = { ...INITIAL_VIEW };
  private lastDraw = 0;
  private lastFrame = -1;
  private lastRound = -1;
  private fireTimes: Float64Array;
  private potentialTimes: Float64Array;
  private potentialStrength: Float32Array;
  private outgoing: NeuralCircuit["edges"][];
  private baseEdges: NeuralCircuit["edges"];
  private pulses: Pulse[] = [];
  private cloudProjection: Projection[];
  private circuitProjection: Projection[];
  private order: number[];
  private sprites: HTMLCanvasElement[];
  private whiteSprite = makeSprite("#e7ffff");
  private goldSprite = makeSprite("#ffe8a1");
  private pointer = { x: -100, y: -100, startX: 0, startY: 0, dragging: false, moved: false };
  private hover: number | null = null;

  constructor(private canvas: HTMLCanvasElement, private cloud: BrainCloudData, private circuit: NeuralCircuit, private options: () => Props) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable in this browser.");
    this.context = context;
    this.fireTimes = new Float64Array(circuit.neurons.length).fill(-1e9);
    this.potentialTimes = new Float64Array(circuit.neurons.length).fill(-1e9);
    this.potentialStrength = new Float32Array(circuit.neurons.length);
    this.outgoing = Array.from({ length: circuit.neurons.length }, () => []);
    for (const edge of circuit.edges) this.outgoing[edge.source]?.push(edge);
    for (const edges of this.outgoing) edges.sort((a, b) => b.synapses - a.synapses);
    this.baseEdges = [...circuit.edges].sort((a, b) => b.synapses - a.synapses).slice(0, 42);
    this.cloudProjection = cloud.points.map(() => ({ x: 0, y: 0, z: 0, depth: 1 }));
    this.circuitProjection = cloud.circuitPositions.map(() => ({ x: 0, y: 0, z: 0, depth: 1 }));
    this.order = cloud.points.map((_, index) => index);
    this.sprites = cloud.groups.map((group) => makeSprite(group.color));
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
    canvas.addEventListener("pointerleave", this.pointerLeave);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("keydown", this.keyDown);
    this.resize();
    this.acceptFrame(options().frame);
    this.animation = requestAnimationFrame(this.draw);
  }

  zoom(factor: number) { this.view.zoom = limit(this.view.zoom * factor, 0.65, 3.2); }
  reset() { this.view = { ...INITIAL_VIEW }; }

  acceptFrame(frame: BrainLiveFrame | null) {
    if (!frame || frame.status !== "live") {
      this.pulses = [];
      this.fireTimes.fill(-1e9);
      this.potentialTimes.fill(-1e9);
      return;
    }
    if (frame.roundId !== this.lastRound) {
      this.lastFrame = -1;
      this.lastRound = frame.roundId;
      this.fireTimes.fill(-1e9);
      this.potentialTimes.fill(-1e9);
      this.pulses = [];
    }
    if (frame.sequence === this.lastFrame) return;
    this.lastFrame = frame.sequence;
    const now = performance.now();
    for (const index of frame.active) if (index >= 0 && index < this.fireTimes.length) this.fireTimes[index] = now;
    for (const cell of frame.potentials ?? []) {
      if (cell.index < 0 || cell.index >= this.potentialTimes.length) continue;
      this.potentialTimes[cell.index] = now;
      this.potentialStrength[cell.index] = limit((cell.millivolts + 52) / 7, 0, 1);
    }
    const stride = Math.max(1, Math.ceil(frame.active.length / 20));
    for (let i = 0; i < frame.active.length; i += stride) {
      const source = frame.active[i];
      const edges = this.outgoing[source] ?? [];
      for (let j = 0; j < Math.min(2, edges.length); j++) {
        const edge = edges[(frame.sequence + j) % Math.min(edges.length, 8)];
        this.pulses.push({ source, target: edge.target, start: now, inhibitory: edge.weight < 0 });
      }
    }
    this.pulses = this.pulses.filter((pulse) => now - pulse.start < 240).slice(-160);
  }

  dispose() {
    cancelAnimationFrame(this.animation);
    this.observer.disconnect();
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointermove", this.pointerMove);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.canvas.removeEventListener("pointercancel", this.pointerCancel);
    this.canvas.removeEventListener("pointerleave", this.pointerLeave);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("keydown", this.keyDown);
  }

  private resize = () => {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  };

  private project(x: number, y: number, z: number, target: Projection) {
    const { yaw, pitch, zoom } = this.view;
    const px = x * Math.cos(yaw) + z * Math.sin(yaw);
    const pz = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const py = y * Math.cos(pitch) - pz * Math.sin(pitch);
    const depth = y * Math.sin(pitch) + pz * Math.cos(pitch);
    const perspective = 3.2 / (3.2 + depth);
    const scale = Math.min(this.width * 0.425, this.height * 0.67) * zoom;
    target.x = this.width * 0.5 + px * scale * perspective;
    target.y = this.height * 0.43 + py * scale * perspective;
    target.z = depth;
    target.depth = perspective;
  }

  private visible(index: number) { return this.options().activeGroups[this.cloud.circuitGroups[index] ?? 5] !== false; }

  private draw = (now: number) => {
    this.animation = requestAnimationFrame(this.draw);
    const elapsed = now - this.lastDraw;
    if (elapsed < 1000 / 30 || document.hidden) return;
    this.lastDraw = now;
    const options = this.options();
    if (options.autoRotate && !this.pointer.dragging) this.view.yaw += Math.min(elapsed, 70) * 0.00007;
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = "#030807";
    context.fillRect(0, 0, this.width, this.height);

    // A dim reference grid gives the floating measured points a sense of depth.
    context.strokeStyle = "#91c6b306";
    context.lineWidth = 0.5;
    context.beginPath();
    for (let x = 0; x < this.width; x += 28) { context.moveTo(x, 0); context.lineTo(x, this.height); }
    for (let y = 0; y < this.height; y += 28) { context.moveTo(0, y); context.lineTo(this.width, y); }
    context.stroke();

    for (let index = 0; index < this.cloud.points.length; index++) {
      const point = this.cloud.points[index];
      this.project(point[0], point[1], point[2], this.cloudProjection[index]);
    }
    for (let index = 0; index < this.cloud.circuitPositions.length; index++) {
      const point = this.cloud.circuitPositions[index];
      this.project(point[0], point[1], point[2], this.circuitProjection[index]);
    }
    this.order.sort((a, b) => this.cloudProjection[b].z - this.cloudProjection[a].z);

    if (options.showConnections) {
      context.strokeStyle = "#96c9b914";
      context.lineWidth = 0.55;
      context.beginPath();
      for (const edge of this.baseEdges) {
        if (!this.visible(edge.source) || !this.visible(edge.target)) continue;
        const source = this.circuitProjection[edge.source], target = this.circuitProjection[edge.target];
        context.moveTo(source.x, source.y); context.lineTo(target.x, target.y);
      }
      context.stroke();
    }

    context.globalCompositeOperation = "lighter";
    for (const index of this.order) {
      const group = this.cloud.points[index][3];
      if (options.activeGroups[group] === false) continue;
      const point = this.cloudProjection[index];
      if (point.x < -10 || point.y < -10 || point.x > this.width + 10 || point.y > this.height + 10) continue;
      const size = (4.5 + (index % 7) * 0.18) * point.depth * Math.sqrt(this.view.zoom);
      context.globalAlpha = limit((0.5 - point.z * 0.23) * (group === 5 ? 0.43 : 1), 0.12, 0.85);
      context.drawImage(this.sprites[group], point.x - size / 2, point.y - size / 2, size, size);
    }

    if (options.showConnections) {
      for (const pulse of this.pulses) {
        const progress = (now - pulse.start) / 240;
        if (progress > 1 || !this.visible(pulse.source) || !this.visible(pulse.target)) continue;
        const source = this.circuitProjection[pulse.source], target = this.circuitProjection[pulse.target];
        context.globalAlpha = (1 - progress) * 0.45;
        context.strokeStyle = pulse.inhibitory ? "#edb1e1" : "#aef1e7";
        context.lineWidth = 0.65;
        context.beginPath(); context.moveTo(source.x, source.y); context.lineTo(target.x, target.y); context.stroke();
        const x = source.x + (target.x - source.x) * progress;
        const y = source.y + (target.y - source.y) * progress;
        context.globalAlpha = (1 - progress) * 0.9;
        context.drawImage(this.whiteSprite, x - 3, y - 3, 6, 6);
      }
    }

    for (let index = 0; index < this.circuitProjection.length; index++) {
      if (!this.visible(index)) continue;
      const point = this.circuitProjection[index];
      const fired = Math.max(0, 1 - (now - this.fireTimes[index]) / 250);
      const charged = Math.max(0, 1 - (now - this.potentialTimes[index]) / 180) * this.potentialStrength[index];
      if (fired <= 0 && charged <= 0.18) continue;
      const strength = Math.max(fired, charged * 0.55);
      const size = (7 + strength * 7) * point.depth;
      context.globalAlpha = strength;
      context.drawImage(fired > 0 ? this.whiteSprite : this.goldSprite, point.x - size / 2, point.y - size / 2, size, size);
      if (fired > 0.3) { context.fillStyle = "#efffff"; context.fillRect(point.x - 0.7, point.y - 0.7, 1.4, 1.4); }
    }

    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    const focus = options.selectedIndex ?? this.hover;
    if (focus !== null && this.circuitProjection[focus] && this.visible(focus)) {
      const point = this.circuitProjection[focus];
      context.strokeStyle = "#d3ff9d";
      context.lineWidth = 1;
      context.beginPath(); context.arc(point.x, point.y, 6, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.moveTo(point.x + 9, point.y); context.lineTo(point.x + 25, point.y - 12); context.stroke();
      const neuron = this.circuit.neurons[focus];
      context.font = "10px ui-monospace, monospace";
      context.fillStyle = "#daffb8";
      context.fillText(neuron.type, limit(point.x + 28, 6, this.width - 85), limit(point.y - 10, 30, this.height - 20));
    }

    this.drawAxes();
  };

  private drawAxes() {
    const context = this.context;
    const origin = { x: this.width - 32, y: this.height - 28 };
    const axes: Array<[number, number, number, string, string]> = [[1, 0, 0, "#86a6a1", "x"], [0, 1, 0, "#86a6a1", "y"], [0, 0, 1, "#86a6a1", "z"]];
    context.font = "7px ui-monospace, monospace";
    for (const [x, y, z, color, label] of axes) {
      const px = x * Math.cos(this.view.yaw) + z * Math.sin(this.view.yaw);
      const pz = -x * Math.sin(this.view.yaw) + z * Math.cos(this.view.yaw);
      const py = y * Math.cos(this.view.pitch) - pz * Math.sin(this.view.pitch);
      const targetX = origin.x + px * 16, targetY = origin.y + py * 16;
      context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 0.8;
      context.beginPath(); context.moveTo(origin.x, origin.y); context.lineTo(targetX, targetY); context.stroke();
      context.fillText(label, targetX + 2, targetY + 2);
    }
  }

  private nearest(x: number, y: number) {
    let nearest: number | null = null;
    let distance = 8 * 8;
    for (let index = 0; index < this.circuitProjection.length; index++) {
      if (!this.visible(index)) continue;
      const point = this.circuitProjection[index];
      const d = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (d < distance) { distance = d; nearest = index; }
    }
    return nearest;
  }

  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    this.pointer = { x, y, startX: x, startY: y, dragging: true, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.options().onInteract();
  };

  private pointerMove = (event: PointerEvent) => {
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (this.pointer.dragging) {
      this.view.yaw += (x - this.pointer.x) * 0.007;
      this.view.pitch = limit(this.view.pitch + (y - this.pointer.y) * 0.007, -1.2, 1.2);
      if (Math.hypot(x - this.pointer.startX, y - this.pointer.startY) > 4) this.pointer.moved = true;
    } else {
      this.hover = this.nearest(x, y);
      this.canvas.style.cursor = this.hover === null ? "grab" : "crosshair";
    }
    this.pointer.x = x; this.pointer.y = y;
  };

  private pointerUp = (event: PointerEvent) => {
    if (!this.pointer.dragging) return;
    if (!this.pointer.moved) this.options().onSelect(this.nearest(this.pointer.x, this.pointer.y));
    this.pointer.dragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = "grab";
  };

  private pointerCancel = () => { this.pointer.dragging = false; this.canvas.style.cursor = "grab"; };
  private pointerLeave = () => { if (!this.pointer.dragging) this.hover = null; };
  private wheel = (event: WheelEvent) => { event.preventDefault(); this.zoom(Math.exp(-event.deltaY * 0.001)); };
  private keyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault(); this.options().onInteract();
    if (event.key === "ArrowLeft") this.view.yaw -= 0.08;
    if (event.key === "ArrowRight") this.view.yaw += 0.08;
    if (event.key === "ArrowUp") this.view.pitch = limit(this.view.pitch - 0.08, -1.2, 1.2);
    if (event.key === "ArrowDown") this.view.pitch = limit(this.view.pitch + 0.08, -1.2, 1.2);
    if (event.key === "+" || event.key === "=") this.zoom(1.15);
    if (event.key === "-") this.zoom(1 / 1.15);
    if (event.key === "0") this.reset();
  };
}

export default function BrainCloudCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CloudRenderer | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;

  useImperativeHandle(props.controlRef, () => ({
    zoom: (factor) => rendererRef.current?.zoom(factor),
    reset: () => rendererRef.current?.reset(),
  }), []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new CloudRenderer(canvasRef.current, props.cloud, props.circuit, () => latestProps.current);
    rendererRef.current = renderer;
    return () => { renderer.dispose(); rendererRef.current = null; };
  }, [props.cloud, props.circuit]);

  useEffect(() => { rendererRef.current?.acceptFrame(props.frame); }, [props.frame]);

  return <canvas ref={canvasRef} className="brain-cloud-canvas" tabIndex={0} role="img" aria-label="Döndürülebilir üç boyutlu sinek beyni. Sürükleyerek veya ok tuşlarıyla döndürün, tekerlek veya artı eksi ile yakınlaştırın; devredeki bir nörona tıklayarak seçin." />;
}
