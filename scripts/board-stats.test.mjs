import "./test-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardStats } from "../packages/sage-core/board-stats.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";

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
  assert.deepEqual(stats.gaps.map(gap => gap.what).sort(), ["every project in the Codex logbook folder", "every task of gamma (Claude logbook)"], "T1159 F-T1159-55: a project whose every logbook cannot be read keeps its project name, as in the picker");
  assert.deepEqual([stats.total.merged, stats.total.tokens, stats.empty], [2, 51000, false]);
});

test("F-T1158-1: a config.json that cannot be read leaves the numbers whole, so it is no gap; a folder that cannot be read is", () => {
  const books = () => [book("claude", "alpha-aaaaaa", "alpha", ALPHA)];
  const config = boardStats(model(source("claude", books(), ["config: Unexpected token } in JSON at position 9"])));
  assert.deepEqual([config.gaps, config.total.merged, config.total.tokens], [[], 2, 51000], "the projects of the folder still count, and nothing says they are left out");
  const folder = boardStats(model(source("claude", [], ["EACCES"])));
  assert.deepEqual(folder.gaps.map(gap => gap.what), ["every project in the Claude logbook folder"]);
});

test("F-T1158-7, T1159 F-T1159-55, F-T1159-56: a project whose runs or tasks table cannot be read keeps its name, and the gap names the project, then its logbook", () => {
  const lost = name => model(source("claude", [book("claude", "gamma-cccccc", "gamma", { ...table(), tasks: [task("T1", "framed")], [name]: undefined }, [`${name}: EACCES`])]));
  assert.deepEqual(boardStats(lost("runs")).gaps, [{ project: "gamma", what: "the agent time and tokens of gamma (Claude logbook)" }]);
  assert.deepEqual(boardStats(lost("tasks")).gaps, [{ project: "gamma", what: "every task of gamma (Claude logbook)" }], "T1159 F-T1159-55: with no readable task, the project still has its name, not its folder key");
});

test("F-T1158-2 and F-T1158-10: an unreadable runs, decisions or gates table names exactly what the numbers leave out", () => {
  const lose = (...names) => {
    const tables = { ...ALPHA };
    for (const name of names) tables[name] = undefined;
    return boardStats(model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", tables, names.map(name => `${name}: EACCES`))]))).gaps.map(gap => gap.what);
  };
  assert.deepEqual(lose("runs"), ["the agent time and tokens of alpha (Claude logbook)"], "only the runs are left out; the tasks still count");
  assert.deepEqual(lose("decisions"), ["the merges of alpha (Claude logbook)"]);
  assert.deepEqual(lose("gates"), ["the questions of alpha (Claude logbook)"]);
  assert.deepEqual(lose("runs", "decisions", "gates"), ["the agent time and tokens, the merges and the questions of alpha (Claude logbook)"]);
  assert.deepEqual(lose("findings"), [], "the numbers do not use the findings");
});

test("F-T1158-5: the runs of a task that moved to the shared logbook stay in its old logbook and count in agent time of the project", () => {
  const shared = { ...book("shared", "alpha-aaaaaa", "alpha", table({ tasks: [task("T5", "merged", { adoption: JSON.stringify({ version: 2, provider: "codex", task: "T1" }) })], decisions: [merged("T5", "2026-11-12T00:00:00Z")] })), shared: true, chiefs: [], notes: [] };
  const old = { ...book("shared", "alpha-aaaaaa", "alpha", table({ tasks: [task("T1", "reviewing")], runs: [run("R1", "T1", "2026-11-10T00:00:00Z", "2026-11-10T02:00:00Z", "1000")] })), key: "old-codex/alpha-aaaaaa", old: { provider: "codex", of: "shared/alpha-aaaaaa" } };
  const stats = boardStats(model({ ...source("shared", [shared, old]), shared: true }), "alpha-aaaaaa");
  assert.deepEqual([stats.total.hours, stats.total.tokens, stats.total.runs, stats.total.merged], [2, 1000, 1, 1]);
});

test("T1138: Stats with no task in any logbook is empty, and archived projects count with their mark", () => {
  assert.equal(boardStats(model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", table())]))).empty, true);
  assert.equal(boardStats(model(source("claude", []))).empty, true);
  const shelved = boardStats(model(source("codex", [{ ...book("codex", "beta-bbbbbb", "beta", BETA), archived: true }])));
  assert.deepEqual(shelved.projects.map(row => [row.name, row.archived, row.merged]), [["beta", true, 1]]);
});

test("T1159 F-T1159-53: an open task that moved to the shared logbook counts once in Open tasks and in the picker, not again for its old copy", () => {
  const shared = { ...book("shared", "alpha-aaaaaa", "alpha", table({ tasks: [task("T5", "building", { adoption: JSON.stringify({ version: 2, provider: "codex", task: "T1" }) })] })), shared: true, chiefs: [], notes: [] };
  const old = { ...book("shared", "alpha-aaaaaa", "alpha", table({ tasks: [task("T1", "building"), task("T2", "framed")] })), key: "old-codex/alpha-aaaaaa", old: { provider: "codex", of: "shared/alpha-aaaaaa" } };
  const board = model({ ...source("shared", [shared, old]), shared: true });
  assert.equal(boardStats(board, "alpha-aaaaaa").total.open, 2, "T5, and the old T2 that did not move; the old T1 is T5");
  assert.deepEqual(boardOverview(board).projects.map(project => project.open), [2], "the picker counts the same");
});

test("T1159 F-T1159-57: the need-you tile counts questions and merges only, so an unreadable runs, decisions or gates table never adds to it", () => {
  const needs = (...names) => {
    const tables = { ...ALPHA };
    for (const name of names) tables[name] = undefined;
    return boardStats(model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", tables, names.map(name => `${name}: EACCES`))]))).total.needs;
  };
  assert.deepEqual([needs(), needs("runs"), needs("decisions")], [1, 1, 1], "the one question G1 of T6");
  assert.equal(needs("gates"), 0, "with no readable gates the board knows no question, and the gap banner says so");
});

test("F-T1168-2, F-T1168-3: a milestone whose gates or tasks table cannot be read adds no need to the need-you tile", () => {
  const MILESTONE = { ...ALPHA, tasks: ALPHA.tasks.map(row => row.id === "T4" ? { ...row, milestone: "M1" } : row), milestones: [{ id: "M1", name: "Sample", goal: "g", pilot: "T4", gate: "G2", state: "proposed", at: "" }],
    gates: [...ALPHA.gates, { id: "G2", task: "T4", question: "Approve milestone M1 (Sample)?", options: "approve|change|drop", recommendation: "approve", default: "approve", answer: "", at: "2026-11-13T10:00:00Z" }] };
  const read = (...names) => {
    const tables = { ...MILESTONE };
    for (const name of names) tables[name] = undefined;
    const board = model(source("claude", [book("claude", "alpha-aaaaaa", "alpha", tables, names.map(name => `${name}: EACCES`))]));
    return { needs: boardStats(board).total.needs, kinds: board.milestoneNeeds.map(need => need.kind) };
  };
  assert.deepEqual(read(), { needs: 2, kinds: [] }, "the questions G1 of T6 and G2 of T4");
  assert.deepEqual(read("gates"), { needs: 0, kinds: ["unread", "logbook"] }, "the board shows the problem, and counts no question that it cannot read");
  assert.deepEqual(read("tasks"), { needs: 0, kinds: ["unread", "logbook"] }, "with no readable tasks the board knows no task that waits for you");
});
