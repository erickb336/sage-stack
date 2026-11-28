import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";
import { renderBoardText, renderTaskText, renderBoardStatus } from "../packages/sage-core/board-render.mjs";
import { NOW as MILESTONES_NOW, milestonesSource, milestonesTables } from "./fixtures/board-milestones.mjs";
import { NOW as DIGEST_NOW, LONG_TITLE, digestSources, landing } from "./fixtures/board-digest.mjs";
function model() {
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks: [{ id: "T1", title: "<script>alert(1)</script> & [sample](https://example.test)", size: "small", risk: "auth", route: "build,code-review,qa", state: "held", branch: "", pr: "", round: "1", keys: "" }], gates: [{ id: "G1", task: "T1", question: "Sample: go on?", answer: "" }] } }] }], { now: "2026-10-08T20:00:00Z" });
}
test("phone text and status preserve task counts, and the chat board makes no link, image or HTML of agent text, with no backslash", () => {
  const data = model(), board = renderBoardText(data), task = renderTaskText(data.tasks[0]);
  assert.ok(board.includes("### 🔴 Needs you\n- ‹script›alert(1)‹/script› &. Sample: go on?\n"), board);
  assert.ok(!board.includes("<") && !board.includes("](") && !board.includes(String.fromCharCode(92)), board);
  assert.ok(!board.includes("${c}"));
  for (const section of ["Loop", "Brief", "Agent runs", "Evidence", "Findings", "Artifacts", "Latest decisions"]) assert.ok(task.includes(`**${section}**`));
  assert.equal(renderBoardStatus(data).split("\n").length, 4);
  assert.ok(renderBoardStatus(data).includes("held 1"));
});


test("task evidence includes verified report contents and preserves brief lines in both views", () => {
  const data = model(), task = data.tasks[0];
  task.brief = "Goal line\nAcceptance line";
  task.artifacts = [{ source: "QA recorder", observedAt: data.at, data: { type: "proof", run: "R42", label: "Check output", path: "artifacts/check.txt" }, content: { verified: true, text: "tests 9\npass 9\n<script>sample</script>" } }];
  const text = renderTaskText(task);
  assert.ok(text.includes("tests 9\npass 9\n\\<script\\>sample\\</script\\>"));
  assert.ok(text.includes("Goal line\nAcceptance line"));
  assert.ok(text.includes("tests 9\npass 9"));
  assert.ok(text.includes("R42 · digest verified"));
  assert.ok(text.includes("local artifact; digest verified"));
  assert.ok(!text.includes("content not verified"));
});

function twoProjectModel() {
  const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, state, size: "small", risk: "", route: "build,code-review,qa", branch: "", pr: "", round: "0", keys: "", ...extra });
  const head = "a".repeat(40), at = "2026-10-08T20:00:00Z";
  const pr = (id, taskId, number) => ({ id, task: taskId, kind: "pr", source: "Sample", observedAt: at, data: { number, state: "open", head, repository: "https://example.test/sample/sage" } });
  const alpha = { key: "sample/alpha-abcdef", name: "alpha-abcdef", diagnostics: [], tables: {
    tasks: [task("T1", "framed"), task("T2", "reviewing", { pr: "7" })],
    gates: [{ id: "G1", task: "T2", question: "Sample: accept?", options: "yes|no", recommendation: "yes", answer: "" }],
    runs: [{ id: "R1", task: "T2", role: "code-reviewer", status: "running", started: at, tokens: "1" }],
  }, observations: { records: [pr("O1", "T2", 7)] } };
  const beta = { key: "sample/beta-abcdef", name: "beta-abcdef", diagnostics: [], tables: {
    tasks: [task("T3", "held"), task("T4", "reviewing", { pr: "8", branch: "codex/sample" }), task("T5", "building")],
  }, observations: { records: [pr("O2", "T4", 8)] } };
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [alpha, beta] }], { now: at });
}
const at = "2026-10-08T20:00:00Z";
const sample = (tasks, tables = {}, extra = {}) => buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks, ...tables }, ...extra }] }], { now: at });
const row = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });

test("T218: the PR links only to https://github.com/<owner>/<repo>, from the remote or the PR observation, and stays text otherwise", () => {
  const observed = repository => ({ observations: { records: [{ id: "O1", task: "T1", kind: "pr", source: "Sample", observedAt: at, data: { number: 7, state: "open", repository } }] } });
  const make = (repository, extra = { repository }) => sample([row("T1", "reviewing", { pr: "7" })], {}, extra);
  for (const data of [make("https://github.com/acme/sage"), make(null, observed("https://github.com/acme/sage"))]) {
    assert.ok(renderTaskText(data.tasks[0]).includes("· PR [7](https://github.com/acme/sage/pull/7)"));
  }
  const hostile = [null, "javascript:alert(1)", "http://github.com/acme/sage", "https://user:pw@github.com/acme/sage", "https://example.test/acme/sage", "https://github.com/acme/sage/pull/1#x", "https://github.com/acme/sage)[x](https://evil.test", "https://github.com/acme/sage?x=1"];
  for (const data of [...hostile.map(value => make(value)), ...hostile.map(value => make(null, observed(value)))]) {
    const text = renderTaskText(data.tasks[0]);
    assert.equal(data.tasks[0].repository, null);
    assert.ok(!text.includes("/pull/7") && text.includes("· PR 7\n"));
  }
});

