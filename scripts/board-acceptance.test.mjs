import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardNote, createStateTool } from "../packages/sage-core/index.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const AT = "2026-01-01T00:00:00.000Z", HEAD = "a".repeat(40), OLD_HEAD = "b".repeat(40);
const FRESH = () => new Date(Date.now() - 600000).toISOString();
const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "sample", pr: "", round: "0", keys: "", ...extra });
function table(directory, name, rows) {
  const fields = HEADERS[name].split(" ");
  writeFileSync(join(directory, `${name}.tsv`), `${fields.join("\t")}\n${rows.map(row => fields.map(field => row[field] ?? "").join("\t") + "\n").join("")}`);
}
function records(directory, rows) {
  writeFileSync(join(directory, "observations.json"), JSON.stringify({ version: 1, records: rows.map((row, i) => ({ id: `O${i + 1}`, task: "T1", source: "Sample recorder", basis: "observed", observedAt: AT, recordedAt: AT, ...row })) }));
}
const pr = (extra = {}) => ({ kind: "pr", data: { repository: "https://example.test/sample/project", number: 12, state: "open", head: HEAD, ...extra } });
function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)).map(([name, value]) => [`${entry.name}/${name}`, value]) : [[entry.name, entry.isSymbolicLink() ? "symbolic link" : readFileSync(file).toString("hex")]];
  }));
}
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-acceptance-")), project = join(dir, "project"), sources = [];
  mkdirSync(project);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const add = (id = "sample", tasks = [task("T1", "framed")]) => {
    const root = join(dir, `source-${id}`), book = join(root, "project-abcdef"); mkdirSync(book, { recursive: true });
    for (const name of Object.keys(HEADERS)) table(book, name, name === "tasks" ? tasks : []);
    writeFileSync(join(book, "checkout.txt"), `${project}\n`);
    sources.push({ id, path: root, label: `Source ${id}` });
    return { root, book, key: `${id}/project-abcdef` };
  };
  const first = add();
  const tool = createStateTool({ defaultRoot: () => first.root });
  const invoke = (format, { scope = "all", id, sourceScope } = {}) => tool.sage([
    "board", id ?? scope, "--view", format, "--project", project,
    ...(sourceScope ? ["--name-hex", Buffer.from(sourceScope).toString("hex")] : []),
  ], { ...process.env, SAGE_HOME: first.root, SAGE_BOARD_ROOTS: JSON.stringify(sources) });
  const view = (format, options) => {
    let result;
    assert.doesNotThrow(() => { result = invoke(format, options); }, `the requested ${format} view must return its recorded board`);
    return result;
  };
  return { dir, project, sources, add, ...first, invoke, view };
}
const plain = text => text.replace(/\\(.)/g, "$1");
const clean = (id, number, sha, kinds = ["checks-pass", "review-clean", "qa-pass"]) => kinds.map(kind => ({ task: id, pr: number, sha, kind, cycle: "1", run: "", at: AT }));
const known = f => writeFileSync(join(f.root, "projects.tsv"), `logbook\tat\thow\nproject-abcdef\t${AT}\tinit\n`);
const partsOf = text => Object.fromEntries([...text.matchAll(/^### (?:🔴 )?([^\n]+)\n([\s\S]*?)(?=\n\n(?:### |Quiet: |Archived: |Incomplete source: |Setting ignored: |Logbook note: |More: )|(?![\s\S]))/gm)]
  .map(([, name, body]) => [name, body.split("\n").filter(line => line.startsWith("- "))]));
const placesOf = text => Object.fromEntries(Object.entries(partsOf(text)).flatMap(([name, lines]) => lines.filter(line => /^- Sample T\d+\b/.test(line)).map(line => [line.match(/^- Sample (T\d+)\b/)[1], name])));

test("T280 acceptance: the board shows a PR ready to merge only when sage's own merge check passes on its head", t => {
  const f = fixture(t);
  const [one, two, three, five] = ["1", "2", "3", "5"].map(digit => digit.repeat(40));
  table(f.book, "tasks", [task("T1", "verified", { pr: "21" }), task("T2", "verified", { pr: "22" }), task("T3", "verified", { pr: "23" }), task("T4", "verified", { pr: "24" }), task("T5", "verified", { pr: "25" })]);
  table(f.book, "ledger", [...clean("T1", "21", one), ...clean("T2", "22", two), ...clean("T3", "23", three, ["checks-pass", "review-clean"]), ...clean("T5", "25", five)]);
  const stranger = join(f.root, "stranger-123456"); mkdirSync(stranger);
  table(stranger, "ledger", clean("T5", "25", five, ["checks-pass"]));
  table(f.book, "findings", [{ task: "T2", key: "F-T2-1", round: "0", source: "R9", severity: "medium", summary: "Sample finding", triage: "fix", status: "open" }]);
  known(f);
  const before = snapshot(f.root), text = f.view("chat"), detail = plain(["T1", "T2", "T3", "T4", "T5"].map(id => f.view("task", { id })).join("\n"));
  assert.deepEqual(placesOf(text), { T1: "Needs you", T2: "Moving now", T3: "Moving now", T4: "Needs you", T5: "Moving now" });
  assert.ok(text.includes("\n- Sample T1. The board cannot tell if autopilot is on, so review and merge its PR.\n"), text);
  assert.ok(text.includes("\n- Sample T2. The merge check refuses its last commit; the chief repairs it.\n"), "a refused merge is the chief's to repair");
  assert.ok(text.includes("\n- Sample T4. The merge check is not checked, because the board does not know the last commit of its PR.\n"), text);
  assert.match(detail, /The merge check refuses 5555555\. Stranger-123456 has verdicts on 5555555/, "the reason names the folder, not its path");
  assert.match(detail, /The merge check passes on 1111111\. The board does not check the PR's head branch\./);
  assert.match(detail, /The merge check refuses 2222222\. T2 has open findings/);
  assert.match(detail, /The merge check refuses 3333333\. T3/);
  assert.match(detail, /The merge check is not checked, because the board does not know the last commit of PR 24\./);
  assert.doesNotMatch(text + detail, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no root path in the board");
  assert.deepEqual(snapshot(f.root), before, "the board's merge check writes nothing");
});

test("T205 acceptance: the chat board's state columns describe the recorded tasks without logbook writes", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "framed"), task("T2", "designing"), task("T3", "held"), task("T4", "reviewing"), task("T5", "pr-ready", { pr: "12" }), task("T6", "merged"), task("T7", "abandoned")]);
  table(f.book, "ledger", clean("T5", "12", HEAD));
  known(f);
  const recent = new Date(Date.now() - 86400000).toISOString();
  records(f.book, [{ task: "T6", kind: "completion", observedAt: recent, recordedAt: recent, data: { state: "merged", at: recent } }]);
  const before = snapshot(f.root), text = f.view("chat");
  assert.deepEqual(placesOf(text), { T2: "Moving now", T3: "Moving now", T4: "Moving now", T5: "Needs you", T6: "Done since yesterday" }, "T1 is in the backlog and T7 is abandoned: no line (T1217)");
  assert.deepEqual(partsOf(text)["Moving now"], ["- Sample T2. In design.", "- Sample T3. Held by the chief.", "- Sample T4. In review, cycle 1 of 1."]);
  assert.deepEqual(snapshot(f.root), before);
});

