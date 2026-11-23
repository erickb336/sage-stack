import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.includes("--help")) { console.log("node scripts/board-refresh-bench.mjs [--repo <checkout of sage>] [--runs 1000] [--events 100]: times one full board refresh on a sample logbook, and counts the full reads that slot renewals and action appends cause. It writes only a new folder under the temporary folder, and deletes it."); process.exit(0); }
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1]; };
const repo = resolve(arg("repo", join(dirname(fileURLToPath(import.meta.url)), "..")));
const RUNS = Number(arg("runs", 1000)), EVENTS = Number(arg("events", 100)), RUNNING = 4, REPEAT = 15;
const core = await import(pathToFileURL(join(repo, "packages/sage-core/index.mjs")).href);
const { TABLES } = await import(pathToFileURL(join(repo, "packages/sage-core/logbook-fields.mjs")).href);
const { createBoardServer } = await import(pathToFileURL(join(repo, "packages/sage-board/server.mjs")).href);
const wait = ms => new Promise(wake => setTimeout(wake, ms));

function writeFixture(root) {
  const book = join(root, "bench-abc123"), now = Date.now(), at = minutes => new Date(now - minutes * 60_000).toISOString();
  mkdirSync(book, { recursive: true });
  const tasks = Array.from({ length: Math.ceil(RUNS / 4) }, (_, i) => ({ id: `T${i + 1}`, title: `Sample task ${i + 1}`, size: "small", risk: "", route: "build,code-review,qa", state: i < RUNNING ? "building" : i % 3 ? "merged" : "abandoned", branch: `sage/t${i + 1}`, pr: String(i + 1), round: "0", keys: "", priority: "P2" }));
  const runs = Array.from({ length: RUNS }, (_, i) => {
    const running = i < RUNNING, task = running ? `T${i + 1}` : `T${Math.floor(i / 4) + 1}`;
    return { id: `R${i + 1}`, task, role: ["implementer", "code-reviewer", "qa", "lead"][i % 4], round: "0", candidate: "", branch: "", status: running ? "running" : "done", tokens: "", report: "", started: at(running ? 5 : 600 + i), ended: running ? "" : at(590 + i) };
  });
  const tables = { tasks, runs, findings: [], ledger: [], gates: [], decisions: tasks.map(task => ({ at: at(500), task: task.id, decision: `state ${task.state}`, why: "sample" })), milestones: [], releases: [] };
  for (const [name, rows] of Object.entries(tables)) writeFileSync(join(book, `${name}.tsv`), [TABLES[name].join("\t"), ...rows.map(row => TABLES[name].map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
  mkdirSync(join(book, "actions"));
  for (let i = 1; i <= RUNNING; i++) {
    const slot = join(root, ".hooks", "slots", `slot-${i}`);
    mkdirSync(slot, { recursive: true });
    for (const mark of ["ok", "project-bench", `role-sage_${runs[i - 1].role}`, `run-R${i}`]) writeFileSync(join(slot, mark), "");
    writeFileSync(join(book, "actions", `R${i}.jsonl`), "");
  }
  return book;
}

const stats = list => { const sorted = [...list].sort((a, b) => a - b); return `median ${sorted[sorted.length >> 1].toFixed(1)} ms (min ${sorted[0].toFixed(1)}, max ${sorted.at(-1).toFixed(1)}, n=${list.length})`; };

const dir = mkdtempSync(join(tmpdir(), "sage-board-bench-")), root = join(dir, "source");
try {
  const book = writeFixture(root), sources = [{ id: "bench", path: root, label: "Bench", provider: "claude" }];
  const times = [];
  for (let i = 0; i < REPEAT; i++) {
    const start = performance.now();
    const read = core.readBoardSources(sources, {});
    const model = core.buildBoardModel(read, { now: new Date().toISOString() });
    core.boardOverview(model);
    times.push(performance.now() - start);
  }
  console.log(`checkout: ${repo}`);
  console.log(`fixture: 1 logbook, ${RUNS} runs, ${Math.ceil(RUNS / 4)} tasks, ${RUNNING} running agents with hook slots`);
  console.log(`one full refresh (read every table, build the model and the overview, as the board server does for the app): ${stats(times)}`);

  let reads = 0;
  const server = createBoardServer({ sources, port: 0, settleReads: [], duringRead: () => { reads++; } });
  await server.start();
  await server.ready();
  try {
    await wait(1500);
    for (const [label, change] of [
      ["slot renewals (the hook's utimes on a slot folder)", i => { const when = new Date(); utimesSync(join(root, ".hooks", "slots", `slot-${(i % RUNNING) + 1}`), when, when); }],
      ["action appends (one line to actions/R<n>.jsonl)", i => appendFileSync(join(book, "actions", `R${(i % RUNNING) + 1}.jsonl`), `${JSON.stringify({ v: 1, at: new Date().toISOString(), run: `R${(i % RUNNING) + 1}`, tool: "Read", kind: "file", target: "src/sample.mjs", call: "0123abcd", mark: "ok" })}\n`)],
    ]) {
      reads = 0;
      const start = performance.now();
      for (let i = 0; i < EVENTS; i++) { change(i); await wait(30); }
      await wait(3000);
      console.log(`${EVENTS} ${label}, 30 ms apart: ${reads} full logbook reads in ${((performance.now() - start) / 1000).toFixed(1)} s`);
    }
  } finally { await server.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
