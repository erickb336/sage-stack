import "./test-env.mjs";
import { tname } from "./task-names.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { askingRun, keptUsersText } from "../plugins/sage/core/index.mjs";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";
import { QUESTION } from "./fixtures/question-message.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BODY = "Adds the question view.\n\n## What changes for users\n\nThe board shows each question with its pages.\n\n```sh\n# not a heading\n```\n\n### Details\n\nOne more line.\n\n## Tests\n\nnpm test passed.\n";

function world(t, { remote } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-t1124-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakes = join(base, "fakes"), calls = join(base, "gh-calls");
  mkdirSync(fakes);
  for (const name of ["ps", "kill"]) writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(fakes, "gh"), `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
require("node:fs").appendFileSync(${JSON.stringify(calls)}, args + "\\n");
if (args === "--fake-proof") console.log("FAKE-gh T1124");
else if (args === "pr view 7 --repo example/sample --json body") console.log(JSON.stringify({ body: ${JSON.stringify(BODY)} }));
else if (args === "pr view 8 --repo example/sample --json body") console.log(JSON.stringify({ body: "No such part here." }));
else process.exit(1);
`);
  chmodSync(join(fakes, "gh"), 0o755);
  assert.equal(spawnSync(join(fakes, "gh"), ["--fake-proof"], { encoding: "utf8" }).stdout, "FAKE-gh T1124\n", "the fake gh answers");
  writeFileSync(calls, "");
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), SAGE_HOME: join(base, "sage"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_TEST_PIDS: "{}",
    SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project], { env });
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first"], { env });
  if (remote) execFileSync("git", ["-C", project, "remote", "add", "origin", remote], { env });
  const run = (...args) => {
    const r = spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
    return { status: r.status, out: (r.stdout + r.stderr).trim() };
  };
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `sage ${args.join(" ")}: ${r.out}`); return r.out; };
  const no = (...args) => { const r = run(...args); assert.notEqual(r.status, 0, `sage ${args.join(" ")} must refuse: ${r.out}`); return r.out; };
  const logbook = ok("init").replace(/^\S+ /, "");
  assert.ok(existsSync(join(logbook, "tasks.tsv")), logbook);
  const table = (name) => {
    const [head, ...lines] = readFileSync(join(logbook, `${name}.tsv`), "utf8").replace(/\n+$/, "").split("\n"), cols = head.split("\t");
    return { cols, rows: lines.map((line) => Object.fromEntries(line.split("\t").map((cell, i) => [cols[i], cell]))) };
  };
  const ghCalls = () => readFileSync(calls, "utf8").split("\n").filter(Boolean);
  return { ok, no, logbook, table, ghCalls };
}

const tasks = (w, n, size = "small") => { for (let i = 0; i < n; i++) w.ok("task", "add", "--name", tname(), "--priority", "P2", "--title", `t${i + 1}`, "--size", size); };
const ASK = ["--question", "Which layout?", "--options", "one|two", "--recommend", "one"];

test("T1124 R1: gate add --run records the run of the gate's task that asked; a run of another task, an unknown run or a gate with no task is refused", (t) => {
  const w = world(t);
  tasks(w, 2);
  w.ok("run", "add", "T1", "--role", "designer", "--branch", "sage/t1-design");
  w.ok("run", "add", "T2", "--role", "pe");
  assert.equal(w.table("gates").rows.length, 0);
  w.ok("gate", "add", "--message", QUESTION, "T1", ...ASK);
  assert.ok(!w.table("gates").cols.includes("run"), "a gate without --run keeps the old header");
  assert.match(w.ok("gate", "add", "--message", QUESTION, "T1", ...ASK, "--run", "R1"), /^G2 open · Which layout\?/);
  const { cols, rows } = w.table("gates");
  assert.ok(cols.includes("run"));
  assert.deepEqual(rows.map((g) => [g.id, g.run]), [["G1", ""], ["G2", "R1"]], "the old row reads as no run");
  assert.equal(w.no("gate", "add", "--message", QUESTION, "T1", ...ASK, "--run", "R2"), "sage: --run R2 is a run of T2, not of T1: name the run of T1 that asked this question. Nothing changed.");
  assert.match(w.no("gate", "add", "--message", QUESTION, "T1", ...ASK, "--run", "R9"), /^sage: no run R9\. /);
  assert.match(w.no("gate", "add", "--message", QUESTION, ...ASK, "--run", "R1"), /^sage: --run names the run that asked this question, and a run belongs to a task: give the gate its task/);
  assert.equal(w.table("gates").rows.length, 2, "each refusal adds no gate");
});

