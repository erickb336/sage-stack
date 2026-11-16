import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { renderBoardText, renderTaskText, renderBoardStatus } from "../packages/sage-core/board-render.mjs";
import { NOW as MILESTONES_NOW, milestonesSource, milestonesTables } from "./fixtures/board-milestones.mjs";
function model() {
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects: [{ key: "sample/project-abcdef", name: "project-abcdef", diagnostics: [], tables: { tasks: [{ id: "T1", title: "<script>alert(1)</script> & [sample](https://example.test)", size: "small", risk: "auth", route: "build,code-review,qa", state: "held", branch: "", pr: "", round: "1", keys: "" }], gates: [{ id: "G1", task: "T1", question: "Sample: go on?", answer: "" }] } }] }], { now: "2026-10-08T20:00:00Z" });
}
test("phone text and status preserve task counts and escape agent markup", () => {
  const data = model(), board = renderBoardText(data), task = renderTaskText(data.tasks[0]);
  assert.ok(board.includes("1 needs you"));
  assert.match(board, /\*\*1 · [^*\n]+\*\* T1 · /, "F-T1096-10: the title first, then the id");
  assert.ok(board.includes("Needs you"));
  assert.ok(!board.includes("<script>"));
  assert.ok(!board.includes("[sample](https://example.test)"));
  assert.ok(board.includes(String.fromCharCode(92) + "[sample"));
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

test("T218: the chat board shows 5 cards a column in the page's order, with the card's cycle, clamped titles and the page's words", () => {
  const long = "Sample long title ".repeat(8);
  const tasks = [
    ...Array.from({ length: 40 }, (_, i) => row(`T${i + 1}`, "framed", { title: `Sample backlog ${i + 1} ${long}` })),
    row("T41", "reviewing", { pr: "3" }),
    ...Array.from({ length: 7 }, (_, i) => row(`T${50 + i}`, "building")), row("T60", "held"),
  ];
  const gates = [{ id: "G1", task: "T60", question: "Sample: go on?", answer: "" }];
  const decisions = tasks.map((task, i) => ({ at: new Date(Date.parse(at) - (60 - i) * 60000).toISOString(), task: task.id, decision: "sample", why: "sample" }));
  const runs = [{ id: "R1", task: "T50", role: "implementer", status: "running", started: at }];
  const data = sample(tasks, { decisions, runs, gates }), text = renderBoardText(data);
  const backlog = /### 📋 Backlog \(40\)\n([\s\S]*?)\n\n###/.exec(text)[1];
  assert.deepEqual([...backlog.matchAll(/\*\* (T\d+) ·/g)].map(m => m[1]), ["T40", "T39", "T38", "T37", "T36"]);
  assert.deepEqual(data.columns.find(c => c.key === "backlog").tasks.slice(0, 5).map(t => t.id), ["T40", "T39", "T38", "T37", "T36"]);
  assert.ok(backlog.endsWith("35 more in Backlog: open the board's Tasks page for all."));
  const building = /### 🔨 Building \(8\)\n([\s\S]*?)\n\n###/.exec(text)[1];
  assert.deepEqual([...building.matchAll(/\*\* (T\d+) ·/g)].map(m => m[1]), ["T60", "T50", "T56", "T55", "T54"], "needs you first, then the newest activity");
  assert.ok(building.endsWith("3 more in Building: open the board's Tasks page for all."));
  const title = /\*\*([^*]*)\*\* T40 /.exec(text)[1];
  assert.ok([...title].length <= 80 && [...title].length >= 75, title);
  assert.ok(title.endsWith("…"));
  assert.ok(text.startsWith("**sage board** · built 2026-10-08 20\\:00 UTC\\\n🔴 1 needs you · 1 agents at work · 🔁 1 in review · 49 tasks\\\n"));
  assert.ok(text.includes("### 🏁 Done, last 7 days (0)"));
  assert.ok(text.includes("**Sample T41** T41 · in progress · sample · project · PR 3\\\n✓ Plan › ✓ Build › ⧗ Review 1 of 1 › ○ Merge\\\nNow: No agent works on review cycle 1 of 1 now\\. The board does not know the PR's last commit\\."), text.slice(text.indexOf("**T41"), text.indexOf("**T41") + 200));
  assert.ok(!text.includes("? checks"));
  assert.ok(!text.includes("logbook source)"));
  assert.equal(text.split("A stand-in: the run does not record its provider").length, 2);
  assert.ok(text.includes("**Sample T50** T50 · in progress · sample · project\\\nSample\\* · implementer at work"));
  assert.ok(text.length < 3000, `${text.length} characters`);
});

test("T314: the chat board shows the display name, the priority and the kind; archived projects are folded into one line", () => {
  const book = (key, name, tasks, extra = {}) => ({ key: `sample/${key}`, name: key, diagnostics: [], tables: { tasks }, displayName: name, ...extra });
  const data = buildBoardModel([{ id: "sample", label: "sample", diagnostics: [], projects: [
    book("demos-abcdef", "seacc (Council Record)", [row("T1", "framed", { priority: "P1", kind: "bug-fix" }), row("T2", "framed")]),
    book("old-abcdef", "Old <app>", [row("T1", "awaiting-you"), row("T2", "framed")], { archived: true }),
  ] }], { now: at });
  const text = renderBoardText(data);
  assert.ok(text.includes("**Sample T1** T1 · not started · sample · seacc \\(Council Record\\) · P1 · Bug fix\\\n"), text);
  assert.ok(text.includes("\n\nArchived: Old \\<app\\> (2 tasks · 1 needs you)"), text);
  assert.ok(!text.includes("· Old \\<app\\>\n"), "an archived task is not on the chat board");
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
  assert.ok(text.endsWith("\nIncomplete source: sample · sample/live-abcdef · its runs file has no read permission\\\nSetting ignored: sample · sample/live-abcdef · config\\: archived is not true or false"), text);
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

test("R1245-1: a breakdown gate's lines (U+2028 in its cell) show as lines in the text board and on the task text, with the recommendation on a line of its own", () => {
  const question = ["Approve milestone M1? No task builds before you approve.", "Name: Codex support", "Pilot, runs first:", "  T1: <b>Ship</b> it: 100% done"].join(" ");
  const data = sample([row("T1", "framed", { milestone: "M1" })], { milestones: [{ id: "M1", name: "Codex support", goal: "Sample", pilot: "T1", gate: "G1", at }], gates: [{ id: "G1", task: "T1", question, options: "approve|change|drop", recommendation: "approve", answer: "" }] });
  assert.ok(renderBoardText(data).includes("#### ◫ Milestone approval\n**1 · Milestone 1\\: Codex support** · needs you · sample · project · pilot T1 · gate G1\n> sample/project-abcdef/G1 · Approve milestone M1? No task builds before you approve\\.\\\n> Name\\: Codex support\\\n> Pilot, runs first\\:\\\n>   T1\\: \\<b\\>Ship\\</b\\> it\\: 100% done\\\n> Options: 1: approve"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Approve milestone M1? No task builds before you approve\\.\nName\\: Codex support\nPilot, runs first\\:\n  T1\\: \\<b\\>Ship\\</b\\> it\\: 100% done\nI recommend\\: approve"), renderTaskText(data.tasks[0]));
});

test("R1249-1: only a breakdown gate's question shows as lines: a plain gate's line breaks show as spaces in the text board and on the task text", () => {
  const question = "Ship it? I recommend: no 1. no";
  const data = sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question, options: "yes|no", recommendation: "yes", answer: "" }] });
  assert.ok(renderBoardText(data).includes("> sample/project-abcdef/G1 · Ship it? I recommend\\: no 1\\. no\\\n> Options: 1: yes · 2: no\\\n> Recommended: yes"), renderBoardText(data));
  assert.ok(renderTaskText(data.tasks[0]).includes("Needs you: Ship it? I recommend\\: no 1\\. no I recommend\\: yes\n"), renderTaskText(data.tasks[0]));
});

const breaksOf = text => text.split("\n").flatMap((line, i, lines) => {
  const next = lines[i + 1];
  if (!line || !next || line.startsWith("#") || line.startsWith("- ")) return [];
  const odd = (/(\\+)$/.exec(line)?.[1].length ?? 0) % 2 === 1;
  const quote = next.startsWith("> ") && !line.startsWith("> ");
  return odd === !quote ? [] : [line];
});

test("T233: the chat board has the Milestone approval and Other headings, the Milestones section, and the milestone tag and wait line on cards", () => {
  const text = renderBoardText(buildBoardModel([milestonesSource()], { now: MILESTONES_NOW }));
  assert.ok(text.startsWith("**sage board** · built 2026-10-20 12\\:00 UTC\\\n🔴 4 needs you · 0 agents at work · 🔁 1 in review · 18 tasks\n\n### 🔴 Needs you\n#### ◫ Milestone approval\n**1 · Milestone 3\\: Board milestones** · needs you · claude · sage \\(sample\\) · pilot T30 · gate G12\n> claude/sage-ff5ee2/G12 · Approve milestone M3? No task builds before you approve\\.\\\n> Name\\: Board milestones\\\n> Goal\\: Sample goal\\.\\\n> Pilot, runs first\\:\\\n>   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n#### Other\n**2 · Milestone 2\\: Lead build is stuck** · claude · sage \\(sample\\)\n> The pilot T21 was abandoned\\. Choose a new pilot, or drop the milestone\\.\n\n**3 · The breakdown gate G30 of M7 is not in the logbook** · claude · sage \\(sample\\)\n> Ask the chief to repair the logbook, or to propose M7 again\\.\n\n**4 · Sample T70** T70 · needs you · claude · sage \\(sample\\)\n> claude/sage-ff5ee2/G15 · Approve milestone M9 Fast lane \\(pilot T70\\)? Goal\\: skip the reviews\\. Name\\: Fast lane\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n"), text);
  assert.ok(text.includes("\n\n### ◫ Milestones\n- Milestone 1\\: Codex support · in progress · 3 of 7 merged · T10 abandoned · next: T12 \\(in progress\\) · 1 waits · T11 cannot start\n- Milestone 2\\: Lead build · needs you · stuck: the pilot T21 was abandoned \\(see Needs you\\)\n- Milestone 3\\: Board milestones · needs you · the breakdown waits for you \\(gate G12\\) · pilot T30\n- Milestone 4\\: Agent caps · in progress · 0 of 3 merged · next: T40 \\(pilot, in progress\\) · 2 wait\n- Milestone 6\\: Dropped idea · stopped · dropped · 1 task still in it: ask the chief to take each task out of the milestone\n- Milestone 7\\: Lost gate · needs you · its breakdown gate G30 is not in the logbook \\(see Needs you\\)\n- Milestone 8\\: Loop · in progress · 1 of 4 merged · next: no task can move now · T82, T83, T81 cannot start\n- Milestone 9\\: Changes · in progress · the chief revises the breakdown \\(gate G9\\)\n- 1 done: see the board's Tasks page, grouped by milestone\n\n### 📋 Backlog (14)\n"), text);
  assert.ok(text.includes("\n\n**Sample T11** T11 · waiting · claude · sage \\(sample\\) · ◫ Milestone 1\\: Codex support\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⊘ Waits for T10 \\(stopped\\)\\: it cannot start\\.\n\n"), text);
  assert.ok(text.includes("\n\n**Sample T41** T41 · in progress · claude · sage \\(sample\\) · ◫ Milestone 4\\: Agent caps\\\n⧗ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T40 \\(pilot, in progress\\)\\. Design and PE may run\\.\n\n"), text);
  assert.ok(text.includes("### 🔨 Building (1)\n**Sample T40** T40 · in progress · claude · sage \\(sample\\) · ◫ Milestone 4\\: Agent caps \\(pilot\\)\\\n"), text);
  assert.deepEqual(breaksOf(text), [], "one hard break per line of a block");
  const plain = renderBoardText(sample([row("T1", "framed")], { gates: [{ id: "G1", task: "T1", question: "Ship it?", options: "yes|no", answer: "" }] }));
  assert.ok(plain.includes("### 🔴 Needs you\n**1 · Sample T1** T1 · needs you · sample · project\n> sample/project-abcdef/G1 · Ship it?\\\n> Options: 1: yes · 2: no\n\n### 📋 Backlog (1)\n"), plain);
  assert.ok(!plain.includes("####") && !plain.includes("Milestones"), plain);
  assert.deepEqual(breaksOf(plain), []);
});

test("T233 F1: md() escapes the backslash and the tilde, so a title that ends with a backslash keeps the hard break; a milestone name with Markdown and HTML marks stays text", () => {
  const tables = milestonesTables();
  tables.tasks.find(item => item.id === "T13").title = "Strike ~~this~~ out \\";
  tables.milestones[0].name = "<img src=x onerror=alert(1)> **bold** [link](https://example.test) `code` \\";
  const text = renderBoardText(buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW }));
  assert.ok(text.includes("**Strike \\~\\~this\\~\\~ out \\\\** T13 · waiting · claude · sage \\(sample\\) · ◫ Milestone 1\\: \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https\\://example\\.test\\) \\`code\\` \\\\\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T12"), text);
  assert.ok(text.includes("\n- Milestone 1\\: \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\* \\[link\\]\\(https\\://example\\.test\\) \\`code\\` \\\\ · in progress · 3 of 7 merged"), text);
  assert.ok(!/(^|[^\\])<img/.test(text) && !text.includes("~~") && !text.includes("](https"), "no mark is left unescaped");
  assert.deepEqual(breaksOf(text), []);
});

