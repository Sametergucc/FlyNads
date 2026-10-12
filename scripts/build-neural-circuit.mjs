import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
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
const headers = lines[0].split("\t");
const columns = Object.fromEntries(["root_id", "super_class", "cell_class", "cell_sub_class", "cell_type", "top_nt", "side"].map((key) => [key, headers.indexOf(key)]));
if (Object.values(columns).some((index) => index < 0)) throw new Error("The FlyWire annotation table is missing expected columns.");

const neurons = new Map();
const populations = { lc10: new Set(), aotu: new Set(), cx: new Set(), kc: new Set(), mbon: new Set(), dan: new Set(), mbin: new Set(), dn: new Set() };
for (const line of lines.slice(1)) {
  const row = line.split("\t");
  const id = row[columns.root_id];
  const type = row[columns.cell_type] || row[columns.cell_class] || row[columns.super_class] || "neuron";
  const cellClass = row[columns.cell_class] || "";
  const side = row[columns.side]?.toLowerCase() === "right" ? "right" : "left";
  const neuron = { id, type, superClass: row[columns.super_class] || "unknown", cellClass, transmitter: row[columns.top_nt] || "unknown", side };
  neurons.set(id, neuron);
  if (/^LC10/.test(type)) populations.lc10.add(id);
  if (/^AOTU/.test(type)) populations.aotu.add(id);
  if (cellClass === "CX") populations.cx.add(id);
  if (cellClass === "Kenyon_Cell") populations.kc.add(id);
  if (cellClass === "MBON") populations.mbon.add(id);
  if (cellClass === "DAN") populations.dan.add(id);
  if (cellClass === "MBIN") populations.mbin.add(id);
  if (/^DN/.test(type)) populations.dn.add(id);
}

const edges = { fromLc10: [], intoAotu: [], aotuToCx: [], cxInternal: [], cxToDn: [], cxToKc: [], kcToMbon: [], mbonToDn: [], danToKc: [], mbinToKc: [] };
const file = await asyncBufferFromFile(connectomePath);
const metadata = await parquetMetadataAsync(file);
let rowStart = 0;
for (const group of metadata.row_groups) {
  const groupEnd = rowStart + Number(group.num_rows);
  const buffers = {};
  await parquetRead({
    file, metadata,
    columns: ["Presynaptic_ID", "Postsynaptic_ID", "Connectivity", "Excitatory x Connectivity"],
    rowStart, rowEnd: groupEnd, compressors,
    onChunk: ({ columnName, columnData }) => { buffers[columnName] = columnData; },
  });
  const preColumn = buffers.Presynaptic_ID, postColumn = buffers.Postsynaptic_ID;
  const countColumn = buffers.Connectivity, weightColumn = buffers["Excitatory x Connectivity"];
  for (let index = 0; index < preColumn.length; index++) {
    const pre = String(preColumn[index]), post = String(postColumn[index]), synapses = Number(countColumn[index]);
    if (synapses < MIN_SYNAPSES) continue;
    const edge = { pre, post, synapses, weight: Number(weightColumn[index]) };
    if (populations.lc10.has(pre)) edges.fromLc10.push(edge);
    if (populations.aotu.has(post)) edges.intoAotu.push(edge);
    if (populations.aotu.has(pre) && populations.cx.has(post)) edges.aotuToCx.push(edge);
    if (populations.cx.has(pre) && populations.cx.has(post)) edges.cxInternal.push(edge);
    if (populations.cx.has(pre) && populations.dn.has(post)) edges.cxToDn.push(edge);
    if (populations.cx.has(pre) && populations.kc.has(post)) edges.cxToKc.push(edge);
    if (populations.kc.has(pre) && populations.mbon.has(post)) edges.kcToMbon.push(edge);
    if (populations.mbon.has(pre) && populations.dn.has(post)) edges.mbonToDn.push(edge);
    if (populations.dan.has(pre) && populations.kc.has(post)) edges.danToKc.push(edge);
    if (populations.mbin.has(pre) && populations.kc.has(post)) edges.mbinToKc.push(edge);
  }
  rowStart = groupEnd;
  console.log(`Scanned ${rowStart.toLocaleString()} / ${Number(metadata.num_rows).toLocaleString()} connections`);
}

