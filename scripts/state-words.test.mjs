import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel, milestoneWord, releaseWord, renderBoardText, renderTaskText, taskWord } from "../packages/sage-core/index.mjs";
import { FLAGS, KINDS, MARKS as MARKS_TABLE, OBJECTS, STEPS, URGENCY, WORDS, chiefName, milestoneSentence, prName, runWord, shown, taskSentence } from "../packages/sage-core/state-words.mjs";
import * as words from "../packages/sage-core/state-words.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { NOW as MILESTONES_NOW, milestonesSource } from "./fixtures/board-milestones.mjs";

const SIX = ["not started", "waiting", "needs you", "in progress", "done", "stopped"];
const ROOT = join(import.meta.dirname, ".."), { buildSync } = createRequire(import.meta.url)("esbuild");
const now = "2026-10-08T20:00:00.000Z", head = "a".repeat(40);
const task = (id, state, extra = {}) => ({ id, title: "Sample", size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });
const observation = (kind, data) => ({ id: "O1", task: "T1", kind, source: "sample recorder", basis: "observed", observedAt: now, recordedAt: now, data });
const gate = (answer = "") => ({ id: "G1", task: "T1", question: "Sample: which layout?", recommendation: "the first", answer });
const clean = ["checks-pass", "review-clean", "qa-pass"].map(kind => ({ task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now }));
const autopilot = on => [observation("pr", { number: 41, head, state: "open" }), observation("mode", { autopilot: on })];
const failed = kind => [...clean, { task: "T1", pr: "41", sha: head, kind, cycle: "1", at: now }];
const passes = () => ({ ok: true, reason: "" });
const refuses = () => ({ ok: false, reason: "T1 has open findings: F-T1-1. Fix them." });
const model = ({ row, others = [], gates = [], ledger = [], records = [], landing = passes }) =>
  buildBoardModel([{ id: "one", label: "one", diagnostics: [], config: {}, projects: [{ key: "one/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [row, ...others], gates, ledger }, observations: { version: 1, records } }] }], { now, landing });

const CASES = [
  ["framed: no agent works on it", { row: task("T1", "framed") }, "not started"],
  ["framed with an unmet wait", { row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "building")] }, "waiting"],
  ["framed with a wait that is never met: it cannot start", { row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "abandoned")] }, "waiting"],
  ["designing", { row: task("T1", "designing") }, "in progress"],
  ["PE: designing with an unmet wait", { row: task("T1", "designing", { waits: "T2" }), others: [task("T2", "building")] }, "in progress"],
  ["awaiting-you with no gate", { row: task("T1", "awaiting-you") }, "needs you"],
  ["awaiting-you with an open gate", { row: task("T1", "awaiting-you"), gates: [gate()] }, "needs you"],
  ["F2: awaiting-you after the owner answered", { row: task("T1", "awaiting-you"), gates: [gate("the first")] }, "in progress"],
  ["briefed", { row: task("T1", "briefed") }, "in progress"],
  ["F3: briefed with an unmet wait", { row: task("T1", "briefed", { waits: "T2" }), others: [task("T2", "reviewing")] }, "waiting"],
  ["building", { row: task("T1", "building") }, "in progress"],
  ["F4: held by the chief, no open gate", { row: task("T1", "held") }, "in progress"],
  ["F4: held after repair rounds, no open gate yet", { row: task("T1", "held", { hold: "round", round: "3" }) }, "in progress"],
  ["F4: held after repair rounds, with an open gate", { row: task("T1", "held", { hold: "round", round: "3" }), gates: [gate()] }, "needs you"],
  ["reviewing", { row: task("T1", "reviewing", { pr: "41" }) }, "in progress"],
  ["repairing", { row: task("T1", "repairing", { pr: "41" }) }, "in progress"],
  ["replan with no open gate", { row: task("T1", "replan") }, "in progress"],
  ["replan with an open gate", { row: task("T1", "replan"), gates: [gate()] }, "needs you"],
  ["verifying", { row: task("T1", "verifying", { pr: "41" }) }, "in progress"],
  ["verified, autopilot on", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(true) }, "in progress"],
  ["PE: verified, autopilot off", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false) }, "needs you"],
  ["PE: verified, autopilot unknown", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(true).slice(0, 1) }, "needs you"],
  ["pr-ready, autopilot on", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(true) }, "in progress"],
  ["PE: pr-ready, autopilot off", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(false) }, "needs you"],
  ["F5: verified, the merge check refuses the head", { row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false), landing: refuses }, "in progress"],
  ["F5: pr-ready, the merge check refuses the head", { row: task("T1", "pr-ready", { pr: "41" }), ledger: clean, records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: verified, refused, QA failed, autopilot on", { row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: verified, refused, QA failed, autopilot off", { row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(false), landing: refuses }, "in progress"],
  ["F5: pr-ready, refused, checks failed, autopilot on", { row: task("T1", "pr-ready", { pr: "41" }), ledger: failed("checks-fail"), records: autopilot(true), landing: refuses }, "in progress"],
  ["F5: pr-ready, refused, checks failed, autopilot off", { row: task("T1", "pr-ready", { pr: "41" }), ledger: failed("checks-fail"), records: autopilot(false), landing: refuses }, "in progress"],
  ["verified with no build: the chief concludes it", { row: task("T1", "verified", { route: "investigate,evidence-review" }) }, "in progress"],
  ["merged", { row: task("T1", "merged", { pr: "41" }) }, "done"],
  ["concluded", { row: task("T1", "concluded", { route: "investigate,evidence-review" }) }, "done"],
  ["abandoned", { row: task("T1", "abandoned") }, "stopped"],
  ["an open gate on any state that has not ended", { row: task("T1", "building"), gates: [gate()] }, "needs you"],
  ["a done task with an open gate keeps its word", { row: task("T1", "merged", { pr: "41" }), gates: [gate()], records: [observation("completion", { state: "merged", at: now })] }, "done"],
  ["a stopped task with an open gate keeps its word", { row: task("T1", "abandoned"), gates: [gate()] }, "stopped"],
];
const cardOf = fixture => model(fixture).tasks.find(card => card.id === "T1");

