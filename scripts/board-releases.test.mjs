import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardText } from "../packages/sage-core/board-render.mjs";
import { NOW, releasesSource, releasesTables } from "./fixtures/board-releases.mjs";

const model = (tables = releasesTables()) => buildBoardModel([releasesSource(tables)], { now: NOW });
const partOf = (text, label) => text.split(new RegExp(`### (?:🔴 )?${label}\\n`))[1].split(/\n\n(?:### |More: |Quiet: |Archived: |Incomplete source: |Setting ignored: |Logbook note: )/)[0];

test("T996, T1217: the chat digest gives each release that is not done one line, first under Milestones, and no backlog task", () => {
  const tables = releasesTables();
  tables.tasks.find(task => task.id === "T992").priority = "P0";
  const text = renderBoardText(model(tables));
  assert.equal(partOf(text, "Milestones"), ["- Release 1.0: 1 of 10 tasks done.", "- Release 1.1: 0 of 3 tasks done.", "- Sage feel: 0 of 8 merged. Next, Presentation skill.", "- Faster reviews: the breakdown waits for you."].join("\n"), text);
  for (const title of ["Playbook: a new feature", "Fix a typo in the guide"]) assert.ok(!text.includes(title), `${title}: a waiting or backlog task has no line`);
});
test("T996, T1217: a done release has no line; a release that a cell names and the table lacks says so", () => {
  const tables = releasesTables();
  tables.tasks = tables.tasks.filter(task => ["T900", "T993"].includes(task.id));
  tables.milestones = []; tables.gates = [];
  assert.equal(partOf(renderBoardText(model(tables)), "Milestones"), "- Release 1.1: 0 of 0 tasks done.", "1.1 is empty, so not started; 0.9 and 1.0 are done");
  tables.releases = tables.releases.slice(0, 2);
  assert.equal(partOf(renderBoardText(model(tables)), "Milestones"), "No milestone is open.");
  tables.releases = [];
  assert.equal(partOf(renderBoardText(model(tables)), "Milestones"), ["0.9", "1.0"].map(name => `- Release ${name}: 1 of 1 task done. It is not in the logbook. Ask the chief to add it.`).join("\n"), "a missing release shows, also when its tasks are done");
});
test("T996: a logbook with no releases table, or an empty one, shows the board as before: no frame, no Releases tab, no release tag", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-releases-")), project = join(root, "sample-abcdef");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  const sheet = (name, rows) => writeFileSync(join(project, `${name}.tsv`), rows.map(row => row.join("\t")).join("\n") + "\n");
  sheet("tasks", [["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone"], ["T1", "Sample pilot", "small", "", "build", "building", "", "", "0", "", "M1"], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", ""]]);
  sheet("gates", [["id", "task", "question", "options", "recommendation", "default", "answer", "at"], ["G1", "T1", "Approve milestone M1? No task builds before you approve.", "approve|change|drop", "approve", "", "approve", ""]]);
  sheet("milestones", [["id", "name", "goal", "pilot", "gate", "at"], ["M1", "Sample milestone", "Sample goal.", "T1", "G1", ""]]);
  const views = () => {
    const sources = readBoardSources([{ id: "sample", path: root, label: "Sample source" }]);
    assert.deepEqual(sources[0].projects[0].diagnostics.filter(message => message.startsWith("releases")), []);
    const data = buildBoardModel(sources, { now: NOW });
    return { data, text: renderBoardText(data) };
  };
  const missing = views();
  sheet("releases", [["name", "goal", "at"]]);
  const empty = views();
  assert.deepEqual(missing.data.releases, []);
  assert.ok(!missing.text.includes("Release"), missing.text);
  assert.equal(partOf(missing.text, "Milestones"), "- Sample milestone: 0 of 1 merged. Next, Sample pilot.", "the Milestones part stays");
  sheet("releases", [["name", "goal", "at"], ["1.0", "Sample goal.", ""]]);
  const one = views();
  assert.equal(one.data.releases[0].releases[0].name, "1.0");
  assert.ok(partOf(one.text, "Milestones").startsWith("- Release 1.0: "), one.text);
});

test("T996, T1217: a release name from the logbook is plain text on one line, with no HTML and no code fence", () => {
  const tables = releasesTables(), hostile = "<script>alert(1)</script>\n```\n# x", goal = '<img src=x onerror="alert(2)">';
  tables.releases[1] = { ...tables.releases[1], name: hostile, goal };
  for (const row of [...tables.tasks, ...tables.milestones]) if (row.release === "1.0") row.release = hostile;
  const text = renderBoardText(model(tables));
  assert.ok(partOf(text, "Milestones").startsWith("- Release ‹script›alert(1)‹/script› ``` # x: 1 of 10 tasks done.\n"), text);
  assert.ok(!text.includes("<") && !text.includes("onerror") && !text.includes("\n```"), text);
});
test("T996, T1217: a long release or milestone name is cut after 60 characters with an ellipsis", () => {
  const tables = releasesTables();
  tables.releases[1].name = "版本".repeat(30) + "x";
  tables.milestones[0].name = "M".repeat(200);
  const lines = partOf(renderBoardText(model(tables)), "Milestones").split("\n");
  assert.equal(lines[0], `- Release ${"版本".repeat(30)}…: 0 of 0 tasks done.`);
  assert.ok(lines.includes(`- ${"M".repeat(60)}…: 0 of 8 merged. Next, Presentation skill.`), lines.join("\n"));
});
test("F-T996-1: a releases table that cannot be read is a Needs you item, and no release that a cell names shows as not in the logbook", t => {
  const data = buildBoardModel([damagedReleases(t)], { now: NOW });
  const text = renderBoardText(data);
  const needs = partOf(text, "Needs you");
  assert.equal(needs, "- The releases table cannot be read. releases.tsv line 2 has 2 cells, and its header has 3. The board shows the tasks without their releases. Ask the chief to repair the logbook.");
  assert.equal(data.counts.needsOwner, 1);
  assert.deepEqual(data.releases, []);
  assert.ok(!text.includes("Release 1"), text);
  assert.ok(!needs.includes("logbook cannot be read"), needs);
});

test("F-T996-2, T1217: a dropped milestone with tasks still in it, in a done release, keeps its line under Milestones, with its next step", () => {
  const tables = releasesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T950", title: "Old plan pilot", state: "framed", release: "", milestone: "M4" });
  tables.gates.push({ id: "G4", task: "T950", question: "Approve milestone M4? No task builds before you approve. Name: Old plan", options: "approve|change|drop", recommendation: "approve", default: "", answer: "drop", at: tables.gates[0].at });
  tables.milestones.push({ id: "M4", name: "Old plan", goal: "Sample goal.", pilot: "T950", gate: "G4", at: tables.milestones[0].at, release: "0.9" });
  const data = model(tables), text = renderBoardText(data);
  assert.equal(data.releases[0].releases[0].word, "done", "0.9 holds a done task and a stopped milestone: done");
  assert.ok(!text.includes("Release 0.9"), "a done release has no line");
  assert.ok(partOf(text, "Milestones").includes("\n- Old plan: dropped, with 1 task still in it. Ask the chief to take the task out of the milestone."), text);
  tables.tasks = tables.tasks.filter(task => task.id !== "T950");
  assert.ok(!renderBoardText(model(tables)).includes("Old plan"));
});
test("F-T996-5, T1217: the chat's breakdown approval names the milestone by its name", () => {
  assert.ok(partOf(renderBoardText(model()), "Needs you").startsWith("- Faster reviews. Approve milestone M6? "));
});
const damagedReleases = t => logbookOnDisk(t, { releases: [["name", "goal", "at"], ["1.0", "Sample goal."]] });
function logbookOnDisk(t, sheets) {
  const root = mkdtempSync(join(tmpdir(), "sage-board-releases-")), project = join(root, "sample-abcdef");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(project);
  const sheet = (name, rows) => writeFileSync(join(project, `${name}.tsv`), rows.map(row => row.join("\t")).join("\n") + "\n");
  sheet("tasks", [["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone", "release"], ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "", ""], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", "", "1.0"]]);
  for (const [name, header] of Object.entries({ runs: "id task role round candidate branch status tokens report started ended", findings: "task key round source severity summary triage reason status", ledger: "task pr sha kind cycle run at", gates: "id task question options recommendation default answer at", decisions: "at task decision why", milestones: "id name goal pilot gate at" })) sheet(name, [header.split(" ")]);
  sheet("releases", [["name", "goal", "at"], ["1.0", "Sample goal.", ""]]);
  for (const [name, rows] of Object.entries(sheets)) if (rows) sheet(name, rows); else rmSync(join(project, `${name}.tsv`));
  return readBoardSources([{ id: "sample", path: root, label: "Sample source" }])[0];
}

const TASKS_HEADER = ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys", "milestone", "release"];
function noReleaseFrom(source, need, reason, name = "sample") {
  const data = buildBoardModel([source], { now: NOW }), text = renderBoardText(data);
  assert.deepEqual(data.releases, [], need);
  assert.ok(!text.includes("Release 1.0"), text);
  const needs = partOf(text, "Needs you");
  assert.ok(needs.startsWith(`- ${need}. `) && needs.includes(reason), needs);
}
test("F-T996-28: a milestones table that cannot be read gives no release, so release 1.0 with open milestone work never reads done", t => {
  noReleaseFrom(logbookOnDisk(t, {
    tasks: [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]],
    milestones: [["id", "name", "goal", "pilot", "gate", "at", "release"], ["M1", "Sample milestone"]] }),
  "The milestones table cannot be read", "milestones.tsv line 2 has 2 cells, and its header has 7.");
});
test("F-T996-29: a tasks table that cannot be read gives no release, so release 1.0 never reads \"not started, 0 of 0\"", t => {
  noReleaseFrom(logbookOnDisk(t, { tasks: [TASKS_HEADER, ["T1", "Sample first"]] }), "The Sample source logbook cannot be read", "tasks.tsv line 2 has 2 cells, and its header has 12.", "sample-abcdef");
});

const NO_RELEASE_TASKS = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", ""]];
const DAMAGED_MILESTONES = [["id", "name", "goal", "pilot", "gate", "at", "release"], ["M1", "Sample milestone"]];

test("F-T996-37: a project with no releases and a milestones table that cannot be read: Needs you names the milestones table", t => {
  const data = buildBoardModel([logbookOnDisk(t, { releases: [["name", "goal", "at"]], tasks: NO_RELEASE_TASKS, milestones: DAMAGED_MILESTONES })], { now: NOW });
  assert.deepEqual(data.releases, []);
  assert.ok(partOf(renderBoardText(data), "Needs you").startsWith("- The milestones table cannot be read. "));
});

test("F-T996-40: a damaged milestones table hides the releases, and Needs you says why", t => {
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]];
  const data = buildBoardModel([logbookOnDisk(t, { tasks, milestones: DAMAGED_MILESTONES })], { now: NOW });
  assert.deepEqual(data.releases, [], "no release shows");
  assert.ok(renderBoardText(data).includes("milestones.tsv line 2 has 2 cells, and its header has 7."), "the chat board says why");
});

test("F-T996-42: the releases still show when an old logbook of the project is damaged", () => {
  const live = releasesSource(), old = releasesSource({ milestones: [], releases: [], gates: [], decisions: [] }, "codex");
  Object.assign(old.projects[0], { key: "codex/sage-old111", name: "sage-old111", checkout: null, displayName: null, old: { provider: "codex", of: live.projects[0].key }, diagnostics: ["tasks: line 2 has 2 cells, and its header has 12"] });
  const data = buildBoardModel([live, old], { now: NOW });
  assert.ok(data.milestoneNeeds.some(need => need.kind === "logbook"), "Needs you still says that the old logbook cannot be read");
  assert.ok(renderBoardText(data).includes("\n- Release 1.0: "), "the release shows");
});

test("F-T996-36: an older logbook with programs.tsv (before the rename, T995) and a damaged milestones or tasks table gives no release", t => {
  const programs = [["id", "name", "goal", "pilot", "gate", "at", "release"]];
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "merged", "", "", "0", "", "", "1.0"]];
  noReleaseFrom(logbookOnDisk(t, { programs, tasks, milestones: DAMAGED_MILESTONES }), "The milestones table cannot be read", "milestones.tsv line 2 has 2 cells, and its header has 7.");
  noReleaseFrom(logbookOnDisk(t, { programs, tasks: [TASKS_HEADER, ["T1", "Sample first"]] }), "The Sample source logbook cannot be read", "tasks.tsv line 2 has 2 cells, and its header has 12.", "sample-abcdef");
});

