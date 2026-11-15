import assert from "node:assert/strict";
import { test } from "node:test";
import { H, W, labelArea, layout, meets } from "../packages/sage-board/app/layout.js";
import { graphProblems } from "./fixtures/graph-geometry.mjs";

const drawn = graph => {
  const { boxes, links } = layout(graph);
  return graphProblems({ boxes: boxes.map(box => ({ id: box.node.key, x: box.x, y: box.y, w: W, h: H })), links: links.map(link => ({ id: link.id, d: link.path })) });
};
const tasks = (...ids) => ids.map(id => ({ key: id, group: "wait" }));
const links = text => text.split(" ").filter(Boolean).map(pair => { const [from, to] = pair.split(">"); return { from, to, met: false }; });

test("T1063: the named cases keep each link on its own line and out of every box", () => {
  const cases = [
    ["F-T1063-15: T7 waits for T5; T6 for T5, T3 and T7; T13 for T5 and T7", { nodes: tasks("T5", "T3", "T8", "T7", "T6", "T13"), waits: links("T5>T7 T5>T6 T3>T6 T7>T6 T5>T13 T7>T13"), conflicts: [{ from: "T3", to: "T8" }] }],
    ["F-T1063-17: T6 waits for T5, T13 for T7, T4 for T7 and T6, T2 for T3 and T13", { nodes: tasks("T5", "T3", "T7", "T6", "T13", "T4", "T2"), waits: links("T5>T6 T7>T13 T7>T4 T6>T4 T3>T2 T13>T2"), conflicts: [] }],
    ["F-T1063-19: T8 waits for T3, and the two may conflict", { nodes: tasks("T3", "T8"), waits: links("T3>T8"), conflicts: [{ from: "T3", to: "T8" }] }],
    ["F-T1063-20: ten tasks in one column all may conflict", { nodes: tasks(...Array.from({ length: 10 }, (_, i) => `T${80 + i}`)), waits: [], conflicts: Array.from({ length: 10 }, (_, a) => Array.from({ length: 9 - a }, (_, k) => ({ from: `T${80 + a}`, to: `T${81 + a + k}` }))).flat() }],
  ];
  for (const [name, graph] of cases) assert.deepEqual(drawn(graph), { through: [], shared: [] }, name);
});

const seededRandom = seed => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

function* randomGraphs(count) {
  const next = seededRandom(1063);
  for (let trial = 0; trial < count; trial++) {
    const n = 2 + Math.floor(next() * 11), ids = Array.from({ length: n }, (_, i) => `T${i + 1}`);
    const ahead = 0.1 + next() * 0.5, behind = next() * 0.12, conflict = next() * 0.35;
    const waits = [], conflicts = [];
    for (const [b, to] of ids.entries()) for (const [a, from] of ids.entries()) if (next() < (a < b ? ahead : behind)) waits.push({ from, to, met: next() < 0.2 });
    for (const [b, to] of ids.entries()) for (const from of ids.slice(0, b)) if (next() < conflict) conflicts.push({ from, to });
    const linked = new Set([...waits, ...conflicts].flatMap(link => [link.from, link.to]));
    if (!linked.size) continue;
    yield { nodes: ids.filter(id => linked.has(id)).map(key => ({ key, group: ["ready", "review", "wait"][Math.floor(next() * 3)] })), waits, conflicts };
  }
}
const named = graph => ({ waits: graph.waits.map(link => `${link.from}>${link.to}`).join(" "), conflicts: graph.conflicts.map(link => `${link.from}|${link.to}`).join(" ") });

test("T1063: in 3,000 random graphs with loops, self-waits, conflicts, long links and crowded gaps, each link keeps its own line and stays out of every box", () => {
  const failures = [];
  for (const graph of randomGraphs(3000)) {
    const { through, shared } = drawn(graph);
    if (through.length || shared.length) failures.push({ ...named(graph), through: through.slice(0, 2), shared: shared.slice(0, 2) });
  }
  assert.deepEqual(failures.slice(0, 3), [], `${failures.length} graphs break the rule`);
});

const labelProblems = graph => {
  const { boxes, links } = layout(graph), problems = [];
  const labels = links.filter(link => link.label).map(link => ({ id: link.id, area: labelArea(link.label, link.x, link.y) }));
  for (const [i, label] of labels.entries()) {
    for (const other of labels.slice(i + 1)) if (meets(label.area, other.area)) problems.push(`${label.id} covers ${other.id}`);
    for (const box of boxes) if (meets(label.area, { x: box.x, y: box.y, w: W, h: H })) problems.push(`${label.id} covers ${box.node.key}`);
  }
  return { problems, marks: links.filter(link => link.label && link.label !== "may conflict").map(link => `${link.id} ${link.label}`).sort() };
};

test("F-T1081-11, F-T1081-12: a loop mark and a self-wait mark keep their own place, also with many self-waits in one column", () => {
  const loopAndSelf = { nodes: tasks("T5", "T6", "T7", "T13"), waits: links("T5>T6 T13>T6 T6>T7 T7>T13 T13>T13 T7>T5"), conflicts: [] };
  assert.deepEqual(labelProblems(loopAndSelf), { problems: [], marks: ["wait:T13>T13 waits for itself", "wait:T13>T6 loop", "wait:T7>T5 loop"] });
  const manySelf = { nodes: tasks("T3", "T5", "T8", "T50", "T6"), waits: links("T3>T3 T8>T8 T50>T50 T5>T5 T5>T6"), conflicts: [{ from: "T3", to: "T8" }, { from: "T8", to: "T50" }] };
  assert.deepEqual(labelProblems(manySelf).problems, []);
  assert.equal(labelProblems(manySelf).marks.length, 4, "each self-wait keeps its mark");
});

test("F-T1081-11: in 3,000 random graphs no label covers another label or a box; a loop or self-wait mark is never left out", () => {
  const failures = [];
  for (const graph of randomGraphs(3000)) {
    const { problems, marks } = labelProblems(graph), expected = graph.waits.filter(link => link.from === link.to).length;
    if (problems.length || marks.filter(mark => mark.endsWith("itself")).length !== expected) failures.push({ ...named(graph), problems: problems.slice(0, 2) });
  }
  assert.deepEqual(failures.slice(0, 3), [], `${failures.length} graphs break the rule`);
});

test("F-T1081-15: a chain of 20,000 tasks, and 20,000 tasks in one column, lay out without a stack overflow", () => {
  const nodes = tasks(...Array.from({ length: 20_000 }, (_, i) => `T${i + 1}`));
  const chain = layout({ nodes, waits: nodes.slice(1).map((node, i) => ({ from: nodes[i].key, to: node.key, met: false })), conflicts: [] });
  assert.equal(new Set(chain.boxes.map(box => box.x)).size, 20_000, "each task of the chain has its own column");
  const column = layout({ nodes, waits: [], conflicts: [{ from: "T1", to: "T2" }] });
  assert.equal(new Set(column.boxes.map(box => box.y)).size, 20_000, "each task of the column has its own row");
});
