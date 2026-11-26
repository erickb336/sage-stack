import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview, taskPanel } from "../packages/sage-core/board-overview.mjs";
import { boardChiefs } from "../packages/sage-core/chief-live.mjs";
import { appTables } from "./fixtures/board-app.mjs";

const NOW = "2026-11-13T12:00:00.000Z";
const source = (tables = appTables(NOW), label = "claude") => ({ id: label, label, provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: `${label}/sample-app-abc123`, source: label, name: "sample-app-abc123", checkout: "/sample/app", displayName: "sample app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] });
const overview = (tables, now = NOW, label) => boardOverview(buildBoardModel([source(tables, label)], { now }));
const stuck = view => view.agents.reduce((n, book) => n + book.look, 0);

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
    ["M2", "P0", "active", 0, 2, 0, 1, 1],
    ["M1", "P1", "active", 1, 4, 2, 1, 0],
    ["M3", null, "done", 2, 2, 0, 0, 0],
  ], "T1223: a row has one state, so T10, which needs you, is not in progress too");
  const later = overview(undefined, "2026-11-19T12:00:00.000Z");
  assert.deepEqual(later.milestones.map(m => m.id), ["M2", "M1"], "M3's last task merged 30 h before NOW, so it leaves after 7 days");
  assert.deepEqual(later.hiddenDone, { "sample-app-abc123": 1 }, "T1135: by project");
});

test("T1054, T1224: the board reads again when a merge leaves the last 24 hours; a failed run of the last 24 hours counts as flagged", () => {
  const now = overview();
  assert.equal(stuck(now), 1);
  assert.equal(now.next, Date.parse("2026-11-14T10:00:00.000Z") + 1, "T1's merge leaves the window first");
  const later = overview(undefined, "2026-11-14T13:00:00.000Z");
  assert.deepEqual(lookRuns(later.agents[0]), ["R2"], "the failed run R1 left the window; R2 now has no news for a day, so it is Look at it");
  assert.equal(later.agents[0].runs.find(run => run.id === "R2").flag.text, "Look at it");
  const panel = (label, at) => taskPanel(buildBoardModel([source(undefined, label)], { now: at }), `${label}/sample-app-abc123/T3`).runs.find(run => run.id === "R2");
  assert.equal(panel("claude", "2026-11-14T13:00:00.000Z").flag.text, "Look at it", "the task page shows the same flag");
  assert.equal(panel("codex", "2026-11-14T13:00:00.000Z").flag, null, "the task page's short line leaves out a calm flag");
});

