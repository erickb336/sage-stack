import "./test-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardStats } from "../packages/sage-core/board-stats.mjs";

const NOW = "2026-11-13T12:00:00.000Z";
const WEEKS_MONDAY_21_SEP_TO_9_NOV = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];
const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });
const run = (id, taskId, started, ended, tokens = "") => ({ id, task: taskId, role: "implementer", round: "0", status: ended ? "done" : "running", tokens, started, ended: ended ?? "" });
const merged = (taskId, at) => ({ at, task: taskId, decision: "state merged", why: "sample" });
const book = (label, name, display, tables, diagnostics = []) => ({ key: `${label}/${name}`, source: label, name, checkout: `/sample/${display}`, displayName: display, diagnostics, warnings: [], tables, observations: { version: 1, records: [] } });
const source = (label, projects, diagnostics = []) => ({ id: label, label, provider: null, config: {}, diagnostics, hooks: { present: false, slots: [], helpers: [], problem: null }, projects });
const table = (rows = {}) => ({ tasks: [], runs: [], findings: [], ledger: [], gates: [], decisions: [], milestones: [], ...rows });

const ALPHA = table({
  tasks: [task("T1", "merged", { pr: "11" }), task("T2", "merged", { pr: "12", round: "2" }), task("T3", "merged", { pr: "13", round: "1" }), task("T4", "framed"), task("T5", "building"), task("T6", "designing"), task("T7", "abandoned")],
  runs: [
    run("R1", "T1", "2026-11-10T08:00:00Z", "2026-11-10T10:00:00Z", "50000"),
    run("R2", "T1", "2026-11-10T10:00:00Z", "2026-11-10T10:30:00Z"),
    run("R3", "T2", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z", "1000"),
    run("R4", "T3", "2026-08-01T00:00:00Z", "2026-08-01T05:00:00Z", "9000"),
    run("R5", "T5", "2026-11-13T11:00:00Z"),
    run("R6", "T7", "2026-09-20T20:00:00Z", "2026-09-20T23:59:59Z", "7000"),
  ],
  gates: [{ id: "G1", task: "T6", question: "Sample: design A or B?", options: "A|B", recommendation: "A", default: "A", answer: "", at: "2026-11-13T09:00:00Z" }],
  decisions: [merged("T1", "2026-11-10T11:00:00Z"), merged("T2", "2026-10-01T02:00:00Z"), merged("T3", "2026-08-01T06:00:00Z")],
});
const BETA = table({
  tasks: [task("T1", "merged", { pr: "4", round: "4" }), task("T2", "reviewing", { pr: "5" })],
  runs: [run("R1", "T1", "2026-11-12T00:00:00Z", "2026-11-12T03:00:00Z", "2000")],
  decisions: [merged("T1", "2026-11-12T04:00:00Z")],
});
const model = (...sources) => buildBoardModel(sources, { now: NOW });
const sample = () => model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", ALPHA)]), source("codex", [book("codex", "beta-bbbbbb", "beta", BETA)]));

test("T1138: Stats for all projects counts merges, agent time and tokens of the last 8 weeks, and open tasks and questions now", () => {
  const stats = boardStats(sample());
  assert.deepEqual(stats.weeks, WEEKS_MONDAY_21_SEP_TO_9_NOV);
  assert.deepEqual(stats.total, { merged: 3, undated: 0, open: 4, needs: 1, hours: 6.5, tokens: 53000, runs: 4, noTokens: 1, noTime: 0, rounds: 2 },
    "T3 and R4 are older than 8 weeks; R6 ended 1 s before the first week; R5 still runs; R2 has no token count");
  assert.deepEqual(stats.perWeek, { merged: [0, 1, 0, 0, 0, 0, 0, 2], hours: [0, 1, 0, 0, 0, 0, 0, 5.5], tokens: [0, 1000, 0, 0, 0, 0, 0, 52000] });
  assert.deepEqual(stats.open, [{ word: "not started", count: 1 }, { word: "waiting", count: 0 }, { word: "needs you", count: 1 }, { word: "in progress", count: 2 }]);
  assert.deepEqual(stats.rounds.map(row => row.count), [1, 0, 1, 1], "rounds 0, 2 and 4 of the merged pull requests; 4 goes to 3 or more");
  assert.deepEqual(stats.projects.map(row => [row.name, row.merged, row.open, row.needs, row.hours, row.tokens]).sort(), [["alpha", 2, 3, 1, 3.5, 51000], ["beta", 1, 1, 0, 3, 2000]]);
  assert.deepEqual([stats.empty, stats.gaps, stats.logbooks], [false, [], 2]);
});

test("T1138: Stats for one project counts only that project, and an unknown project gives no stats", () => {
  const stats = boardStats(sample(), "beta-bbbbbb");
  assert.equal(stats.project, "beta-bbbbbb");
  assert.deepEqual([stats.total.merged, stats.total.open, stats.total.hours, stats.total.tokens, stats.total.needs, stats.total.rounds], [1, 1, 3, 2000, 0, 4]);
  assert.deepEqual(stats.projects.map(row => row.name), ["beta"]);
  assert.equal(boardStats(sample(), "gamma-cccccc"), null);
});

test("T1138: a logbook that cannot be read is named as a gap, and the other projects still count", () => {
  const lost = book("claude", "gamma-cccccc", "gamma", { ...table(), tasks: undefined }, ["tasks: EACCES"]);
  const stats = boardStats(model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", ALPHA), lost]), source("codex", [], ["EACCES"])));
  assert.deepEqual(stats.gaps.map(gap => gap.what).sort(), ["the Claude logbook of gamma-cccccc", "the Codex logbook folder"], "a project whose every logbook cannot be read shows its folder name, as in the picker");
  assert.deepEqual([stats.total.merged, stats.total.tokens, stats.empty], [2, 51000, false]);
});

test("T1138: Stats with no task in any logbook is empty, and archived projects count with their mark", () => {
  assert.equal(boardStats(model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", table())]))).empty, true);
  assert.equal(boardStats(model(source("claude", []))).empty, true);
  const shelved = boardStats(model(source("codex", [{ ...book("codex", "beta-bbbbbb", "beta", BETA), archived: true }])));
  assert.deepEqual(shelved.projects.map(row => [row.name, row.archived, row.merged]), [["beta", true, 1]]);
});
