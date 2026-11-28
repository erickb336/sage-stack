import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readBoardSources, readHookNotes } from "../packages/sage-core/board-reader.mjs";
import { agentCaps } from "../packages/sage-core/logbook-fields.mjs";
import { taskPanel } from "../packages/sage-core/board-overview.mjs";
import { renderBoardText, renderTaskText } from "../packages/sage-core/board-render.mjs";

const NOW = "2026-10-18T12:00:00.000Z", at = Date.parse(NOW);
const ago = minutes => at - minutes * 60_000;
const iso = minutes => new Date(ago(minutes)).toISOString();
const sha256 = text => createHash("sha256").update(text).digest("hex");
const task = (id, title = `Sample task ${id}`) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state: "building", branch: "", pr: "", round: "0", keys: "", priority: "P1", kind: "ui" });
const run = (id, role, started, extra = {}) => ({ id, task: "T1", role, round: "0", status: "running", started: iso(started), ended: "", model: "", ...extra });
const ended = (id, role, minutes) => ({ id, task: "T1", role, round: "0", status: "done", started: iso(1000 + minutes), ended: iso(1000) });
const book = (name, runs, extra = {}) => ({ key: `claude/${name}`, source: "claude", name, logbook: sha256(name), diagnostics: [], warnings: [], tables: { tasks: [task("T1")], runs }, observations: { version: 1, records: [] }, ...extra });
const slot = (name, marks, idle) => ({ name, marks: [...marks, "ok"], at: ago(idle) });
const claude = (books, slots = [], { helpers = [], present = true, problem = null, config = {} } = {}) => ({ id: "claude", label: "Claude", provider: "claude", config, diagnostics: [], projects: books, hooks: { present, slots, helpers, problem } });
const agents = (...sources) => buildBoardModel(sources, { now: NOW }).agents;
const rows = model => model.projects.flatMap(project => project.agents.flatMap(agent => [agent, ...agent.children]));
const flagOf = agent => agent.flag ? `${agent.flag.level} ${agent.flag.text}` : "none";
const brief = agent => `${agent.runId ?? "-"} ${agent.state} ${flagOf(agent)}${agent.lead ? ` under ${agent.lead}` : ""}`;
const implementerSlot = (name, id, idle, project = "sample") => slot(name, [`project-${project}`, "role-sage_implementer", `run-${id}`], idle);
const LOOK = "amber Look at it", STOPPED = "red Stopped without a report";

test("T308, T1224: a slot joins its run by the run mark; a run that no slot holds gets Look at it, and a slot with no run gets no flag", () => {
  const model = agents(claude([book("sample-abcdef", [run("R1", "implementer", 10), run("R2", "qa", 90)])], [
    slot("slot-1", ["project-sample", "role-sage_implementer", "run-R1"], 2),
    slot("slot-2", ["project-sample", "role-sage_designer"], 3),
    slot("slot-3", ["project-other", "role-sage_qa", "run-R2"], 1),
    { name: "slot-4", marks: ["project-sample", "role-sage_qa", "run-R2"], at: ago(1) },
  ]));
  const list = rows(model);
  assert.deepEqual(list.map(agent => [agent.runId, agent.role, agent.task?.title ?? null, agent.state, flagOf(agent)]), [
    ["R2", "qa", "Sample task T1", "work", LOOK],
    ["R1", "implementer", "Sample task T1", "work", "none"],
    [null, "designer", null, "work", "none"],
    ["R2", "qa", null, "work", "none"],
  ]);
  assert.equal(list.find(agent => agent.runId === "R2" && agent.task).why, "no agent slot holds this run: the hook frees a slot after 60 min with no activity. Ask the chief to check the run.");
  assert.deepEqual(model.unmatched, [{ run: "R2", project: "sample" }]);
  assert.deepEqual([model.count, model.look, model.projects[0].look], [4, 1, 1]);
  assert.deepEqual(model.projects.map(project => project.name), ["sample", "other"], "the project with a flag first");
});