const SENTENCES = {
  "framed: no agent works on it": ["○", "not started", null],
  "framed with an unmet wait": ["⧗", "waits for T2", null],
  "framed with a wait that is never met: it cannot start": ["⊘", "cannot start, because T2 was abandoned", null],
  "designing": ["⧗", "in design", null],
  "PE: designing with an unmet wait": ["⧗", "in design", null],
  "awaiting-you with no gate": ["?", "in design", "Needs your answer on the design."],
  "awaiting-you with an open gate": ["?", "in design", "Needs your answer."],
  "F2: awaiting-you after the owner answered": ["⧗", "you answered; the chief moves it on", null],
  "briefed": ["⧗", "the build starts next", null],
  "F3: briefed with an unmet wait": ["⧗", "waits for T2", null],
  "building": ["⧗", "in the build", null],
  "F4: held by the chief, no open gate": ["⧗", "held by the chief", null],
  "F4: held after repair rounds, no open gate yet": ["⧗", "held by the chief", null],
  "F4: held after repair rounds, with an open gate": ["?", "held by the chief", "Needs your answer."],
  "reviewing": ["⧗", "built, in review", null],
  "repairing": ["⧗", "built, in repair round 1 of 3", null],
  "replan with no open gate": ["⧗", "the chief makes a new plan", null],
  "replan with an open gate": ["?", "the chief makes a new plan", "Needs your answer."],
  "verifying": ["⧗", "the last checks before the merge", null],
  "verified, autopilot on": ["⧗", "ready to merge", null],
  "PE: verified, autopilot off": ["?", "ready to merge", "Needs you to merge it: autopilot is off."],
  "PE: verified, autopilot unknown": ["?", "ready to merge", "Needs you to merge it: the board cannot tell if autopilot is on."],
  "pr-ready, autopilot on": ["⧗", "ready to merge", null],
  "PE: pr-ready, autopilot off": ["?", "ready to merge", "Needs you to merge it: autopilot is off."],
  "F5: verified, the merge check refuses the head": ["!", "ready to merge", null],
  "F5: pr-ready, the merge check refuses the head": ["!", "ready to merge", null],
  "F5: verified, refused, QA failed, autopilot on": ["!", "ready to merge", null],
  "F5: verified, refused, QA failed, autopilot off": ["!", "ready to merge", null],
  "F5: pr-ready, refused, checks failed, autopilot on": ["!", "ready to merge", null],
  "F5: pr-ready, refused, checks failed, autopilot off": ["!", "ready to merge", null],
  "verified with no build: the chief concludes it": ["⧗", "ready to conclude", null],
  "merged": ["✓", "merged", null],
  "concluded": ["✓", "concluded", null],
  "abandoned": ["■", "stopped for good", null],
  "an open gate on any state that has not ended": ["?", "in the build", "Needs your answer."],
  "a done task with an open gate keeps its word": ["?", `merged ${new Date(now).getDate()} Oct`, "Needs your answer."],
  "a stopped task with an open gate keeps its word": ["■", "stopped for good", null],
};
const sentenceOf = fixture => { const built = model(fixture), names = new Map(built.tasks.map(card => [card.id, card.name])), card = built.tasks.find(item => item.id === "T1"); return taskSentence(card, id => names.get(id) ?? id, card.state !== "abandoned"); };