// Select only real, directed FlyWire edges that connect the visual input to
// descending steering neurons. The central-complex segment is kept to cells
// on a short measured path from AOTU input to a descending output.
const lc10Targets = new Set(edges.fromLc10.map((edge) => edge.post));
const aotuSources = new Set(edges.intoAotu.map((edge) => edge.pre));
const sharedVisualMids = new Set([...lc10Targets].filter((id) => aotuSources.has(id)));
const visualEdges = [
  ...edges.fromLc10.filter((edge) => sharedVisualMids.has(edge.post) || populations.aotu.has(edge.post)),
  ...edges.intoAotu.filter((edge) => sharedVisualMids.has(edge.pre)),
];
const reachedAotu = new Set(visualEdges.flatMap((edge) => [edge.pre, edge.post]).filter((id) => populations.aotu.has(id)));
for (const edge of edges.fromLc10) if (populations.aotu.has(edge.post)) visualEdges.push(edge);
const uniqueVisualEdges = [...new Map(visualEdges.map((edge) => [`${edge.pre}:${edge.post}`, edge])).values()];
const aotuOutput = edges.aotuToCx.filter((edge) => reachedAotu.has(edge.pre));
const cxSeeds = new Set(aotuOutput.map((edge) => edge.post));

const cxForward = new Map(), cxReverse = new Map();
for (const edge of edges.cxInternal) {
  if (!cxForward.has(edge.pre)) cxForward.set(edge.pre, []);
  if (!cxReverse.has(edge.post)) cxReverse.set(edge.post, []);
  cxForward.get(edge.pre).push(edge.post);
  cxReverse.get(edge.post).push(edge.pre);
}
function walk(seeds, adjacency, depth) {
  const visited = new Set(seeds), frontier = new Set(seeds);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set();
    for (const id of frontier) for (const target of adjacency.get(id) ?? []) if (!visited.has(target)) { visited.add(target); next.add(target); }
    frontier.clear();
    for (const id of next) frontier.add(id);
  }
  return visited;
}
const descendingSeeds = new Set(edges.cxToDn.map((edge) => edge.pre));
const visuallyReachableCx = walk(cxSeeds, cxForward, 2);
const descendingReachableCx = walk(descendingSeeds, cxReverse, 2);
const relevantCx = new Set([...visuallyReachableCx].filter((id) => descendingReachableCx.has(id)));
if (!relevantCx.size) for (const id of cxSeeds) relevantCx.add(id);
const cxEdges = edges.cxInternal.filter((edge) => relevantCx.has(edge.pre) && relevantCx.has(edge.post));
const cxOutputEdges = edges.cxToDn.filter((edge) => relevantCx.has(edge.pre));
const cxInputEdges = aotuOutput.filter((edge) => relevantCx.has(edge.post));

// Add the measured mushroom-body value branch only where it rejoins the same
// descending output. It remains optional if the selected AOTU/CX cells do not
// have a measured route through that branch in this connectome release.
const cxKenyonEdges = edges.cxToKc.filter((edge) => relevantCx.has(edge.pre));
const reachedKc = new Set(cxKenyonEdges.map((edge) => edge.post));
const kenyonMbonEdges = edges.kcToMbon.filter((edge) => reachedKc.has(edge.pre));
const reachedMbon = new Set(kenyonMbonEdges.map((edge) => edge.post));
const mbonDescendingEdges = edges.mbonToDn.filter((edge) => reachedMbon.has(edge.pre));
const connectedMbon = new Set(mbonDescendingEdges.map((edge) => edge.pre));
const valueEdges = [
  ...cxKenyonEdges.filter((edge) => kenyonMbonEdges.some((next) => next.pre === edge.post && connectedMbon.has(next.post))),
  ...kenyonMbonEdges.filter((edge) => connectedMbon.has(edge.post)),
  ...mbonDescendingEdges,
];
const valueKc = new Set(valueEdges.filter((edge) => populations.kc.has(edge.post) || populations.kc.has(edge.pre)).flatMap((edge) => [edge.pre, edge.post]).filter((id) => populations.kc.has(id)));
const danToKc = edges.danToKc.filter((edge) => valueKc.has(edge.post));
const mbinToKc = edges.mbinToKc.filter((edge) => valueKc.has(edge.post));
const includedDan = new Set(danToKc.map((edge) => edge.pre));
const includedMbin = new Set(mbinToKc.map((edge) => edge.pre));

