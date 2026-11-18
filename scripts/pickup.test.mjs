import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { backed } from "./verdict-backing.mjs";
import { QUESTION } from "./fixtures/question-message.mjs";

const SHA = "b".repeat(40), ADD = ["--size", "small", "--priority", "P2"], HOUR = 3_600_000, STARTED = Date.parse("2026-11-17T08:00:00.000Z");
const LAUNCHER = [fileURLToPath(new URL("../plugins/sage/hooks/launcher.mjs", import.meta.url)), "sage-hook.mjs"];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function world(t, pids = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-pickup-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_WORKTREES: join(base, "worktrees"),
    SAGE_TEST_PIDS: JSON.stringify(pids), SAGE_TEST_MACHINE_ID: "test-machine", SAGE_TEST_BOOT: String(STARTED - HOUR) };
  delete env.SAGE_HOME;
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env);
  const chief = (tool, native) => tool.chiefFor(project, native, env);
  const as = (tool, id) => (...args) => tool.sage([...args, "--project", project, "--chief", id], env);
  const rows = (table) => claude.read(dir, table);
  const record = (id, { ago = 0, ended, pid = 100, confirmed = true, autopilot = false } = {}) => writeFileSync(join(dir, "live", `${id}.json`), JSON.stringify({
    provider: "claude", checkout: project, sageMode: true, autopilot, at: new Date(Date.now() - ago).toISOString(), pid, pidStart: STARTED, machine: "test-machine", boot: STARTED - HOUR, seen: STARTED, confirmed,
    ...(ended ? { ended: { at: new Date(Date.now() - ago).toISOString(), reason: ended } } : {}) }));
  const set = (table, id, cells) => {
    const file = join(dir, `${table}.tsv`), [head, ...lines] = readFileSync(file, "utf8").split("\n"), cols = head.split("\t");
    for (const c of Object.keys(cells)) if (!cols.includes(c)) throw new Error(`no column ${c}`);
    writeFileSync(file, [head, ...lines.map((l) => (l.split("\t")[0] === id ? cols.map((c, k) => (Object.hasOwn(cells, c) ? cells[c] : l.split("\t")[k] ?? "")).join("\t") : l))].join("\n"));
  };
  mkdirSync(join(dir, "live"), { recursive: true });
  return { base, env, project, dir, chief, as, rows, record, set };
}
const row = (w, table, id) => w.rows(table).find((r) => r.id === id);

test("T1172 rule 1: a live or quiet chief never loses work: two live chiefs move nothing, and a quiet chief with an open gate keeps all", (t) => {
  const w = world(t, { 100: STARTED });
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(codex, w.chief(codex, "s-b"));
  c2("task", "add", "--title", "theirs", ...ADD);
  c2("gate", "add", "T1", "--question", "Ship it?", "--options", "yes|no", "--recommend", "yes", "--message", QUESTION);
  w.record("C1");
  w.record("C2");
  assert.equal(c1("pickup"), "nothing to pick up", "two live chiefs");
  w.record("C2", { ago: 3 * HOUR, pid: 100 });
  assert.equal(c1("pickup"), "nothing to pick up", "a quiet chief whose program runs");
  w.record("C2", { ago: 9 * HOUR, pid: 100 });
  assert.equal(c1("pickup"), "nothing to pick up", "9 h quiet, its program runs, and it has an open gate: quiet, not stopped");
  assert.deepEqual([row(w, "tasks", "T1").chief, row(w, "gates", "G1").chief], ["C2", "C2"], "C2 keeps its task and its gate");
  assert.throws(() => c1("task", "T1", "set", "title=x"), /T1 belongs to chief C2 \(codex\), not to C1/, "the owner check still holds");
});

