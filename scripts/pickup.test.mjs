import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { readBoardSources } from "../plugins/sage/core/board-reader.mjs";
import { buildBoardModel } from "../plugins/sage/core/board-model.mjs";
import { boardOverview } from "../plugins/sage/core/board-overview.mjs";
import { renderBoardText } from "../plugins/sage/core/board-render.mjs";
import { pickupsOf } from "../plugins/sage/core/pickup.mjs";
import { boardChiefs } from "../plugins/sage/core/chief-live.mjs";
import { pickupLine, sessionRow } from "../plugins/sage/core/state-words.mjs";
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

test("T1172 F-T1172-20: the board and the pick-up agree on a session 9 h quiet: a running run holds it live, also with no news for 24 h; with no running run it is stopped", (t) => {
  const DAY = 24 * HOUR, iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
  const look = (started) => {
    const w = world(t, { 100: STARTED });
    const c1 = w.as(claude, w.chief(claude, "s-a")), c2 = w.as(claude, w.chief(claude, "s-b"));
    c2("task", "add", "--title", "a", ...ADD);
    if (started !== null) {
      c2("run", "add", "T1", "--role", "lead");
      const old = iso(Date.now() - started);
      for (const table of ["runs", "decisions"]) writeFileSync(join(w.dir, `${table}.tsv`), readFileSync(join(w.dir, `${table}.tsv`), "utf8").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, old));
    }
    w.record("C1");
    w.record("C2", { ago: 9 * HOUR });
    const now = Date.now(), model = buildBoardModel(readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now }), { now: new Date(now).toISOString() });
    const chief = model.projects.find((p) => p.books.includes(`shared/${basename(w.dir)}`)).chiefs.find((c) => c.id === "C2");
    const stale = model.tasks.find((one) => one.id === "T1").agents.map((agent) => agent.stale);
    const gone = claude.stoppedSessions(w.project, w.env).includes("s-b"), picked = c1("pickup") !== "nothing to pick up";
    return { board: chief.session, lost: chief.lost, stale, hook: gone, pickup: picked };
  };
  assert.deepEqual(look(3 * DAY), { board: "live", lost: 0, stale: [true], hook: false, pickup: false }, "a run with no news for 24 h: the board shows it stale, and the session stays live in the board, the hook and the pick-up");
  assert.deepEqual(look(10 * 60_000), { board: "live", lost: 0, stale: [false], hook: false, pickup: false }, "a fresh run holds the session live everywhere");
  assert.deepEqual(look(null), { board: "stopped", lost: 0, stale: [], hook: true, pickup: true }, "with no running run, all three say stopped");
});

function firstRealPickupOf20Nov(t) {
  const w = world(t);
  w.chief(claude, "s-a");
  w.chief(codex, "s-b");
  const c3 = w.as(claude, w.chief(claude, "s-c"));
  const put = (table, rows) => {
    const file = join(w.dir, `${table}.tsv`), cols = [...new Set([...readFileSync(file, "utf8").split("\n")[0].split("\t"), "chief"])];
    writeFileSync(file, [cols, ...rows.map((r) => cols.map((c) => r[c] ?? ""))].map((line) => line.join("\t")).join("\n") + "\n");
  };
  const owners = [...Array(69).fill("C1"), ...Array(2).fill("C2"), ...Array(75).fill("")];
  put("tasks", owners.map((chief, i) => ({ id: `T${i + 1}`, title: `task ${i + 1}`, size: "small", route: "build", state: "building", round: "0", priority: "P2", chief })));
  put("runs", [{ id: "R1", task: "T1", role: "implementer", round: "0", status: "running", started: new Date(Date.now() - HOUR).toISOString(), chief: "C1" }]);
  w.record("C1", { ago: 10 * 60_000, ended: "prompt_input_exit" });
  w.record("C2", { ago: 10 * 60_000, ended: "prompt_input_exit" });
  w.record("C3");
  assert.match(c3("pickup"), /^sage: pick-up from C1/, "the pick-up ran");
  const at = w.rows("decisions").findLast((d) => d.why === "pick-up").at, now = Date.now();
  const model = buildBoardModel(readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now }), { now: new Date(now).toISOString() });
  return { w, at, model, project: model.projects.find((p) => p.books.includes(`shared/${basename(w.dir)}`)) };
}