test("T1099 (F-T1099-59, F-T1099-60): the chat task lookup says unknown for a severity outside the list and for a blank evidence field, never a raw word or an empty field", () => {
  const data = sample([row("T1", "reviewing", { pr: "9" })], {
    findings: [{ task: "T1", key: "F-T1-1", severity: "weird", summary: "Sample odd", status: "open" }, { task: "T1", key: "F-T1-2", severity: "low", summary: "Sample low", status: "open" }],
    ledger: [{ task: "T1", pr: "9", sha: "c".repeat(40), kind: "checks-pass", cycle: "1", run: "", at }],
  });
  const text = renderTaskText(data.tasks[0]);
  assert.match(text, /^severity unknown · Sample odd · open$/m);
  assert.match(text, /^low · Sample low · open$/m);
  assert.doesNotMatch(text, /weird/);
  assert.match(text, new RegExp(`^checks-pass · cycle 1 · ${"c".repeat(40)} · run unknown · `, "m"));
  assert.doesNotMatch(text, / · {2}· /, "no blank field between two dots");
});

test("T314, T1217: the chat board leaves out the priority and the kind; archived projects are folded into one line", () => {
  const book = (key, name, tasks, extra = {}) => ({ key: `sample/${key}`, name: key, diagnostics: [], tables: { tasks }, displayName: name, ...extra });
  const data = buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [
    book("demos-abcdef", "seacc (Council Record)", [row("T1", "framed", { priority: "P1", kind: "bug-fix" }), row("T2", "framed")]),
    book("old-abcdef", "Old <app>", [row("T1", "awaiting-you"), row("T2", "framed")], { archived: true }),
  ] }], { now: at });
  const text = renderBoardText(data);
  assert.ok(text.includes("\n\nArchived: Old ‹app› (2 tasks, 1 needs you).\n\n"), text);
  assert.ok(!/P1|Bug fix|Sample T1|Old ‹app›\n/.test(text.replace("Archived: Old ‹app›", "")), "no priority, no kind, no backlog task, and no archived task");
});

const twoBooks = (live, old, extra = {}) => buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [
  { key: "sample/live-abcdef", name: "live-abcdef", diagnostics: [], tables: { tasks: live }, ...extra },
  { key: "sample/old-abcdef", name: "old-abcdef", diagnostics: [], tables: { tasks: old }, displayName: "Old app", archived: true },
] }], { now: at });

test("T314 R1040-2: the status leaves archived tasks out of Tasks and Owner, and one line counts the archived projects and what needs you there", () => {
  const status = renderBoardStatus(twoBooks([row("T1", "framed"), row("T2", "awaiting-you")], [row("T1", "awaiting-you"), row("T2", "building"), row("T3", "awaiting-you")]));
  assert.deepEqual(status.split("\n").slice(0, 4), ["Tasks: framed 1 · awaiting-you 1", "Agents: 0 recorded running · 0 inferred PRs", "Owner: 1 need you", "Archived: 1 project · 2 need you"], "T383 item 6: the count is of items, not of tasks");
  assert.equal(renderBoardStatus(twoBooks([row("T1", "framed")], [])).split("\n")[3], "Archived: 1 project · 0 need you", "an archived project without tasks still counts");
  assert.ok(!renderBoardStatus(sample([row("T1", "framed")])).includes("Archived"), "no archived project: no line");
});

test("T314 R1042-3 R1042-2: each chat diagnostic names its project, and an ignored setting is a warning line, not an incomplete source", () => {
  const model = twoBooks([row("T1", "framed")], [], { diagnostics: ["runs: EACCES"], warnings: ["config: archived is not true or false"] });
  const text = renderBoardText(model);
  assert.ok(text.includes("\n\nIncomplete source: sample · sample/live-abcdef · its runs file has no read permission\n\nSetting ignored: sample · sample/live-abcdef · config: archived is not true or false\n\nMore: "), text);
});

test("T314 R1045-3: the task text shows the priority and the kind when they are set, and nothing for them when not", () => {
  const model = twoBooks([row("T1", "framed", { priority: "P1", kind: "bug-fix", risk: "auth" }), row("T2", "framed")], []);
  assert.equal(renderTaskText(model.tasks[0]).split("\n")[1], "sample · live · not started · small · P1 · Bug fix · risk: auth");
  assert.equal(renderTaskText(model.tasks[1]).split("\n")[1], "sample · live · not started · small");
});