test("T1257: each recorded state and edge case reads as one phrase of the one table, with a mark and a need line only when the owner acts", () => {
  assert.deepEqual(CASES.map(([name, fixture]) => { const said = sentenceOf(fixture); return [name, [said.mark, said.says, said.need]]; }), CASES.map(([name]) => [name, SENTENCES[name]]));
  assert.equal(sentenceOf(CASES.find(([name]) => name === "F5: verified, the merge check refuses the head")[1]).flag, "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1.", "a problem shows as its flag line");
});

test("T1263: ▶ shows only while an agent works on the task; an open task with no agent at work waits; the At work row counts its agents, also for a framed task or one that waits", () => {
  const run = (role, status = "running") => ({ id: `R${role.length}`, task: "T1", role, round: "0", status, started: now, ...(status !== "running" && { ended: now }) });
  const said = (fixture, runs = []) => { const built = buildBoardModel([{ id: "one", label: "one", diagnostics: [], config: {}, projects: [{ key: "one/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [fixture.row, ...fixture.others ?? []], runs }, observations: { version: 1, records: [] } }] }], { now });
    const names = new Map(built.tasks.map(card => [card.id, card.name])), card = built.tasks.find(item => item.id === "T1"), { mark, says, tone } = taskSentence(card, id => names.get(id) ?? id); return [mark, says, tone]; };
  assert.deepEqual(said({ row: task("T1", "building") }, [run("implementer")]), ["▶", "in the build, 1 agent at work", "run"]);
  assert.deepEqual(said({ row: task("T1", "building") }, [run("implementer", "done")]), ["⧗", "in the build", ""], "the agent ended: the task waits for its next step");
  assert.deepEqual(said({ row: task("T1", "reviewing") }), ["⧗", "built, in review", ""]);
  assert.deepEqual(said({ row: task("T1", "framed") }, [run("pe")]), ["▶", "in the plan, 1 agent at work", "run"], "a framed task with a running agent is not 'not started'");
  assert.deepEqual(said({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "building", { name: "Chief records" })] }, [run("designer")]), ["▶", "waits for Chief records, 1 agent at work", "run"]);
  assert.deepEqual(said({ row: task("T1", "framed") }), ["○", "not started", ""]);
});

test("T1263: a route with only a design step has no evidence review, so in review it says neither built nor report written", () => {
  assert.equal(sentenceOf({ row: task("T1", "reviewing", { route: "design" }) }).says, "in review");
});

test("T1257: waits read by name; a loop, an odd cell, a missing task and an abandoned one cannot start; a state the board does not know says so", () => {
  const said = fixture => { const { mark, says } = sentenceOf(fixture); return [mark, says]; };
  assert.deepEqual(said({ row: task("T1", "framed", { waits: "T2,T3" }), others: [task("T2", "building", { name: "Chief records" }), task("T3", "reviewing", { name: "Shared limits" })] }), ["⧗", "waits for Chief records and Shared limits"]);
  assert.deepEqual(said({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "framed", { waits: "T1", name: "Loop two" })] }), ["⊘", "cannot start, because its waits make a loop through Loop two"]);
  assert.deepEqual(said({ row: task("T1", "framed", { waits: "soon" }) }), ["⊘", "cannot start, because its waits cell is not a task id"]);
  assert.deepEqual(said({ row: task("T1", "briefed", { waits: "T9" }) }), ["⊘", "cannot start, because T9 is not in the logbook"]);
  assert.deepEqual(said({ row: task("T1", "half-done") }), ["◌", 'the board cannot read the state "half-done"']);
});

test("T1257: a route with no build step never says built or build; a build route counts its clean cycles and its agents", () => {
  const investigate = state => sentenceOf({ row: task("T1", state, { route: "investigate,evidence-review" }) }).says;
  assert.deepEqual(["briefed", "building", "reviewing", "repairing", "verifying", "verified"].map(investigate),
    ["the investigation starts next", "in the investigation", "report written, in the evidence review", "report written, in repair round 1 of 3", "the last checks before the conclusion", "ready to conclude"]);
  for (const state of ["framed", "designing", "briefed", "building", "held", "reviewing", "repairing", "replan", "verifying", "verified", "pr-ready", "concluded", "abandoned"]) assert.doesNotMatch(investigate(state), /\bbuil[dt]\b|merge/, state);
  const large = { row: task("T1", "reviewing", { pr: "41", size: "large" }), ledger: clean, records: autopilot(true).slice(0, 1) };
  assert.equal(sentenceOf(large).says, "built, in review, 1 of 2 cycles clean");
  const runs = ["implementer", "lead"].map((role, i) => ({ id: `R${i + 1}`, task: "T1", role, round: "0", status: "running", started: now }));
  const agents = buildBoardModel([{ id: "one", label: "one", diagnostics: [], config: {}, projects: [{ key: "one/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [task("T1", "building")], runs }, observations: { version: 1, records: [] } }] }], { now });
  assert.equal(taskSentence(agents.tasks[0]).says, "in the build, 2 agents at work");
});

test("T1257: a milestone reads as its counts, with a need line that names the tasks that need you, or its breakdown question", () => {
  const base = { state: "active", merged: 1, total: 5, abandoned: [], moving: 2, waiting: 2, cannotStart: [] };
  assert.deepEqual(milestoneSentence(base), { says: "1 of 5 tasks merged, 2 at work, 2 waiting", need: null, mark: "◫", tone: "run" });
  assert.deepEqual(milestoneSentence({ ...base, moving: 0, waiting: 1, cannotStart: ["T9"] }, ["Sync design"]), { says: "1 of 5 tasks merged, 1 waiting, 1 cannot start", need: "Sync design needs you.", mark: "◫", tone: "need" });
  assert.equal(milestoneSentence({ ...base, state: "done", merged: 2, total: 2, moving: 0, waiting: 0, doneAt: null }).says, "done, all 2 tasks merged");
  assert.equal(milestoneSentence({ ...base, state: "done", merged: 2, total: 3, abandoned: ["T3"], moving: 0, waiting: 0 }).says, "done, 2 of 3 tasks merged, 1 abandoned");
  assert.deepEqual(milestoneSentence({ ...base, state: "proposed", merged: 0, moving: 0, waiting: 0 }), { says: "0 of 5 tasks merged", need: "Its breakdown waits for your answer.", mark: "◫", tone: "need" });
  assert.equal(milestoneSentence({ ...base, state: "changing" }).says, "you asked for changes. The chief revises the breakdown");
  assert.deepEqual(milestoneSentence({ ...base, state: "stuck", merged: 0, total: 2, abandoned: ["T1", "T2"], moving: 0, waiting: 0 }), { says: "0 of 2 tasks merged", need: "Its pilot stopped. Choose a new pilot, or drop the milestone.", mark: "◫", tone: "need" },
    "T1263: only the milestone's state says done; a stuck milestone whose tasks are all abandoned is not done");
});

test("T1002: each recorded state and edge case gives the design's word", () => {
  assert.deepEqual(CASES.map(([name, fixture]) => [name, taskWord(cardOf(fixture)).word]), CASES.map(([name, , word]) => [name, word]));
});

test("T1002: the case table covers all 15 recorded states, and every word is one of the six with a reason", () => {
  const STATES = ["framed", "designing", "awaiting-you", "briefed", "building", "held", "reviewing", "repairing", "replan", "verifying", "verified", "pr-ready", "merged", "concluded", "abandoned"];
  assert.deepEqual([...new Set(CASES.map(([, fixture]) => fixture.row.state))].sort(), [...STATES].sort());
  for (const [name, fixture] of CASES) {
    const { word, reason } = taskWord(cardOf(fixture));
    assert.ok(SIX.includes(word), `${name}: ${word}`);
    assert.ok(typeof reason === "string" && reason.length > 0, `${name}: a reason`);
  }
});

test("T1002: the reason says what the owner answers, what the task waits for, or the refusal (F5)", () => {
  const reason = fixture => taskWord(cardOf(fixture)).reason;
  assert.equal(reason({ row: task("T1", "building"), gates: [gate()] }), "Sample: which layout?");
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false) }), "Autopilot is off, so review and merge PR 41.");
  assert.equal(reason({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "building")] }), "Waits for T2 (in progress).");
  assert.match(reason({ row: task("T1", "framed", { waits: "T2" }), others: [task("T2", "abandoned")] }), /cannot start/);
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: clean, records: autopilot(false), landing: refuses }), "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1.");
  assert.equal(reason({ row: task("T1", "verified", { pr: "41" }), ledger: failed("qa-fail"), records: autopilot(true), landing: refuses }), "The merge check refuses aaaaaaa. T1 has open findings: F-T1-1.");
});

