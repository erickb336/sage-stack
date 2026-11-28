import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";
import { taskNames } from "../packages/sage-core/task-name.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const ADD = ["--size", "small", "--priority", "P2"];

const rowsOf = (dir, table) => {
  const [head, ...lines] = readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n").filter(Boolean);
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [head.split("\t")[i], v])));
};
const tables = (dir) => ["tasks", "decisions"].map((t) => readFileSync(join(dir, `${t}.tsv`), "utf8")).join("\f");
const renames = (dir) => rowsOf(dir, "decisions").filter((d) => d.decision.startsWith("name ")).map((d) => [d.task, d.decision, d.why]);

function logbook() {
  const home = mkdtempSync(join(tmpdir(), "sage-name-")), project = mkdtempSync(join(tmpdir(), "sage-name-project-"));
  const env = { ...process.env, HOME: home, SAGE_HOME: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(SPY)}`.trim(), SAGE_TEST_KILLS: join(home, "kills"), SAGE_TEST_PIDS: "{}" };
  const run = (args, cwd) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, cwd, timeout: 60_000 });
  const ok = (...args) => { const r = run(args); assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  const no = (...args) => { const r = run(args); assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused: ${r.stdout}`); return r.stderr.trim(); };
  const noIn = (cwd, ...args) => { const r = run(args, cwd); assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused: ${r.stdout}`); return r.stderr.trim(); };
  const file = (text) => { const path = join(home, `names-${Math.random().toString(16).slice(2)}.txt`); writeFileSync(path, text); return path; };
  return { home, dir: ok("init").replace(/^\S+ /, ""), ok, no, noIn, file };
}

test("T1255: task add needs a name, refuses each bad one with what is wrong and how to fix it, writes nothing then, and keeps a good one", () => {
  const s = logbook();
  const before = tables(s.dir);
  assert.match(s.no("task", "add", "--title", "Show names", ...ADD), /^sage: task add needs --name "<name>"\. A task's name is 1 to 4 words of at most 32 characters, such as "Board names", and no other open task has it\. Nothing changed\.$/);
  const bad = {
    "": /has 0 characters: give 1 to 32/,
    "Board names for every row of it": /has 7 words: give 1 to 4/,
    "Longwordnameoverthirtytwocharacters": /has 35 characters: give 1 to 32/,
    T12: /has the form of a sage id \(such as T12 or M3\)/, m3: /has the form of a sage id/, "Ｔ１２": /has the form of a sage id/, PG4: /has the form of a sage id/,
    None: /is none, which sage reads as no name: give it words/,
    "Board: names": /has a colon, a middle dot \(·\) or a comma/, "Board · names": /has a colon, a middle dot/, "Board, names": /has a colon, a middle dot/,
    "Board：names": /has a colon, a middle dot/, "Board，names": /has a colon, a middle dot/, "Board、names": /has a colon, a middle dot/, "Board・names": /has a colon, a middle dot/, "Board∶names": /has a colon, a middle dot/,
    " Board": /has a space at its start or end/, "Board\tnames": /has a control, format or hidden character/,
  };
  for (const [name, why] of Object.entries(bad)) {
    const said = s.no("task", "add", "--name", name, "--title", "Show names", ...ADD);
    assert.match(said, why, name);
    assert.match(said, /A task's name is 1 to 4 words .* Nothing changed\.$/, name);
  }
  assert.equal(tables(s.dir), before, "a refused add writes no task and no decision");
  assert.match(s.ok("task", "add", "--name", "Board names", "--title", "Show names on the board", ...ADD), /^T1 framed · small/);
  assert.equal(rowsOf(s.dir, "tasks")[0].name, "Board names");
  assert.match(s.ok("task", "add", "--name", "Café board", "--title", "x", ...ADD), /^T2 framed/);
  assert.equal(rowsOf(s.dir, "tasks")[1].name, "Café board", "the name is kept in its composed form");
  assert.match(s.no("task", "add", "--name", "board NAMES", "--title", "y", ...ADD), /the name "board NAMES" is the name of T1 already \(case and width do not count\): give each open task its own name/);
  assert.match(s.no("task", "add", "--name", "ｃａｆé Board", "--title", "y", ...ADD), /is the name of T2 already/);
  s.ok("task", "T1", "set", "state=abandoned", "--why", "a sample");
  assert.match(s.ok("task", "add", "--name", "Board names", "--title", "Show names again", ...ADD), /^T3 framed/, "an ended task's name is free again");
});

test("T1255: task set name= renames with a decision row; the same name writes none; a name of another open task or a bad one refuses", () => {
  const s = logbook();
  s.ok("task", "add", "--name", "First name", "--title", "a", ...ADD);
  s.ok("task", "add", "--name", "Second name", "--title", "b", ...ADD);
  assert.match(s.ok("task", "T1", "set", "name=Board rows"), /^T1 framed/);
  assert.equal(rowsOf(s.dir, "tasks")[0].name, "Board rows");
  s.ok("task", "T1", "set", "name=Board rows");
  assert.deepEqual(renames(s.dir), [["T1", "name First name → Board rows", "task set"]], "one row for the change; none for the same name");
  const before = tables(s.dir);
  assert.match(s.no("task", "T1", "set", "name=second NAME"), /the name "second NAME" is the name of T2 already/);
  assert.match(s.no("task", "T1", "set", "name=T7"), /has the form of a sage id/);
  assert.match(s.no("task", "T1", "set", "name="), /has 0 characters/);
  assert.equal(tables(s.dir), before);
  assert.match(s.no("task", "T1", "set", "colour=red"), /task set takes state=, branch=, pr=, title=, name=, request=/);
});

test("T1255: task names names many tasks in one write, checks the whole result, and a second run with the same file changes nothing and says so", () => {
  const s = logbook();
  for (const [name, title] of [["Alpha", "a"], ["Beta", "b"], ["Gamma", "c"]]) s.ok("task", "add", "--name", name, "--title", title, ...ADD);
  const swap = s.file("T1 Beta\nT2   Alpha\r\n\nT3\tGamma\n");
  assert.equal(s.ok("task", "names", "--file", swap), "2 tasks named: T1, T2 · 1 had that name already. Each change has a decision row.", "a swap passes: the check is on the result");
  assert.deepEqual(rowsOf(s.dir, "tasks").map((t) => t.name), ["Beta", "Alpha", "Gamma"]);
  assert.deepEqual(renames(s.dir), [["T1", "name Alpha → Beta", "task names"], ["T2", "name Beta → Alpha", "task names"]]);
  const after = tables(s.dir);
  assert.equal(s.ok("task", "names", "--file", swap), `nothing changed: each of the 3 tasks in ${swap} has that name already.`);
  assert.equal(tables(s.dir), after, "the second run writes nothing");

  const bad = s.file("T1 Delta\nT9 Lost\nT2 Board: rows\nT1 Again\nnoname\nT3 Alpha\n");
  const said = s.no("task", "names", "--file", bad);
  assert.match(said, /has 5 bad lines, so no task changed:/);
  for (const line of [/line 2: this logbook has no task T9/, /line 3: the name "Board: rows" of T2 has a colon/, /line 4: T1 is on line 1 too: give each task once/, /line 5: give a task id, a space and its name/, /line 6: the name "Alpha" of T3 is the name of T2 too: give each open task its own name/])
    assert.match(said, line);
  assert.equal(tables(s.dir), after, "a bad line refuses the whole file: no partial write");
  assert.match(s.no("task", "names", "--file", s.file("T1 Alpha\nT2 Alpha\n")), /line 1: the name "Alpha" of T1 is the name of T2 on line 2 too/);
  assert.match(s.no("task", "names", "--file", s.file("\n\n")), /names no task/);
  assert.match(s.no("task", "names", "--file", join(s.home, "none.txt")), /is not a text file of at most 1 MiB that sage can read/);
  assert.match(s.no("task", "names"), /task names takes --file/);
  assert.equal(tables(s.dir), after);
});

test("T1255: an old logbook with no name column reads and writes: status shows the names from the titles, and a rename adds the column", () => {
  const s = logbook();
  const old = [["T1", "Board names: show them on rows"], ["T2", "Board names: and in the chat"], ["T3", "Lint: the offer"]];
  writeFileSync(join(s.dir, "tasks.tsv"), [TABLES.tasks.join("\t"), ...old.map(([id, title]) => TABLES.tasks.map((c) => ({ id, title, size: "small", route: "build,code-review,qa", state: "framed", round: "0", priority: "P2" })[c] ?? "").join("\t"))].join("\n") + "\n");
  assert.match(s.ok("status"), /^names   3 open tasks have no name and show one from the title: T1 "Board names show them…", T2 "Board names and in…", T3 "Lint" · name one with task <T> set name=<name>, or many with task names --file <file>$/m);
  s.ok("task", "T1", "set", "name=Board rows");
  assert.match(readFileSync(join(s.dir, "status.md"), "utf8"), /\| T3 \| \*Lint\* \| framed \|/, "status.md, which each write saves, shows a name from the title in italics");
  assert.ok(readFileSync(join(s.dir, "tasks.tsv"), "utf8").split("\n")[0].split("\t").includes("name"));
  assert.match(s.ok("task", "add", "--name", "Chat rows", "--title", "Board names: in the chat digest", ...ADD), /^T4 framed/);
  assert.match(s.ok("status"), /^names   2 open tasks have no name and show one from the title: T2 "Board names", T3 "Lint"/m, "T2's lead is free once T1 has a name of its own");
  assert.match(readFileSync(join(s.dir, "status.md"), "utf8"), /\| T1 \| Board rows \| framed \|/);
});

test("T1255: the name that each task shows: its own, else the title before its colon when no open task has it, else the first words of the title", () => {
  const t = (id, title, more = {}) => ({ id, title, state: "framed", ...more });
  const names = taskNames([
    t("T1", "Board names: rows"), t("T2", "Board names: chat"), t("T3", "Lint: the offer"), t("T4", "Plain short title"),
    t("T5", "Reviews: faster", { state: "merged" }), t("T6", "Reviews: of the board"), t("T7", "Hooks: first", { name: "Hooks" }), t("T8", "Hooks: second"),
    t("T9", "Lint: old", { state: "abandoned" }), t("T10", "Anextremelylongwordthatcannotfitinone name"), t("T11", "A five word title here, with more"),
  ]);
  const shown = Object.fromEntries([...names].map(([id, { name, given }]) => [id, given ? `${name} (own)` : name]));
  assert.deepEqual(shown, {
    T1: "Board names rows", T2: "Board names chat", T3: "Lint", T4: "Plain short title",
    T5: "Reviews faster", T6: "Reviews", T7: "Hooks (own)", T8: "Hooks second",
    T9: "Lint old", T10: "Anextremelylongwordthatcannotfi…", T11: "A five word title…",
  });
});

test("T1263: on a milestone page no two rows read the same name: ended tasks whose titles share a start take more title words, a name given by hand counts as taken, and the row order changes nothing", () => {
  const t = (id, title, more = {}) => ({ id, title, state: "merged", milestone: "M7", ...more });
  const tasks = [
    t("T1", "Board: remove the phone parts (password sign-in)"), t("T2", "Board: chief records (register at sage mode on)"), t("T3", "Board: the agent queue"),
    t("T4", "Board pilot: React stack"), t("T5", "Board: same start here, one"), t("T6", "Board: same start here, two"), t("T7", "Queue: a hand name", { name: "Board pilot" }),
    t("T8", "Board: elsewhere", { milestone: "M2" }), t("T9", "Board: open work", { state: "building", milestone: "M3" }),
  ];
  const shown = list => Object.fromEntries([...taskNames(list)].map(([id, { name }]) => [id, name]));
  const names = shown(tasks);
  assert.deepEqual(names, {
    T1: "Board remove the phone…", T2: "Board chief records…", T3: "Board the agent queue", T4: "Board pilot React stack", T5: "T5", T6: "T6", T7: "Board pilot",
    T8: "Board elsewhere", T9: "Board",
  }, "T4's lead is T7's own name; T5 and T6 share their first four words, so each shows its id; T8 is in another milestone, but the open T9 holds the lead");
  const m7 = tasks.filter(x => x.milestone === "M7").map(x => names[x.id].toLowerCase());
  assert.equal(new Set(m7).size, m7.length, "each row of M7 reads its own name");
  assert.deepEqual(shown([...tasks].reverse()), names, "the same logbook gives the same names in any row order");
  assert.deepEqual(shown([t("T1", "Board: one"), t("T2", "Board: two", { milestone: "" }), t("T3", "Board: three", { milestone: "" })]), { T1: "Board", T2: "Board two", T3: "Board three" }, "tasks in no milestone count as one milestone");
});

test("T1263: a name from the title that is cut ends with … and never leaves a bracket open; a name given by hand that breaks the name rules shows a name from the title", () => {
  const t = (id, title, more = {}) => ({ id, title, state: "framed", ...more });
  const names = Object.fromEntries([...taskNames([
    t("T1", "Fewest special cases (owner: merged"), t("T2", "Show the board in the chat"), t("T3", "Fix (a) and (b) c d"), t("T4", "Board (draft"),
    t("T5", "Short [one] two"), t("T6", "Hooks: first", { name: "x".repeat(5000) }), t("T7", "Lint: the offer", { name: "Lint\u0000rows" }),
  ])].map(([id, { name }]) => [id, name]));
  assert.deepEqual(names, { T1: "Fewest special cases…", T2: "Show the board in…", T3: "Fix (a) and (b)…", T4: "Board…", T5: "Short [one] two", T6: "Hooks", T7: "Lint" });
  for (const name of Object.values(names)) assert.equal((name.match(/[([{]/g) ?? []).length, (name.match(/[)\]}]/g) ?? []).length, `${name}: no open bracket`);
});

test("T1255: a name that each task shows from its title follows the name rules and no other open task shows it; when no title words do, the task shows its id", () => {
  const t = (id, title, more = {}) => ({ id, title, state: "framed", ...more });
  const tasks = [
    t("T1", "Board, names"), t("T2", "Board names: rows"), t("T3", "None"), t("T4", "T12"), t("T5", "Board names"), t("T6", "x", { name: "Board names" }),
    t("T7", "Hooks、first"), t("T8", "Lint"), t("T9", "Lint: the offer"), t("T10", "Lint", { state: "merged" }),
  ];
  const names = taskNames(tasks), shown = Object.fromEntries([...names].map(([id, { name }]) => [id, name]));
  assert.deepEqual(shown, { T1: "T1", T2: "Board names rows", T3: "T3", T4: "T4", T5: "T5", T6: "Board names", T7: "Hooks first", T8: "Lint", T9: "Lint the offer", T10: "T10" });
  const open = tasks.filter((x) => x.state === "framed").map((x) => shown[x.id].toLowerCase());
  assert.equal(new Set(open).size, open.length, "no two open tasks show one name");
  assert.deepEqual(Object.fromEntries([...taskNames([t("T1", "Board, names"), t("T2", "Board names: rows", { state: "merged" })])].map(([id, { name }]) => [id, name])),
    { T1: "Board names", T2: "Board names rows" }, "a closed task's name gives way to an open task's");
});

test("T1255: a closed task's name need not be unique, in task names and in set name=; a relative --file refusal names where sage looked; status.md escapes the name cell", () => {
  const s = logbook();
  s.ok("task", "add", "--name", "Alpha", "--title", "a", ...ADD);
  s.ok("task", "add", "--name", "Beta", "--title", "b", ...ADD);
  s.ok("task", "T2", "set", "state=abandoned", "--why", "a sample");
  assert.match(s.ok("task", "names", "--file", s.file("T2 Alpha\n")), /^1 task named: T2\./, "a closed target may take an open task's name");
  assert.match(s.ok("task", "names", "--file", s.file("T1 Alpha\nT2 Gamma\n")), /^1 task named: T2/);
  assert.match(s.ok("task", "T2", "set", "name=Alpha"), /^T2 abandoned/, "set name= on a closed task skips the twin check too");
  assert.match(s.ok("task", "names", "--file", s.file("T1 Gamma\n")), /^1 task named: T1/, "a closed holder does not block an open task");
  assert.deepEqual(rowsOf(s.dir, "tasks").map((t) => t.name), ["Gamma", "Alpha"]);

  const said = s.noIn(s.home, "task", "names", "--file", "missing.txt");
  assert.ok(said.includes(join(s.home, "missing.txt")), `the refusal names the full path that sage tried: ${said}`);
  assert.match(said, /sage looked for missing\.txt in the folder .*: give the file's absolute path\. Nothing changed\.$/);

  s.ok("task", "add", "--name", "a | b", "--title", "c", ...ADD);
  s.ok("task", "add", "--name", "*Board*", "--title", "d", ...ADD);
  s.ok("task", "add", "--name", "<i>x</i>", "--title", "e", ...ADD);
  const md = readFileSync(join(s.dir, "status.md"), "utf8");
  assert.match(md, /^\| T3 \| a \\\| b \| framed \|/m, "a bar in a name does not split the row");
  assert.match(md, /^\| T4 \| \\\*Board\\\* \| framed \|/m, "a given name in stars does not look like a name from the title");
  assert.match(md, /^\| T5 \| \\<i\\>x\\<\/i\\> \| framed \|/m, "a tag in a name is text");
});