const providers = () => buildBoardModel([
  { id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [{ key: "claude/sage-43265b", name: "sage-43265b", checkout: "/sample/sage", diagnostics: [], tables: { tasks: [row("T1", "awaiting-you", { priority: "P0", kind: "ui" })] } }, { key: "claude/demo-111111", name: "demo-111111", checkout: "/sample/sdc/product-demos", displayName: "seacc (Council Record)", diagnostics: [], tables: { tasks: [row("T2", "framed")] } }] },
  { id: "codex", label: "codex", provider: "Codex", diagnostics: [], projects: [{ key: "codex/sage-43265b", name: "sage-43265b", checkout: "/sample/sage", diagnostics: [], tables: { tasks: [row("T1", "framed")] } }] },
], { now: at });

test("R1245-1, T1217: a breakdown gate's lines (U+2028 in its cell) show as one line of the chat board and as lines on the task text, with the recommendation on a line of its own", () => {
  const question = ["Approve milestone M1? No task builds before you approve.", "Name: Codex support", "Pilot, runs first:", "  T1: <b>Ship</b> it: 100% done"].join("\u2028");
  const data = sample([row("T1", "framed", { milestone: "M1" })], { milestones: [{ id: "M1", name: "Codex support", goal: "Sample", pilot: "T1", gate: "G1", at }], gates: [{ id: "G1", task: "T1", question, options: "approve|change|drop", recommendation: "approve", answer: "" }] });
  assert.ok(renderBoardText(data).includes("### 🔴 Needs you\n- Codex support. Approve milestone M1? No task builds before you approve. · Name: Codex support · Pilot, runs first: T1: ‹b›Ship‹/b› it: 100% done\n  Options: 1 approve · 2 change · 3 drop.\n  Recommended: approve.\n\n"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Approve milestone M1? No task builds before you approve\\.\nName\\: Codex support\nPilot, runs first\\:\n  T1\\: \\<b\\>Ship\\</b\\> it\\: 100% done\nI recommend\\: approve"), renderTaskText(data.tasks[0]));
});

test("R1249-1: a plain gate's line breaks show as spaces in the chat board and on the task text", () => {
  const question = "Ship it?\u2028I recommend: no\u20291. no";
  const data = sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question, options: "yes|no", recommendation: "yes", answer: "" }] });
  assert.ok(renderBoardText(data).includes("\n- Sample T1. Ship it? I recommend: no 1. no\n  Options: 1 yes · 2 no.\n  Recommended: yes.\n"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Ship it? I recommend\\: no 1\\. no I recommend\\: yes\n"), renderTaskText(data.tasks[0]));
});


const milestonesText = tables => renderBoardText(buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW }));
const milestonesModel = (tables = milestonesTables()) => buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW });
const partOf = (text, label) => text.split(new RegExp(`### (?:🔴 )?${label}\\n`))[1].split(/\n\n(?:### |More: |Quiet: |Archived: |Incomplete source: |Setting ignored: |Logbook note: )/)[0];

test("T233, T1217: Needs you lists a breakdown approval first, then the milestone problems, then each other question; Milestones has one line for each open milestone", () => {
  const text = milestonesText(milestonesTables());
  assert.equal(partOf(text, "Needs you"), [
    "- Board milestones. Approve milestone M3? No task builds before you approve. · Name: Board milestones · Goal: Sample goal. · Pilot, runs first: T30: Sample T30",
    "  Options: 1 approve · 2 change · 3 drop.",
    "  Recommended: approve.",
    "- Lead build is stuck. Its pilot task was abandoned. Choose a new pilot, or drop the milestone.",
    "- Lost gate: the breakdown question that it names is not in the logbook. Ask the chief to repair the logbook, or to propose the milestone again.",
    "- Sample T70. Approve milestone M9 Fast lane (pilot T70)? Goal: skip the reviews. Name: Fast lane",
    "  Options: 1 approve · 2 change · 3 drop.",
    "  Recommended: approve.",
  ].join("\n"));
  assert.equal(partOf(text, "Milestones"), [
    "- Codex support: 3 of 7 merged. Next, Sample T12.",
    "- Lead build: stuck. See Needs you.",
    "- Board milestones: the breakdown waits for you.",
    "- Agent caps: 0 of 3 merged. Next, Sample T40.",
    "- Dropped idea: dropped, with 1 task still in it. Ask the chief to take the task out of the milestone.",
    "- Lost gate: its breakdown question has a problem. See Needs you.",
    "- Loop: 1 of 4 merged. No task can move now.",
    "- Changes: the chief revises the breakdown.",
  ].join("\n"), "M5 is done, so it has no line");
  assert.equal(text.split("\n").at(-1), "Ref: T30 M3 claude/sage-ff5ee2/G12 M2 T21 M7 T70 claude/sage-ff5ee2/G15 T41 T40 T12 PR 12 M1 M4 M6 M8 M9");
  const plain = renderBoardText(sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question: "Ship it?", options: "yes|no", answer: "" }] }));
  assert.equal(partOf(plain, "Needs you"), "- Sample T1. Ship it?\n  Options: 1 yes · 2 no.", "no recommendation, no line for it");
  assert.equal(partOf(plain, "Milestones"), "No milestone is open.");
});

