import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Rebuild the anatomical display from every located neuron in the same public
// annotation snapshot as the simulated circuit. No random positions, mirrored
// copies or morphology guesses are added.
const projectRoot = process.cwd();
const annotationPath = resolve(projectRoot, "data/brain/Supplemental_file1_neuron_annotations.tsv");
const circuitPath = resolve(projectRoot, "src/data/flywire-vision-circuit.json");
const outputPath = resolve(projectRoot, "src/data/flywire-brain-cloud.json");
const annotationUrl = "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv";
const documentationUrl = "https://github.com/flyconnectome/flywire_annotations/blob/main/supplemental_files/README.md";

if (!existsSync(annotationPath)) {
  await mkdir(dirname(annotationPath), { recursive: true });
  const response = await fetch(annotationUrl);
  if (!response.ok) throw new Error(`FlyWire annotations download failed: HTTP ${response.status}`);
  writeFileSync(annotationPath, Buffer.from(await response.arrayBuffer()));
}
if (!existsSync(circuitPath)) throw new Error("Build the neural circuit first with npm run brain:build.");

const sourceBytes = readFileSync(annotationPath);
const lines = sourceBytes.toString("utf8").trimEnd().split(/\r?\n/);
const headers = lines.shift().split("\t");
const column = Object.fromEntries(headers.map((name, index) => [name, index]));
for (const name of ["root_id", "super_class", "cell_class", "side", "pos_x", "pos_y", "pos_z", "soma_x", "soma_y", "soma_z"]) {
  if (column[name] === undefined) throw new Error(`Missing FlyWire annotation column: ${name}`);
}

const groups = [
  { id: "visual", label: "Görsel nöronlar", color: "#5ce5ed", meaning: "super_class optic, visual_projection or visual_centrifugal; or cell_class visual or optic_lobes" },
  { id: "olfactory", label: "Koku devresi", color: "#ff9a51", meaning: "cell_class olfactory, ALPN, ALLN, ALIN or ALON" },
  { id: "mushroom", label: "Mantar cismi", color: "#eb7ddd", meaning: "cell_class Kenyon_Cell, MBON or MBIN" },
  { id: "central_complex", label: "Merkezî kompleks", color: "#f4dd74", meaning: "cell_class CX" },
  { id: "lateral_horn", label: "Yan boynuz", color: "#93d679", meaning: "cell_class LHLN or LHCENT" },
  { id: "other", label: "Diğer nöronlar", color: "#9aaeb7", meaning: "Remaining annotated neuron classes" },
];

function groupFor(superClass, cellClass) {
  if (["Kenyon_Cell", "MBON", "MBIN"].includes(cellClass)) return 2;
  if (cellClass === "CX") return 3;
  if (["LHLN", "LHCENT"].includes(cellClass)) return 4;
  if (["olfactory", "ALPN", "ALLN", "ALIN", "ALON"].includes(cellClass)) return 1;
  if (["optic", "visual_projection", "visual_centrifugal"].includes(superClass) || ["visual", "optic_lobes"].includes(cellClass)) return 0;
  return 5;
}

function readPosition(row, prefix) {
  const xyz = ["x", "y", "z"].map((axis) => {
    const value = row[column[`${prefix}_${axis}`]];
    return value !== "" && value !== undefined ? Number(value) : NaN;
  });
  return xyz.every((value) => Number.isFinite(value) && value > 0) ? xyz : null;
}

const neurons = new Map();
let rejectedPositions = 0;
for (const line of lines) {
  const row = line.split("\t");
  const soma = readPosition(row, "soma");
  const xyz = soma || readPosition(row, "pos");
  if (!xyz) { rejectedPositions++; continue; }
  const id = row[column.root_id];
  // The official table uses 4×4×40 nm voxel units, not isotropic XYZ.
  const positionMicrometers = [xyz[0] * 0.004, xyz[1] * 0.004, xyz[2] * 0.04];
  neurons.set(id, {
    id,
    group: groupFor(row[column.super_class], row[column.cell_class]),
    side: row[column.side] || "unknown",
    position: positionMicrometers,
    coordinateSource: soma ? "soma" : "anchor",
  });
}