test("T1002: a state that the state tool does not write has no word, also one named like an Object key", () => {
  assert.equal(taskWord(cardOf({ row: task("T1", "half-done") })).word, null);
  for (const state of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(taskWord({ state, reasons: [] }).word, null, state);
    assert.deepEqual(milestoneWord({ state }, ["done"]), { word: "done", reason: "1 of 1 done." }, state);
  }
});

test("T1002: a missing card, reasons or words read as an unknown state or an empty list", () => {
  assert.equal(taskWord(null).word, null);
  assert.equal(taskWord().word, null);
  assert.deepEqual(taskWord({ state: "building", reasons: null }), { word: "in progress", reason: "In progress." });
  assert.deepEqual(milestoneWord({ state: "active" }), { word: "not started", reason: "Nothing is in it yet." });
  assert.deepEqual(releaseWord(), { word: "not started", reason: "Nothing is in it yet." });
});

test("T1002: 'needs you' agrees with the board's Needs you box, but for a done task; a refused merge is in neither (F-T1096-8)", () => {
  const changed = new Set(["a done task with an open gate keeps its word"]);
  const sample = MILESTONES_NOW, board = buildBoardModel([milestonesSource()], { now: sample });
  const cards = [...CASES.map(([name, fixture]) => [name, model(fixture)]).map(([name, built]) => [name, built.tasks.find(card => card.id === "T1"), built]),
    ...board.tasks.map(card => [`milestones fixture ${card.id}`, card, board])];
  const agree = cards.filter(([name]) => !changed.has(name)).map(([name, card, built]) => [name, taskWord(card).word === "needs you", built.needsOwner.includes(card)]);
  assert.deepEqual(agree.map(([name, word]) => [name, word]), agree.map(([name, , box]) => [name, box]));
  assert.ok(agree.filter(([, word]) => word).length >= 8, "the fixtures hold cards in the box, not only cards out of it");
  for (const name of changed) {
    const [, card, built] = cards.find(([n]) => n === name);
    assert.deepEqual([built.needsOwner.includes(card), taskWord(card).word === "needs you"], [true, false], name);
  }
});