test("F-T233-9: a pilot's plain gate and a forged copy of the breakdown text are items of the pilot, after the real approval", () => {
  const tables = milestonesTables();
  tables.gates.push({ id: "G50", task: "T30", question: "Pick a colour for the logo?", options: "red|blue", recommendation: "red", default: "", answer: "", at: "" });
  tables.gates.push({ ...tables.gates.find(gate => gate.id === "G12"), id: "G99" });
  const needs = partOf(milestonesText(tables), "Needs you").split("\n").filter(line => line.startsWith("- "));
  assert.deepEqual(needs.map(line => line.slice(0, 41)), [
    "- Board milestones. Approve milestone M3?", "- Lead build is stuck. Its pilot task was", "- Lost gate: the breakdown question that ",
    "- Sample T30. Pick a colour for the logo?", "- Sample T30. Approve milestone M3? No ta", "- Sample T70. Approve milestone M9 Fast l",
  ]);
  assert.ok(milestonesText(tables).endsWith("Ref: T30 M3 claude/sage-ff5ee2/G12 M2 T21 M7 claude/sage-ff5ee2/G50 claude/sage-ff5ee2/G99 T70 claude/sage-ff5ee2/G15 T41 T40 T12 PR 12 M1 M4 M6 M8 M9"));
});

