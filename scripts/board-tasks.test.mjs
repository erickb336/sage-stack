import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview, taskPanel } from "../packages/sage-core/board-overview.mjs";
import { renderTaskText } from "../packages/sage-core/board-render.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { budgetOf } from "../packages/sage-board/reader.mjs";
import { ABOUT, appTables, writeTasksLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-13T12:00:00.000Z";
const KEY = id => `shared/sample-app-abc123/${id}`;
const b64 = key => Buffer.from(key).toString("base64url");

function world(t, options) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-tasks-")), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(dir, { recursive: true, force: true }); });
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), NOW, options);
  return { dir, logbook, sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }] };
}
const modelOf = sources => buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW });

async function serve(t, sources) {
  const server = createBoardServer({ sources, port: 0, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [] });
  t.after(() => server.close());
  return `http://127.0.0.1:${(await server.start()).port}`;
}

test("T1061: the stream lists every task with its state word, priority, kind, chief tag and may-conflict flag; ended tasks are marked", t => {
  const { tasks } = boardOverview(modelOf(world(t).sources));
  const row = id => tasks.find(task => task.id === id);
  assert.deepEqual(tasks.map(task => task.id).sort(), ["T1", "T10", "T11", "T2", "T20", "T21", "T3", "T30", "T4", "T40"], "every task, ended ones too");
  assert.deepEqual([row("T3").word, row("T3").priority, row("T3").kind, row("T3").chief, row("T3").pr, row("T3").ended], ["in progress", "P2", "providers", { id: "C2", provider: "Codex", stopped: false, waits: false }, "12", false]);
  assert.deepEqual(row("T3").conflicts, [{ key: KEY("T40"), id: "T40", chief: "Claude · C1" }], "T3 (C2) and T40 (C1) change src/shared.js; the chief reads as on its row (F-T1080-17)");
  assert.deepEqual(row("T40").conflicts.map(other => other.id), ["T3"]);
  assert.deepEqual(row("T2").conflicts, [], "a task with no files record has no flag");
  assert.deepEqual([row("T1").word, row("T1").ended], ["done", true]);
  assert.deepEqual([row("T10").word, row("T10").needsYou], ["needs you", true]);
  assert.equal(row("T4").waits, "Waits for T2 (in progress).");
  assert.deepEqual(row("T3").step, { label: "Review 1 of 1", status: "run" });
  assert.equal(row("T3").milestone.title, "Milestone 1: Board redesign");
  assert.equal(row("T40").milestone, null);
  assert.equal(row("T3").log, undefined, "the panel's detail is not in the stream");
});

test("T1061: the panel gives the route's steps with the current step, the clean-cycle count, the last event, the log, the decisions and the artifacts", t => {
  const panel = taskPanel(modelOf(world(t).sources), KEY("T3"));
  assert.deepEqual(panel.steps.map(step => [step.label, step.status]), [["Plan", "done"], ["Build", "done"], ["Review 1 of 1", "run"], ["Merge", "wait"]]);
  assert.deepEqual(panel.steps[2].parts, [{ name: "checks", status: "done" }, { name: "code review", status: "done" }, { name: "QA", status: "run" }]);
  assert.deepEqual(panel.cycles, { required: 1, clean: 0, reviews: true });
  assert.deepEqual(panel.lastEvent, { at: "2026-11-13T11:30:00.000Z", who: "R6", text: "qa started" });
  assert.deepEqual(panel.log.map(event => event.text), ["qa started", "review-clean · cycle 1 on bbbbbbb", "code-reviewer ended: done", "checks-pass · cycle 1 on bbbbbbb", "code-reviewer started", "implementer ended: done", "implementer started", "state reviewing · the PR is open"], "newest first");
  assert.deepEqual(panel.decisions, [{ id: "G6", question: "Keep one limit for both providers?", answer: "A: yes", pending: null, recommendation: "A: yes", waits: false, at: "2026-11-13T04:00:00.000Z" }]);
  assert.deepEqual(panel.artifacts.map(item => [item.label, item.run, item.url]), [["Limits design note", "R7", "https://github.com/sample-owner/sample-app/pull/12"]]);
  assert.equal(panel.prUrl, "https://github.com/sample-owner/sample-app/pull/12", "from the PR observation's repository");
  assert.deepEqual(panel.conflicts, [{ key: KEY("T40"), id: "T40", chief: "Claude · C1", paths: ["src/shared.js"] }]);
  assert.equal(taskPanel(modelOf(world(t).sources), KEY("T999")), null);
});