test("F-T1065-2, T1224: a Codex run says Codex: activity unknown and never counts as flagged, also with no logbook write for 40 min", () => {
  const minutesAgo = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const codex = (started, decisions = []) => {
    const tables = appTables(NOW);
    tables.runs = tables.runs.map(run => run.id === "R2" ? { ...run, started: minutesAgo(started) } : run);
    tables.decisions.push(...decisions);
    return overview(tables, NOW, "codex");
  };
  const silentNow = codex(40), [book] = silentNow.agents;
  assert.equal(book.look, 1, "only the failed run R1: R2 started 40 min ago with no later write, but Codex sends no notes, so the board cannot tell");
  assert.deepEqual(book.runs.filter(run => run.status === "running").map(run => [run.id, run.state, run.look, run.flag.level, run.flag.text]), [["R2", "work", false, "calm", "Codex: activity unknown"]]);
  assert.equal(silentNow.next, Date.parse("2026-11-14T10:00:00.000Z") + 1, "no wake for a Codex silence");
  assert.equal(stuck(overview(undefined, NOW, "claude")), 1, "a Claude run with no hook notes is not known, so only the failed run R1 counts");
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

const done = (role, first) => [1, 2, 3, 4, 5].map(i => [`R${first + i}`, "T21", role, "done", 300 + 20 * i, 290 + 20 * i]);
test("F-T1062-21, F-T1062-24, F-T1065-3, T1224: the flagged count is one list: failed in 24 hours, Look at it, or Stopped without a report; never long alone, and never a slot with no logbook run", () => {
  const world = hooked({
    runs: [
      ["R50", "T2", "lead", "running", 90], ["R51", "T3", "implementer", "running", 60], ["R52", "T2", "qa", "running", 50],
      ...done("designer", 70), ...done("lead", 80), ...done("implementer", 90), ["R53", "T11", "designer", "running", 60],
    ],
    slots: [["R50", 40], ["R51", 40], ["R53", 1], ["R2", 1], ["R99", 40], [null, 40]],
    helpers: [{ lead: leadKey("R50"), run: "R52", stopped: true, at: Date.parse(NOW) - 5 * 60_000 }],
  });
  const [book] = world.agents, byId = Object.fromEntries(book.runs.map(run => [run.id, run]));
  assert.deepEqual([byId.R50, byId.R51, byId.R52, byId.R53, byId.R2].map(run => [run.state, run.flag?.text ?? null]), [["work", "Look at it"], ["work", "Look at it"], ["work", "Stopped without a report"], ["work", null], ["work", null]]);
  assert.deepEqual(lookRuns(book), ["R1", "R50", "R51", "R52"], "the failed run, the two quiet agents past their usual length and the stopped helper; R53 only runs long");
  assert.equal(book.look, 4, "the two slots with no running logbook run (R99, and one with no run mark) count on neither page");
});

test("F-T1062-29, T1135 R11: a run that failed after the model's time does not count; an archived project keeps its agents, on its own pages only", () => {
  const future = hooked({ runs: [["R60", "T2", "qa", "failed", 10, -30]], slots: [["R2", 1]] });
  assert.equal(stuck(future), 1, "R60's end is 30 min after the model's time, so only R1 counts");
  assert.deepEqual(lookRuns(future.agents[0]), ["R1"]);
  const archived = hooked({ runs: [["R50", "T2", "lead", "running", 90], ...done("lead", 80)], slots: [["R50", 40], ["R2", 1]], archived: true });
  assert.deepEqual(archived.projects.map(project => [project.key, project.list, project.archived]), [["sample-app-abc123", "archived", true]]);
  assert.deepEqual(archived.agents.map(book => [book.project, lookRuns(book)]), [["sample-app-abc123", ["R50"]]], "the silent lead shows on the archived project's Agents page; its failed run R1 needs no look there");
  assert.deepEqual(lookRuns(hooked({ runs: [["R50", "T2", "lead", "running", 90], ...done("lead", 80)], slots: [["R50", 40], ["R2", 1]] }).agents[0]), ["R1", "R50"], "the same lead and the failed run when the project is not archived");
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

test("T1135 R11: the app model lists each project for the picker, and every row names its project, also in an archived project", () => {
  const live = source(), put = source(appTables(NOW), "codex");
  Object.assign(put.projects[0], { key: "codex/old-app-def456", name: "old-app-def456", checkout: "/sample/old-app", displayName: "old app", archived: true });
  const view = boardOverview(buildBoardModel([live, put], { now: NOW }));
  assert.deepEqual(view.projects.map(project => [project.key, project.name, project.list, project.archived, project.books, project.needs > 0, project.open > 0]), [
    ["sample-app-abc123", "sample app", "needs", false, ["claude/sample-app-abc123"], true, true],
    ["old-app-def456", "old app", "archived", true, ["codex/old-app-def456"], true, true],
  ], "needs you first; the archived project stays, marked");
  const of = rows => [...new Set(rows.map(row => row.project))].sort();
  for (const rows of [view.tasks, view.needs, view.milestones, view.agents]) assert.deepEqual(of(rows), ["old-app-def456", "sample-app-abc123"], "each row names its project by key, and the archived project keeps its rows");
  assert.deepEqual(view.needs.filter(need => need.project === "old-app-def456").map(need => need.gate), ["G4", "G5"], "its questions stay on its own page");
});

const ROW_NOW = "2026-11-13T12:00:00.000Z", HEAD = "c".repeat(40);
function rowOf({ state = "building", route = "build,code-review,qa", run = null, gate = null, autopilot = null, head = false } = {}) {
  const minutes = n => new Date(Date.parse(ROW_NOW) - n * 60_000).toISOString();
  const tables = { tasks: [{ id: "T1", title: "Sample row", size: "small", risk: "", route, state, branch: "", pr: "7", round: "0", keys: "" }],
    runs: run ? [{ id: "R1", task: "T1", role: "implementer", round: "0", status: run, started: minutes(20), ended: run === "running" ? "" : minutes(5) }] : [],
    gates: gate ? [{ id: "G1", task: "T1", question: "Sample: keep the old copy?", options: "yes|no", recommendation: "yes", default: "", answer: gate === "answered" ? "yes" : "", at: minutes(10) }] : [],
    decisions: [], milestones: [], findings: [], ledger: [] };
  const records = [...(head ? [{ id: "O1", task: "T1", kind: "pr", source: "sample", basis: "observed", observedAt: ROW_NOW, recordedAt: ROW_NOW, data: { number: 7, head: HEAD, state: "open" } }] : []),
    ...(autopilot === null ? [] : [{ id: "O2", task: "T1", kind: "mode", source: "sample", basis: "observed", observedAt: ROW_NOW, recordedAt: ROW_NOW, data: { autopilot } }])];
  const book = source(tables);
  book.projects[0].observations = { version: 1, records };
  return boardOverview(buildBoardModel([book], { now: ROW_NOW, landing: () => ({ ok: true, scope: "all", reason: "" }) })).tasks[0].row;
}

test("T1223: a task's row is in one of four states: waits, at work, needs you or done", () => {
  const cases = [
    ["framed, no agent", {}, "framed", "waits"],
    ["waiting for a step: briefed, no agent", {}, "briefed", "waits"],
    ["an agent at work on a step", { run: "running" }, "building", "work"],
    ["an open question", { gate: "open" }, "building", "needs"],
    ["a design that waits for the owner", {}, "awaiting-you", "needs"],
    ["a verified PR that waits for the owner's merge, autopilot off", { head: true, autopilot: false }, "verified", "needs"],
    ["a verified PR that autopilot merges", { head: true, autopilot: true }, "verified", "waits"],
    ["merged", {}, "merged", "done"],
    ["concluded", { route: "investigate,evidence-review" }, "concluded", "done"],
    ["merged, with a question still open: the question does not hide", { gate: "open" }, "merged", "needs"],
  ];
  assert.deepEqual(cases.map(([name, facts, state]) => [name, rowOf({ ...facts, state })]), cases.map(([name, , , row]) => [name, row]));
});

test("T1223: each move of the row's state chart, and abandoned goes to done from any state", () => {
  const moves = [
    ["waits → at work: an agent starts a step", [{ state: "briefed" }, { state: "building", run: "running" }], ["waits", "work"]],
    ["at work → waits: the step ends, and the next waits", [{ state: "building", run: "running" }, { state: "building", run: "done" }], ["work", "waits"]],
    ["at work → needs you: a question", [{ state: "building", run: "running" }, { state: "building", run: "running", gate: "open" }], ["work", "needs"]],
    ["at work → needs you: a merge, autopilot off", [{ state: "reviewing", run: "running", head: true, autopilot: false }, { state: "verified", run: "done", head: true, autopilot: false }], ["work", "needs"]],
    ["needs you → at work: you answer", [{ state: "building", run: "running", gate: "open" }, { state: "building", run: "running", gate: "answered" }], ["needs", "work"]],
    ["needs you → done: you merge, autopilot off", [{ state: "verified", head: true, autopilot: false }, { state: "merged", head: true, autopilot: false }], ["needs", "done"]],
    ["at work → done: merged", [{ state: "verifying", run: "running" }, { state: "merged", run: "done" }], ["work", "done"]],
    ["waits → done: concluded", [{ state: "verifying", route: "investigate,evidence-review" }, { state: "concluded", route: "investigate,evidence-review" }], ["waits", "done"]],
  ];
  assert.deepEqual(moves.map(([name, steps]) => [name, steps.map(rowOf)]), moves.map(([name, , rows]) => [name, rows]));
  const from = { waits: { state: "framed" }, work: { state: "building", run: "running" }, needs: { state: "building", gate: "open" }, merge: { state: "verified", head: true, autopilot: false } };
  assert.deepEqual(Object.entries(from).map(([name, facts]) => [name, rowOf(facts), rowOf({ ...facts, state: "abandoned" })]),
    [["waits", "waits", "done"], ["work", "work", "done"], ["needs", "needs", "done"], ["merge", "needs", "done"]]);
});

const key = id => `claude/sample-app-abc123/${id}`;
test("T1223: the model keeps levels 0-2: all projects, a project, a milestone and the tasks in no milestone, each by row state", () => {
  const { levels } = overview();
  const lists = node => ({ needs: node.needs, work: node.work, waits: node.waits, done: node.done, agents: node.agents });
  assert.deepEqual(lists(levels.all), { needs: [key("T10"), key("T30")], work: [key("T3")], waits: [key("T11"), key("T2"), key("T4")], done: [key("T1"), key("T21"), key("T20")], agents: 1 },
    "needs you by the oldest question first; at work and waits by priority; done newest first");
  assert.deepEqual([levels.all.projects, levels.all.milestones], [["sample-app-abc123"], [key("M2"), key("M1"), key("M3")]]);
  assert.deepEqual(lists(levels.projects["sample-app-abc123"]), lists(levels.all));
  assert.deepEqual(levels.projects["sample-app-abc123"].milestones, levels.all.milestones);
  assert.deepEqual(Object.fromEntries(Object.entries(levels.milestones).map(([id, node]) => [id, lists(node)])), {
    [key("M2")]: { needs: [key("T10")], work: [], waits: [key("T11")], done: [], agents: 0 },
    [key("M1")]: { needs: [], work: [key("T3")], waits: [key("T2"), key("T4")], done: [key("T1")], agents: 1 },
    [key("M3")]: { needs: [], work: [], waits: [], done: [key("T21"), key("T20")], agents: 0 },
  });
  assert.deepEqual(lists(levels.loose["sample-app-abc123"]), { needs: [key("T30")], work: [], waits: [], done: [], agents: 0 });
  assert.deepEqual(overview(undefined, "2026-11-19T12:00:00.000Z").levels.all.done, [key("T1")], "a done row stays 7 days: T21 and T20 ended earlier");
});

test("T1223: an archived project keeps its own levels, and all projects leaves its rows out", () => {
  const live = source(), put = source(appTables(NOW), "codex");
  Object.assign(put.projects[0], { key: "codex/old-app-def456", name: "old-app-def456", checkout: "/sample/old-app", displayName: "old app", archived: true });
  const { levels } = boardOverview(buildBoardModel([live, put], { now: NOW }));
  assert.deepEqual(levels.all.projects, ["sample-app-abc123", "old-app-def456"]);
  assert.ok([...levels.all.needs, ...levels.all.waits, ...levels.all.done, ...levels.all.milestones].every(item => item.startsWith("claude/")), "no row of the archived project");
  assert.deepEqual(levels.projects["old-app-def456"].needs, ["codex/old-app-def456/T10", "codex/old-app-def456/T30"]);
});

test("T1223: the search rows hold open, ended and archived tasks, the approved designs and the projects, open work first", () => {
  const live = source(), put = source(appTables(NOW), "codex");
  Object.assign(put.projects[0], { key: "codex/old-app-def456", name: "old-app-def456", checkout: "/sample/old-app", displayName: "old app", archived: true });
  live.projects[0].designs = [{ task: "T1", gate: "G6", design: "designs/final", answer: "Approve", at: "2026-11-12T10:00:00.000Z", files: 2 }];
  const { search } = boardOverview(buildBoardModel([live, put], { now: NOW }));
  const of = (kind, project) => search.filter(row => row.kind === kind && row.project === project);
  assert.deepEqual(of("task", "sample-app-abc123").map(row => [row.id, row.rank]).sort(), [["T1", 1], ["T10", 0], ["T11", 0], ["T2", 0], ["T20", 1], ["T21", 1], ["T3", 0], ["T30", 0], ["T4", 0]], "open 0, ended 1");
  assert.ok(of("task", "old-app-def456").length === 9 && of("task", "old-app-def456").every(row => row.rank === 2), "archived: 2");
  assert.deepEqual(of("design", "sample-app-abc123").map(row => [row.key, row.id, row.label, row.rank]), [[key("T1/G6"), "T1", "Sample pinned bundle", 1]]);
  assert.deepEqual(search.filter(row => row.kind === "project").map(row => [row.key, row.label, row.rank]), [["sample-app-abc123", "sample app", 0], ["old-app-def456", "old app", 2]]);
  assert.deepEqual(search.map(row => row.rank), search.map(row => row.rank).sort(), "rank order");
  assert.equal(search.find(row => row.id === "T3").row, "work");
});

test("T1223: the approved-design rows: the newest approved design of each task that is not abandoned, newest first, on each level", () => {
  const tables = appTables(NOW);
  tables.tasks = tables.tasks.map(task => task.id === "T4" ? { ...task, state: "abandoned" } : task);
  const book = source(tables);
  const design = (task, gate, at, answer = "Approve") => ({ task, gate, design: "designs/final", answer, at, files: 1 });
  book.projects[0].designs = [design("T1", "G6", "2026-11-10T10:00:00.000Z"), design("T1", "G7", "2026-11-11T10:00:00.000Z", "Approve with your words: bigger buttons"),
    design("T21", "G8", "2026-11-12T10:00:00.000Z"), design("T4", "G9", "2026-11-13T10:00:00.000Z"), design("T99", "G10", "2026-11-13T11:00:00.000Z")];
  const view = boardOverview(buildBoardModel([book], { now: NOW }));
  assert.deepEqual(view.designs.map(row => [row.key, row.task, row.gate, row.answer, row.milestone]), [
    [key("T21/G8"), key("T21"), "G8", "Approve", key("M3")],
    [key("T1/G7"), key("T1"), "G7", "Approve with your words: bigger buttons", key("M1")],
  ], "T1's later approval replaces G6; abandoned T4 and the unknown T99 show nothing");
  assert.deepEqual([view.levels.all.designs, view.levels.projects["sample-app-abc123"].designs, view.levels.milestones[key("M1")].designs, view.levels.milestones[key("M2")].designs],
    [[key("T21/G8"), key("T1/G7")], [key("T21/G8"), key("T1/G7")], [key("T1/G7")], []]);
});