test("T1172 rule 2 (F-T1172-1): all holdings move: a stopped chief with no task, a running run, a queued run and an open gate is picked up, in one write with one decision row", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(codex, w.chief(codex, "s-b"));
  c1("task", "add", "--title", "mine", ...ADD);
  c1("run", "add", "T1", "--role", "qa");
  c1("run", "add", "T1", "--role", "code-reviewer");
  w.set("runs", "R1", { chief: "C2" });
  w.set("runs", "R2", { chief: "C2", status: "queued" });
  c2("gate", "add", "--question", "A question of C2?", "--options", "yes|no", "--recommend", "yes", "--message", QUESTION);
  w.record("C1");
  w.record("C2", { ago: 5 * 60_000, ended: "prompt_input_exit" });
  const out = c1("pickup");
  assert.match(out, /^sage: pick-up from C2 \(codex\) to C1: lost runs R1; queued runs R2; open gates G1; its session stopped \(ended\) at \S+\.\nsage: tell the owner in one line what passed to C1, and start each lost run again now \(R1\), within the agent limit\.$/);
  const [r1, r2] = ["R1", "R2"].map((id) => row(w, "runs", id));
  assert.deepEqual([r1.status, r1.chief, r2.status, r2.chief], ["failed", "C2", "queued", "C1"], "the running run is lost; the queued run waits for C1");
  assert.match(r1.failure, /^lost: its session stopped at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(row(w, "gates", "G1").chief, "C1", "the open gate names the new chief");
  const decision = w.rows("decisions").at(-1);
  assert.deepEqual([decision.task, decision.why], ["", "pick-up"]);
  assert.deepEqual(JSON.parse(decision.handover), { from: "C2", to: "C1", fromProvider: "codex", toProvider: "claude", reason: "ended", since: JSON.parse(decision.handover).since, tasks: [], lost: ["R1"], queued: ["R2"], gates: ["G1"] }, "the typed hand-over row (the board of PR 3 reads it)");
  assert.equal(w.rows("decisions").filter((d) => d.why === "pick-up").length, 1, "one decision row for each stopped chief");
});

test("T1172 rule 3: race: two pick-ups in order: the first takes all, and the second prints nothing to pick up", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b")), c3 = w.as(codex, w.chief(codex, "s-c"));
  c2("task", "add", "--title", "a", ...ADD);
  for (const id of ["C1", "C3"]) w.record(id);
  w.record("C2", { ago: HOUR, ended: "logout" });
  assert.match(c1("pickup"), /^sage: pick-up from C2 \(claude\) to C1: tasks T1;/);
  assert.equal(c3("pickup"), "nothing to pick up");
  assert.equal(row(w, "tasks", "T1").chief, "C1");
});

test("T1172 rule 4 (F-T1172-1): a crash after the tasks write and before the runs write: the next write settles it, so no task is without its owner and no run keeps a stopped owner", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b"));
  c2("task", "add", "--title", "a", ...ADD);
  c2("run", "add", "T1", "--role", "qa");
  w.record("C1");
  w.record("C2", { ago: HOUR, ended: "other" });
  const rename = fs.renameSync;
  let hit = false;
  t.mock.method(fs, "renameSync", (...args) => {
    if (!hit && String(args[1]) === join(w.dir, "runs.tsv")) {
      hit = true;
      throw Object.assign(Error("Injected pick-up stop"), { code: "EIO" });
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => c1("pickup"), /Injected pick-up stop/); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(hit, true, "the fault ran at the runs write");
  assert.deepEqual([row(w, "tasks", "T1").chief, row(w, "runs", "R1").status], ["C1", "running"], "half written: the task moved, the run did not");
  assert.match(c1("log", "-", "a note", "--why", "after the crash"), /logged/, "the next write settles the saved change first");
  assert.deepEqual([row(w, "tasks", "T1").chief, row(w, "runs", "R1").status], ["C1", "failed"]);
  assert.equal(w.rows("runs").filter((r) => r.status === "running" && r.chief === "C2").length, 0, "no run keeps a stopped owner");
  assert.equal(w.rows("decisions").filter((d) => d.why === "pick-up").length, 1, "the settled write has its one decision row");
  assert.equal(c1("pickup"), "nothing to pick up");
});

test("T1172 rule 5 (F-T1172-3): the pick-up runs in the state tool before any chief write: its decision row comes before the new task's row", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(codex, w.chief(codex, "s-b"));
  c2("task", "add", "--title", "theirs", ...ADD);
  w.record("C1");
  w.record("C2", { ago: HOUR, ended: "off" });
  const out = c1("task", "add", "--title", "mine", ...ADD);
  assert.match(out, /^T2 framed [^\n]*\nsage: pick-up from C2 \(codex\) to C1: tasks T1; its session stopped \(ended\) at \S+\.\n/, "the write's own line, then the pick-up line");
  const order = w.rows("decisions").map((d) => (d.why === "pick-up" ? "pick-up" : `${d.task} ${d.decision}`));
  assert.ok(order.indexOf("pick-up") >= 0 && order.indexOf("pick-up") < order.indexOf("T2 task added"), order.join(" | "));
});