test("T1124 R1: an old gates.tsv without the run column still reads, and the next gate with --run adds the column", (t) => {
  const w = world(t);
  tasks(w, 1);
  w.ok("run", "add", "T1", "--role", "investigate");
  writeFileSync(join(w.logbook, "gates.tsv"), `${TABLES.gates.join("\t")}\nG1\tT1\tOld?\tyes|no\tyes\t\t\t2026-11-01T00:00:00Z\n`);
  assert.match(w.ok("status"), /G1/);
  w.ok("gate", "add", "--message", QUESTION, "T1", ...ASK, "--run", "R1");
  assert.deepEqual(w.table("gates").rows.map((g) => [g.id, g.question, g.run]), [["G1", "Old?", ""], ["G2", "Which layout?", "R1"]]);
});

test("T1124 R1: askingRun gives the gate's run, else the newest designer, pe or investigate run of its task that started by the gate's time", () => {
  const runs = [
    { id: "R1", task: "T1", role: "designer", started: "2026-11-15T10:00:00Z" },
    { id: "R2", task: "T1", role: "pe", started: "2026-11-15T11:00:00Z" },
    { id: "R3", task: "T1", role: "implementer", started: "2026-11-15T11:30:00Z" },
    { id: "R4", task: "T2", role: "investigate", started: "2026-11-15T11:40:00Z" },
    { id: "R5", task: "T1", role: "designer", started: "2026-11-15T13:00:00Z" },
  ];
  const gate = { id: "G1", task: "T1", at: "2026-11-15T12:00:00Z", run: "" };
  assert.equal(askingRun(gate, runs)?.id, "R2", "the newest asking role before the gate; not the implementer, not another task's run, not a later run");
  assert.equal(askingRun({ ...gate, run: "R1" }, runs)?.id, "R1", "a recorded run wins");
  assert.equal(askingRun({ ...gate, at: "2026-11-15T09:00:00Z" }, runs), null, "no run asked before the gate");
  assert.equal(askingRun({ ...gate, task: "" }, runs), null, "a gate with no task has no run");
});

test("T1124 S7: run done --status failed needs --why, keeps it in the failure column, and refuses a bad reason; an old runs.tsv still reads", (t) => {
  const w = world(t);
  tasks(w, 1);
  w.ok("run", "add", "T1", "--role", "designer", "--branch", "sage/t1-design");
  w.ok("run", "add", "T1", "--role", "pe");
  assert.ok(!w.table("runs").cols.includes("failure"), "the column comes only with the first reason");
  assert.match(w.no("run", "done", "R1", "--status", "failed"), /^sage: run done --status failed needs --why "<the reason>": one line of at most 200 characters that says why R1 failed/);
  assert.equal(w.no("run", "done", "R1", "--status", "done", "--why", "x"), "sage: --why gives the reason of a failed run, so it goes only with --status failed. Nothing changed.");
  for (const why of ["", "x".repeat(201), "two\nlines", " starts with a space", "hidden​mark"])
    assert.match(w.no("run", "done", "R1", "--status", "failed", "--why", why), /^sage: --why is one line of at most 200 characters, the reason why R1 failed; it /, JSON.stringify(why));
  assert.deepEqual(w.table("runs").rows.map((r) => r.status), ["running", "running"], "each refusal changes nothing");
  assert.equal(w.ok("run", "done", "R1", "--status", "failed", "--why", "its agent stopped with no report"), "R1 failed");
  assert.deepEqual(w.table("runs").rows.map((r) => [r.id, r.status, r.failure]), [["R1", "failed", "its agent stopped with no report"], ["R2", "running", ""]]);
  assert.equal(w.ok("run", "done", "R2", "--status", "failed", "--why", "y".repeat(200)), "R2 failed", "200 characters is the limit");
});