test("T1002 F1: while a breakdown waits for the owner, only the pilot needs you; the milestone's other tasks wait", () => {
  const board = buildBoardModel([milestonesSource()], { now: MILESTONES_NOW });
  const word = id => taskWord(board.tasks.find(card => card.id === id)).word;
  assert.deepEqual(["T30", "T31", "T32"].map(word), ["needs you", "waiting", "waiting"]);
  assert.match(taskWord(board.tasks.find(card => card.id === "T31")).reason, /your approval of milestone 3/);
});

test("T1002: each milestone's word, from its state and its tasks' words", () => {
  const board = buildBoardModel([milestonesSource()], { now: MILESTONES_NOW });
  const byKey = new Map(board.tasks.map(card => [card.key, card]));
  const words = Object.fromEntries(board.milestones.map(milestone => [milestone.id, milestoneWord(milestone, milestone.tasks.map(key => taskWord(byKey.get(key)).word)).word]));
  assert.deepEqual(words, {
    M1: "in progress",
    M2: "needs you",
    M3: "needs you",
    M4: "in progress",
    M5: "done",
    M6: "stopped",
    M7: "needs you",
    M8: "in progress",
    M9: "in progress",
  });
  for (const milestone of board.milestones) {
    const inBox = !!milestone.need || board.needsOwner.some(card => card.reasons.some(reason => reason.breakdown?.id === milestone.id));
    assert.equal(words[milestone.id] === "needs you", inBox, milestone.id);
  }
});