const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));
const circuitIds = circuit.neurons.map((neuron) => neuron.id);
const circuitNeurons = circuitIds.map((id) => {
  const neuron = neurons.get(id);
  if (!neuron) throw new Error(`Simulated neuron ${id} has no valid annotated position.`);
  return neuron;
});
const allNeurons = [...neurons.values()].sort((a, b) => a.id.localeCompare(b.id));
for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
  const group = groups[groupIndex];
  const population = allNeurons.filter((neuron) => neuron.group === groupIndex);
  group.population = population.length;
  group.count = population.length;
  group.somaCount = population.filter((neuron) => neuron.coordinateSource === "soma").length;
  group.anchorCount = population.length - group.somaCount;
}

// One similarity transform, shared by the cloud and every simulated neuron.
// Preserve aspect ratio and original axes; the renderer may rotate the camera.
const boundsMicrometers = [0, 1, 2].map((axis) => {
  let min = Infinity, max = -Infinity;
  for (const neuron of neurons.values()) { min = Math.min(min, neuron.position[axis]); max = Math.max(max, neuron.position[axis]); }
  return [min, max];
});
const centerMicrometers = boundsMicrometers.map(([min, max]) => (min + max) / 2);
const scaleMicrometers = Math.max(...boundsMicrometers.map(([min, max]) => (max - min) / 2));
const normalize = (neuron) => neuron.position.map((value, axis) => Number(((value - centerMicrometers[axis]) / scaleMicrometers).toFixed(5)));
const pointIds = allNeurons.map((neuron) => neuron.id);
const points = allNeurons.map((neuron) => [...normalize(neuron), neuron.group]);
const circuitPositions = circuitNeurons.map(normalize);

if (new Set(pointIds).size !== points.length) throw new Error("Duplicate annotated root IDs.");
if (points.length < 100_000) throw new Error(`Unexpected full-brain point count: ${points.length}`);
if (points.some((point) => point.length !== 4 || point.some((value) => !Number.isFinite(value)))) throw new Error("Invalid cloud coordinates.");
if (circuitPositions.length !== circuit.neurons.length) throw new Error("Circuit index alignment failed.");
const cloudIndexById = new Map(pointIds.map((id, index) => [id, index]));
for (let index = 0; index < circuitPositions.length; index++) {
  const point = points[cloudIndexById.get(circuitIds[index])];
  if (!point || circuitPositions[index].some((value, axis) => value !== point[axis])) throw new Error(`Circuit/cloud mismatch at index ${index}`);
}

const output = {
  dataset: "FlyWire FAFB v783",
  description: "Measured neuron soma positions, with annotated backbone anchors only where a soma is unavailable. Colours represent annotated cell groups, not neuropil meshes.",
  groups,
  points,
  pointIds,
  circuitPositions,
  circuitIds,
  circuitGroups: circuitNeurons.map((neuron) => groupFor(neuron.superClass, neuron.cellClass)),
  coordinates: {
    inputUnits: "4 × 4 × 40 nm voxels",
    positionPreference: "Complete soma_x/y/z triplet, otherwise complete pos_x/y/z anchor triplet",
    axisOrder: ["x", "y", "z"],
    centerMicrometers,
    scaleMicrometers,
    boundsMicrometers,
    normalization: "(positionMicrometers - centerMicrometers) / scaleMicrometers; one uniform scale for all axes and both datasets",
    orientation: "Original annotation axes retained; x is the broad left/right axis. Positions are not mirrored, warped or projected onto synthetic regions.",
  },
  provenance: {
    annotationUrl,
    annotationDocumentation: documentationUrl,
    annotationSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceNeuronCount: neurons.size,
    rejectedPositionCount: rejectedPositions,
    sampling: "No sampling: every annotated neuron with a valid soma or anchor location is included.",
    citation: "Schlegel et al., Whole-brain annotation and multi-connectome cell typing of Drosophila, Nature (2024), doi:10.1038/s41586-024-07686-5; current annotations also incorporate Matsliah et al. (2024) and Berg et al. (2025/2026), as documented by FlyWire.",
    limitation: "Each dot is one measured soma/anchor, not a reconstructed arbor or the position of a synapse. The selected connectome-constrained circuit is simulated; other points provide anatomical context.",
  },
};
await mkdir(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output));
console.log(`Wrote ${points.length} real neuron positions and ${circuitPositions.length} matching circuit positions.`);
console.log(JSON.stringify(groups.map(({ id, count, population, somaCount, anchorCount }) => ({ id, count, population, somaCount, anchorCount })), null, 2));
console.log(`Bounds in µm: ${JSON.stringify(boundsMicrometers)}; shared scale: ${scaleMicrometers} µm`);
console.log(`Output: ${outputPath}`);