test("T1061: unknown shows as unknown: no clean-cycle count without the PR's last commit, and no last event when nothing is recorded", () => {
  const source = { id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", diagnostics: [], warnings: [], tables: appTables(NOW), observations: { version: 1, records: [] } }] };
  const model = buildBoardModel([source], { now: NOW });
  const review = taskPanel(model, "claude/sample-app-abc123/T3");
  assert.deepEqual(review.cycles, { required: 1, clean: null, reviews: true }, "the board does not know PR 12's head");
  assert.equal(taskPanel(model, "claude/sample-app-abc123/T4").lastEvent, null);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T4").chief.id, null, "a logbook with no chiefs names only the provider");
});

test("T1061 (F-T1061-13): a task with no route has no steps in its row or its panel, and says why", () => {
  const tables = appTables(NOW);
  tables.tasks.find(task => task.id === "T2").route = "";
  const source = { id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }] };
  const model = buildBoardModel([source], { now: NOW }), panel = taskPanel(model, "claude/sample-app-abc123/T2");
  assert.deepEqual([panel.route, panel.steps, panel.now, panel.next], [[], [], ["The logbook records no route for this task, so the board shows no steps."], null]);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T2").step, null);
  assert.equal(boardOverview(model).tasks.find(task => task.id === "T3").step.label, "Review 1 of 1", "a task with a route keeps its step");
});