test("T997: the board model gives each milestone the same word, from the one rule that status and the release line use", () => {
  const board = buildBoardModel([milestonesSource()], { now: MILESTONES_NOW });
  assert.deepEqual(Object.fromEntries(board.milestones.map(milestone => [milestone.id, milestone.word])),
    { M1: "in progress", M2: "needs you", M3: "needs you", M4: "in progress", M5: "done", M6: "stopped", M7: "needs you", M8: "in progress", M9: "in progress" });
});

test("T1002: an active milestone with nothing started is not started; a stuck one whose tasks all stopped still needs you", () => {
  assert.deepEqual(milestoneWord({ state: "active" }, ["not started", "waiting", "waiting"]), { word: "not started", reason: "Nothing in it has started." });
  assert.equal(milestoneWord({ state: "active" }, ["waiting", "needs you"]).word, "in progress");
  assert.equal(milestoneWord({ state: "stuck" }, ["stopped", "stopped"]).word, "needs you");
});

test("T1002 F6: a release's word, from the words of its items", () => {
  const word = words => releaseWord(words).word;
  assert.deepEqual([
    word([]), word(["not started", "waiting"]), word(["done", "waiting"]), word(["needs you"]), word(["in progress", "done"]),
    word(["done", "stopped"]), word(["done"]), word(["stopped", "stopped"]),
  ], ["not started", "not started", "in progress", "in progress", "in progress", "done", "done", "stopped"]);
  assert.equal(releaseWord(["done", "stopped", "in progress", "not started"]).reason, "1 of 4 done.");
});

const SHOWN = { T1: "not started", T2: "waiting", T3: "in progress", T4: "needs you", T5: "done", T6: "stopped" };
const MARKS = { "not started": "○", waiting: "⧗", "needs you": "\\?", "in progress": "▶", done: "✓", stopped: "■" };
const sixBoard = () => model({
  row: task("T1", "framed"),
  others: [task("T2", "framed", { waits: "T3" }), task("T3", "building", { name: "Agenda import" }), task("T4", "framed", { name: "Layout pick" }), task("T5", "merged", { pr: "41", name: "Task board" }), task("T6", "abandoned"), task("T7", "framed", { waits: "T6" })],
  gates: [{ ...gate(), task: "T4" }],
  records: [{ ...observation("completion", { state: "merged", at: now }), task: "T5" }],
});

test("T997: the board model gives each card its word, one card for each of the six words", () => {
  const board = sixBoard();
  assert.deepEqual(Object.fromEntries(Object.keys(SHOWN).map(id => [id, board.tasks.find(card => card.id === id).word])), SHOWN);
});

test("T997, T1217: the chat digest puts a task that needs you, one in progress and one done in their parts, and leaves out the backlog's not started, waiting and stopped tasks", () => {
  const board = sixBoard(), text = renderBoardText(board);
  assert.ok(text.includes("### 🔴 Needs you\n- Layout pick. Sample: which layout?\n  Recommended: the first.\n\n### Moving now\n- ⧗ Agenda import: in the build.\n\n### Done since yesterday\n- ✓ Task board: merged at "), text);
  assert.equal(text.split("\n").filter(line => line.startsWith("- ")).length, 3, "T1, T2, T6 and T7 are not started, waiting or stopped: no line");
  assert.equal(renderTaskText(board.tasks.find(card => card.id === "T6")).split("\n")[1], "one · sample · stopped · small", "the chat lookup of one task");
});