test("T205 acceptance: current-head review evidence ignores old SHA and clears same-second repaired failures", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" })]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "security-reviewer", status: "running", started: FRESH() }]);
  records(f.book, [pr(), { kind: "run", data: { run: "R1", provider: "sample-provider", head: HEAD, cycle: 1 } }]);
  const verdict = (kind, sha = HEAD) => ({ task: "T1", pr: "12", sha, kind, cycle: "1", at: AT });
  table(f.book, "ledger", [verdict("qa-pass", OLD_HEAD), verdict("qa-fail")]);
  const failed = f.view("task", { id: "T1" });
  assert.ok(failed.includes("QA failed on the recorded PR head")); assert.ok(failed.includes("! QA: done · failed"));
  assert.ok(failed.includes("▶ security review: in progress")); assert.ok(failed.includes("sample-provider · security-reviewer"));
  table(f.book, "ledger", [verdict("qa-pass", OLD_HEAD), verdict("qa-fail"), verdict("qa-pass")]);
  const fixed = f.view("task", { id: "T1" }); assert.ok(fixed.includes("✓ QA: done")); assert.ok(!fixed.includes("QA failed on the recorded PR head"));
  table(f.book, "ledger", [verdict("qa-pass"), verdict("qa-fail")]);
  assert.ok(f.view("task", { id: "T1" }).includes("QA failed on the recorded PR head"));
});