test("T1124 S7: a failed run with no reason, from an old runs.tsv, may add one later, once", (t) => {
  const w = world(t);
  tasks(w, 1);
  w.ok("run", "add", "T1", "--role", "designer", "--branch", "sage/t1-design");
  const { cols, rows } = w.table("runs");
  const old = cols.filter((c) => TABLES.runs.includes(c));
  assert.ok(!old.includes("failure"));
  writeFileSync(join(w.logbook, "runs.tsv"), `${old.join("\t")}\n${old.map((c) => ({ status: "failed", ended: "2026-11-15T10:00:00Z" })[c] ?? rows[0][c]).join("\t")}\n`);
  assert.match(w.ok("status"), /^agents  1 runs · 0 running/m, "the old header reads");
  assert.equal(w.ok("run", "done", "R1", "--status", "failed", "--why", "the owner stopped it"), "R1 failed · added reason");
  assert.equal(w.table("runs").rows[0].failure, "the owner stopped it");
  assert.equal(w.no("run", "done", "R1", "--status", "failed", "--why", "another"), "sage: R1 already ended as failed with its reason, and --why never replaces it. Nothing changed.");
  assert.match(w.no("run", "done", "R1", "--status", "failed"), /^sage: R1 already ended as failed: a run ends once\. A later run done --status failed may only add --tokens or --report, which it lacks\./);
});

test("T1124 R11: a merged task keeps its PR's \"What changes for users\" part from a fake gh, and the board reads it with keptUsersText", (t) => {
  const w = world(t, { remote: "https://github.com/example/sample.git" });
  tasks(w, 2, "tiny");
  for (const task of ["T1", "T2"]) {
    w.ok("task", task, "set", "state=briefed", "state=building", "state=reviewing", "state=verifying");
    w.ok("verdict", task, "--sha", SHA, "--kind", "checks-pass");
    w.ok("task", task, "set", "state=verified");
  }
  w.ok("task", "T1", "set", "pr=7");
  w.ok("task", "T2", "set", "pr=8");
  assert.equal(keptUsersText(w.logbook, "T1"), null, "nothing is kept before the merge");
  assert.match(w.ok("task", "T1", "set", "state=merged"), /^T1 merged · .* · kept PR 7's "What changes for users" for the board/);
  assert.equal(keptUsersText(w.logbook, "T1"), "The board shows each question with its pages.\n\n```sh\n# not a heading\n```\n\n### Details\n\nOne more line.");
  assert.match(w.ok("task", "T2", "set", "state=merged"), / · PR 8 has no "What changes for users" part \(at most 64 KiB\), so the board has no text for this change/);
  assert.equal(keptUsersText(w.logbook, "T2"), null);
  assert.deepEqual(w.ghCalls(), ["pr view 7 --repo example/sample --json body", "pr view 8 --repo example/sample --json body"], "one gh call for each merge, with the repository named");
  assert.equal(keptUsersText(w.logbook, "../T1"), null, "a task id that is not one reads nothing");
});

test("T1124 R11: a project with no GitHub remote asks gh nothing, and a gh failure never stops the merge", (t) => {
  const plain = world(t);
  tasks(plain, 1, "tiny");
  plain.ok("task", "T1", "set", "state=briefed", "state=building", "state=reviewing", "state=verifying");
  plain.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  plain.ok("task", "T1", "set", "state=verified", "pr=7");
  assert.doesNotMatch(plain.ok("task", "T1", "set", "state=merged"), /What changes for users/);
  assert.deepEqual(plain.ghCalls(), []);
  const failing = world(t, { remote: "git@github.com:example/sample.git" });
  tasks(failing, 1, "tiny");
  failing.ok("task", "T1", "set", "state=briefed", "state=building", "state=reviewing", "state=verifying");
  failing.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  failing.ok("task", "T1", "set", "state=verified", "pr=9");
  assert.match(failing.ok("task", "T1", "set", "state=merged"), /^T1 merged · .* · PR 9's "What changes for users" is not kept: gh pr view 9 failed$/);
  assert.equal(failing.table("tasks").rows[0].state, "merged");
});