test("T1096: each mark of the shared table has one meaning: '?' is needs you, '!' is a problem flag, and no two words share a mark", () => {
  assert.deepEqual([MARKS_TABLE["needs you"], MARKS_TABLE.problem], ["?", "!"]);
  const meanings = new Map();
  for (const [meaning, mark] of Object.entries(MARKS_TABLE)) meanings.set(mark, [...meanings.get(mark) ?? [], meaning]);
  assert.deepEqual([...meanings].filter(([, list]) => list.length > 1), []);
  assert.deepEqual(WORDS.filter(word => !MARKS_TABLE[word]), [], "each of the six words has a mark");
  assert.deepEqual([...WORDS].sort(), [...URGENCY].sort(), "the urgency order holds the same six words");
});

test("T1096: each primary object has its label, and each tool state and step gives one of the six words and at most one flag", () => {
  assert.deepEqual(Object.keys(OBJECTS), ["project", "release", "milestone", "task", "agent", "question", "pull request", "chief"]);
  assert.deepEqual(Object.values(OBJECTS).map(object => object.label), ["Project", "Release", "Milestone", "Task", "Agent", "Question", "Pull request", "Chief"]);
  const pairs = [...Object.values(OBJECTS).flatMap(object => Object.entries(object.states)), ...Object.entries(STEPS)];
  for (const [state, [word, flag, ...rest]] of pairs) assert.ok(WORDS.includes(word) && (flag === undefined || FLAGS.includes(flag)) && !rest.length, state);
  assert.deepEqual(Object.entries(OBJECTS.task.states).filter(([state]) => taskWord({ state }).word !== OBJECTS.task.states[state][0]), [], "the task map agrees with taskWord");
  assert.deepEqual([runWord("running", { level: "amber", text: "Look at it" }), runWord("work", { level: "calm", text: "Codex: activity unknown" }), shown(OBJECTS.agent.states.failed), shown([])],
    [{ word: "in progress", flag: "Look at it", mark: "!", text: "in progress · Look at it" }, { word: "in progress", flag: "Codex: activity unknown", mark: "▶", text: "in progress · Codex: activity unknown" }, { word: "stopped", flag: "failed", mark: "!", text: "stopped · failed" }, { word: "unknown", flag: null, mark: "◌", text: "unknown" }]);
  assert.deepEqual(Object.keys(OBJECTS.agent.states).filter(state => !["queued", "running", "done", "question", "failed", "blocked", "work", "wait"].includes(state)), [], "T1224: a flag is not an agent state");
  assert.deepEqual([prName(44), chiefName("C1", "claude"), chiefName("C2", null), chiefName(null, "codex")], ["PR 44", "Claude · C1", "C2", "Codex"]);
});