let selectedEdges = [...uniqueVisualEdges, ...cxInputEdges, ...cxEdges, ...cxOutputEdges, ...valueEdges, ...danToKc, ...mbinToKc];
selectedEdges = [...new Map(selectedEdges.map((edge) => [`${edge.pre}:${edge.post}`, edge])).values()];
if (!selectedEdges.length || !uniqueVisualEdges.length || !cxOutputEdges.length) throw new Error("No complete ≥5-synapse FlyWire path from LC10 visual input through central-complex output was found.");

const nodeIds = new Set(selectedEdges.flatMap((edge) => [edge.pre, edge.post]));
for (const id of reachedAotu) nodeIds.add(id);
for (const id of relevantCx) nodeIds.add(id);
for (const id of includedDan) nodeIds.add(id);
for (const id of includedMbin) nodeIds.add(id);
const included = [...nodeIds].map((id) => neurons.get(id)).filter(Boolean);
const outputNeurons = included.map((neuron) => ({ id: neuron.id, type: neuron.type, superClass: neuron.superClass, cellClass: neuron.cellClass, transmitter: neuron.transmitter, side: neuron.side }));
const indexById = new Map(outputNeurons.map((neuron, index) => [neuron.id, index]));
const outputEdges = selectedEdges.map((edge) => ({ source: indexById.get(edge.pre), target: indexById.get(edge.post), synapses: edge.synapses, weight: edge.weight })).filter((edge) => edge.source !== undefined && edge.target !== undefined);
const dnas = outputNeurons.map((neuron, index) => ({ index, type: neuron.type, side: neuron.side })).filter((neuron) => /^DN/.test(neuron.type));
const groups = outputNeurons.map((neuron) => {
  if (/^LC10/.test(neuron.type)) return "visual";
  if (/^AOTU/.test(neuron.type)) return "visual_intermediate";
  if (neuron.cellClass === "CX") return "central_complex";
  if (neuron.cellClass === "Kenyon_Cell") return "mushroom_body";
  if (neuron.cellClass === "MBON") return "mushroom_body_output";
  if (neuron.cellClass === "DAN" || neuron.cellClass === "MBIN") return "modulatory";
  if (/^DN/.test(neuron.type)) return "descending";
  return "interneuron";
});
const leftInputTypes = new Set(outputNeurons.map((neuron, index) => neuron.side === "left" && /^LC10/.test(neuron.type) ? index : -1).filter((index) => index >= 0));
const rightInputTypes = new Set(outputNeurons.map((neuron, index) => neuron.side === "right" && /^LC10/.test(neuron.type) ? index : -1).filter((index) => index >= 0));
const rewardInput = [...includedDan].map((id) => indexById.get(id)).filter(Number.isInteger);
const punishmentInput = [...includedMbin].map((id) => indexById.get(id)).filter(Number.isInteger);
const steering = dnas.map(({ index, type, side }) => ({ index, type, side }));
const output = {
  dataset: "FlyWire FAFB v783",
  model: "Connectome-constrained leaky integrate-and-fire prototype; Shiu et al. 2024 parameters",
  pathway: "Measured LC10 family → AOTU → central-complex / descending cells, with connected mushroom-body modulation where present",
  minimumSynapses: MIN_SYNAPSES,
  neurons: outputNeurons,
  edges: outputEdges,
  neuronGroups: groups,
  input: {
    left: [...leftInputTypes],
    right: [...rightInputTypes],
    reward: rewardInput,
    punishment: punishmentInput,
  },
  steering,
  sources: {
    connectome: connectomeUrl,
    annotations: annotationsUrl,
    model: "https://www.nature.com/articles/s41586-024-07763-9",
  },
  stats: {
    visualInputs: leftInputTypes.size + rightInputTypes.size,
    aotu: [...reachedAotu].filter((id) => nodeIds.has(id)).length,
    centralComplex: relevantCx.size,
    kenyonCells: valueKc.size,
    mushroomBodyOutput: connectedMbon.size,
    rewardCells: rewardInput.length,
    punishmentCells: punishmentInput.length,
    descending: steering.length,
  },
};
if (new Set(output.neurons.map((neuron) => neuron.id)).size !== output.neurons.length) throw new Error("Duplicate neuron IDs in selected circuit.");
if (output.edges.some((edge) => !Number.isInteger(edge.source) || !Number.isInteger(edge.target) || !Number.isFinite(edge.weight))) throw new Error("Invalid circuit edge index or weight.");
writeFileSync(outputPath, JSON.stringify(output));
console.log(`Wrote ${output.neurons.length} measured FlyWire neurons and ${output.edges.length} real directed connections.`);
console.log(JSON.stringify(output.stats, null, 2));