test("T205 acceptance: provider roots keep duplicate task identities separate and offer exact task selection", t => {
  const f = fixture(t), other = f.add("second", [task("T1", "held", { title: "Sample second provider" })]);
  table(f.book, "tasks", [task("T1", "held")]);
  const before = [snapshot(f.root), snapshot(other.root)], text = f.view("chat", { scope: "this" });
  assert.ok(text.includes("- Sample T1. Held by the chief.") && text.includes("- Sample second provider. Held by the chief."), text);
  assert.ok(text.endsWith("\nRef: T1 T1"), "two task identities, one for each source");
  assert.throws(() => f.invoke("task", { id: "T1" }), /task is ambiguous/);
  const detail = f.view("task", { id: "T1", sourceScope: other.key });
  assert.ok(detail.includes("Sample second provider")); assert.ok(!detail.includes("Source sample"));
  assert.throws(() => f.invoke("task", { id: "T9", sourceScope: other.key }), /Nearest recorded ids: T1.*No task was opened/);
  const named = f.view("chat", { sourceScope: "project" });
  assert.ok(named.includes("Sample T1") && named.includes("Sample second provider"), named);
  assert.deepEqual([snapshot(f.root), snapshot(other.root)], before);
});

test("T205 acceptance: owner questions and hostile text remain escaped, complete and source-qualified", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "held", { title: "<script>sample</script> [sample](https://example.test)" })]);
  table(f.book, "gates", [{ id: "G1", task: "T1", question: "Pick <sample>?", options: "keep|change", recommendation: "keep", default: "keep", answer: "", at: AT }]);
  const text = f.view("chat");
  assert.ok(text.includes("\n- ‹script›sample‹/script›. Pick ‹sample›?\n  Options: 1 keep · 2 change.\n  Recommended: keep.\n"), text);
  assert.ok(text.endsWith("\nRef: T1 sample/project-abcdef/G1"), "the Ref line gives the full gate key");
  assert.ok(!text.includes("[sample](https://example.test)") && !text.includes("<") && !text.includes(String.fromCharCode(92)), "no link, no HTML and no backslash");
});

test("T205 acceptance: task details show verified briefs, report proof, run time and screenshots, then reject tampering", t => {
  const f = fixture(t), brief = "GOAL: Show recorded work\nSCOPE: Board\nACCEPTANCE: Keep both views equal\n- Preserve detail\nVERIFY: Tests\n", proof = "tests 12\npass 12\n<sample proof>\n";
  table(f.book, "tasks", [task("T1", "building")]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "qa", status: "done", started: AT, ended: "2026-01-01T00:02:00.000Z", tokens: "200" }]);
  mkdirSync(join(f.book, "briefs")); mkdirSync(join(f.book, "reports")); mkdirSync(join(f.book, "artifacts"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64");
  const saved = [["briefs/T1.md", brief, "brief", "Sample brief"], ["reports/R1.md", proof, "proof", "Sample proof"], ["artifacts/screen.png", image, "artifact", "Sample screenshot"]];
  for (const [path, content] of saved) writeFileSync(join(f.book, path), content);
  records(f.book, saved.map(([path, content, type, label]) => ({ kind: "artifact", data: { type, label, path, ...(type === "proof" ? { run: "R1" } : {}), sha256: createHash("sha256").update(content).digest("hex") } })));
  const before = snapshot(f.root), text = f.view("task", { id: "T1" });
  assert.ok(text.includes("Goal: Show recorded work")); assert.ok(text.includes("Acceptance: Keep both views equal\n- Preserve detail"));
  assert.ok(text.includes("tests 12\npass 12")); assert.ok(text.includes("120 s")); assert.ok(text.includes("peak context 200"));
  assert.ok(text.includes("R1 · digest verified")); assert.ok(text.includes("Full brief:")); assert.ok(text.includes("\\<sample proof\\>"));
  assert.ok(text.includes("Sample screenshot · local artifact; digest verified"));
  assert.ok(text.includes("digest verified")); assert.ok(!text.includes("content not verified"));
  assert.deepEqual(snapshot(f.root), before);
  writeFileSync(join(f.book, "reports/R1.md"), "TAMPERED CONTENT MUST NOT SHOW");
  const damaged = f.view("task", { id: "T1" }); assert.ok(damaged.includes("content not verified")); assert.ok(!damaged.includes("TAMPERED CONTENT MUST NOT SHOW"));
});