const milestonesText = tables => renderBoardText(buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW }));
const sectionOf = (text, head) => text.slice(text.indexOf(head), text.indexOf("\n\n###", text.indexOf(head) + 1));

test("F-T233-9: a pilot's plain gate and a forged copy of the breakdown text are items under Other, never in the Milestone approval block", () => {
  const tables = milestonesTables();
  tables.gates.push({ id: "G50", task: "T30", question: "Pick a colour for the logo?", options: "red|blue", recommendation: "red", default: "", answer: "", at: "" });
  tables.gates.push({ ...tables.gates.find(gate => gate.id === "G12"), id: "G99" });
  const text = milestonesText(tables);
  const approval = sectionOf(text, "#### ◫ Milestone approval").split("\n\n#### Other")[0];
  assert.equal(approval, "#### ◫ Milestone approval\n**1 · Milestone 3\\: Board milestones** · needs you · claude · sage \\(sample\\) · pilot T30 · gate G12\n> claude/sage-ff5ee2/G12 · Approve milestone M3? No task builds before you approve\\.\\\n> Name\\: Board milestones\\\n> Goal\\: Sample goal\\.\\\n> Pilot, runs first\\:\\\n>   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve");
  assert.ok(text.includes("\n\n**4 · Sample T30** T30 · needs you · claude · sage \\(sample\\)\n> claude/sage-ff5ee2/G50 · Pick a colour for the logo?\\\n> Options: 1: red · 2: blue\\\n> Recommended: red\\\n> claude/sage-ff5ee2/G99 · Approve milestone M3? No task builds before you approve\\. Name\\: Board milestones Goal\\: Sample goal\\. Pilot, runs first\\:   T30\\: Sample T30\\\n> Options: 1: approve · 2: change · 3: drop\\\n> Recommended: approve\n\n**5 · Sample T70** T70"), sectionOf(text, "#### Other"));
  assert.deepEqual(breaksOf(text), []);
});