test("F-T1182-2: the board reads the pick-up decision rows: one pick-up for one write, with from, to, the task count of each source, the lost runs and the time", (t) => {
  const { at, model, project } = firstRealPickupOf20Nov(t);
  const want = { at, to: "C3", toProvider: "claude", tasks: 146, lost: ["R1"], sources: [{ from: "C1", fromProvider: "claude", tasks: 69, gates: 0, queued: 0, passedOn: true }, { from: "C2", fromProvider: "codex", tasks: 2, gates: 0, queued: 0, passedOn: true }, { from: "", fromProvider: "", tasks: 75, gates: 0, queued: 0, passedOn: false }] };
  const shape = ({ at, to, toProvider, tasks, lost, sources }) => ({ at, to, toProvider, tasks, lost, sources });
  assert.deepEqual((project.pickups ?? []).map(shape), [want], "the board model");
  assert.deepEqual((boardOverview(model).pickups ?? []).map(shape), [want], "the board in the browser");
  const chiefs = Object.fromEntries(project.chiefs.map((c) => [c.id, { pickedUp: c.pickedUp ?? null, passedOn: c.passedOn ?? null }]));
  assert.deepEqual(chiefs, { C1: { pickedUp: null, passedOn: { at, to: "C3" } }, C2: { pickedUp: null, passedOn: { at, to: "C3" } }, C3: { pickedUp: { at, tasks: 146, gates: 0, queued: 0, lost: 1 }, passedOn: null } });
});

test("F-T1182-1: the Sessions part and the pick-up list show each pick-up short, in counts, with its lost run: on the chat board and in the browser", (t) => {
  const { at, model, project } = firstRealPickupOf20Nov(t);
  const hhmm = at.slice(11, 16), sessions = renderBoardText(model).split("### Sessions\n")[1]?.split("\n\n### ")[0] ?? "";
  const row = (id) => sessions.split("\n").findIndex((line) => line.startsWith(`- Claude · ${id} `) || line.startsWith(`- Codex · ${id} `));
  const sub = (id) => sessions.split("\n")[row(id) + 1] ?? "";
  assert.match(sub("C3"), new RegExp(`· picked up 146 tasks at ${hhmm.replace(":", "\\\\:")} UTC, 1 run lost$`), "the session that took the work");
  assert.match(sub("C1"), new RegExp(`· passed on to C3 at ${hhmm.replace(":", "\\\\:")} UTC$`), "a session that passed its work on");
  const line = sessions.split("\n").map((one) => one.replaceAll("\\", "")).find((one) => one.includes("picked up 146 tasks:"));
  assert.equal(line, `- ${at.slice(0, 10)} ${hhmm} UTC · Claude · C3 picked up 146 tasks: 69 from Claude · C1, 2 from Codex · C2 and 75 with no owning chief · 1 run lost: R1`);
  assert.doesNotMatch(line, /T\d/, "counts, not task ids");
  assert.ok(sessions.includes("Pick-ups, last 7 days:"), sessions);
  const web = boardOverview(model), chief = web.chiefs.find((c) => c.id === "C3");
  assert.deepEqual([chief.pickedUp, web.pickups.length], [{ at, tasks: 146, gates: 0, queued: 0, lost: 1 }, 1], "the browser gets the same notes for its Sessions part and its pick-up list");
  assert.equal(project.chiefs.find((c) => c.id === "C3").tasks, 146);
});

const AT = "2026-11-20T09:25:00.000Z", hhmm = (at) => at.slice(11, 16);
const handover = (from, to, { at = AT, reason = "ended", tasks = [], lost = [], queued = [], gates = [], fromProvider = "claude" } = {}) =>
  ({ at, task: "", decision: `pick-up from ${from} to ${to}`, why: "pick-up", handover: JSON.stringify({ from, to, fromProvider, toProvider: "claude", reason, since: "", tasks, lost, queued, gates }) });
const CHIEFS = ["C1", "C2", "C3"].map((id) => ({ id, provider: "claude", at: "2026-11-01T00:00:00Z" }));
const notesOf = (decisions, now = AT, live = {}) => {
  const chiefs = boardChiefs({ rows: CHIEFS, live, pickups: pickupsOf(decisions), now });
  return Object.fromEntries(chiefs.map((c) => [c.id, sessionRow(c, now, hhmm, (at) => `${at.slice(0, 10)} ${hhmm(at)}`).sub.split(" · ").filter((part) => /^(picked up|passed on)/.test(part))]));
};

test("F-T1186-1: a source that passed on only a question or only a lost run shows what moved, never 0 tasks", () => {
  const gateOnly = pickupsOf([handover("C1", "C3", { gates: ["G1"] })]), lostOnly = pickupsOf([handover("C2", "C3", { lost: ["R1"], fromProvider: "codex" })]);
  assert.equal(pickupLine(gateOnly[0], hhmm), "09:25 · Claude · C3 picked up 1 question: 1 question from Claude · C1 · no run lost");
  assert.equal(pickupLine(lostOnly[0], hhmm), "09:25 · Claude · C3 picked up no task: nothing open from Codex · C2 · 1 run lost: R1");
  const mixed = pickupsOf([handover("C1", "C3", { tasks: ["T1", "T2"] }), handover("C2", "C3", { lost: ["R1"], fromProvider: "codex" })]);
  assert.equal(pickupLine(mixed[0], hhmm), "09:25 · Claude · C3 picked up 2 tasks: 2 from Claude · C1 and nothing open from Codex · C2 · 1 run lost: R1", "the normal form stays for tasks");
  assert.deepEqual(notesOf([handover("C1", "C3", { gates: ["G1"] })]).C3, ["picked up 1 question at 09:25"], "the session note of the chief that took it");
});