test("F-T1012-1, F-T1012-2: a damaged programs.tsv is the milestones table's problem: Needs you names programs.tsv", t => {
  const programs = [["id", "name", "goal", "pilot", "gate", "at", "release"], ["P1"]];
  const reason = "programs.tsv line 2 has 1 cell, and its header has 7.";
  noReleaseFrom(logbookOnDisk(t, { programs, milestones: null }), "The milestones table cannot be read", reason);
  const tasks = [TASKS_HEADER, ["T1", "Sample first", "small", "", "build", "framed", "", "", "0", "", "M1", ""], ["T2", "Sample single", "small", "", "build", "framed", "", "", "0", "", "", "1.0"]];
  const data = buildBoardModel([logbookOnDisk(t, { programs, tasks, milestones: null })], { now: NOW });
  assert.deepEqual(data.milestoneNeeds.map(need => [need.kind, need.text]), [["milestones", `milestones.tsv is missing. ${reason} The board shows the tasks without their milestones. Ask the chief to repair the logbook.`]]);
});

test("F-T996-41: a damaged tasks or gates table makes no milestone advice that guesses: Needs you names the table and asks for a repair", () => {
  for (const [table, header] of [["tasks", 18], ["gates", 8]]) {
    const tables = releasesTables(), source = releasesSource(tables);
    delete tables[table];
    source.projects[0].diagnostics.push(`${table}: line 2 has 2 cells, and its header has ${header}`);
    const data = buildBoardModel([source], { now: NOW }), text = renderBoardText(data);
    const m5 = data.milestoneNeeds.find(need => need.milestone === "M5");
    assert.ok(m5 && m5.text.includes(`${table}.tsv`) && m5.text.endsWith("Ask the chief to repair the logbook."), JSON.stringify(m5));
  }
});

test("F-T996-12, F-T996-15, F-T996-16: owner text names a milestone by its level, never by its raw id", () => {
  const data = model(), text = renderBoardText(data);
  const stuck = releasesTables();
  stuck.tasks.find(task => task.id === "T1010").state = "abandoned";
  for (const view of [text, renderBoardText(model(stuck))]) for (const old of ["Milestone M6", "of M6", "M6 breakdown", "M6 Faster reviews"]) assert.ok(!view.includes(old), old);
});

test("F-T996-13, T1217: a dropped milestone with tasks still in it gives its next step in the chat", () => {
  const tables = releasesTables();
  tables.gates.find(gate => gate.id === "G3").answer = "drop";
  assert.ok(partOf(renderBoardText(model(tables)), "Milestones").includes("\n- Faster reviews: dropped, with 2 tasks still in it. Ask the chief to take each task out of the milestone."));
});