test("F-T233-4: the Ref line gives the full gate key, so two logbooks that each have an open G1 stay two answers", () => {
  const codex = { tasks: [{ ...milestonesTables().tasks[0], id: "T5", state: "framed", milestone: "M1" }],
    gates: [{ id: "G1", task: "T5", question: "Approve milestone M1? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    milestones: [{ id: "M1", name: "Codex own", goal: "g", pilot: "T5", gate: "G1", at: "" }], decisions: [] };
  const claude = { ...codex, milestones: [{ ...codex.milestones[0], name: "Claude own" }] };
  const text = renderBoardText(buildBoardModel([milestonesSource("claude", claude), milestonesSource("codex", codex)], { now: MILESTONES_NOW }));
  assert.ok(partOf(text, "Needs you").startsWith("- Claude own. Approve milestone M1? No task builds before you approve.\n  Options: 1 approve · 2 change · 3 drop.\n  Recommended: approve.\n- Codex own. Approve milestone M1?"), text);
  assert.equal(text.split("\n").at(-1), "Ref: T5 M1 claude/sage-ff5ee2/G1 T5 M1 codex/sage-ff5ee2/G1");
});

test("F-T233-6: the chat board drops format characters and makes controls and separators a space, and a gate line that starts with a block mark stays inside its item", () => {
  const tables = milestonesTables();
  tables.milestones[2].name = "Evil\u202eEXE\u200bzero\u2028line\u2029para\u0085next\u009bend";
  tables.gates.find(gate => gate.id === "G12").question = ["Approve milestone M3? No task builds before you approve.", "===", "---", "- item", "  = two", "Goal: \u202eflip"].join("\u2028");
  const text = milestonesText(tables);
  assert.ok(partOf(text, "Needs you").startsWith("- EvilEXEzero line para next end. Approve milestone M3? No task builds before you approve. · === · --- · - item · = two · Goal: flip\n"), partOf(text, "Needs you"));
  assert.ok(partOf(text, "Milestones").includes("\n- EvilEXEzero line para next end: the breakdown waits for you.\n"), partOf(text, "Milestones"));
  assert.ok(!/[\u202e\u200b\u2028\u2029\u0085\u009b]/.test(text), "no hidden or format character reaches the chat");
  assert.deepEqual(partOf(text, "Needs you").split("\n").filter(line => !/^(- |  [OR])/.test(line)), [], "each line is an item or its Options or Recommended line");
});

test("F-T233-10: a dropped milestone that still has open tasks has its own Milestones line; one with none has no line", () => {
  assert.ok(partOf(milestonesText(milestonesTables()), "Milestones").includes("\n- Dropped idea: dropped, with 1 task still in it. Ask the chief to take the task out of the milestone.\n"));
  const out = milestonesTables();
  out.tasks.find(item => item.id === "T60").milestone = "";
  assert.ok(!milestonesText(out).includes("Dropped idea"));
});

test("F-T233-2, F-T233-3, F-T233-7: a milestone whose gate is not its breakdown gate by the data rule points to Needs you, and Needs you shows that problem once", () => {
  const plain = milestonesTables();
  plain.gates.find(gate => gate.id === "G12").options = "yes|no";
  const model = buildBoardModel([milestonesSource("claude", plain)], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(partOf(text, "Milestones").includes("\n- Board milestones: its breakdown question has a problem. See Needs you.\n"), text);
  assert.ok(partOf(text, "Needs you").includes("\n- Sample T30. Approve milestone M3? No task builds before you approve. Name: Board milestones Goal: Sample goal. Pilot, runs first: T30: Sample T30 · Board milestones: the question that it names is not a breakdown question on its pilot task. Ask the chief to repair the logbook, or to propose the milestone again.\n  Options: 1 yes · 2 no.\n"), text);
  assert.equal(text.split("not a breakdown question on its pilot task").length, 2, "one item says it");
  assert.equal(model.counts.needsOwner, 4, "T30, T70 and the two other milestone items: G12 counts once");
  const edited = milestonesTables();
  edited.gates.find(gate => gate.id === "G12").question = "Ship it?";
  const shipped = milestonesText(edited);
  assert.ok(!shipped.includes("breakdown waits for you"), shipped);
  assert.ok(partOf(shipped, "Needs you").includes("\n- Sample T30. Ship it? · Board milestones: its breakdown question names no milestone. Ask the chief to repair the logbook, or to propose the milestone again.\n"), shipped);
  const one = milestonesTables().tasks[0];
  const twin = {
    tasks: [{ ...one, id: "T1", state: "framed", milestone: "M1" }, { ...one, id: "T2", state: "framed", milestone: "M2" }],
    gates: [{ id: "G1", task: "T1", question: "Approve milestone M2? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    milestones: [{ id: "M1", name: "First", goal: "g", pilot: "T1", gate: "G1", at: "" }, { id: "M2", name: "Second", goal: "g", pilot: "T1", gate: "G1", at: "" }], decisions: [] };
  const both = milestonesText(twin);
  assert.equal(partOf(both, "Milestones"), "- First: its breakdown question has a problem. See Needs you.\n- Second: the breakdown waits for you.");
  assert.ok(partOf(both, "Needs you").startsWith("- Second. Approve milestone M2? No task builds before you approve. · First: its breakdown question names another milestone. Ask the chief to repair the logbook, or to propose the milestone again.\n"), both);
});

const noMilestones = (reason = "milestones: line 3 has 4 cells, and its header has 6") => {
  const tables = milestonesTables();
  delete tables.milestones;
  const source = milestonesSource("claude", tables);
  source.projects[0].diagnostics = [reason];
  return source;
};

test("R1307-1: when the milestones table cannot be read, the board shows no milestone, and Needs you says why, in full, first", () => {
  const model = buildBoardModel([noMilestones()], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(partOf(text, "Needs you").startsWith("- The milestones table cannot be read. milestones.tsv line 3 has 4 cells, and its header has 6. The board shows the tasks without their milestones. Ask the chief to repair the logbook.\n- Sample T30. "), text);
  assert.equal(partOf(text, "Milestones"), "No milestone is open.");
  assert.deepEqual([model.counts.needsOwner, model.projects[0].needsOwner, model.milestoneNeeds.length, model.projects[0].name], [3, 3, 1, "sage (sample)"]);
  assert.deepEqual(model.tasks.filter(task => task.milestone || task.waits.some(wait => wait.breakdown || wait.pilot)).map(task => task.id), []);
  assert.equal(buildBoardModel([noMilestones("milestones: ENOENT")], { now: MILESTONES_NOW }).milestoneNeeds[0].text, "milestones.tsv is missing. The board shows the tasks without their milestones. Ask the chief to repair the logbook.");
});

test("R1307-2: a logbook that the board cannot read is an item of Needs you, with the reason", () => {
  const codex = milestonesSource("codex", { gates: [], runs: [] });
  codex.projects[0].diagnostics = ["tasks: line 14 has 9 cells, and its header has 16"];
  const model = buildBoardModel([milestonesSource(), codex], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(partOf(text, "Needs you").includes("\n- The Codex logbook cannot be read. tasks.tsv line 14 has 9 cells, and its header has 16. The board shows only the Claude logbook of sage (sample). Ask the chief to repair the logbook.\n- Sample T70. "), text);
  assert.deepEqual([model.projects[0].needsOwner, model.milestoneNeeds.length], [5, 3]);
  const runs = sample([row("T1", "framed")], {}, { diagnostics: ["runs: EACCES", "artifact A1: artifact digest does not match"] });
  assert.deepEqual(runs.milestoneNeeds.map(need => [need.title, need.text]), [["The Sample logbook cannot be read", "runs.tsv has no read permission. The board shows its tasks without the rows of runs.tsv. Ask the chief to repair the logbook."]]);
  assert.equal(runs.counts.needsOwner, 1);
});

test("T374-8: a project of the model has no milestoneNeeds field", () => {
  const model = milestonesModel();
  assert.deepEqual([Object.hasOwn(model.projects[0], "milestoneNeeds"), model.milestoneNeeds.length, model.projects[0].needsOwner], [false, 2, 4]);
});

test("T383 item 11: Needs you has one item for each answer: a pilot with a breakdown gate and a plain gate is two items", () => {
  const tables = milestonesTables();
  tables.gates.push({ id: "G40", task: "T30", question: "Logo A or B?", options: "A|B", recommendation: "", default: "", answer: "", at: "" });
  const items = partOf(milestonesText(tables), "Needs you").split("\n").filter(line => line.startsWith("- "));
  assert.equal(items.length, 5, "G12, then M2 and M7, then T30's G40 and T70");
  assert.equal(items[3], "- Sample T30. Logo A or B?");
});

test("T383 item 10: an unreadable provider root is an item of Needs you under Every project, so the board groups by project", () => {
  const root = { id: "codex", label: "codex", provider: null, config: {}, diagnostics: ["EACCES"], projects: [], hooks: { present: false, slots: [], helpers: [], problem: null } };
  const text = renderBoardText(buildBoardModel([milestonesSource(), root], { now: MILESTONES_NOW }));
  assert.ok(partOf(text, "Needs you").startsWith("sage (sample)\n- Board milestones. "), text);
  assert.ok(partOf(text, "Needs you").endsWith("\n\nEvery project\n- The Codex logbooks cannot be read. Its folder has no read permission. The board shows no Codex logbook. Check that the board can read the folder."), text);
});

test("T390: the chat board calls the main session the chief, never the sage", () => {
  const data = milestonesModel();
  const pages = { chat: renderBoardText(data), status: renderBoardStatus(data), ...Object.fromEntries(data.tasks.map(task => [task.id, renderTaskText(task)])) };
  for (const [name, page] of Object.entries(pages)) assert.ok(!/\bthe sage\b/i.test(page), `${name}: ${page.match(/.{60}\bthe sage\b.{60}/i)?.[0]}`);
  assert.ok(pages.chat.includes("\n- Changes: the chief revises the breakdown.\n"));
});

test("R1508-1: a milestone row with an empty gate cell names no breakdown gate; only a missing row is not in the logbook", () => {
  const tables = milestonesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T62", state: "framed", milestone: "M41" }, { ...tables.tasks[0], id: "T63", state: "framed", milestone: "M41" });
  tables.milestones.push({ ...tables.milestones[0], id: "M41", name: "No gate", pilot: "T62", gate: "" });
  const model = milestonesModel(tables);
  assert.equal(model.tasks.find(task => task.id === "T63").waitLine.text, "Waits for the breakdown of milestone 41, whose milestone names no breakdown gate: it cannot start.");
  const text = renderBoardText(model);
  assert.ok(partOf(text, "Milestones").endsWith("\n- No gate: its breakdown question has a problem. See Needs you."), text);
  assert.ok(!/gate {2}is/.test(text), "no double space where the gate is empty");
});

test("R1509-1, R1535-1: in a proposed milestone, a loop of waits shows in the wait lines, for the pilot too", () => {
  const tables = milestonesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T66", title: "Sample pilot of a loop", state: "framed", milestone: "M40", waits: "T67" }, { ...tables.tasks[0], id: "T67", state: "framed", milestone: "M40", waits: "T66" });
  tables.milestones.push({ ...tables.milestones[0], id: "M40", name: "Loop in a proposal", pilot: "T66", gate: "G40" });
  tables.gates.push({ ...tables.gates[0], id: "G40", task: "T66", question: tables.gates[0].question.replace(/M1/g, "M40").replace(/T1\b/g, "T66"), answer: "" });
  const model = milestonesModel(tables), card = id => model.tasks.find(task => task.id === id);
  const line = (id, word) => `Waits for ${id} (${word}, in a loop) and your approval of milestone 40 (gate G40): it cannot start. Its waits make a loop, which never ends: the chief sets its waits again.`;
  assert.deepEqual([card("T67").waitLine, card("T66").waitLine], [{ never: true, text: line("T66", "needs you") }, { never: true, text: line("T67", "waiting") }]);
  assert.ok(partOf(renderBoardText(model), "Needs you").includes("\n- Loop in a proposal. Approve milestone M40?"), "the chat board asks for the approval");
});
test("F-T420-1, R1551: the chat task lookup shows a stuck wait", () => {
  const tables = milestonesTables();
  const sample = (id, milestone, waits) => ({ ...tables.tasks.find(task => task.id === "T32"), id, title: `Sample ${id}`, milestone, waits });
  tables.tasks.push(sample("T33", "M3", "T52"), sample("T91", "M9", "T10"));
  const model = milestonesModel(tables), lookup = id => renderTaskText(model.tasks.find(task => task.id === id)).split("\n\n**Brief**")[0];
  assert.ok(lookup("T11").includes("\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\n⊘ Now: Waits for T10 \\(stopped\\)\\: it cannot start\\.\nNext: Nothing until the wait changes\\. Ask the chief to remove the wait, or to drop this task\\.\n○ Plan: not started"), lookup("T11"));
  assert.ok(!lookup("T11").includes("Next: The build"), lookup("T11"));
  assert.ok(lookup("T13").includes("\n⧗ Now: Waits for T12 \\(in progress\\)\\.\nNext: Starts when T12 merges\\.\n"), lookup("T13"));
  tables.gates.push({ id: "G40", task: "T11", question: "Sample: go on?", options: "yes|no", recommendation: "yes", default: "", answer: "", at: "2026-10-20T10:00:00Z" });
  const asked = renderTaskText(milestonesModel(tables).tasks.find(task => task.id === "T11"));
  assert.ok(/\nNeeds you: [^\n]*go on\?[^\n]*\n⊘ Waits for T10 \\\(stopped\\\)\\: it cannot start\\\.\nNext: Nothing until the wait changes/.test(asked), asked);
});

test("T995: no chat view of the milestones sample says program or names an old program id", () => {
  const model = milestonesModel();
  const pages = { chat: renderBoardText(model), status: renderBoardStatus(model), ...Object.fromEntries(model.tasks.map((t) => [t.id, renderTaskText(t)])) };
  assert.ok(model.milestones.length > 3 && pages.chat.includes("Milestones"), "the sample has milestones");
  for (const [name, page] of Object.entries(pages)) assert.doesNotMatch(page, /\bprograms?\b|\bPG\d/i, name);
});

const digest = (sources = digestSources(), zone = "America/New_York") => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { return renderBoardText(buildBoardModel(sources, { now: DIGEST_NOW, landing }), { port: 50123 }); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};
const heads = text => text.split("\n").filter(line => line.startsWith("### ")).map(line => line.replace(/^### (?:🔴 )?/, ""));

test("T1217: the digest gives the four parts in order, then the board link, then the Ref line last", () => {
  const text = digest(), lines = text.split("\n");
  assert.deepEqual(heads(text), ["Needs you", "Moving now", "Done since yesterday", "Milestones"]);
  assert.equal(lines.at(-3), "More: http://127.0.0.1:50123");
  assert.match(lines.at(-1), /^Ref: /);
  assert.ok(text.indexOf("Quiet: ") > text.indexOf("### Milestones") && text.indexOf("Quiet: ") < text.indexOf("More: "), text);
});

test("T1217: the digest is plain words with no backslash, and agent text makes no link, image or HTML", () => {
  const sources = digestSources();
  sources[0].projects[1].tables.gates[0].question = "Checkout layout: A (one page) or B [three steps]? See ![x](https://example.test/x.png) <b>now</b>";
  const text = digest(sources);
  assert.ok(!text.includes(String.fromCharCode(92)), text);
  assert.ok(text.includes("- Checkout layout. Checkout layout: A (one page) or B [three steps]? See ![x] (https://example.test/x.png) ‹b›now‹/b›\n  Options: 1 A · 2 B.\n  Recommended: A.\n"), text);
  assert.ok(!text.includes("](") && !text.includes("<"), "no markdown link or image, and no HTML tag");
});

test("T1257: the digest names each task by its short name, never its long title; a task with no name shows the name that the board makes from its title", () => {
  const text = digest();
  assert.ok(text.includes("\n- Free hook slots. Building, 20 min.\n"), text);
  assert.ok(!text.includes(LONG_TITLE.slice(0, 30)), "the long title does not show");
  assert.ok(text.includes("\n- The board answers while. In review, cycle 1 of 1, 5 min."), "no name: the first words of the title");
});

test("T1217: times are in the local zone, named once in the head line", () => {
  const york = digest(), tokyo = digest(undefined, "Asia/Tokyo");
  assert.equal(york.split("\n")[0], "sage board · 10:43 UTC-05:00");
  assert.equal(tokyo.split("\n")[0], "sage board · 00:43 UTC+09:00");
  assert.ok(york.includes("- Read-only roles. Merged at 09:40.\n"), york);
  assert.ok(york.includes("- Two prior-art links. Merged yesterday at 11:43.\n"), york);
  assert.ok(tokyo.includes("- Read-only roles. Merged yesterday at 23:40.\n"), "in Tokyo the board is past midnight, so the same merge was yesterday");
  for (const text of [york, tokyo]) assert.equal(text.match(/UTC/g).length, 1, "the zone is named once");
});

test("T1217: the digest leaves out the backlog, the sessions, the pick-ups, the step lines and what was done before yesterday", () => {
  const text = digest();
  for (const gone of ["A task in the backlog", "A second task in the backlog", "Someday", "An old merge from last week", "Backlog", "Sessions", "Pick-ups", "›", "Now: ", "P1", "Bug fix"]) assert.ok(!text.includes(gone), gone);
  assert.ok(text.includes("Cart total") && text.includes("Two prior-art links"), "the sample has work that shows");
});

test("T1217: a chief that stopped with open work is one line under Needs you; a live chief has no line", () => {
  const needs = partOf(digest(), "Needs you").split("\n");
  assert.deepEqual(needs.filter(line => /chief/i.test(line)), ["- A Claude chief stopped at 07:33 with 2 open tasks. The next chief that works in this project picks them up."]);
  const sources = digestSources();
  sources[0].projects[0].chiefLive.C1 = { at: Date.parse(DIGEST_NOW) - 60_000 };
  assert.ok(!/chief stopped/.test(digest(sources)), "C1 is live now: no line");
});

test("T1217: task, gate, milestone, chief and PR ids show only on the Ref line, which keeps each one", () => {
  const lines = digest().split("\n"), ref = lines.at(-1);
  const id = /\b(?:[TGMRC][1-9]\d*|PR \d+)\b|c0ffee1/;
  assert.deepEqual(lines.slice(0, -1).filter(line => id.test(line)), [], "no id above the Ref line");
  assert.ok(lines.includes("- Board-only links. The board cannot tell if autopilot is on, so review and merge its PR."), lines.join("\n"));
  assert.equal(ref, "Ref: sage-stack T1205 PR 645 T1210 claude/sage-stack-aaaaaa/G236 C1 T1204 T1206 PR 640 T1199 PR 641 T1190 PR 630 M7 · sedalina T88 claude/sedalina-bbbbbb/G62 T89");
});

test("T1217: each part groups its lines by project when two or more projects have work, and not when one has", () => {
  const two = digest();
  assert.ok(partOf(two, "Needs you").startsWith("sage-stack\n- ") && partOf(two, "Needs you").includes("\n\nsedalina\n- Checkout layout."), two);
  assert.equal(partOf(two, "Moving now").split("\n").filter(line => !line.startsWith("- ")).join("|"), "sage-stack||sedalina");
  const sources = digestSources();
  sources[0].projects[1].tables = { tasks: [] };
  const one = digest(sources);
  for (const label of ["Needs you", "Moving now", "Done since yesterday", "Milestones"]) assert.ok(partOf(one, label).split("\n").every(line => /^(- |  )/.test(line)), `${label}: no project line`);
  assert.ok(!one.includes("Ref: sage-stack"), "one project: the Ref line names no project");
});

test("T1217: a Quiet line counts the projects with nothing that moves or needs you", () => {
  assert.ok(digest().includes("\n\nQuiet: 1 other project has nothing that moves or needs you.\n\n"));
  const sources = digestSources();
  for (const project of sources[0].projects) project.tables = { tasks: [] };
  const empty = digest(sources);
  assert.ok(empty.includes("### Needs you\nNothing waits for you.\n\n### Moving now\nNo task moves now."), "no red mark when nothing waits");
  assert.ok(empty.includes("\n\nQuiet: 3 projects have nothing that moves or needs you.\n\n"), empty);
});

test("T1223: the chat digest and the board give each task the same row state, from the one function in core", () => {
  const sources = digestSources(), stack = sources[0].projects[0];
  stack.tables.tasks.push(
    { ...stack.tables.tasks[0], id: "T1211", name: "Briefed task", title: "Briefed and waiting for its build agent", state: "briefed", milestone: "" },
    { ...stack.tables.tasks[0], id: "T1212", name: "Abandoned task", title: "Abandoned with its question still open", state: "abandoned", milestone: "" });
  stack.tables.gates.push({ id: "G237", task: "T1212", question: "Keep the abandoned branch?", options: "yes|no", recommendation: "no", default: "", answer: "", at: "2026-11-23T15:00:00Z" });
  const model = buildBoardModel(sources, { now: DIGEST_NOW, landing });
  const board = Object.fromEntries(boardOverview(model).tasks.map(row => [row.id, row.row]));
  const text = digest(sources), parts = ["Needs you", "Moving now", "Done since yesterday"];
  const placed = Object.fromEntries(model.tasks.map(task => [task.id, parts.filter(label => partOf(text, label).includes(`- ${task.name}.`))]));
  const rows = { T1204: "work", T1206: "work", T1205: "needs", T1210: "needs", T88: "needs", T89: "work", T1211: "waits", T1150: "waits", T1151: "waits", T3: "waits", T1199: "done", T1190: "done", T1180: "done", T1212: "done" };
  const PLACE = { needs: ["Needs you"], work: ["Moving now"], waits: ["Moving now"], done: ["Done since yesterday"] };
  const backlog = ["T1150", "T1151", "T3"], older = ["T1180", "T1212"];
  assert.deepEqual({ board, digest: placed }, { board: rows, digest: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, backlog.includes(id) || older.includes(id) ? [] : PLACE[row]])) },
    "a row that waits shows under Moving now past the backlog; done shows for today and yesterday; abandoned is done, also with its question open");
});