test("F-T1186-2: a chief that unclaimed its tasks gets no passed-on note; a stopped chief does", () => {
  const notes = notesOf([handover("C1", "C3", { reason: "unclaimed", tasks: ["T1"] }), handover("C2", "C3", { tasks: ["T2"] })]);
  assert.deepEqual([notes.C1, notes.C2], [[], ["passed on to C3 at 09:25"]]);
});

test("F-T1186-4: a passed-on or picked-up note 12 h old or more shows its date, and a fresh one only its time", () => {
  const rows = [handover("C1", "C3", { tasks: ["T1"] })];
  assert.deepEqual(notesOf(rows, "2026-11-20T15:00:00.000Z"), { C1: ["passed on to C3 at 09:25"], C2: [], C3: ["picked up 1 task at 09:25"] });
  assert.deepEqual(notesOf(rows, "2026-11-22T10:00:00.000Z"), { C1: ["passed on to C3 at 2026-11-20 09:25"], C2: [], C3: ["picked up 1 task at 2026-11-20 09:25"] });
});

test("F-T1186-4: on the chat board, a passed-on note two days old shows its date", (t) => {
  const { w } = firstRealPickupOf20Nov(t);
  const file = join(w.dir, "decisions.tsv"), [head, ...lines] = readFileSync(file, "utf8").trim().split("\n"), cols = head.split("\t"), old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  writeFileSync(file, [head, ...lines.map((l) => (l.split("\t")[cols.indexOf("why")] === "pick-up" ? l.split("\t").with(cols.indexOf("at"), old).join("\t") : l))].join("\n") + "\n");
  w.record("C1", { ago: 2 * 86_400_000 + 10 * 60_000, ended: "prompt_input_exit" });
  const now = Date.now(), model = buildBoardModel(readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now }), { now: new Date(now).toISOString() });
  const text = renderBoardText(model).replaceAll("\\", "");
  assert.ok(text.includes(`passed on to C3 at ${old.slice(0, 10)} ${hhmm(old)} UTC`), text);
});

test("F-T1186-6: a repeated pick-up row counts once", () => {
  const row = handover("C1", "C3", { tasks: ["T1"], lost: ["R1", "R2"] }), [one] = pickupsOf([row, { ...row }]);
  assert.equal(pickupLine(one, hhmm), "09:25 · Claude · C3 picked up 1 task: 1 from Claude · C1 · 2 runs lost: R1, R2");
  assert.deepEqual(notesOf([row, { ...row }]).C3, ["picked up 1 task at 09:25, 2 runs lost"]);
});

test("F-T1186-8: a stopped chief's two groups, the tasks it held and the tasks it unclaimed before, both count", () => {
  const rows = [handover("C1", "C3", { tasks: ["T1"] }), handover("C1", "C3", { reason: "unclaimed", tasks: ["T2"] })], [one] = pickupsOf(rows);
  assert.ok(pickupLine(one, hhmm).startsWith("09:25 · Claude · C3 picked up 2 tasks: "), pickupLine(one, hhmm));
  assert.deepEqual(notesOf(rows), { C1: ["passed on to C3 at 09:25"], C2: [], C3: ["picked up 2 tasks at 09:25"] });
});

test("F-T1186-9: a chief that came back after its work passed on, and stopped again, shows no old passed-on note", () => {
  const rows = [handover("C1", "C3", { tasks: ["T1"] })], beat = (at) => ({ C1: { checkout: null, sageMode: true, autopilot: false, at: Date.parse(at) } }), now = "2026-11-20T20:00:00.000Z";
  assert.deepEqual(notesOf(rows, now, beat("2026-11-20T09:00:00.000Z")).C1, ["passed on to C3 at 09:25"], "its last event was before the pick-up");
  assert.deepEqual(notesOf(rows, now, beat("2026-11-20T10:00:00.000Z")).C1, [], "its last event was after the pick-up");
});

test("F-T1186-7: a pick-up from a chief to itself shows one note: the one for the chief that took the work", () => {
  assert.deepEqual(notesOf([handover("C3", "C3", { tasks: ["T1"] })]).C3, ["picked up 1 task at 09:25"]);
});
