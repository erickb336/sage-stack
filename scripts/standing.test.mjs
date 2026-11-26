import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-standing-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), SAGE_HOME: join(base, "sage"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}" };
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first"]);
  return { env, project };
}
const ORDERS = "# Standing orders\n\nIntro line.\n\n1. One.\n2. Two.\n   The rest of two.\n3. Three.\n\n## From another logbook\n\n4. Four.\n";
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function legacy(t) {
  const w = scratch(t);
  const run = (...args) => claude.sage([...args, "--project", w.project], w.env);
  run("init");
  writeFileSync(join(claude.storeDir(w.project, w.env), "standing.md"), ORDERS);
  return run;
}

test("a retired order leaves the agents' read and stays in standing --all with its reason and date; its text is never deleted", (t) => {
  const run = legacy(t), before = day();
  assert.match(run("standing", "retire", "2", "--why", "replaced by order 4"), /^standing order 2 retired/);
  const today = [before, day()];
  const read = run("standing");
  assert.doesNotMatch(read, /Two|The rest of two/, "the order and its lines under it leave the agents' read");
  assert.match(read, /^1\. One\.$/m);
  assert.match(read, /^3\. Three\.$/m);
  assert.match(read, /^4\. Four\.$/m, "an order under a heading stays");
  assert.match(read, /Not shown: 1 retired \(sage standing --all prints every order\)\.$/);
  const all = run("standing", "--all");
  const mark = all.match(/^2\. \[retired (\S+): replaced by order 4\] Two\.$/m);
  assert.ok(mark, all);
  assert.ok(today.includes(mark[1]), `the mark has today's date: ${mark[1]}`);
  assert.match(all, /^ {3}The rest of two\.$/m);
});

test("numbers never change: a later add takes the next new number, and a retired number is not taken again", (t) => {
  const run = legacy(t);
  run("standing", "retire", "4", "--why", "done");
  assert.equal(run("standing", "add", "Five."), "standing order 5 added");
  const read = run("standing");
  assert.match(read, /^5\. Five\.$/m);
  assert.doesNotMatch(read, /^4\./m);
  assert.match(run("standing", "--all"), /^4\. \[retired \S+: done\] Four\.$/m);
});

test("retire and chief refuse a missing or a retired number, and retire needs a reason; nothing changes", (t) => {
  const run = legacy(t);
  run("standing", "retire", "1", "--why", "old");
  const was = run("standing", "--all");
  assert.throws(() => run("standing", "retire", "9", "--why", "x"), { message: "the standing orders have no order 9. Nothing changed." });
  assert.throws(() => run("standing", "chief", "9"), { message: "the standing orders have no order 9. Nothing changed." });
  assert.throws(() => run("standing", "retire", "1", "--why", "again"), { message: /^standing order 1 is retired already: \[retired \S+: old\]\. Nothing changed\.$/ });
  assert.throws(() => run("standing", "chief", "1"), { message: /^standing order 1 is retired already/ });
  assert.throws(() => run("standing", "retire", "3"), /--why/);
  assert.throws(() => run("standing", "retire", "x", "--why", "y"), /takes one order number/);
  assert.equal(run("standing", "--all"), was);
});

function shared(t) {
  const w = scratch(t);
  claude.sage(["link", "--separate", "--project", w.project], w.env);
  writeFileSync(join(claude.storeDir(w.project, w.env), "standing.md"), ORDERS);
  const chief = claude.chiefFor(w.project, "session-a", w.env);
  return {
    chief: (...args) => claude.sage([...args, "--project", w.project, "--chief", chief], w.env),
    agent: (...args) => claude.sage([...args, "--project", w.project], w.env),
    lead: (...args) => claude.sage([...args, "--project", w.project, "--lead", "R1"], w.env),
  };
}

test("a chief-only order shows, marked, only in the chief's read; the chief's read hides retired orders", (t) => {
  const w = shared(t);
  assert.match(w.chief("standing", "chief", "3"), /^standing order 3 is for the chief only/);
  assert.match(w.chief("standing", "chief", "3"), /^standing order 3 is for the chief only already\. Nothing changed\.$/);
  w.chief("standing", "retire", "1", "--why", "old");
  const agents = w.agent("standing");
  assert.doesNotMatch(agents, /One|Three/);
  assert.match(agents, /^2\. Two\.$/m);
  assert.match(agents, /Not shown: 1 retired and 1 for the chief only/);
  const mine = w.chief("standing");
  assert.match(mine, /^3\. \[chief only\] Three\.$/m);
  assert.doesNotMatch(mine, /One/);
  assert.match(mine, /Not shown: 1 retired \(/);
  const all = w.agent("standing", "--all");
  assert.match(all, /^1\. \[retired \S+: old\] One\.$/m);
  assert.match(all, /^3\. \[chief only\] Three\.$/m);
});

test("only a chief retires or marks: a command with no chief and a lead are refused, and nothing changes", (t) => {
  const w = shared(t);
  w.chief("task", "add", "--title", "a", "--size", "small", "--priority", "P2");
  w.chief("task", "T1", "set", "state=briefed");
  w.chief("run", "add", "T1", "--role", "lead");
  const was = w.agent("standing", "--all");
  for (const args of [["standing", "retire", "2", "--why", "x"], ["standing", "chief", "2"]]) {
    assert.throws(() => w.agent(...args), /a command with no chief only reads: add --chief/, args.join(" "));
    assert.throws(() => w.lead(...args), new RegExp(`"standing ${args[1]}" is not on a lead's list\\.`), args.join(" "));
  }
  assert.equal(w.agent("standing", "--all"), was);
});