test("T1224: Look at it needs two true facts, no note for 15 min and past the step's usual top length; each fact alone gives no flag", () => {
  const history = [10, 10, 10, 20, 30].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes));
  const model = agents(claude([book("sample-abcdef", [...history, run("R1", "implementer", 60), run("R2", "implementer", 60), run("R5", "implementer", 20), run("R6", "implementer", 60)])], [
    implementerSlot("slot-1", "R1", 14), implementerSlot("slot-2", "R2", 15), implementerSlot("slot-5", "R5", 16), implementerSlot("slot-6", "R6", 2),
  ]));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([flagOf(byRun.R2), byRun.R2.why], [LOOK, "no note for 15 min, and past 30 min, the usual top length of an implementer run here"], "both facts: quiet 15 min and 60 min past 30 min");
  assert.equal(flagOf(byRun.R1), "none", "past the usual length, but a note 14 min ago");
  assert.equal(flagOf(byRun.R5), "none", "quiet 16 min, but 20 min is not past the usual 30 min");
  assert.equal(flagOf(byRun.R6), "none", "past the usual length, but a note 2 min ago");
  assert.equal(model.look, 1);
  assert.equal(model.next, ago(14) + 15 * 60_000, "the board reads again when R1's quiet reaches 15 min");
});

test("T1224: a lead whose helper runs waits with no flag; a quiet lead alone has no usual length, so no flag", () => {
  const lead = sha256("lead agent");
  const model = agents(claude([book("sample-abcdef", [run("R3", "lead", 120), run("R4", "qa", 40)])], [
    slot("slot-3", ["project-sample", "role-sage_lead", "run-R3", `bound-${lead}`], 45),
    slot("slot-4", ["project-sample", "role-sage_qa", "run-R4", `parent-${lead}`], 5),
  ]));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([byRun.R3.state, flagOf(byRun.R3), byRun.R3.why], ["wait", "none", "1 of 1 helper working"]);
  assert.equal(byRun.R4.lead, "R3");
  const alone = agents(claude([book("sample-abcdef", [run("R3", "lead", 120)])], [slot("slot-3", ["project-sample", "role-sage_lead", "run-R3", `bound-${lead}`], 45)]));
  assert.deepEqual(rows(alone).map(brief), ["R3 work none"]);
});

test("T1224: fewer than 5 done runs of the step give no usual length, so no amber; failed runs do not count", () => {
  const four = [10, 10, 10, 20].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes));
  const failed = { ...ended("R19", "implementer", 5), status: "failed" };
  const model = agents(claude([book("sample-abcdef", [...four, failed, run("R1", "implementer", 300)])], [implementerSlot("slot-1", "R1", 120)]));
  assert.deepEqual(rows(model).map(brief), ["R1 work none"], "4 done runs and 1 failed run: no usual length");
  const five = agents(claude([book("sample-abcdef", [...four, ended("R18", "implementer", 20), run("R1", "implementer", 300)])], [implementerSlot("slot-1", "R1", 120)]));
  assert.deepEqual(rows(five).map(brief), [`R1 work ${LOOK}`], "the fifth done run gives the usual length");
});

test("T1224: the usual top length is the 90th percentile of done runs, for each step in each project", () => {
  const tens = (role, first, step = 10) => Array.from({ length: 10 }, (_, i) => ({ ...ended(`R${first + i}`, role, step * (i + 1)), role }));
  const sample = book("sample-abcdef", [...tens("implementer", 10), ...tens("qa", 30, 100), run("R1", "implementer", 91), run("R2", "implementer", 89), run("R3", "qa", 200)]);
  const other = { ...book("other-abcdef", [...tens("implementer", 50, 30), run("R4", "implementer", 200)]), key: "claude/other-abcdef" };
  const model = agents(claude([sample, other], [implementerSlot("slot-1", "R1", 20), implementerSlot("slot-2", "R2", 20), slot("slot-3", ["project-sample", "role-sage_qa", "run-R3"], 20), implementerSlot("slot-4", "R4", 20, "other")]));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([flagOf(byRun.R1), byRun.R1.why], [LOOK, "no note for 20 min, and past 1 h 30 min, the usual top length of an implementer run here"], "9 of the 10 implementer runs took 90 min or less");
  assert.equal(flagOf(byRun.R2), "none", "89 min is not past 90 min");
  assert.equal(flagOf(byRun.R3), "none", "the qa step has its own usual length, 900 min");
  assert.equal(flagOf(byRun.R4), "none", "the other project has its own usual length for implementers, 270 min");
});

