import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const root = process.cwd();
const dataDirectory = resolve(root, "data/brain");
const outputPath = resolve(root, "src/data/flywire-vision-circuit.json");
const connectomePath = resolve(dataDirectory, "Connectivity_783.parquet");
const annotationsPath = resolve(dataDirectory, "Supplemental_file1_neuron_annotations.tsv");
const connectomeUrl = "https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/Connectivity_783.parquet";
const annotationsUrl = "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv";
const MIN_SYNAPSES = 5;

async function downloadIfMissing(path, url) {
  if (existsSync(path)) return;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

await mkdir(dataDirectory, { recursive: true });
await mkdir(resolve(root, "src/data"), { recursive: true });
await downloadIfMissing(connectomePath, connectomeUrl);
await downloadIfMissing(annotationsPath, annotationsUrl);

const lines = readFileSync(annotationsPath, "utf8").trimEnd().split(/\r?\n/);
const columns = lines[0].split("\t");
const columnIndex = Object.fromEntries([
  "root_id", "super_class", "cell_class", "cell_sub_class", "cell_type", "top_nt", "side", "pos_x", "pos_y", "pos_z", "soma_x", "soma_y", "soma_z",
].map((name) => [name, columns.indexOf(name)]));
if (Object.values(columnIndex).some((index) => index < 0)) throw new Error("The FlyWire annotation table is missing expected columns.");

const neurons = new Map();
const inputsBySide = { left: [], right: [] };
const aotu = new Set();
const steeringNeurons = new Set();
for (const line of lines.slice(1)) {
  const row = line.split("\t");
  const id = row[columnIndex.root_id];
  const type = row[columnIndex.cell_type];
  const side = row[columnIndex.side]?.toLowerCase();
  const neuron = {
    id,
    type: type || row[columnIndex.cell_class] || row[columnIndex.super_class] || "neuron",
    superClass: row[columnIndex.super_class] || "unknown",
    cellClass: row[columnIndex.cell_class] || "",
    transmitter: row[columnIndex.top_nt] || "unknown",
    side: side === "right" ? "right" : "left",
    x: Number(row[columnIndex.soma_x]) || Number(row[columnIndex.pos_x]) || 0,
    y: Number(row[columnIndex.soma_y]) || Number(row[columnIndex.pos_y]) || 0,
    z: Number(row[columnIndex.soma_z]) || Number(row[columnIndex.pos_z]) || 0,
  };
  neurons.set(id, neuron);
  if (type === "LC10a") inputsBySide[neuron.side].push(id);
  if (type === "AOTU019" || type === "AOTU025") aotu.add(id);
  if (["DNa01", "DNa02", "DNa03", "DNa04", "DNa11"].includes(type)) steeringNeurons.add(id);
}

if (!inputsBySide.left.length || !inputsBySide.right.length || !aotu.size || !steeringNeurons.size) {
  throw new Error("Could not find the LC10a → AOTU → steering-neuron labels in the FlyWire annotations.");
}

const inputIds = new Set([...inputsBySide.left, ...inputsBySide.right]);
const inputEdges = [];
const aotuInputEdges = [];
const aotuOutputEdges = [];
const steeringInputEdges = [];
const file = await asyncBufferFromFile(connectomePath);
const metadata = await parquetMetadataAsync(file);
let rowStart = 0;

for (const group of metadata.row_groups) {
  const groupEnd = rowStart + Number(group.num_rows);
  const buffers = {};
  await parquetRead({
    file,
    metadata,
    columns: ["Presynaptic_ID", "Postsynaptic_ID", "Connectivity", "Excitatory x Connectivity"],
    rowStart,
    rowEnd: groupEnd,
    compressors,
    onChunk: ({ columnName, columnData }) => { buffers[columnName] = columnData; },
  });

  const presynaptic = buffers.Presynaptic_ID;
  const postsynaptic = buffers.Postsynaptic_ID;
  const synapses = buffers.Connectivity;
  const signedWeight = buffers["Excitatory x Connectivity"];
  for (let index = 0; index < presynaptic.length; index++) {
    const pre = String(presynaptic[index]);
    const post = String(postsynaptic[index]);
    const count = Number(synapses[index]);
    if (count < MIN_SYNAPSES) continue;
    const row = { pre, post, synapses: count, weight: Number(signedWeight[index]) };
    if (inputIds.has(pre)) inputEdges.push(row);
    if (aotu.has(post)) aotuInputEdges.push(row);
    if (aotu.has(pre)) aotuOutputEdges.push(row);
    if (steeringNeurons.has(post)) steeringInputEdges.push(row);
  }
  rowStart = groupEnd;
  console.log(`Scanned ${rowStart.toLocaleString()} / ${Number(metadata.num_rows).toLocaleString()} connections`);
}

const inputMids = new Set(inputEdges.map((edge) => edge.post));
const aotuMids = new Set(aotuInputEdges.map((edge) => edge.pre));
const sharedMids = new Set([...inputMids].filter((id) => aotuMids.has(id)));
let edges = [
  ...inputEdges.filter((edge) => sharedMids.has(edge.post)),
  ...aotuInputEdges.filter((edge) => sharedMids.has(edge.pre)),
];

const aotuOutputs = new Set(aotuOutputEdges.map((edge) => edge.post));
const steeringInputs = new Set(steeringInputEdges.map((edge) => edge.pre));
const sharedSteeringMids = new Set([...aotuOutputs].filter((id) => steeringInputs.has(id)));
edges.push(
  ...aotuOutputEdges.filter((edge) => sharedSteeringMids.has(edge.post)),
  ...steeringInputEdges.filter((edge) => sharedSteeringMids.has(edge.pre)),
);

if (!edges.some((edge) => inputIds.has(edge.pre) && aotu.has(edge.post))) {
  // Preserve any direct LC10a-to-AOTU edges even when their path does not need an intermediary.
  edges.push(...inputEdges.filter((edge) => aotu.has(edge.post)));
}
if (!edges.length) throw new Error("No ≥5-synapse LC10a-to-steering paths were found in the selected connectome release.");

const aggregated = new Map();
for (const edge of edges) {
  const key = `${edge.pre}:${edge.post}`;
  const previous = aggregated.get(key);
  if (previous) {
    previous.synapses += edge.synapses;
    previous.weight += edge.weight;
  } else {
    aggregated.set(key, { ...edge });
  }
}
edges = [...aggregated.values()];
const nodeIds = new Set([...inputIds, ...aotu, ...steeringNeurons]);
for (const edge of edges) { nodeIds.add(edge.pre); nodeIds.add(edge.post); }
const includedNeurons = [...nodeIds].map((id) => neurons.get(id)).filter(Boolean);
const xValues = includedNeurons.map((neuron) => neuron.x).filter(Number.isFinite);
const yValues = includedNeurons.map((neuron) => neuron.y).filter(Number.isFinite);
const minX = Math.min(...xValues), maxX = Math.max(...xValues);
const minY = Math.min(...yValues), maxY = Math.max(...yValues);
const normalized = includedNeurons.map((neuron) => ({
  ...neuron,
  x: (neuron.x - minX) / Math.max(1, maxX - minX),
  y: (neuron.y - minY) / Math.max(1, maxY - minY),
}));
const indexById = new Map(normalized.map((neuron, index) => [neuron.id, index]));
const output = {
  dataset: "FlyWire FAFB v783",
  model: "Connectome-constrained leaky integrate-and-fire; Shiu et al. 2024 parameters",
  pathway: "LC10a visual object detector → AOTU019/AOTU025 → DNa steering neurons",
  minimumSynapses: MIN_SYNAPSES,
  neurons: normalized,
  edges: edges.map((edge) => ({
    source: indexById.get(edge.pre),
    target: indexById.get(edge.post),
    synapses: edge.synapses,
    weight: edge.weight,
  })).filter((edge) => edge.source !== undefined && edge.target !== undefined),
  input: {
    left: inputsBySide.left.map((id) => indexById.get(id)).filter(Number.isInteger),
    right: inputsBySide.right.map((id) => indexById.get(id)).filter(Number.isInteger),
  },
  interneurons: normalized.map((neuron, index) => ({ index, type: neuron.type })).filter(({ type }) => type === "AOTU019" || type === "AOTU025").map(({ index }) => index),
  steering: normalized.map((neuron, index) => ({ index, type: neuron.type, side: neuron.side })).filter(({ type }) => /^DNa/.test(type)).map(({ index, type, side }) => ({ index, type, side })),
  sources: {
    connectome: connectomeUrl,
    annotations: annotationsUrl,
    model: "https://www.nature.com/articles/s41586-024-07763-9",
  },
};

await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, JSON.stringify(output)));
console.log(`Wrote ${output.neurons.length} neurons and ${output.edges.length} real FlyWire connections to ${outputPath}`);