for (const [name, from, fresh] of [["a Codex chief", codex, true], ["another Claude chief", claude, false]]) {
  test(`T1172 rule 6 (F-T1172-2): merge check: a task picked up from ${name} ${fresh ? "needs one cycle of runs that started after the pick-up" : "needs no fresh cycle"}, read from the typed hand-over column`, (t) => {
    const w = world(t);
    const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(from, w.chief(from, "s-b"));
    c2("task", "add", "--title", "a", ...ADD);
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) c2(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: c2, keep: (fields) => from.keepReport(w.project, fields, w.env) }));
    w.record("C1");
    w.record("C2", { ago: HOUR, ended: "prompt_input_exit" });
    c1("pickup");
    const old = "2026-01-01T00:00:00Z";
    const decisions = join(w.dir, "decisions.tsv"), [dhead, ...dlines] = readFileSync(decisions, "utf8").trim().split("\n"), dc = dhead.split("\t");
    writeFileSync(decisions, [dhead, ...dlines.map((l) => (l.split("\t")[dc.indexOf("why")] === "pick-up" ? l.split("\t").with(dc.indexOf("at"), "2026-01-01T00:00:01Z").join("\t") : l))].join("\n") + "\n");
    const ledger = join(w.dir, "ledger.tsv"), [head, ...lines] = readFileSync(ledger, "utf8").trim().split("\n"), k = head.split("\t").indexOf("at");
    writeFileSync(ledger, [head, ...lines.map((l) => l.split("\t").with(k, old).join("\t"))].join("\n") + "\n");
    const runs = join(w.dir, "runs.tsv"), [rhead, ...rlines] = readFileSync(runs, "utf8").trim().split("\n"), rc = rhead.split("\t");
    writeFileSync(runs, [rhead, ...rlines.map((l) => l.split("\t").map((v, i) => (["started", "ended"].includes(rc[i]) && v ? old : v)).join("\t"))].join("\n") + "\n");
    const check = () => claude.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", "C1"], w.env);
    if (!fresh) return assert.equal(check(), "T1 may merge: 1 clean cycle on this SHA", "a pick-up between two Claude chiefs keeps the cycle");
    assert.throws(check, /^Error: T1 came from a chief of another provider \(\S+, by a takeover gate or a pick-up\), so the cycles before that do not merge it alone: run one cycle of its reviews and QA on this SHA/);
    for (const kind of ["review-clean", "qa-pass"]) c1(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "2", "--pr", "41"], { cli: c1, keep: (fields) => claude.keepReport(w.project, fields, w.env) }));
    assert.equal(check(), "T1 may merge: 2 clean cycles on this SHA", "after one cycle of runs that started after the pick-up");
  });
}

test("T1172 rule 7 (F-T1172-6): agent limit: 20 running runs of a stopped chief stop counting, so a new run is admitted at once", (t) => {
  const w = world(t, { 100: null });
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b"));
  c1("config", "max_agents=20");
  c2("task", "add", "--title", "a", ...ADD);
  for (let k = 0; k < 20; k++) c2("run", "add", "T1", "--role", "qa");
  assert.equal(w.rows("runs").filter((r) => r.status === "running").length, 20);
  c1("task", "add", "--title", "b", ...ADD);
  w.record("C1");
  w.record("C2", { ago: 5 * 60_000, pid: 100 });
  assert.match(c1("run", "add", "T2", "--role", "qa"), /^R21 running[^\n]*\nsage: pick-up from C2 \(claude\) to C1: tasks T1; lost runs R1, .*R20; its session stopped \(gone\)/, "its program is surely gone, so its 20 places are free");
  assert.equal(w.rows("runs").filter((r) => r.status === "running").length, 1);
});