test("T308, T1224: a helper whose process ended with no report, while the logbook still says running, is Stopped without a report", () => {
  const b = book("sample-abcdef", [run("R3", "lead", 120), run("R4", "ux-reviewer", 40), run("R5", "qa", 40), run("R6", "qa", 40)]);
  const key = sha256(`${b.logbook}:R3`);
  const model = agents(claude([b], [slot("slot-1", ["project-sample", "role-sage_lead", "run-R3", `logbook-${b.logbook}`, "bound-" + sha256("x")], 1)], { helpers: [
    { lead: key, run: "R4", stopped: false, at: null }, { lead: key, run: "R4", stopped: true, at: Date.parse("2026-10-18T11:46:00Z") },
    { lead: key, run: "R5", stopped: false, at: null },
    { lead: sha256("another lead"), run: "R6", stopped: true, at: ago(5) },
  ] }));
  assert.deepEqual(rows(model).map(brief), [`R6 work ${LOOK}`, "R3 work none", `R4 work ${STOPPED} under R3`, `R5 work ${LOOK} under R3`]);
  assert.equal(rows(model).find(agent => agent.runId === "R4").why, "its process ended at 11:46 UTC with no report; the logbook still says running");
});

test("T308, T1224: Codex agents come from the logbook only and say Codex: activity unknown, never Look at it, even with no news for a day", () => {
  const history = [10, 10, 10, 20, 30].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes));
  const codex = { id: "codex", label: "Codex", provider: "codex", config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null },
    projects: [{ ...book("sample-abcdef", [...history, run("R7", "implementer", 12)]), key: "codex/sample-abcdef", source: "codex" }, { ...book("solo-abcdef", [...history.map(row => ({ ...row, task: "T2" })), run("R8", "implementer", 3000)]), key: "codex/solo-abcdef", source: "codex" }] };
  const model = agents(claude([book("sample-abcdef", [run("R1", "qa", 5)])], [slot("slot-1", ["project-sample", "role-sage_qa", "run-R1"], 1)], { config: { max_agents: "3" } }), codex);
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([byRun.R7.provider, byRun.R7.state, flagOf(byRun.R7), byRun.R7.why], ["codex", "work", "calm Codex: activity unknown", "Codex sends no activity notes yet"]);
  assert.deepEqual([flagOf(byRun.R8), byRun.R8.why], ["calm Codex: activity unknown", "Codex sends no activity notes yet; no news since 16 Oct"], "50 h with no logbook change, past the usual length: still no amber");
  assert.equal(model.look, 0, "a Codex row never counts as flagged");
  assert.deepEqual(model.providers, [{ name: "Claude", count: 1 }, { name: "Codex", count: 2 }]);
  assert.deepEqual(model.projects.map(project => project.name), ["sample", "solo"]);
});

test("T1224: a Claude run with no news for a day gets Look at it; a hook note in the last day keeps it calm", () => {
  const model = agents(claude([book("sample-abcdef", [run("R1", "qa", 1500), run("R2", "qa", 1500)])], [slot("slot-1", ["project-sample", "role-sage_qa", "run-R1"], 1440), slot("slot-2", ["project-sample", "role-sage_qa", "run-R2"], 60)]));
  const byRun = Object.fromEntries(rows(model).map(agent => [agent.runId, agent]));
  assert.deepEqual([flagOf(byRun.R1), byRun.R1.why], [LOOK, "no news since 17 Oct, so ask the chief to check it"]);
  assert.equal(flagOf(byRun.R2), "none", "a note 60 min ago is news");
});

test("T1224 (F-T1224-7): a run with no logbook change for a day but a fresh hook note is calm on the step, the chat task card and the chat board too", () => {
  const model = buildBoardModel([claude([book("sample-abcdef", [run("R2", "qa", 1500)])], [slot("slot-2", ["project-sample", "role-sage_qa", "run-R2"], 60)])], { now: NOW });
  const card = model.tasks[0], plain = text => text.replace(/\\/g, "");
  assert.equal(flagOf(rows(model.agents)[0]), "none", "the Agents row is calm");
  assert.deepEqual([card.loop.steps[1].status, card.loop.steps[1].detail], ["run", "The QA agent (run R2) is at work. It started on 17 Oct."]);
  assert.doesNotMatch(plain(renderTaskText(card)), /no news|ask the chief/, "the chat task card");
  assert.ok(plain(renderBoardText(model)).includes("▶ Sample task T1: in the build, 1 agent at work, since 17 Oct."), "the chat board's line");
});

test("T308, T1224: unreadable hook notes show every Claude run from the logbook, with no flag: the board cannot tell", () => {
  const model = agents(claude([book("sample-abcdef", [run("R1", "qa", 5)])], [], { problem: "EACCES" }));
  assert.deepEqual(rows(model).map(agent => [agent.runId, agent.state, flagOf(agent), agent.why]), [["R1", "work", "none", ""]]);
  assert.deepEqual(model.problems, [{ source: "claude", message: "its folder has no read permission" }]);
  assert.deepEqual(model.unmatched, []);
  assert.equal(model.look, 0);
});

