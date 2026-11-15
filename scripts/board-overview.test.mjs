import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";
import { boardChiefs } from "../packages/sage-core/chief-live.mjs";
import { appTables } from "./fixtures/board-app.mjs";

const NOW = "2026-11-13T12:00:00.000Z";
const source = (tables = appTables(NOW), label = "claude") => ({ id: label, label, provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: `${label}/sample-app-abc123`, source: label, name: "sample-app-abc123", checkout: "/sample/app", displayName: "sample app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
const overview = (tables, now = NOW, label) => boardOverview(buildBoardModel([source(tables, label)], { now }));

test("T1054: Needs you lists each open question oldest first, with its recommendation, gate, task and the time it was asked", () => {
  const { needs } = overview();
  assert.deepEqual(needs.map(need => [need.gate, need.question, need.recommendation, need.task.id, need.askedAt]), [
    ["G4", "Can a viewer copy a shared list into their own lists?", "A: yes, as a new private list", "T10", "2026-11-13T09:00:00.000Z"],
    ["G5", "Crash reports: send them on their own, or ask each time?", "A: ask each time", "T30", "2026-11-13T11:18:00.000Z"],
  ]);
});

test("T1054: a milestone problem that is not a gate is in Needs you too, with no invented time", () => {
  const tables = appTables(NOW);
  tables.tasks = tables.tasks.map(task => task.id === "T20" ? { ...task, state: "abandoned" } : task);
  tables.milestones = tables.milestones.map(milestone => milestone.id === "M3" ? { ...milestone, pilot: "T20" } : milestone);
  tables.tasks.push({ ...tables.tasks.find(task => task.id === "T21"), id: "T22", state: "framed" });
  const stuck = overview(tables).needs.find(need => need.kind === "stuck");
  assert.equal(stuck.question, "Milestone 3: Sign-in rework is stuck");
  assert.equal(stuck.askedAt, null);
  assert.equal(stuck.milestone, "claude/sample-app-abc123/M3", "F-T1061-26: the need names its milestone, so it can link to it");
});

test("T1054: milestones come by the top priority of their open tasks, with progress; a done milestone shows for 7 days", () => {
  const rows = overview().milestones.map(m => [m.id, m.priority, m.state, m.merged, m.total, m.moving, m.waiting, m.needsYou]);
  assert.deepEqual(rows, [
    ["M2", "P0", "active", 0, 2, 1, 1, 1],
    ["M1", "P1", "active", 1, 4, 2, 1, 0],
    ["M3", null, "done", 2, 2, 0, 0, 0],
  ]);
  const later = overview(undefined, "2026-11-19T12:00:00.000Z");
  assert.deepEqual(later.milestones.map(m => m.id), ["M2", "M1"], "M3's last task merged 30 h before NOW, so it leaves after 7 days");
  assert.equal(later.hiddenDone, 1);
});

test("T1054: the counts cover the last 24 hours: a merge 2 h ago counts and one 30 h ago does not; a failed run counts as stuck", () => {
  const { counts, next } = overview();
  assert.deepEqual(counts, { merged: 1, stuck: 1, added: null });
  assert.equal(next, Date.parse("2026-11-14T10:00:00.000Z") + 1, "T1's merge leaves the window first");
  assert.deepEqual(overview(undefined, "2026-11-14T13:00:00.000Z").counts, { merged: 0, stuck: 0, added: null });
});

test("F-T1065-2: a Codex run that writes nothing to the logbook for 30 minutes counts as stuck, and the board wakes when one goes silent", () => {
  const minutesAgo = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const codex = (started, decisions = []) => {
    const tables = appTables(NOW);
    tables.runs = tables.runs.map(run => run.id === "R2" ? { ...run, started: minutesAgo(started) } : run);
    tables.decisions.push(...decisions);
    return overview(tables, NOW, "codex");
  };
  const silentNow = codex(40), [book] = silentNow.agents;
  assert.deepEqual(silentNow.counts, { merged: 1, stuck: 2, added: null }, "R2 started 40 min ago, and T3 has no later write");
  assert.equal(book.look, silentNow.counts.stuck, "the Agents page counts the same runs as the Overview");
  assert.deepEqual(book.runs.filter(run => run.status === "running").map(run => [run.id, run.state, run.look, run.why]), [["R2", "stuck", true, "no logbook write for 40 min"]]);
  assert.deepEqual(codex(40, [{ at: minutesAgo(5), task: "T3", decision: "round 1", why: "sample" }]).counts, { merged: 1, stuck: 1, added: null }, "a write on T3 5 min ago shows that the run is alive");
  const quiet = codex(10);
  assert.deepEqual(quiet.counts, { merged: 1, stuck: 1, added: null });
  assert.equal(quiet.next, Date.parse(NOW) + 20 * 60_000, "the board reads again when R2 reaches 30 silent minutes");
  assert.equal(overview(undefined, NOW, "claude").counts.stuck, 1, "a Claude run with no hook notes is not known, so only the failed run R1 counts");
});

const LOGBOOK = "f".repeat(64), minutesAgo = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
function hooked({ runs = [], slots = [], helpers = [], archived = false } = {}) {
  const tables = appTables(NOW), claude = source(tables);
  tables.runs.push(...runs.map(([id, task, role, status, started, ended = ""]) => ({ id, task, role, round: "0", candidate: "", branch: "", status, tokens: "", report: "", started: minutesAgo(started), ended: ended === "" ? "" : minutesAgo(ended) })));
  claude.provider = "claude";
  Object.assign(claude.projects[0], { logbook: LOGBOOK, archived });
  claude.hooks = { present: true, problem: null, helpers, slots: slots.map(([run, idle], i) => ({ name: `slot-${i + 1}`, marks: ["ok", "project-sample-app", ...(run ? [`run-${run}`] : [])], at: Date.parse(NOW) - idle * 60_000 })) };
  return boardOverview(buildBoardModel([claude], { now: NOW }));
}
const leadKey = id => createHash("sha256").update(`${LOGBOOK}:${id}`).digest("hex");
const lookRuns = book => book.runs.filter(run => run.look).map(run => run.id).sort();

test("F-T1062-21, F-T1062-24, F-T1065-3: Stuck counts the one list: failed in 24 hours, silent for 30 min, or stopped; never running long, and never a slot with no logbook run", () => {
  const world = hooked({
    runs: [
      ["R50", "T2", "lead", "running", 90], ["R51", "T3", "implementer", "running", 60], ["R52", "T2", "qa", "running", 50],
      ...[1, 2, 3, 4, 5].map(i => [`R${70 + i}`, "T21", "designer", "done", 300 + 20 * i, 290 + 20 * i]), ["R53", "T11", "designer", "running", 60],
    ],
    slots: [["R50", 40], ["R51", 40], ["R53", 1], ["R2", 1], ["R99", 40], [null, 40]],
    helpers: [{ lead: leadKey("R50"), run: "R52", stopped: true, at: Date.parse(NOW) - 5 * 60_000 }],
  });
  const [book] = world.agents, byId = Object.fromEntries(book.runs.map(run => [run.id, run]));
  assert.deepEqual([byId.R50.state, byId.R51.state, byId.R52.state, byId.R53.state, byId.R2.state], ["stuck", "stuck", "stop", "long", "work"]);
  assert.deepEqual(lookRuns(book), ["R1", "R50", "R51", "R52"], "the failed run, the two silent agents and the stopped helper; R53 only runs long");
  assert.equal(world.counts.stuck, 4, "the two slots with no running logbook run (R99, and one with no run mark) count on neither page");
  assert.equal(book.look, world.counts.stuck, "one list: the Agents page's 'need a look' is the Overview's Stuck");
});

test("F-T1062-27, F-T1062-29: an archived project and a run that failed after the model's time count on neither page", () => {
  const future = hooked({ runs: [["R60", "T2", "qa", "failed", 10, -30]], slots: [["R2", 1]] });
  assert.equal(future.counts.stuck, 1, "R60's end is 30 min after the model's time, so only R1 counts");
  assert.deepEqual(lookRuns(future.agents[0]), ["R1"]);
  const archived = hooked({ runs: [["R50", "T2", "lead", "running", 90]], slots: [["R50", 40], ["R2", 1]], archived: true });
  assert.deepEqual([archived.counts.stuck, archived.agents], [0, []], "an archived project's silent lead and failed run count nowhere");
  assert.equal(hooked({ runs: [["R50", "T2", "lead", "running", 90]], slots: [["R50", 40], ["R2", 1]] }).counts.stuck, 2, "the same lead counts when the project is not archived");
});

test("F-T1065-1: a milestone names its abandoned tasks", () => {
  const tables = appTables(NOW);
  tables.tasks = tables.tasks.map(task => ["T3", "T4"].includes(task.id) ? { ...task, state: "abandoned" } : task);
  const m1 = overview(tables).milestones.find(milestone => milestone.id === "M1");
  assert.deepEqual([m1.merged, m1.total, m1.abandoned], [1, 4, ["T3", "T4"]]);
  assert.deepEqual(overview().milestones.find(milestone => milestone.id === "M1").abandoned, []);
});

test("T1054: a stale model says so, with its problems", () => {
  const model = { ...buildBoardModel([source()], { now: NOW }), stale: true, diagnostics: [{ source: "claude", message: "tasks: the file cannot be read" }] };
  const result = boardOverview(model);
  assert.equal(result.stale, true);
  assert.deepEqual(result.problems, ["tasks: the file cannot be read"]);
  assert.equal(result.milestones.length, 3, "the last good data stays");
});

test("F-T1059-10: a chief that waits for the owner sets no refresh time, so the board still refreshes when another live chief stops", () => {
  const now = Date.parse(NOW), iso = ms => new Date(ms).toISOString();
  const rows = [{ id: "C1", provider: "claude", at: iso(now - 5 * 3600_000) }, { id: "C2", provider: "codex", at: iso(now - 5 * 3600_000) }];
  const live = { C1: { checkout: "/sample/a", sageMode: true, autopilot: false, at: now - 2 * 3600_000 }, C2: { checkout: "/sample/b", sageMode: true, autopilot: false, at: now - 60_000 } };
  const chiefs = boardChiefs({ rows, live, runs: [], waits: ["C1"], now }).map(chief => ({ key: `claude/sample-app-abc123/${chief.id}`, ...chief }));
  assert.deepEqual(chiefs.map(chief => [chief.id, chief.waitsForOwner, chief.stopped]), [["C1", true, false], ["C2", false, false]]);
  const { next } = boardOverview({ at: NOW, tasks: [], needsOwner: [], milestones: [], projects: [{ name: "sample-app", chiefs }], agents: { projects: [] } });
  assert.equal(next, now - 60_000 + 30 * 60_000 + 1, "the next refresh is when C2 stops: 30 minutes after its last event");
});

test("F-T1062-38: a running lead with no valid start takes no helper by time; with a start, it takes only the helpers that started after it", () => {
  const at = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const sample = { id: "T1", title: "Sample task", size: "small", risk: "", route: "build,code-review,qa", state: "reviewing", branch: "", pr: "", round: "2", keys: "", hold: "", priority: "P2", kind: "" };
  const row = (id, role, round, status, started, ended = "") => ({ id, task: "T1", role, round, status, started, ended, tokens: "1", chief: "" });
  const runs = start => [
    row("R1", "lead", "1", "done", at(3000), at(2000)), row("R2", "qa", "1", "done", at(2900), at(2800)),
    row("R3", "implementer", "1", "running", at(2500)), row("R4", "lead", "2", "running", start), row("R5", "qa", "2", "running", at(10)),
  ];
  const book = start => overview({ tasks: [sample], runs: runs(start), decisions: [], gates: [], milestones: [], findings: [], ledger: [] }).agents[0];
  const shown = start => book(start).runs.map(run => [run.id, run.lead, run.endedHelpers ?? null]);
  assert.deepEqual(shown(at(30)), [["R3", null, null], ["R4", null, 0], ["R5", "R4", null]], "R5 started after the lead; R2 and R3 of round 1 did not");
  for (const start of ["", "not a time"]) {
    assert.deepEqual(shown(start), [["R4", null, 0], ["R3", null, null], ["R5", null, null]], `lead start ${JSON.stringify(start)}: unknown stays unknown, so no helper and no ended helper is the lead's`);
  }
});