test("T1172 rule 8: autopilot does not travel: a task picked up from a session with autopilot on does not merge by itself in the picking session, whose autopilot is off", (t) => {
  const w = world(t);
  const bin = join(w.base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '{"headRefName":"sage/t1-a","isCrossRepository":false}'\n`, { mode: 0o755 });
  const env = { ...w.env, PATH: `${bin}:${w.env.PATH}`, SAGE_HOOKS_STATE: join(w.base, "hooks") };
  const send = (event, session) => {
    const r = spawnSync("node", LAUNCHER, { input: JSON.stringify({ session_id: session, cwd: w.project, ...event }), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const a = w.chief(claude, "s-a"), b = w.chief(claude, "s-b");
  assert.deepEqual([a, b], ["C1", "C2"]);
  const merge = (session) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}` } }, session)?.hookSpecificOutput?.permissionDecisionReason;
  for (const prompt of ["sage mode", "autopilot on"]) send({ hook_event_name: "UserPromptSubmit", prompt }, "s-b");
  send({ hook_event_name: "UserPromptSubmit", prompt: "sage mode" }, "s-a");
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b"));
  c2("task", "add", "--title", "a", ...ADD);
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) c2(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: c2, keep: (fields) => claude.keepReport(w.project, fields, w.env) }));
  assert.equal(merge("s-b"), undefined, "before the pick-up, the session with autopilot on merges its own verified task");
  w.record("C1");
  w.record("C2", { ago: HOUR, ended: "prompt_input_exit", autopilot: true });
  assert.match(c1("pickup"), /^sage: pick-up from C2 \(claude\) to C1: tasks T1;/);
  assert.match(merge("s-a"), /autopilot is off, so the user merges/, "the picking session's own switch decides");
  assert.match(merge("s-b"), /T1 belongs to chief C1/, "the old session's autopilot no longer reaches the task");
});

test("T1172 F-T1172-4: a closed Codex desktop thread, whose app program stays open, passes on by the 8 h quiet rule only", (t) => {
  const w = world(t, { 100: STARTED });
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(codex, w.chief(codex, "s-b"));
  c2("task", "add", "--title", "a", ...ADD);
  w.record("C1");
  w.record("C2", { ago: 7 * HOUR, pid: 100 });
  assert.equal(c1("pickup"), "nothing to pick up", "7 h: the app runs, so the probe proves nothing, and it is quiet");
  w.record("C2", { ago: 8 * HOUR + 60_000, pid: 100 });
  assert.match(c1("pickup"), /^sage: pick-up from C2 \(codex\) to C1: tasks T1; its session stopped \(quiet-8h\) at /, "8 h with no action, no agent and no open gate: it passes on");
});

test("T1172 F-T1172-18: claim, offer, cancel and accept are gone, and each points to unclaim, the pick-up and the takeover gate", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a"));
  c1("task", "add", "--title", "a", ...ADD);
  for (const cmd of ["claim", "offer", "cancel", "accept"]) {
    assert.throws(() => c1(cmd, "T1"), new RegExp(`^Error: unknown command "${cmd}"\\. Commands: [^\\n]+\\n${cmd} is gone: .*unclaim <T>.*pick-up.*takeover gate`), `F-T1172-18: ${cmd} points to what replaced it`);
  }
  assert.throws(() => c1("frobnicate", "T1"), (e) => /^unknown command "frobnicate"\. Commands: [^\n]+$/.test(e.message), "another unknown word gets the plain list only");
});

test("T1172 F-T1172-5, F-T1172-16: no command is named release for a task's owner: release T<n> is no alias of unclaim", (t) => {
  const w = world(t);
  const c1 = w.as(claude, w.chief(claude, "s-a"));
  c1("task", "add", "--title", "a", ...ADD);
  assert.throws(() => c1("release", "T1"), /^Error: release takes: add --name/, "F-T1172-16: release T<n> is no command: no alias of unclaim");
  assert.equal(row(w, "tasks", "T1").chief, "C1", "release T1 changed nothing");
  assert.match(c1("release", "add", "--name", "1.0"), /^release 1\.0 added/, "release stays the word for a version");
});