test("T1224 (F-T1224-2, F-T1224-4): the step line, the task page steps, the chat task card and the chat board show the Agents row's flag for the same run", () => {
  const history = [10, 10, 10, 20, 30].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes));
  const b = book("sample-abcdef", [...history, run("R1", "implementer", 60), run("R2", "designer", 30, { task: "T2" }), run("R3", "lead", 120, { task: "T3" }), run("R4", "qa", 40, { task: "T3" })]);
  b.tables.tasks = ["T1", "T2", "T3"].map(id => task(id));
  const lead = sha256(`${b.logbook}:R3`);
  const model = buildBoardModel([claude([b], [implementerSlot("slot-1", "R1", 20), slot("slot-3", ["project-sample", "role-sage_lead", "run-R3", `logbook-${b.logbook}`, `bound-${sha256("x")}`], 1)],
    { helpers: [{ lead, run: "R4", stopped: false, at: null }, { lead, run: "R4", stopped: true, at: Date.parse("2026-10-18T11:46:00Z") }] })], { now: NOW });
  const plain = text => text.replace(/\\/g, "");
  const chat = plain(renderBoardText(model));
  const cases = [
    ["T1", "R1", "stale", LOOK, "Look at it. For the implementer (run R1), no note for 20 min, and past 30 min, the usual top length of an implementer run here."],
    ["T2", "R2", "stale", LOOK, "Look at it. For the designer (run R2), no agent slot holds this run: the hook frees a slot after 60 min with no activity. Ask the chief to check the run."],
    ["T3", "R4", "lost", STOPPED, "The lead is at work on the build. Stopped without a report. For the QA agent (run R4), its process ended at 11:46 UTC with no report; the logbook still says running."],
  ];
  for (const [id, runId, status, flag, now] of cases) {
    const card = model.tasks.find(item => item.id === id), row = rows(model.agents).find(agent => agent.runId === runId), text = flag.replace(/^\w+ /, "");
    assert.equal(flagOf(row), flag, `${runId}: the Agents row`);
    assert.deepEqual(card.runs.find(item => item.id === runId).flag, row.flag, `${runId}: the card's run has the row's flag`);
    assert.deepEqual([card.loop.steps[1].status, card.loop.now.text], [status, now], `${id}: the step line`);
    const panel = taskPanel(model, card.key);
    assert.deepEqual([panel.steps[1].status, panel.runs.find(item => item.id === runId).flag?.text], [status, text], `${id}: the task page steps`);
    const taskText = plain(renderTaskText(card));
    assert.ok(taskText.includes(`Now: ${now}`), `${id}: the chat task card's Now line`);
    assert.match(taskText, new RegExp(`\\n! Build: in progress · ${text} · `), `${id}: the chat task card's step`);
    assert.match(taskText, new RegExp(`\\n${runId} .* · in progress · ${text} · `), `${id}: the chat task card's run`);
    assert.ok(new RegExp(`\\n- ▶ Sample task ${id}: in the build, \\d agents? at work, ${text} \\(run ${runId}\\)\\.\\n`).test(chat), `${id}: the chat board's line`);
  }
});

test("T1224 (F-T1224-5): a done run with no start, no end, a start that is not a time, or an end before its start counts for no usual length", () => {
  const five = [10, 10, 10, 20, 30].map((minutes, i) => ended(`R${10 + i}`, "implementer", minutes));
  const bad = [{ started: "" }, { ended: "" }, { started: "not a time" }, { started: iso(500), ended: iso(1000) }].map((change, i) => ({ ...ended(`R${20 + i}`, "implementer", 10), ...change }));
  const model = agents(claude([book("sample-abcdef", [...five, ...bad, run("R1", "implementer", 60)])], [implementerSlot("slot-1", "R1", 20)]));
  assert.deepEqual([flagOf(rows(model)[0]), rows(model)[0].why], [LOOK, "no note for 20 min, and past 30 min, the usual top length of an implementer run here"], "the 5 good runs give the usual length; the bad ones change nothing");
  const fewer = agents(claude([book("sample-abcdef", [...five.slice(1), ...bad, run("R1", "implementer", 60)])], [implementerSlot("slot-1", "R1", 20)]));
  assert.equal(flagOf(rows(fewer)[0]), "none", "4 good runs and 4 bad ones: fewer than 5 done runs, so no usual length");
});