test("F-T233-4: the Milestone approval block shows the full gate key, so two logbooks that each have an open G1 stay two answers", () => {
  const codex = { tasks: [{ ...milestonesTables().tasks[0], id: "T5", state: "framed", milestone: "M1" }],
    gates: [{ id: "G1", task: "T5", question: "Approve milestone M1? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    milestones: [{ id: "M1", name: "Codex own", goal: "g", pilot: "T5", gate: "G1", at: "" }], decisions: [] };
  const claude = { ...codex, milestones: [{ ...codex.milestones[0], name: "Claude own" }] };
  const text = renderBoardText(buildBoardModel([milestonesSource("claude", claude), milestonesSource("codex", codex)], { now: MILESTONES_NOW }));
  assert.ok(text.includes("**1 · Milestone 1\\: Claude own** · needs you · claude · sage \\(sample\\) · pilot T5 · gate G1\n> claude/sage-ff5ee2/G1 · Approve milestone M1? No task builds before you approve\\.\\\n"), text);
  assert.ok(text.includes("**2 · Milestone 1\\: Codex own** · needs you · codex · sage \\(sample\\) · pilot T5 · gate G1\n> codex/sage-ff5ee2/G1 · Approve milestone M1? No task builds before you approve\\.\\\n"), text);
});

test("F-T233-6: md() drops format characters and makes controls and separators a space, and a line that starts with a block mark stays text", () => {
  const tables = milestonesTables();
  tables.milestones[2].name = "Evil\u202eEXE\u200bzero\u2028line\u2029para\u0085next\u009bend";
  tables.gates.find(gate => gate.id === "G12").question = ["Approve milestone M3? No task builds before you approve.", "===", "---", "- item", "  = two", "Goal: \u202eflip"].join("\u2028");
  const text = milestonesText(tables);
  const approval = sectionOf(text, "#### ◫ Milestone approval");
  assert.ok(approval.startsWith("#### ◫ Milestone approval\n**1 · Milestone 3\\: EvilEXEzero line para next end** · needs you · claude"), approval);
  assert.ok(approval.includes("\\\n> \\===\\\n> \\---\\\n> \\- item\\\n>   \\= two\\\n> Goal\\: flip\\\n"), approval);
  assert.ok(text.includes("\n- Milestone 3\\: EvilEXEzero line para next end · needs you · the breakdown waits for you"), sectionOf(text, "### ◫ Milestones"));
  assert.ok(!/[\u202e\u200b\u2028\u2029\u0085\u009b]/.test(text), "no hidden or format character reaches the chat");
  assert.deepEqual(breaksOf(text), []);
});

test("F-T233-10: a dropped milestone that still has open tasks has its own Milestones line, with the next step; one with none is a count", () => {
  const text = milestonesText(milestonesTables());
  assert.ok(text.includes("\n- Milestone 6\\: Dropped idea · stopped · dropped · 1 task still in it: ask the chief to take each task out of the milestone\n"), sectionOf(text, "### ◫ Milestones"));
  const out = milestonesTables();
  out.tasks.find(item => item.id === "T60").milestone = "";
  const empty = milestonesText(out);
  assert.ok(!empty.includes("M6") && empty.includes("\n- 1 done · 1 dropped: see the board's Tasks page, grouped by milestone\n"), sectionOf(empty, "### ◫ Milestones"));
});

test("F-T233-2, F-T233-3, F-T233-7: a milestone whose gate is not its breakdown gate by the data rule says so in one way on every line, and Needs you shows that problem once", () => {
  const plain = milestonesTables();
  plain.gates.find(gate => gate.id === "G12").options = "yes|no";
  const model = buildBoardModel([milestonesSource("claude", plain)], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(text.includes("\n- Milestone 3\\: Board milestones · needs you · its gate G12 is not a breakdown gate on its pilot T30 \\(see Needs you\\)\n"), sectionOf(text, "### ◫ Milestones"));
  assert.ok(text.includes("\n> claude/sage-ff5ee2/G12 · Approve milestone M3? No task builds before you approve\\. Name\\: Board milestones Goal\\: Sample goal\\. Pilot, runs first\\:   T30\\: Sample T30\\\n> The gate G12 of M3 is not a breakdown gate on its pilot T30\\: ask the chief to repair the logbook, or to propose M3 again\\.\\\n> Options: 1: yes · 2: no\\\n"), sectionOf(text, "### 🔴 Needs you"));
  assert.equal(text.split("G12 of M3").length, 2, "one item says it");
  assert.equal(model.counts.needsOwner, 4, "T30, T70 and the two other milestone items: G12 counts once");
  const edited = milestonesTables();
  edited.gates.find(gate => gate.id === "G12").question = "Ship it?";
  const shipped = milestonesText(edited);
  assert.ok(!shipped.includes("breakdown waits for you") && !shipped.includes("Milestone approval"), shipped);
  assert.ok(shipped.includes("\n- Milestone 3\\: Board milestones · needs you · its gate G12 names no milestone in its question \\(see Needs you\\)\n"), sectionOf(shipped, "### ◫ Milestones"));
  assert.ok(shipped.includes("\n> claude/sage-ff5ee2/G12 · Ship it?\\\n> The gate G12 of M3 names no milestone in its question\\: ask the chief to repair the logbook, or to propose M3 again\\.\\\n"), shipped);
  assert.ok(shipped.includes("⊘ Waits for the breakdown of milestone 3, whose gate G12 names no milestone in its question\\: it cannot start\\."), "the cards agree");
  const one = milestonesTables().tasks[0];
  const twin = {
    tasks: [{ ...one, id: "T1", state: "framed", milestone: "M1" }, { ...one, id: "T2", state: "framed", milestone: "M2" }],
    gates: [{ id: "G1", task: "T1", question: "Approve milestone M2? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "", at: "" }],
    milestones: [{ id: "M1", name: "First", goal: "g", pilot: "T1", gate: "G1", at: "" }, { id: "M2", name: "Second", goal: "g", pilot: "T1", gate: "G1", at: "" }], decisions: [] };
  const both = milestonesText(twin);
  assert.ok(both.includes("\n- Milestone 1\\: First · needs you · its gate G1 names M2 in its question, not M1 \\(see Needs you\\)\n- Milestone 2\\: Second · needs you · the breakdown waits for you \\(gate G1\\) · pilot T1"), sectionOf(both, "### ◫ Milestones"));
  assert.ok(both.includes("**1 · Milestone 2\\: Second** · needs you · claude · sage \\(sample\\) · pilot T1 · gate G1\n> claude/sage-ff5ee2/G1 · Approve milestone M2? No task builds before you approve\\.\\\n> The gate G1 of M1 names M2 in its question, not M1\\: ask the chief to repair the logbook, or to propose M1 again\\.\\\n"), both);
  assert.equal(both.split("breakdown waits for you").length, 2, "only M2's breakdown waits for you");
});

const noMilestones = (reason = "milestones: line 3 has 4 cells, and its header has 6") => {
  const tables = milestonesTables();
  delete tables.milestones;
  const source = milestonesSource("claude", tables);
  source.projects[0].diagnostics = [reason];
  return source;
};

test("R1307-1: when the milestones table cannot be read, the cards show no milestone, and Needs you says why, in full, and counts it", () => {
  const model = buildBoardModel([noMilestones()], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(text.startsWith("**sage board** · built 2026-10-20 12\\:00 UTC\\\n🔴 3 needs you · 0 agents at work · 🔁 1 in review · 18 tasks\n\n### 🔴 Needs you\n**1 · The milestones table cannot be read** · claude · sage \\(sample\\)\n> milestones\\.tsv line 3 has 4 cells, and its header has 6\\. The board shows the tasks without their milestones\\. Ask the chief to repair the logbook\\.\n\n**2 · Sample T30** T30 · needs you · claude · sage \\(sample\\)\n"), text);
  assert.ok(!text.includes("◫") && !text.includes("Waits for the M") && !text.includes("pilot\\)") && !text.includes("Waits for T21"), text);
  assert.ok(text.includes("\n\n**Sample T11** T11 · waiting · claude · sage \\(sample\\)\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⊘ Waits for T10 \\(stopped\\)\\: it cannot start\\.\n\n"), text);
  assert.ok(text.includes("\n\n**Sample T22** T22 · not started · claude · sage \\(sample\\)\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\nNow: In the backlog\\. No agent works on it\\.\n\n"), text);
  assert.deepEqual([model.counts.needsOwner, model.projects[0].needsOwner, model.milestoneNeeds.length, model.projects[0].name], [3, 3, 1, "sage (sample)"]);
  assert.deepEqual(model.tasks.filter(task => task.milestone || task.waits.some(wait => wait.breakdown || wait.pilot)).map(task => task.id), []);
  assert.deepEqual(breaksOf(text), []);
  assert.equal(buildBoardModel([noMilestones("milestones: ENOENT")], { now: MILESTONES_NOW }).milestoneNeeds[0].text, "milestones.tsv is missing. The board shows the tasks without their milestones. Ask the chief to repair the logbook.");
});

test("R1307-2: a logbook that the board cannot read is an item of Needs you, under Other, with the reason, and counts in needs you", () => {
  const codex = milestonesSource("codex", { gates: [], runs: [] });
  codex.projects[0].diagnostics = ["tasks: line 14 has 9 cells, and its header has 16"];
  const model = buildBoardModel([milestonesSource(), codex], { now: MILESTONES_NOW }), text = renderBoardText(model);
  assert.ok(text.includes("\n🔴 5 needs you · "), text.slice(0, 200));
  assert.ok(sectionOf(text, "#### Other").startsWith("#### Other\n**2 · Milestone 2\\: Lead build is stuck** · claude · sage \\(sample\\)\n> The pilot T21 was abandoned\\. Choose a new pilot, or drop the milestone\\.\n\n**3 · The breakdown gate G30 of M7 is not in the logbook** · claude · sage \\(sample\\)\n> Ask the chief to repair the logbook, or to propose M7 again\\.\n\n**4 · The Codex logbook cannot be read** · codex · sage \\(sample\\)\n> tasks\\.tsv line 14 has 9 cells, and its header has 16\\. The board shows only the Claude logbook of sage \\(sample\\)\\. Ask the chief to repair the logbook\\.\n\n**5 · Sample T70** T70"), sectionOf(text, "#### Other"));
  assert.deepEqual([model.projects[0].needsOwner, model.milestoneNeeds.length], [5, 3]);
  const runs = sample([row("T1", "framed")], {}, { diagnostics: ["runs: EACCES", "artifact A1: artifact digest does not match"] });
  assert.deepEqual(runs.milestoneNeeds.map(need => [need.title, need.text]), [["The Sample logbook cannot be read", "runs.tsv has no read permission. The board shows its tasks without the rows of runs.tsv. Ask the chief to repair the logbook."]]);
  assert.equal(runs.counts.needsOwner, 1);
});

test("R1307-3: a card with a wait line shows it instead of its Now line; a card with no wait keeps its Now line", () => {
  const text = milestonesText(milestonesTables());
  assert.ok(text.includes("\n\n**Sample T13** T13 · waiting · claude · sage \\(sample\\) · ◫ Milestone 1\\: Codex support\\\n○ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T12 \\(in progress\\)\\.\n\n"), text);
  assert.ok(text.includes("\n\n**Sample T41** T41 · in progress · claude · sage \\(sample\\) · ◫ Milestone 4\\: Agent caps\\\n⧗ Plan › ○ Build › ○ Review 1 of 1 › ○ Merge\\\n⧗ Waits for T40 \\(pilot, in progress\\)\\. Design and PE may run\\.\n\n"), text);
  assert.ok(text.includes("### 🔨 Building (1)\n**Sample T40** T40 · in progress · claude · sage \\(sample\\) · ◫ Milestone 4\\: Agent caps \\(pilot\\)\\\n✓ Plan › ⧗ Build › ○ Review 1 of 1 › ○ Merge\\\nNow: No agent works on the build now\\.\n\n"), text);
});

test("R1309-2: md() escapes ':' and '@', so a bare URL or an email in a milestone name or a gate line makes no autolink", () => {
  const tables = milestonesTables();
  tables.milestones[0].name = "See https://evil.test/x, mail me@evil.test";
  tables.gates.find(gate => gate.id === "G12").question = "Approve milestone M3? No task builds before you approve. Read http://evil.test first.";
  const text = milestonesText(tables);
  assert.ok(text.includes("\n- Milestone 1\\: See https\\://evil\\.test/x, mail me\\@evil\\.test · in progress · 3 of 7 merged"), sectionOf(text, "### ◫ Milestones"));
  assert.ok(text.includes("> claude/sage-ff5ee2/G12 · Approve milestone M3? No task builds before you approve\\. Read http\\://evil\\.test first\\.\\\n"), text);
  assert.ok(!/[^\\](:\/\/|@)/.test(text), "every :// and @ has its escape");
});

const KEY = id => `claude/sage-ff5ee2/${id}`, B64 = value => Buffer.from(value).toString("base64url");
const milestonesModel = (tables = milestonesTables()) => buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW });

test("T374-8: a project of the model has no milestoneNeeds field", () => {
  const model = milestonesModel();
  assert.deepEqual([Object.hasOwn(model.projects[0], "milestoneNeeds"), model.milestoneNeeds.length, model.projects[0].needsOwner], [false, 2, 4]);
});

test("T383 item 11: the chat board's count is the number of its numbered items: a pilot with a breakdown gate and a plain gate is two items", () => {
  const tables = milestonesTables();
  tables.gates.push({ id: "G40", task: "T30", question: "Logo A or B?", options: "A|B", recommendation: "", default: "", answer: "", at: "" });
  const text = renderBoardText(buildBoardModel([milestonesSource("claude", tables)], { now: MILESTONES_NOW }));
  const items = (text.slice(0, text.indexOf("### ◫ Milestones")).match(/^\*\*\d+ · /gm) ?? []).length;
  assert.equal(items, 5, "G12 under Milestone approval; T30's G40, T70, M2 and M7 under Other");
  assert.equal(text.split("\n")[1], "🔴 5 needs you · 0 agents at work · 🔁 1 in review · 18 tasks");
});

test("T383 item 10: an unreadable provider root shows as a numbered item of the chat board, with no project name of its own", () => {
  const root = { id: "codex", label: "codex", provider: null, config: {}, diagnostics: ["EACCES"], projects: [], hooks: { present: false, slots: [], helpers: [], problem: null } };
  const text = renderBoardText(buildBoardModel([milestonesSource(), root], { now: MILESTONES_NOW }));
  assert.ok(text.includes("\n**4 · The Codex logbooks cannot be read** · codex · every project\n> Its folder has no read permission\\. The board shows no Codex logbook\\. Check that the board can read the folder\\.\n"), sectionOf(text, "### 🔴 Needs you"));
  assert.equal(text.split("\n")[1].split(" · ")[0], "🔴 5 needs you");
});

test("T390: the chat board calls the main session the chief, never the sage", () => {
  const data = milestonesModel();
  const pages = { chat: renderBoardText(data), status: renderBoardStatus(data), ...Object.fromEntries(data.tasks.map(task => [task.id, renderTaskText(task)])) };
  for (const [name, page] of Object.entries(pages)) assert.ok(!/\bthe sage\b/i.test(page), `${name}: ${page.match(/.{60}\bthe sage\b.{60}/i)?.[0]}`);
  assert.ok(pages.chat.includes("- Milestone 9\\: Changes · in progress · the chief revises the breakdown \\(gate G9\\)\n"));
});

test("R1508-1: a milestone row with an empty gate cell names no breakdown gate; only a missing row is not in the logbook", () => {
  const tables = milestonesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T62", state: "framed", milestone: "M41" }, { ...tables.tasks[0], id: "T63", state: "framed", milestone: "M41" });
  tables.milestones.push({ ...tables.milestones[0], id: "M41", name: "No gate", pilot: "T62", gate: "" });
  const model = milestonesModel(tables);
  assert.equal(model.tasks.find(task => task.id === "T63").waitLine.text, "Waits for the breakdown of milestone 41, whose milestone names no breakdown gate: it cannot start.");
  const text = renderBoardText(model);
  assert.ok(text.includes("\n- Milestone 41\\: No gate · needs you · the milestone names no breakdown gate \\(see Needs you\\)"), text);
  assert.ok(!/gate {2}is/.test(text), "no double space where the gate is empty");
});

test("R1509-1, R1535-1: in a proposed milestone, a loop of waits shows in the wait lines and in the chat board, for the pilot too", () => {
  const tables = milestonesTables();
  tables.tasks.push({ ...tables.tasks[0], id: "T66", title: "Sample pilot of a loop", state: "framed", milestone: "M40", waits: "T67" }, { ...tables.tasks[0], id: "T67", state: "framed", milestone: "M40", waits: "T66" });
  tables.milestones.push({ ...tables.milestones[0], id: "M40", name: "Loop in a proposal", pilot: "T66", gate: "G40" });
  tables.gates.push({ ...tables.gates[0], id: "G40", task: "T66", question: tables.gates[0].question.replace(/M1/g, "M40").replace(/T1\b/g, "T66"), answer: "" });
  const model = milestonesModel(tables), card = id => model.tasks.find(task => task.id === id);
  const line = (id, word) => `Waits for ${id} (${word}, in a loop) and your approval of milestone 40 (gate G40): it cannot start. Its waits make a loop, which never ends: the chief sets its waits again.`;
  assert.deepEqual([card("T67").waitLine, card("T66").waitLine], [{ never: true, text: line("T66", "needs you") }, { never: true, text: line("T67", "waiting") }]);
  assert.ok(renderBoardText(model).includes(`**Sample pilot of a loop** T66`) && renderBoardText(model).includes(`⊘ ${line("T67", "waiting").replace(/[().:]/g, c => `\\${c}`)}`), "the chat board says the same");
});
test("F-T420-1, R1551: the chat task lookup and the chat milestones list show a stuck wait", () => {
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
  const text = renderBoardText(model);
  assert.ok(text.includes("\n- Milestone 3\\: Board milestones · needs you · the breakdown waits for you \\(gate G12\\) · pilot T30 · T33 cannot start\n"), text);
  assert.ok(text.includes("\n- Milestone 9\\: Changes · in progress · the chief revises the breakdown \\(gate G9\\) · T91 cannot start\n"), text);
});

test("T995: no chat view of the milestones sample says program or names an old program id", () => {
  const model = milestonesModel();
  const pages = { chat: renderBoardText(model), status: renderBoardStatus(model), ...Object.fromEntries(model.tasks.map((t) => [t.id, renderTaskText(t)])) };
  assert.ok(model.milestones.length > 3 && pages.chat.includes("Milestones"), "the sample has milestones");
  for (const [name, page] of Object.entries(pages)) assert.doesNotMatch(page, /\bprograms?\b|\bPG\d/i, name);
});