test("T205 acceptance: missing and malformed inputs show diagnostics without exposing content or initializing files", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "held")]);
  const valid = f.view("chat"); assert.ok(valid.includes("Sample T1"));
  f.sources.push({ id: "missing", path: join(f.dir, "does-not-exist") });
  writeFileSync(join(f.root, "config.json"), "SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW");
  writeFileSync(join(f.book, "runs.tsv"), "bad header\nSAMPLE_PRIVATE_TABLE_DO_NOT_SHOW\n");
  const before = snapshot(f.root), text = plain(f.view("chat"));
  assert.ok(text.includes("Incomplete source: missing")); assert.ok(text.includes("its folder is missing") && !text.includes("ENOENT"), "R1075-6: plain words, not the code"); assert.ok(text.includes("config: invalid JSON"));
  assert.ok(!text.includes("SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW")); assert.ok(!text.includes("SAMPLE_PRIVATE_TABLE_DO_NOT_SHOW"));
  assert.deepEqual(snapshot(f.root), before);
  rmSync(join(f.book, "runs.tsv"));
  const external = join(f.dir, "external.tsv"); writeFileSync(external, "SAMPLE_LINK_TARGET_DO_NOT_SHOW"); symlinkSync(external, join(f.book, "runs.tsv"));
  const linked = plain(f.view("chat")); assert.ok(linked.includes("its runs file is a link, which the board does not follow"), "R1075-6"); assert.ok(!linked.includes("SAMPLE_LINK_TARGET_DO_NOT_SHOW"));
  assert.equal(readFileSync(external, "utf8"), "SAMPLE_LINK_TARGET_DO_NOT_SHOW");
});

test("T205 acceptance: Done uses completion evidence and status preserves actual task-state counts", t => {
  const f = fixture(t), recent = new Date(Date.now() - 86400000).toISOString(), old = new Date(Date.now() - 9 * 86400000).toISOString();
  table(f.book, "tasks", [task("T1", "merged", { title: "Recent completion" }), task("T2", "merged", { title: "Old completion" }), task("T3", "concluded", { title: "Unknown completion" })]);
  records(f.book, [{ task: "T1", kind: "completion", observedAt: recent, recordedAt: recent, data: { state: "merged", at: recent } }, { task: "T2", kind: "completion", observedAt: old, recordedAt: old, data: { state: "merged", at: old } }]);
  table(f.book, "decisions", [{ task: "T2", at: recent, decision: "renamed title", why: "sample" }, { task: "T3", at: recent, decision: "added note", why: "sample" }]);
  const text = f.view("chat"), status = f.view("status");
  assert.deepEqual(partsOf(text)["Done since yesterday"], [`- Recent completion. Merged yesterday at ${String(new Date(recent).getHours()).padStart(2, "0")}:${String(new Date(recent).getMinutes()).padStart(2, "0")}.`]);
  assert.ok(!text.includes("Old completion")); assert.ok(!text.includes("Unknown completion"));
  assert.equal(status.split("\n")[0], "Tasks: merged 2 · concluded 1");
  assert.equal(status.split("\n")[1], "Agents: 0 recorded running · 0 inferred PRs");
  assert.ok(f.view("task", { id: "T2" }).includes("Old completion"), "old tasks remain available by exact task request");
});

test("T205 acceptance: the task loop marks recorded PE work current without inferring it from the route alone", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "designing", { route: "design,pe,build,code-review,qa" })]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "pe", status: "running", started: FRESH() }]);
  const text = f.view("task", { id: "T1" });
  assert.ok(text.includes("▶ PE check: in progress")); assert.ok(text.includes("Now: The PE is at work on the design\\."));
  table(f.book, "runs", []);
  const unknown = f.view("task", { id: "T1" });
  assert.ok(unknown.includes("⧗ design: waiting")); assert.ok(!unknown.includes("▶")); assert.ok(!unknown.includes("at work on"), "no run: nothing says running now (R1077)");
});