test("T1224: a run of an old logbook has no Agents row, so its step and the chat take the flag from its logbook alone: Look at it after a day with no news", () => {
  const old = { ...book("sample-abcdef", [run("R1", "implementer", 4000)], { old: { provider: "claude", of: "shared/sample-abcdef" } }), key: "old-claude/sample-abcdef" };
  const shared = { id: "shared", label: "Shared", shared: true, config: {}, diagnostics: [], hooks: { present: false, slots: [], helpers: [], problem: null }, projects: [{ ...book("sample-abcdef", []), key: "shared/sample-abcdef", source: "shared", shared: true, tables: { tasks: [] } }, old] };
  const model = buildBoardModel([shared, claude([])], { now: NOW }), card = model.tasks.find(item => item.key === "old-claude/sample-abcdef/T1");
  assert.deepEqual([model.agents.count, card.runs[0].flag?.text, card.loop.steps[1].status, card.loop.now.text], [0, "Look at it", "stale", "Look at it. For the implementer (run R1), no news since 15 Oct, so ask the chief to check it."]);
  assert.match(renderTaskText(card).replace(/\\/g, ""), /\nR1 .* · in progress · Look at it · /);
});

test("T1224: no built plugin copy, guide or skill names an old agent word beside the one flag", () => {
  const OLD = /may be stuck|running long|run still open|no logbook write for|usual for an? [a-z-]+ here is about/;
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(mjs|js|jsx|md|json|css|html)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const root = fileURLToPath(new URL("..", import.meta.url)), files = ["plugins/sage", "plugins/sage-codex", "packages", "docs"].flatMap(dir => walk(join(root, dir)));
  assert.ok(files.some(file => /plugins\/sage\/board\/app\/app-[A-Z0-9]+\.js$/.test(file)), "the built board app is read");
  assert.deepEqual(files.filter(file => OLD.test(readFileSync(file, "utf8"))).map(file => relative(root, file)), []);
});

test("T308: the caps are the hook's: cap.<project>, else max_agents, and cap_total, read as the state tool reads a count", () => {
  assert.deepEqual([agentCaps({}).cap("x"), agentCaps({}).total], [10, 20]);
  const caps = agentCaps({ max_agents: "2.9", "cap.sage": 6, cap_total: "0", "cap.bad": "many" });
  assert.deepEqual([caps.cap("sage"), caps.cap("other"), caps.cap("bad"), caps.total], [6, 2, 2, 1]);
  assert.equal(agentCaps({ cap_total: 900 }).total, 50);
});

test("T308: the reader takes slot marks and times, helper notes by name only, and refuses a link", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readHookNotes(dir), { present: false, slots: [], helpers: [], problem: null });
  const slotDir = join(dir, ".hooks", "slots", "slot-1"), helpers = join(dir, ".hooks", "helpers"), lead = "a".repeat(64);
  mkdirSync(slotDir, { recursive: true }); mkdirSync(helpers);
  for (const mark of ["ok", "run-R3", "project-sample"]) writeFileSync(join(slotDir, mark), "");
  mkdirSync(join(dir, ".hooks", "slots", "not-a-slot"));
  utimesSync(slotDir, new Date(ago(7)), new Date(ago(7)));
  for (const name of [`started-${lead}.R4`, `stopped-${lead}.R4`, `owned-${lead}.R4`, "stopped-short.R4"]) writeFileSync(join(helpers, name), "secret report text");
  utimesSync(join(helpers, `stopped-${lead}.R4`), new Date(ago(3)), new Date(ago(3)));
  const notes = readHookNotes(dir);
  assert.deepEqual(notes.slots, [{ name: "slot-1", marks: ["ok", "project-sample", "run-R3"], at: ago(7) }]);
  assert.deepEqual(notes.helpers.sort((a, b) => a.stopped - b.stopped), [{ lead, run: "R4", stopped: false, at: null }, { lead, run: "R4", stopped: true, at: ago(3) }]);
  assert.ok(!JSON.stringify(notes).includes("secret"), "no note's content is read");
  const linked = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-agents-link-"));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  mkdirSync(join(linked, ".hooks")); symlinkSync(join(dir, ".hooks", "slots"), join(linked, ".hooks", "slots"));
  assert.deepEqual(readHookNotes(linked), { present: false, slots: [], helpers: [], problem: "ELOOP" });
  mkdirSync(join(dir, "sample-abcdef"));
  const [source] = readBoardSources([{ id: "claude", path: dir }], { now: at });
  assert.equal(source.hooks.slots.length, 1);
  assert.equal(source.projects[0].logbook, sha256(join(dir, "sample-abcdef")));
});