test("T1061: /app/task/<key> sends one task's panel with its pages, its own kept reports and briefs, and nothing of another task", async t => {
  const w = world(t), base = await serve(t, w.sources);
  const response = await fetch(`${base}/app/task/${b64(KEY("T3"))}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const panel = await response.json();
  assert.equal(panel.id, "T3");
  assert.deepEqual(panel.files.pages.map(page => page.name), ["limits-design.html", "notes.md"]);
  assert.deepEqual(panel.files.kept.map(item => [item.run, item.role, item.status, item.result]), [["R5", "code-reviewer", "done", "CLEAN. The limits change is correct."]], "R7's kept report names T2, so it is left out");
  assert.deepEqual(panel.files.briefs, [{ name: "sage_qa_t3_r6.json", run: "R6" }], "T30's brief is not T3's");
  const other = await (await fetch(`${base}/app/task/${b64(KEY("T40"))}`)).json();
  assert.deepEqual([other.files.pages, other.files.kept, other.files.briefs], [null, [], []], "T40 has no pages folder and no files");
});

test("T1061: the task route refuses a bad key, an unknown task, another site and a write, and follows no link in the logbook", async t => {
  const w = world(t), outside = join(w.dir, "outside.json");
  writeFileSync(outside, JSON.stringify({ task: "T3", run: "R6", role: "qa", sha: "", text: "STATUS done\nRESULT linked in from outside", at: NOW }));
  symlinkSync(outside, join(w.logbook, "kept", "R6.json"));
  const base = await serve(t, w.sources);
  const panel = await (await fetch(`${base}/app/task/${b64(KEY("T3"))}`)).json();
  assert.deepEqual(panel.files.kept.map(item => item.run), ["R5"], "a link is not read");
  for (const path of [`/app/task/${b64(KEY("T999"))}`, "/app/task/not*base64", `/app/task/${b64(KEY("T3"))}=`, "/app/task/"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  assert.equal((await fetch(`${base}/app/task/${b64(KEY("T3"))}`, { method: "POST" })).status, 405);
  const status = headers => new Promise((accept, reject) => {
    const req = request(`${base}/app/task/${b64(KEY("T3"))}`, { headers: { Host: new URL(base).host, ...headers }, agent: false }, response => { response.resume(); accept(response.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(await status({}), 200);
  assert.equal(await status({ Origin: "http://evil.test" }), 403);
  assert.equal(await status({ "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await status({ "X-Forwarded-For": "10.0.0.1" }), 403);
});

test("T1061 (F-T1061-4, F-T1061-5): the kept-report reader reads no run id that leaves kept/, and no kept/ that is a link", async t => {
  const w = world(t), outside = join(w.dir, "outside");
  mkdirSync(outside);
  const report = run => JSON.stringify({ task: "T3", run, role: "qa", sha: "", text: "STATUS done\nRESULT read from outside the logbook", at: NOW });
  writeFileSync(join(outside, "R9.json"), report("../../../outside/R9"));
  const runs = join(w.logbook, "runs.tsv"), columns = readFileSync(runs, "utf8").split("\n")[0].split("\t");
  const values = { id: "../../../outside/R9", task: "T3", role: "qa", round: "0", status: "done", chief: "C2" };
  appendFileSync(runs, `${columns.map(column => values[column] ?? "").join("\t")}\n`);
  const base = await serve(t, w.sources), kept = async () => (await (await fetch(`${base}/app/task/${b64(KEY("T3"))}`)).json()).files.kept.map(item => item.run);
  assert.deepEqual(await kept(), ["R5"], "a run id with a path in it is not read");

  writeFileSync(join(outside, "R5.json"), report("R5"));
  renameSync(join(w.logbook, "kept"), join(w.dir, "kept-real"));
  symlinkSync(outside, join(w.logbook, "kept"));
  assert.deepEqual(await kept(), [], "a kept/ that is a link is not followed");
});

test("T1061 (F-T1061-29): a throw while the task route builds its answer is a 503 with the board's headers, and the board answers the next request", async t => {
  const w = world(t), base = await serve(t, w.sources), url = `${base}/app/task/${b64(KEY("T3"))}`, stringify = JSON.stringify;
  JSON.stringify = (value, ...rest) => { if (value?.files) throw new Error("a fault while the panel is built"); return stringify(value, ...rest); };
  let broken;
  try { broken = await fetch(url); } finally { JSON.stringify = stringify; }
  assert.equal(broken.status, 503);
  assert.equal(broken.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(broken.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await broken.text(), "The board snapshot is unavailable.\n");
  const next = await fetch(url);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).id, "T3");
});

test("T1062 F-T1062-5, F-T1062-6: a queued run shows once in the task's log, as queued with its place, and the task's step names it", t => {
  const { sources } = world(t, { agents: true });
  const model = modelOf(sources), panel = taskPanel(model, KEY("T41"));
  assert.deepEqual(panel.log.filter(event => event.who === "R33").map(event => [event.at, event.text]), [[new Date(Date.parse(NOW) - 2 * 60_000).toISOString(), "implementer queued for an agent slot, place 3"]],
    "one line, when it was queued: no 'started' and no 'ended' for a run that has not started");
  assert.equal(panel.steps.find(step => step.key === "build").detail, "The implementer (run R33) waits for an agent slot: place 3 in the project's queue. It starts when a running agent ends.");
  assert.deepEqual(panel.now, [], "the build step says it, so the panel's now lines do not repeat it");
  assert.deepEqual(taskPanel(model, KEY("T2")).log.filter(event => event.who === "R24").map(event => event.text), ["qa queued for an agent slot, place 1"]);
  assert.match(taskPanel(model, KEY("T2")).now.join(" "), /at work/, "a running agent of the task still comes first");
});

test("T1062: the stream's agents hold running and queued runs, recent failures, and the ended helpers of running leads only, with each chief's count against the logbook's limits", t => {
  const { sources } = world(t, { agents: true, endedRuns: 1300 });
  const model = modelOf(sources), [book] = boardOverview(model).agents;
  assert.deepEqual([book.running, book.limit, book.leads, book.leadLimit, book.queued], [7, 20, 4, 5, 3]);
  assert.deepEqual(book.byChief, [{ chief: "C1", count: 4 }, { chief: "C2", count: 3 }]);
  const byId = Object.fromEntries(book.runs.map(run => [run.id, run]));
  assert.deepEqual(Object.keys(byId).sort(), ["R1", "R20", "R21", "R22", "R23", "R24", "R25", "R26", "R27", "R30", "R31", "R32", "R33", "R6"].sort(), "the 1,300 ended runs of no running lead stay out; a run that failed in the last 24 hours stays in");
  assert.deepEqual([byId.R22.lead, byId.R24.lead, byId.R6.lead, byId.R31.lead, byId.R5], ["R20", "R20", "R30", null, undefined], "a helper belongs to its task's running lead when it started after the lead");
  assert.deepEqual([byId.R24.status, byId.R24.place, byId.R32.place, byId.R33.place], ["queued", 1, 2, 3]);
  assert.deepEqual([byId.R21.tokens, byId.R21.model, byId.R20.model, byId.R6.model], [210000, "sonnet", "opus", null]);
  assert.ok(JSON.stringify(book).length < 8000, "the agents part of the stream stays small");
});

test("T1062 F-T1062-13: the Agents page's 'need a look' counts the same runs as the Overview's Stuck count, and each one is a row of the page", t => {
  const { sources } = world(t, { agents: true });
  const overview = boardOverview(modelOf(sources)), [book] = overview.agents;
  assert.deepEqual(book.runs.filter(run => run.look).map(run => [run.id, run.status, run.lead, run.why]),
    [["R1", "failed", null, null], ["R30", "running", null, "no logbook write for 30 min"], ["R6", "running", "R30", "no logbook write for 30 min"], ["R27", "failed", "R25", null]],
    "the failed run of the last 24 hours with no running lead, the lead's failed helper, and the Codex runs whose task has no logbook write for 30 min are all rows");
  assert.deepEqual(book.runs.filter(run => !run.look && run.status === "failed"), [], "a run that does not need a look is not marked");
});

function addRuns(logbook, rows) {
  const file = join(logbook, "runs.tsv"), [head] = readFileSync(file, "utf8").split("\n"), columns = head.split("\t"), at = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  appendFileSync(file, rows.map(([id, task, role, chief, started, ended]) => {
    const row = { id, task, role, round: "0", status: "failed", started: at(started), ended: at(ended), chief };
    return `${columns.map(column => row[column] ?? "").join("\t")}\n`;
  }).join(""));
}

test("T1062 F-T1062-32: failed runs travel as rows up to 20 for each lead and each chief, with how many more; the count stays the true total", t => {
  const { sources, logbook } = world(t, { agents: true });
  const tasks = join(logbook, "tasks.tsv"), [head] = readFileSync(tasks, "utf8").split("\n"), columns = head.split("\t");
  appendFileSync(tasks, Array.from({ length: 25 }, (_, i) => `${columns.map(column => ({ id: `T${500 + i}`, title: `Sample open task ${i}`, size: "small", route: "build,code-review,qa", state: "building", round: "0", chief: "C2" })[column] ?? "").join("\t")}\n`).join(""));
  addRuns(logbook, [
    ...Array.from({ length: 433 }, (_, i) => [`R${3000 + i}`, "T2", "qa", "C1", 60 - i * 0.1, 10]),
    ...Array.from({ length: 25 }, (_, i) => [`R${4000 + i}`, `T${500 + i}`, "pe", "C2", 120 - i, 100]),
    ...Array.from({ length: 5 }, (_, i) => [`R${4100 + i}`, "T21", "pe", "C2", 120 - i, 100]),
  ]);
  const overview = boardOverview(modelOf(sources)), [book] = overview.agents;
  assert.equal(book.runs.filter(run => run.lead === "R20" && run.look).length, 0, "T1120 S3: R20's 433 failed qa helpers each have a later qa run (R24), so none is a problem");
  assert.equal(book.runs.filter(run => run.chief === "C2" && !run.lead && run.status === "failed").length, 20, "C2's newest 20 failed runs with no running lead");
  assert.deepEqual(book.failedMore, [{ lead: null, chief: "C2", count: 5 }]);
  assert.equal(book.look, 4 + 25, "the page counts every failed run of an open task that did not run again; T1120 S3: the failed runs of merged T21 do not count");
  assert.ok(JSON.stringify(book).length < 20_000, `the agents part of the stream stays small: ${JSON.stringify(book).length} B`);
});

test("T1062 F-T1062-22: a helper counts for the chief of its running lead, so the top bar's count of each chief is the number of running rows in its box", t => {
  const { sources } = world(t, { agents: true, agentEdges: true, chiefCases: true });
  const [book] = boardOverview(modelOf(sources)).agents;
  assert.deepEqual(book.byChief, [{ chief: "C1", count: 7 }, { chief: "C2", count: 3 }], "R36 has no chief of its own and runs under C1's lead R20");
  assert.equal(book.byChief.reduce((sum, item) => sum + item.count, 0), book.running, "the total stays the same");
});

test("T1062 F-T1062-9, F-T1062-11, F-T1062-14, F-T1062-18, F-T1062-19: helpers, lapsed admissions, failure reasons and the count of ended helpers", t => {
  const { sources } = world(t, { agents: true, agentEdges: true, chiefCases: true });
  const model = modelOf(sources), [book] = boardOverview(model).agents, byId = Object.fromEntries(book.runs.map(run => [run.id, run]));
  assert.deepEqual([byId.R34.lead, byId.R35.lead], [null, null], "a pe run after the lead and a run admitted in the lead's second are not its helpers");
  assert.deepEqual([byId.R36.lead, byId.R36.chief], ["R20", "C1"], "a running helper with no chief belongs to its task's lead, and shows and counts under the lead's chief");
  assert.deepEqual([byId.R38.look, byId.R38.why], [true, "no agent started within 10 minutes of its admission"], "a failed run shows its reason from the logbook");
  assert.equal(byId.R20.endedHelpers, 1300, "the lead knows how many ended helpers it has");
  assert.equal(book.runs.filter(run => run.lead === "R20" && run.status === "done").length, 20, "only the last 20 ended helpers travel to the page");
  const log = taskPanel(model, KEY("T40")).log;
  assert.deepEqual(log.filter(event => event.who === "R38").map(event => event.text), ["qa ended: stopped · failed", "qa admitted from the queue, but its agent did not start"], "a lapsed admission never says started");
  assert.deepEqual(log.filter(event => event.who === "R39").map(event => event.text), ["code-reviewer ended: done", "code-reviewer started after its place in the queue"]);
});

const claudeSource = (tables, more = []) => ({ id: "claude", label: "claude", provider: null, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
  projects: [{ key: "claude/sample-app-abc123", source: "claude", name: "sample-app-abc123", checkout: "/sample/app", diagnostics: [], warnings: [], tables, observations: { version: 1, records: [] } }, ...more] });

test("T1080 (F-T1080-4): the model gives a task with no route no steps, so the chat board lists none either", () => {
  const tables = appTables(NOW);
  tables.tasks.find(task => task.id === "T2").route = "";
  const model = buildBoardModel([claudeSource(tables)], { now: NOW }), task = model.tasks.find(item => item.id === "T2");
  assert.deepEqual([task.loop.steps, task.loop.next], [[], null]);
  assert.doesNotMatch(renderTaskText(task), /Plan|Build|Merge|Evidence review/, "no step names in the chat board's task text");
  assert.match(renderTaskText(model.tasks.find(item => item.id === "T3")), /Plan/, "a task with a route keeps its steps");
});

test("T1080 (F-T1080-3): the panel gives the question, the recommendation and the next step as separate lines, and does not repeat a step's own line", t => {
  const model = modelOf(world(t).sources), waiting = taskPanel(model, KEY("T30"));
  assert.deepEqual(waiting.now, ["Crash reports: send them on their own, or ask each time?", "I recommend: A: ask each time"]);
  assert.ok(waiting.next, "the next step is its own field");
  const merged = taskPanel(model, KEY("T1"));
  assert.equal(merged.steps.at(-1).detail, "Merged.");
  assert.deepEqual(merged.now, [], "\"Merged.\" shows once, in the Merge step");
});

test("T1080 (F-T1080-11, F-T1080-16): a task of an old logbook is marked old and read-only, and its unanswered gate waits for no one", () => {
  const old = appTables(NOW);
  old.tasks = [{ ...old.tasks.find(task => task.id === "T1"), id: "T5", title: "Sample old finished task" }, { ...old.tasks.find(task => task.id === "T2"), id: "T6", title: "Sample old open task" }];
  old.gates = [{ id: "G7", task: "T5", question: "Sample old question?", options: "A|B", recommendation: "A", default: "", answer: "", at: NOW }];
  const model = buildBoardModel([claudeSource(appTables(NOW), [{ key: "claude/sample-app-old", source: "claude", name: "sample-app-old", old: { provider: "codex", of: "claude/sample-app-abc123" },
    checkout: null, diagnostics: [], warnings: [], tables: old, observations: { version: 1, records: [] } }])], { now: NOW });
  const rows = boardOverview(model).tasks, row = key => rows.find(task => task.key === key);
  assert.deepEqual(row("claude/sample-app-old/T6").chief, { id: null, provider: "Codex", stopped: null, old: "Old · Codex · read-only" });
  assert.equal(row("claude/sample-app-abc123/T2").chief.old, undefined, "a live task is not marked old");
  assert.deepEqual(taskPanel(model, "claude/sample-app-old/T5").decisions.map(gate => [gate.id, gate.answer, gate.waits]), [["G7", null, false]], "the model counts no need for it, so the panel does not call it open");
  assert.deepEqual(taskPanel(model, "claude/sample-app-abc123/T10").decisions.find(gate => gate.id === "G4").waits, true, "an open gate of a live task waits for the owner");
});

test("T1080 (F-T1080-10, F-T1080-18): the panel lists a kept report of nearly 1 MiB of text, and says how many brief and report files it leaves out", async t => {
  const w = world(t), text = `STATUS        done\nRESULT        CLEAN. A long report.\nEVIDENCE      ${"\"quoted\" ".repeat(110_000)}\n`;
  assert.ok(Buffer.byteLength(text) < 1 << 20, "the state tool keeps text of at most 1 MiB");
  writeFileSync(join(w.logbook, "kept", "R6.json"), JSON.stringify({ task: "T3", run: "R6", role: "qa", sha: "", text, at: NOW }));
  assert.ok(readFileSync(join(w.logbook, "kept", "R6.json")).length > 1 << 20, "its JSON file is over 1 MiB");
  for (let i = 0; i < 103; i++) writeFileSync(join(w.logbook, "briefs", `sage_qa_t3_r6_${String(i).padStart(3, "0")}.json`), "{}");
  const panel = await (await fetch(`${await serve(t, w.sources)}/app/task/${b64(KEY("T3"))}`)).json();
  assert.deepEqual(panel.files.kept.map(item => [item.run, item.result]), [["R5", "CLEAN. The limits change is correct."], ["R6", "CLEAN. A long report."]]);
  assert.deepEqual([panel.files.briefs.length, panel.files.unlisted], [100, { briefs: 4, reports: 0 }], "104 brief files: 100 listed, 4 counted");
});

test("T1083: /app/task/<key> gives the task page its parts: your request, the milestone's count, the tasks before and after, the brief's goal, criteria and budget, and the cost", async t => {
  const w = world(t, { agents: true, about: true }), base = await serve(t, w.sources);
  const page = await (await fetch(`${base}/app/task/${b64(KEY("T2"))}`)).json();
  assert.equal(page.request, ABOUT.request);
  assert.deepEqual(page.progress, { goal: "One board for every chief", merged: 1, total: 4, abandoned: 0 }, "M1 has T1 to T4, and T1 is merged");
  assert.deepEqual(page.before.map(item => [item.id, item.title, item.word]), [["T1", "Sample pinned bundle", "done"]], "T2 waits for T1");
  assert.deepEqual(page.after.map(item => [item.id, item.title]), [["T4", "Sample queue"]], "T4 waits for T2, so T2 is needed by T4");
  assert.deepEqual([page.brief.state, page.brief.run, page.brief.goal], ["kept", "R20", ABOUT.goal], "the goal comes from the lead's brief");
  assert.deepEqual(page.brief.criteria, [{ text: ABOUT.criteria[0], by: "R45" }, { text: ABOUT.criteria[1], by: null }, { text: ABOUT.criteria[2], by: null }], "a line is met only when a passing QA or review report names it");
  assert.deepEqual([page.brief.budget.ms, page.brief.budget.tokens], [2 * 3_600_000, 1_500_000], "About 2 hours of agent time and 1.5 M tokens");
  assert.equal(page.cost.runs, page.runs.length);
  assert.ok(page.cost.tokens >= 30_000 + 210_000, "the tokens of R21 and R45 count");
  const other = await (await fetch(`${base}/app/task/${b64(KEY("T40"))}`)).json();
  assert.deepEqual([other.request, other.brief.state, other.brief.run], [null, "missing", "R25"], "no request; the lead R25's brief is not kept");
  assert.match(other.brief.why, /^The logbook keeps no brief of R25/);
  const none = await (await fetch(`${base}/app/task/${b64(KEY("T4"))}`)).json();
  assert.deepEqual([none.brief.state, none.brief.why, none.cost.runs], ["none", "No agent has run on this task yet, so there is no brief.", 0]);
});

test("T1083: a failing or unnamed report meets no line, and a brief that the board cannot read says so", async t => {
  const w = world(t, { agents: true, about: true });
  writeFileSync(join(w.logbook, "kept", "R45.json"), JSON.stringify({ task: "T2", run: "R45", role: "qa", sha: "", at: NOW, text: `STATUS done\nRESULT FAIL. ${ABOUT.criteria[0]}: it failed.\nFINDINGS\n- F1 medium it fails` }));
  const base = await serve(t, w.sources), read = async () => (await (await fetch(`${base}/app/task/${b64(KEY("T2"))}`)).json()).brief;
  assert.deepEqual((await read()).criteria.map(line => line.by), [null, null, null], "a FAIL report names the line, but meets nothing");
  rmSync(join(w.logbook, "briefs", "R20.md")); mkdirSync(join(w.logbook, "briefs", "R20.md"));
  const brief = await read();
  assert.deepEqual([brief.state, brief.run], ["unread", "R20"]);
  assert.match(brief.why, /^The board cannot read the brief of R20 now\. It is a folder, not a file\./);
});

test("T1083 (F-T1083-2): a passing report meets a line only in its RESULT or EVIDENCE, never under NOT VERIFIED or QUESTIONS", async t => {
  const w = world(t, { agents: true, about: true }), kept = text => writeFileSync(join(w.logbook, "kept", "R45.json"), JSON.stringify({ task: "T2", run: "R45", role: "qa", sha: "", at: NOW, text }));
  const base = await serve(t, w.sources), read = async () => (await (await fetch(`${base}/app/task/${b64(KEY("T2"))}`)).json()).brief.criteria.map(line => line.by);
  kept(`STATUS done\nRESULT CLEAN\nEVIDENCE none\nFINDINGS none\nQUESTIONS ${ABOUT.criteria[1]}?\nNOT VERIFIED ${ABOUT.criteria[0]}: no browser was available.\nBRANCH none`);
  assert.deepEqual(await read(), [null, null, null], "lines named only under NOT VERIFIED or QUESTIONS are not checked yet");
  kept(`STATUS done\nRESULT CLEAN\nEVIDENCE checked:\n  ${ABOUT.criteria[1]}\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED none\nBRANCH none`);
  assert.deepEqual(await read(), [null, "R45", null], "a line under EVIDENCE is met");
});

test("T1083 (F-T1083-4): a budget reads thousands separators and k or M before tokens", () => {
  for (const [text, tokens] of [["About 1 hour and 1,000,000 tokens.", 1_000_000], ["7 M tokens", 7_000_000], ["400 k tokens", 400_000], ["1.5 M tokens", 1_500_000], ["12,000 tokens", 12_000]]) assert.equal(budgetOf(text).tokens, tokens, text);
  assert.equal(budgetOf("About 1 hour and 1,000,000 tokens.").ms, 3_600_000);
});