test("T1096, F-T1182-4: the guide's mark key and Agents page key show the table's marks and words, and the guide names no offer line", () => {
  const guide = readFileSync(new URL("../docs/guide/board.md", import.meta.url), "utf8");
  for (const word of WORDS) assert.ok(guide.includes(`| ${word} | ${MARKS_TABLE[word]} |`), word);
  for (const [state, flag] of [["work"], ["wait"], ["work", { level: "red", text: "Stopped without a report" }], ["work", { level: "amber", text: "Look at it" }], ["work", { level: "calm", text: "Codex: activity unknown" }]]) { const { mark, text } = runWord(state, flag); assert.ok(guide.includes(`| ${mark} ${text} |`), text); }
  assert.ok(guide.includes(`\`${MARKS_TABLE.problem}\` is a problem: ${FLAGS.slice(0, -1).join(", ")} or ${FLAGS.at(-1)}.`) && guide.includes(`\`${MARKS_TABLE.unknown}\` is a state that the board does not know.`), "the two more marks");
  const render = readFileSync(new URL("../packages/sage-core/board-render.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(guide, /offer line|⇄/, "F-T1182-4: the guide names no offer line: the board shows none");
  assert.match(guide, /"picked up 146 tasks at 15:59"/, "F-T1182-4: the guide shows the pick-up note of a session row");
  assert.ok(guide.includes(`"${words.pickupLine?.({ at: "2026-11-20T15:59:00Z", to: "C3", toProvider: "claude", tasks: 146, lost: [], sources: [{ from: "C1", fromProvider: "claude", tasks: 69 }, { from: "C2", fromProvider: "codex", tasks: 2 }, { from: "", fromProvider: "", tasks: 75 }] }, () => "20 Nov, 15:59")}"`), "F-T1182-4: the guide's pick-up line is the board's line");
  for (const mark of [MARKS_TABLE["cannot start"], "🔴"]) assert.ok((mark === "🔴" ? render.includes(mark) : render.includes('MARKS["cannot start"]')) && new RegExp(`^- \`?${mark}\`? `, "m").test(guide), `F-T1099-58: the guide's key explains ${mark}, which the boards show`);
});

test("T1096: the board app and the message command take their words from the table, and keep no copy of the six words", () => {
  const app = buildSync({ absWorkingDir: ROOT, entryPoints: ["packages/sage-board/app/main.jsx"], bundle: true, write: false, metafile: true, format: "esm", jsx: "automatic", external: ["react", "react-dom", "react/*", "react-dom/*", "@xyflow/react"], loader: { ".css": "empty" }, logLevel: "silent" });
  assert.ok(Object.keys(app.metafile.inputs).includes("packages/sage-core/state-words.mjs"), "the app bundles the table");
  const readers = ["packages/sage-core/board-render.mjs", "packages/sage-core/message.mjs", ...readdirSync(join(ROOT, "packages/sage-board/app")).filter(name => name.endsWith(".jsx")).map(name => `packages/sage-board/app/${name}`)];
  for (const file of readers) assert.doesNotMatch(readFileSync(join(ROOT, file), "utf8"), /"not started", "waiting", "needs you"|"needs you", "in progress", "waiting"|not known"|#\$\{[^}]*\.pr\}|[○⧗▶■◫◎◌⊘]/, file);
});

test("F-T1096-1, F-T1096-12, F-T1099-49: the task page and the chat lookup show each run's word and flag from the table, never the tool's status; a run that ended on a question needs you", () => {
  const STATUSES = { failed: "stopped · failed", blocked: "stopped · blocked", done: "done", question: "needs you", queued: "waiting", running: "in progress" };
  const runs = Object.keys(STATUSES).map((status, i) => ({ id: `R${i + 1}`, task: "T1", role: "qa", round: "0", status, started: now, ended: status === "running" || status === "queued" ? "" : now, tokens: "1" }));
  const board = buildBoardModel([{ id: "one", label: "one", diagnostics: [], config: {}, projects: [{ key: "one/sample-abcdef", name: "sample-abcdef", diagnostics: [], tables: { tasks: [task("T1", "reviewing", { pr: "41" })], runs }, observations: { version: 1, records: [] } }] }], { now });
  const card = board.tasks[0], chat = renderTaskText(card);
  assert.deepEqual(chat.split("**Agent runs**\n")[1].split("\n\n")[0].split("\n").map(line => line.split(" · ")[2] === "stopped" ? line.split(" · ").slice(2, 4).join(" · ") : line.split(" · ")[2]), Object.values(STATUSES));
});

test("F-T1096-2: no mark has two meanings, also across the kind tags, on the web board and in the chat", () => {
  const meanings = new Map();
  for (const [meaning, mark] of [...Object.entries(MARKS_TABLE), ...Object.entries(KINDS).map(([kind, [mark]]) => [`kind ${kind}`, mark])]) meanings.set(mark, [...meanings.get(mark) ?? [], meaning]);
  assert.deepEqual([...meanings].filter(([, list]) => list.length > 1), []);
  for (const [kind, [mark]] of Object.entries(KINDS)) assert.ok(!Object.values(MARKS_TABLE).includes(mark), kind);
});

test("F-T1096-4: a task whose state the board cannot read shows the word unknown in the chat lookup", () => {
  const board = model({ row: task("T1", "half-done") });
  assert.equal(renderTaskText(board.tasks[0]).split("\n")[1], "one · sample · unknown · small");
});