test("T205 acceptance: existing Claude hook dispatches owner board/task/status phrases and rejects quoted agent text", t => {
  const f = fixture(t), hook = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
  const send = (prompt, extra = {}) => {
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sample-owner", cwd: f.project, prompt, ...extra }), encoding: "utf8", env: { ...process.env, HOME: join(f.dir, "user"), SAGE_HOME: f.root, SAGE_HOOKS_STATE: join(f.dir, "hooks"), GH_CONFIG_DIR: join(f.dir, "gh") } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
  };
  for (const [phrase, view] of [["sage board", "chat"], ["show board", "chat"], ["sage board T1", "task"], ["show board T1", "task"], ["board T1", "task"], ["show status", "status"], ["sage status", "status"]]) {
    const note = send(`**${phrase}？**`);
    assert.ok(note.includes(`--view ${view}`), `${phrase}: ${note}`); assert.match(note, /Print (?:its|the chat board's) output word for word/);
    assert.equal(send(`> ${phrase}`), ""); assert.equal(send(`"${phrase}"`), "");
    assert.equal(send(phrase, { agent_id: "sample-child" }), "");
    assert.equal(send(`<agent-message from="qa">${phrase}</agent-message>`), "");
  }
  assert.equal(send("show status"), send("sage status"));
  assert.match(send("sage board for all"), /board all .*--view chat/);
});

test("T922: in a sandbox that blocks every write, as Codex's does, the note's chat board shows a merge after the first board, and writes nothing", { skip: process.platform !== "darwin" && "macOS sandbox-exec only" }, t => {
  const f = fixture(t), home = join(f.dir, "home"), hour = new Date(Date.now() - 3600000).toISOString();
  mkdirSync(home);
  const done = (id, at) => ({ task: id, kind: "completion", observedAt: at, recordedAt: at, data: { state: "merged", at } });
  table(f.book, "tasks", [task("T1", "merged", { title: "First merge" }), task("T2", "reviewing", { title: "Second merge" })]);
  records(f.book, [done("T1", hour)]);
  const cli = fileURLToPath(new URL("../plugins/sage-codex/skills/sage/sage.mjs", import.meta.url));
  const env = { PATH: process.env.PATH, HOME: home, SAGE_HOME: f.root };
  const sandboxed = args => spawnSync("/usr/bin/sandbox-exec", ["-p", `(version 1)(allow default)(deny network*)(deny file-write* (subpath "${f.dir}"))`, process.execPath, ...args], { env, encoding: "utf8" });
  assert.match(sandboxed(["-e", `require("fs").writeFileSync(${JSON.stringify(join(f.root, "board.json"))}, "{}")`]).stderr, /EPERM/, "the profile blocks the write of board.json at the sage root");
  let args;
  boardNote({ kind: "board", scope: "all" }, f.project, { state: words => { args ??= words; return words; }, ensure: "", choice: "" });
  const argv = args.match(/'(?:[^']|'\\'')*'|\S+/g).map(word => word.startsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word);
  assert.ok(argv.includes(f.project), args);
  const board = () => {
    const before = snapshot(f.dir), open = spawnSync(process.execPath, [cli, ...argv], { env, encoding: "utf8" });
    assert.equal(open.status, 0, open.stderr);
    assert.deepEqual(snapshot(f.dir), before, "the chat board writes nothing, also where a write would succeed");
    const run = sandboxed([cli, ...argv]);
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  const first = board();
  assert.deepEqual(partsOf(first)["Done since yesterday"].map(line => line.split(". ")[0]), ["- First merge"], first);
  table(f.book, "tasks", [task("T1", "merged", { title: "First merge" }), task("T2", "merged", { title: "Second merge" })]);
  records(f.book, [done("T1", hour), done("T2", new Date().toISOString())]);
  const second = board();
  assert.deepEqual(partsOf(second)["Done since yesterday"].map(line => line.split(". ")[0]), ["- Second merge", "- First merge"], "newest first; the list is since yesterday, not since the last board");
  assert.equal(existsSync(join(f.root, "board.json")), false);
});