for (const [name, from, fresh] of [["a Codex chief", codex, true], ["another Claude chief", claude, false]]) {
  test(`T1172 F-T1172-10, -12: a takeover from ${name} answered before the typed hand-over (a decision row with no handover cell) ${fresh ? "still needs a fresh cycle" : "needs no fresh cycle"}`, (t) => {
    const w = world(t);
    const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(from, w.chief(from, "s-b"));
    c2("task", "add", "--title", "a", ...ADD);
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) c2(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--pr", "41"], { cli: c2, keep: (fields) => from.keepReport(w.project, fields, w.env) }));
    c1("gate", "replace", "T1", "--to", "C1");
    claude.sage(["gate", "answer", "G1", "--option", "1", "--project", w.project], w.env);
    const old = "2026-01-01T00:00:00Z", file = (table) => join(w.dir, `${table}.tsv`);
    const edit = (table, cell) => {
      const [head, ...lines] = readFileSync(file(table), "utf8").trim().split("\n"), cols = head.split("\t");
      writeFileSync(file(table), [head, ...lines.map((l) => l.split("\t").map((v, k) => cell(cols[k], v, l)).join("\t"))].join("\n") + "\n");
    };
    edit("ledger", (col, v) => (col === "at" ? old : v));
    edit("runs", (col, v) => (["started", "ended"].includes(col) && v ? old : v));
    edit("decisions", (col, v, l) => (!/ → approve\t/.test(l) ? v : col === "at" ? "2026-01-01T00:00:01Z" : col === "handover" ? "" : v));
    const answered = w.rows("decisions").find((d) => / → approve$/.test(d.decision));
    assert.deepEqual([answered.handover ?? "", answered.task], ["", "T1"], "the row has the shape that an older sage wrote");
    assert.equal(row(w, "tasks", "T1").chief, "C1");
    const check = () => claude.sage(["merge-check", "--sha", SHA, "--pr", "41", "--project", w.project, "--chief", "C1"], w.env);
    if (!fresh) return assert.equal(check(), "T1 may merge: 1 clean cycle on this SHA", "a takeover between two Claude chiefs keeps the cycle");
    assert.throws(check, /^Error: T1 came from a chief of another provider \(2026-01-01T00:00:01Z, by a takeover gate or a pick-up\)/);
    for (const kind of ["review-clean", "qa-pass"]) c1(...backed(["verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", "2", "--pr", "41"], { cli: c1, keep: (fields) => claude.keepReport(w.project, fields, w.env) }));
    assert.equal(check(), "T1 may merge: 2 clean cycles on this SHA", "after one cycle of runs that started after the takeover");
  });
}

test("T1172 F-T1172-13: after the off phrase, a session whose agent still runs stays live: no pick-up, its slots stay; once no agent of it runs, its work passes on", (t) => {
  const w = world(t, { 100: STARTED });
  const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b"));
  c2("task", "add", "--title", "a", ...ADD);
  c2("run", "add", "T1", "--role", "lead");
  w.record("C1");
  w.record("C2", { ago: 5 * 60_000, ended: "off" });
  assert.deepEqual(claude.stoppedSessions(w.project, w.env), [], "the hook frees no slot of s-b");
  assert.equal(c1("pickup"), "nothing to pick up", "its program and its lead still run, so the session is live");
  assert.deepEqual([row(w, "runs", "R1").status, row(w, "tasks", "T1").chief], ["running", "C2"]);
  w.set("runs", "R1", { status: "done", ended: new Date().toISOString().slice(0, 19) + "Z" });
  assert.deepEqual(claude.stoppedSessions(w.project, w.env), ["s-b"], "no agent of it runs now: it is stopped");
  assert.match(c1("pickup"), /^sage: pick-up from C2 \(claude\) to C1: tasks T1; its session stopped \(ended\) at /, "no run is lost");
});
