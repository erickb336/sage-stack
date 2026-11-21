import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { boardChiefs, chiefBeat, liveRecord, sessionState } from "../plugins/sage/core/chief-live.mjs";
import { chiefsWhole } from "../plugins/sage/core/chiefs.mjs";
import { readBoardSources } from "../plugins/sage/core/board-reader.mjs";
import { buildBoardModel } from "../plugins/sage/core/board-model.mjs";
import { boardOverview } from "../plugins/sage/core/board-overview.mjs";
import { renderBoardText } from "../plugins/sage/core/board-render.mjs";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE_HOOK = at("../plugins/sage/hooks/sage-hook.mjs"), DISPATCH = pathToFileURL(at("../plugins/sage-codex/hooks/dispatch.mjs")).href;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const MINUTE = 60_000;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-chief-live-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  writeFileSync(join(fakes, "gh"), "#!/bin/sh\necho fake-gh >&2\nexit 1\n");
  chmodSync(join(fakes, "gh"), 0o755);
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  return { base, env, project };
}
function linked(t) {
  const w = scratch(t);
  claude.sage(["link", "--separate", "--project", w.project], w.env);
  const dir = claude.storeDir(w.project, w.env);
  return { ...w, dir, live: (id) => join(dir, "live", `${id}.json`), chiefs: () => readFileSync(join(dir, "chiefs.tsv"), "utf8") };
}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
function table(w, name, rows) {
  const cols = [...new Set([...readFileSync(join(w.dir, `${name}.tsv`), "utf8").split("\n")[0].split("\t"), "chief"])];
  writeFileSync(join(w.dir, `${name}.tsv`), [cols, ...rows.map((row) => cols.map((c) => row[c] ?? ""))].map((line) => line.join("\t")).join("\n") + "\n");
}
const task = (id, chief) => ({ id, title: `task ${id}`, size: "small", route: "build", state: "building", round: "0", chief });
const run = (id, taskId, chief, started) => ({ id, task: taskId, role: "implementer", round: "0", status: "running", started, chief });
function boardOf(w, now) {
  const model = buildBoardModel(readBoardSources([{ id: "shared", path: w.env.SAGE_SHARED_HOME, label: "shared" }], { now }), { now: new Date(now).toISOString() });
  return { model, project: model.projects.find((p) => p.books.includes(`shared/${basename(w.dir)}`)) };
}

function claudeEvent(w, event) {
  const r = spawnSync(process.execPath, [CLAUDE_HOOK], { input: JSON.stringify({ session_id: "claude-1", cwd: w.project, ...event }), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : undefined;
}
const claudeSay = (w, prompt) => claudeEvent(w, { hook_event_name: "UserPromptSubmit", prompt });
const claudeTool = (w) => claudeEvent(w, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(w.project, "x") }, tool_response: {} });

let turns = 0;
function codexEvent(w, event) {
  const transcript = join(w.base, "rollout.jsonl");
  if (!existsSync(transcript)) writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cli_version: "0.164.0", source: "cli" } })}\n`);
  const runner = `import { dispatch } from ${JSON.stringify(DISPATCH)}; import { readFileSync } from "node:fs"; const input = JSON.parse(readFileSync(0, "utf8")); const out = await dispatch(input.hook_event_name, input, {}); process.stdout.write(JSON.stringify(out ?? null));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", runner], { input: JSON.stringify({ session_id: "codex-1", transcript_path: transcript, cwd: w.project, model: "fixture", permission_mode: "default", ...event }), env: w.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const codexSay = (w, prompt) => codexEvent(w, { hook_event_name: "UserPromptSubmit", turn_id: `turn-${++turns}`, prompt });
const codexTool = (w) => codexEvent(w, { hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: {}, tool_response: {} });

const providers = [
  ["Claude", "claude", claudeSay, claudeTool, "claude-1"],
  ["Codex", "codex", codexSay, codexTool, "codex-1"],
];

for (const [name, provider, say, tool, session] of providers) {
  test(`${name}: the sage mode phrase registers the chief before any write, and its hook writes live/C1.json at once`, (t) => {
    const w = linked(t);
    tool(w);
    assert.equal(existsSync(join(w.dir, "chiefs.tsv")), false, "a session with sage mode off is no chief");
    assert.equal(existsSync(w.live("C1")), false);
    say(w, "sage mode");
    const [head, ...rows] = w.chiefs().trim().split("\n");
    assert.equal(head, "id\tprovider\tnative\tat", "chiefs.tsv keeps its four columns");
    assert.deepEqual(rows.map((row) => row.split("\t").slice(0, 3)), [["C1", provider, session]]);
    const live = json(w.live("C1"));
    assert.deepEqual({ ...live, at: undefined }, { provider, checkout: realpathSync(w.project), sageMode: true, autopilot: false, at: undefined, onAt: live.at });
    assert.ok(Math.abs(Date.parse(live.at) - Date.now()) < MINUTE, live.at);
  });

  test(`${name}: the hook does not rewrite live/C1.json within a minute, but at once when autopilot or sage mode changes`, (t) => {
    const w = linked(t);
    say(w, "sage mode");
    const first = readFileSync(w.live("C1"), "utf8"), stamp = statSync(w.live("C1")).mtimeMs;
    tool(w);
    say(w, "show me the tasks");
    tool(w);
    assert.equal(readFileSync(w.live("C1"), "utf8"), first, "no write inside the minute");
    assert.equal(statSync(w.live("C1")).mtimeMs, stamp);
    say(w, "autopilot on");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [true, true], "autopilot on is written at once");
    say(w, "autopilot off");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [true, false], "autopilot off is written at once");
    say(w, "sage mode off");
    assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [false, false], "sage mode off is written at once");
    assert.equal(w.chiefs().trim().split("\n").length, 2, "one chief row");
  });
}

test("Claude and Codex chiefs of one logbook each write their own live file", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  codexSay(w, "sage mode");
  assert.deepEqual(w.chiefs().trim().split("\n").slice(1).map((row) => row.split("\t").slice(0, 2).join(" ")), ["C1 claude", "C2 codex"]);
  assert.deepEqual([json(w.live("C1")).provider, json(w.live("C2")).provider], ["claude", "codex"]);
});

test("a session in a project with no shared logbook writes no live file and makes no chief", (t) => {
  const w = scratch(t);
  claude.sage(["init", "--project", w.project], w.env);
  claudeSay(w, "sage mode");
  const dir = claude.storeDir(w.project, w.env);
  assert.equal(existsSync(join(dir, "chiefs.tsv")), false);
  assert.equal(existsSync(join(dir, "live")), false);
});

test("chiefBeat: a beat is due after a minute, or at once on a change, and never for a session that was never in sage mode", (t) => {
  const w = linked(t);
  const beat = (last, mode, now) => chiefBeat({ last, mode, now, project: w.project, native: "s", provider: "claude", tool: claude, env: w.env });
  const t0 = Date.parse("2026-11-13T10:00:00.000Z"), on = { sageMode: true, autopilot: false };
  assert.equal(beat(undefined, { sageMode: false, autopilot: false }, t0), undefined);
  assert.equal(existsSync(join(w.dir, "chiefs.tsv")), false);
  const first = beat(undefined, on, t0);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z");
  assert.equal(beat(first, on, t0 + MINUTE - 1), first, "not due inside the minute");
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z");
  const second = beat(first, on, t0 + MINUTE);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:01:00.000Z", "due after a minute");
  beat(second, { sageMode: true, autopilot: true }, t0 + MINUTE + 1);
  assert.deepEqual([json(w.live("C1")).at, json(w.live("C1")).autopilot], ["2026-11-13T10:01:00.001Z", true], "due at once on a change");
});

const agentCall = (w) => claudeEvent(w, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "Explore", description: "find", prompt: "find x" } });
const lastBeat = (w) => join(w.env.SAGE_HOOKS_STATE, "live", "claude-1.json");
function beatDue(w) {
  writeFileSync(lastBeat(w), JSON.stringify({ ...json(lastBeat(w)), at: 0 }));
}

test("a failed beat in a sage mode session never throws, and the hook still allows the call", (t) => {
  const w = linked(t);
  const writable = (mode) => chmodSync(join(w.dir, "live"), mode);
  claudeSay(w, "sage mode");
  const first = readFileSync(w.live("C1"), "utf8");
  assert.equal(agentCall(w), undefined, "a chief in sage mode may start an Explore agent");
  writable(0o500);
  try {
    const next = chiefBeat({ last: undefined, mode: { sageMode: true, autopilot: false }, now: Date.now(), project: w.project, native: "claude-1", provider: "claude", tool: claude, env: w.env });
    assert.equal(next.sageMode, true, "the beat is noted, so the hook retries after a minute and not on each event");
    beatDue(w);
    assert.equal(agentCall(w), undefined, "the beat was due and failed, and the hook still allows the call with no second answer");
  } finally { writable(0o700); }
  assert.equal(readFileSync(w.live("C1"), "utf8"), first, "the failed beat changed nothing");
  assert.ok(json(lastBeat(w)).at > 0, "the hook noted the failed beat");
});

test("the Claude hook prints its answer before the beat, so a beat that never returns loses no deny", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  beatDue(w);
  const preload = join(w.base, "beat-never-returns.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    "const write = fs.writeFileSync;",
    'fs.writeFileSync = function (path, ...rest) { if (String(path).includes("/live/C")) process.exit(0); return write.call(this, path, ...rest); };',
    "syncBuiltinESMExports();",
  ].join("\n"));
  const out = claudeEvent({ ...w, env: { ...w.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(w.project, "x"), old_string: "a", new_string: "b" } });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", "a chief in sage mode changes no files, and the deny is out before the beat");
});

test("a live folder that is a link gets no write, and the hook still allows the call", (t) => {
  const w = linked(t);
  const elsewhere = join(w.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(w.dir, "live"));
  claudeSay(w, "sage mode");
  assert.equal(agentCall(w), undefined);
  assert.equal(w.chiefs().trim().split("\n").length, 2, "sage mode still registers the chief");
  assert.deepEqual(readdirSync(elsewhere), [], "the beat does not follow the link");
  const next = chiefBeat({ last: undefined, mode: { sageMode: true, autopilot: false }, now: Date.now(), project: w.project, native: "claude-1", provider: "claude", tool: claude, env: w.env });
  assert.equal(next.sageMode, true);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(lstatSync(join(w.dir, "live")).isSymbolicLink(), "the link stays as it was");
});

test("boardChiefs: a chief turns quiet when its heartbeat is over 30 minutes old, and stops only at 8 h (G227)", () => {
  const beat = Date.parse("2026-11-13T10:00:00.000Z");
  const state = (now) => (({ session, stopped }) => [session, stopped])(boardChiefs({ rows: [{ id: "C1", provider: "claude", at: "2026-11-13T09:00:00.000Z" }], live: { C1: { checkout: null, sageMode: true, autopilot: false, at: beat } }, now })[0]);
  assert.deepEqual(state(beat + 30 * MINUTE), ["live", false]);
  assert.deepEqual(state(beat + 30 * MINUTE + 1), ["quiet", false]);
  assert.deepEqual(state(beat + 8 * 60 * MINUTE - 1), ["quiet", false]);
  assert.deepEqual(state(beat + 8 * 60 * MINUTE), ["stopped", true]);
});

test("boardChiefs, F-T1059-1, -2, -4, -7, -8: names stay apart, a silent chief that waits for the owner is not stopped, a long folder is cut, a stopped chief shows no mode, and agents is a count", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z"), at = "2026-11-13T08:30:00.000Z", old = now - 9 * 60 * MINUTE;
  const rows = [{ id: "C1", provider: "claude", at }, { id: "C2", provider: "claude", at }, { id: "C3", provider: "codex", at }, { id: "C4", provider: "codex", at }];
  const live = { C1: { checkout: "/w/app", sageMode: true, autopilot: true, at: old }, C2: { checkout: "/w/app", sageMode: true, autopilot: true, at: old }, C3: { checkout: `/w/${"long  folder ".repeat(6)}`, sageMode: true, autopilot: true, at: now }, C4: { checkout: "/w/app", sageMode: true, autopilot: false, at: old } };
  const chiefs = boardChiefs({ rows, live, names: { C4: "Claude · app · 2026-11-13 08:30 UTC" }, waits: ["C2"], runs: [{ chief: "C3", status: "running" }, { chief: "C3", status: "running" }], now });
  const [c1, c2, c3, c4] = chiefs;
  assert.deepEqual([c1.name, c2.name, c4.name], ["Claude · app · 2026-11-13 08:30 UTC · C1", "Claude · app · 2026-11-13 08:30 UTC · C2", "Claude · app · 2026-11-13 08:30 UTC · C4"], "F-T1059-1: equal names get their ids, also against a set name");
  assert.deepEqual([c1.stopped, c1.sageMode, c1.autopilot], [true, null, null], "F-T1059-7: a stopped chief shows no mode");
  assert.deepEqual([c2.stopped, c2.waitsForOwner, c2.autopilot], [false, true, true], "F-T1059-2: a silent chief with the owner's open question waits; it is not stopped");
  assert.equal(c3.name, "Codex · long folder long folder long… · 2026-11-13 08:30 UTC", "F-T1059-4: spaces fold, and a long folder is cut at 30 characters");
  assert.equal(c3.agents, 2, "F-T1059-8: agents counts the chief's running runs");
  assert.equal("running" in c3, false);
});

test("the board model: a running run holds its chief live, also a run that the board shows as stale (F-T1172-20); with no running run, the chief stops", (t) => {
  const w = linked(t);
  for (const session of ["a", "b", "c"]) claude.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString(), DAY = 24 * 60 * MINUTE;
  mkdirSync(join(w.dir, "live"));
  const live = (id, ago) => writeFileSync(w.live(id), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - ago) }));
  live("C1", 10 * DAY);
  live("C2", 3 * DAY);
  live("C3", 3 * DAY);
  table(w, "tasks", [task("T1", "C1"), task("T2", "C2"), task("T3", "C3")]);
  table(w, "runs", [run("R1", "T1", "C1", iso(now - 10 * DAY)), { ...run("R2", "T2", "C2", iso(now - 3 * DAY)), status: "done" }, run("R3", "T3", "C3", iso(now - 10 * MINUTE))]);
  const { model, project } = boardOf(w, now);
  assert.deepEqual(project.chiefs.map(({ id, agents, stopped }) => ({ id, agents, stopped })), [
    { id: "C1", agents: 1, stopped: false },
    { id: "C2", agents: 0, stopped: true },
    { id: "C3", agents: 1, stopped: false },
  ]);
  const card = (id) => model.tasks.find((one) => one.id === id);
  assert.deepEqual(["T1", "T2", "T3"].map((id) => card(id).agents.map((agent) => agent.stale)), [[true], [], [false]], "the board's own clock marks R1 stale");
  assert.ok(card("T1").reasons.some((reason) => reason.kind === "chief-unknown"), "the card asks the owner to check C1, which no pick-up takes without the owner");
});

test("the board model: a live file more than 5 minutes in the future is not trusted: all its values are unknown, as with no live file", (t) => {
  const w = linked(t);
  for (const session of ["a", "b", "c"]) claude.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString();
  const rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${[rows[0], ...rows.slice(1).map((row) => row.split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t"))].join("\n")}\n`);
  mkdirSync(join(w.dir, "live"));
  const live = (id, at) => writeFileSync(w.live(id), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: true, at }));
  live("C1", "2099-01-01T00:00:00.000Z");
  live("C2", iso(now + 5 * MINUTE + 1));
  live("C3", iso(now + 5 * MINUTE));
  const folder = basename(realpathSync(w.project)), unknown = { checkout: null, sageMode: null, autopilot: null, heartbeat: null, stopped: null };
  assert.deepEqual(boardOf(w, now).project.chiefs.map(({ id, name, checkout, sageMode, autopilot, heartbeat, stopped }) => ({ id, name, checkout, sageMode, autopilot, heartbeat, stopped })), [
    { id: "C1", name: "Claude · 2026-11-13 08:30 UTC · C1", ...unknown },
    { id: "C2", name: "Claude · 2026-11-13 08:30 UTC · C2", ...unknown },
    { id: "C3", name: `Claude · ${folder} · 2026-11-13 08:30 UTC`, checkout: realpathSync(w.project), sageMode: true, autopilot: true, heartbeat: iso(now + 5 * MINUTE), stopped: false },
  ]);
});

test("F-T1059-3: a live checkout with control or direction characters never reaches the board model: the chief's checkout is unknown, and its default name has no folder", (t) => {
  const w = linked(t);
  claude.chiefFor(w.project, "a", w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${rows[0]}\n${rows[1].split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t")}\n`);
  mkdirSync(join(w.dir, "live"));
  writeFileSync(w.live("C1"), JSON.stringify({ provider: "claude", checkout: "/work/app‮txt.exe\u001b[2Jdone​", sageMode: true, autopilot: false, at: new Date(now - MINUTE).toISOString() }));
  const [chief] = boardOf(w, now).project.chiefs;
  assert.deepEqual([chief.name, chief.checkout], ["Claude · 2026-11-13 08:30 UTC", null]);
});

test("chiefBeat: a beat time later than the clock (the clock moved back) makes a beat due at once", (t) => {
  const w = linked(t);
  const t0 = Date.parse("2026-11-13T10:00:00.000Z"), on = { sageMode: true, autopilot: false };
  const beat = (last, now) => chiefBeat({ last, mode: on, now, project: w.project, native: "s", provider: "claude", tool: claude, env: w.env });
  const ahead = beat(undefined, t0 + 10 * MINUTE);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:10:00.000Z");
  const back = beat(ahead, t0);
  assert.equal(json(w.live("C1")).at, "2026-11-13T10:00:00.000Z", "the beat after the clock moved back writes the true time");
  assert.equal(back.at, t0);
  assert.equal(beat(back, t0 + 1), back, "and then the minute counts again from the true time");
});

test("the Codex launcher prints the hook's answer before the beat, so a beat that never returns loses no answer", (t) => {
  const w = linked(t);
  const cache = join(w.env.CODEX_HOME, "plugins/cache/sage/sage/local"), launcher = join(w.env.CODEX_HOME, "sage-hooks/launch.mjs");
  cpSync(at("../plugins/sage-codex"), cache, { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  cpSync(at("../plugins/sage-codex/hooks/launch.mjs"), launcher);
  const preload = join(w.base, "beat-never-returns.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    "const write = fs.writeFileSync;",
    'fs.writeFileSync = function (path, ...rest) { if (String(path).includes("/live/C")) process.exit(0); return write.call(this, path, ...rest); };',
    "syncBuiltinESMExports();",
  ].join("\n"));
  const transcript = join(w.base, "rollout.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", session_id: "codex-1", cli_version: "0.164.0", source: "cli" } })}\n`);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "codex-1", turn_id: "turn-1", transcript_path: transcript, cwd: w.project, model: "fixture", permission_mode: "default", prompt: "sage mode" };
  const r = spawnSync(process.execPath, [launcher, "UserPromptSubmit"], { input: JSON.stringify(input), env: { ...w.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.chiefs().trim().split("\n").length, 2, "the phrase registered the chief, so the beat was due");
  assert.equal(existsSync(w.live("C1")), false, "the beat never finished");
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /sage mode/i, "the answer is out before the beat");
});

test("the board model: one bad entry in chief-names.json hides only that name, with a warning for it", (t) => {
  const w = linked(t);
  for (const session of ["a", "b"]) claude.chiefFor(w.project, session, w.env);
  writeFileSync(join(w.dir, "chief-names.json"), JSON.stringify({ C1: "Main desk", C2: 5 }));
  const { model, project } = boardOf(w, Date.now());
  assert.deepEqual(project.chiefs.map(({ id, name, named }) => ({ id, named, name: named ? name : "default" })), [
    { id: "C1", named: true, name: "Main desk" },
    { id: "C2", named: false, name: "default" },
  ]);
  assert.deepEqual(model.warnings.map((one) => one.message), ["chief-names.json: the name of C2 is not valid"]);
  assert.throws(() => claude.sage(["chief", "name", "C1", "Front", "--project", w.project], w.env), /chief-names\.json is damaged \(the name of C2 is not valid\)/, "the command never drops the bad entry by itself");
});

test("chief name sets, changes and clears a name with no chief, and refuses a bad name, an unknown chief and a separate logbook", (t) => {
  const w = linked(t);
  claude.chiefFor(w.project, "a", w.env);
  codex.chiefFor(w.project, "b", w.env);
  const names = () => json(join(w.dir, "chief-names.json"));
  const run = (tool, ...args) => tool.sage(["chief", "name", ...args, "--project", w.project], w.env);
  assert.equal(run(claude, "C1", "Main"), 'C1 is named "Main" now.');
  assert.equal(run(codex, "C2", "Night", "shift"), 'C2 is named "Night shift" now.');
  assert.deepEqual(names(), { C1: "Main", C2: "Night shift" });
  run(claude, "C1", "Front desk");
  assert.deepEqual(names(), { C1: "Front desk", C2: "Night shift" });
  assert.equal(run(codex, "C1"), "C1 has no name now, so the board shows its default name.");
  assert.deepEqual(names(), { C2: "Night shift" });
  for (const bad of ["a\tb", "​x", "x".repeat(81)]) assert.throws(() => run(claude, "C2", bad), /the name ".*" has .*Nothing changed\./, JSON.stringify(bad));
  assert.throws(() => run(claude, "C9", "x"), /C9 is not a chief of this logbook/);
  assert.throws(() => run(claude, "R1", "x"), /chief takes: chief name C<n> <name>/);
  assert.deepEqual(names(), { C2: "Night shift" }, "a refusal changes nothing");
  const other = scratch(t);
  claude.sage(["init", "--project", other.project], other.env);
  assert.throws(() => claude.sage(["chief", "name", "C1", "x", "--project", other.project], other.env), /has no shared logbook/);
});

test("the board model lists each chief with provider, name, sage mode, autopilot, heartbeat and stopped; unknown values are null", (t) => {
  const w = linked(t);
  for (const [tool, session] of [[claude, "a"], [codex, "b"], [claude, "c"], [codex, "d"], [claude, "e"]]) tool.chiefFor(w.project, session, w.env);
  const now = Date.parse("2026-11-13T12:00:00.000Z"), iso = (ms) => new Date(ms).toISOString();
  const rows = w.chiefs().trim().split("\n");
  writeFileSync(join(w.dir, "chiefs.tsv"), `${[rows[0], ...rows.slice(1).map((row) => row.split("\t").with(3, "2026-11-13T08:30:00.000Z").join("\t"))].join("\n")}\n`);
  mkdirSync(join(w.dir, "live"));
  const live = (id, minutes, extra = {}) => writeFileSync(w.live(id), JSON.stringify({ provider: "x", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - minutes * MINUTE), ...extra }));
  live("C1", 1, { autopilot: true });
  live("C2", 9 * 60);
  live("C3", 40);
  writeFileSync(w.live("C5"), "{ damaged");
  writeFileSync(join(w.dir, "chief-names.json"), JSON.stringify({ C1: "Main" }));
  table(w, "tasks", [task("T1", "C3")]);
  table(w, "runs", [run("R1", "T1", "C3", iso(now - 10 * MINUTE))]);
  const { model, project } = boardOf(w, now);
  const pick = ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped }) => ({ id, provider, name, named, sageMode, autopilot, heartbeat, stopped });
  const folder = basename(realpathSync(w.project));
  assert.deepEqual(project.chiefs.map(pick), [
    { id: "C1", provider: "claude", name: "Main", named: true, sageMode: true, autopilot: true, heartbeat: iso(now - MINUTE), stopped: false },
    { id: "C2", provider: "codex", name: `Codex · ${folder} · 2026-11-13 08:30 UTC`, named: false, sageMode: null, autopilot: null, heartbeat: iso(now - 9 * 60 * MINUTE), stopped: true },
    { id: "C3", provider: "claude", name: `Claude · ${folder} · 2026-11-13 08:30 UTC`, named: false, sageMode: true, autopilot: false, heartbeat: iso(now - 40 * MINUTE), stopped: false },
    { id: "C4", provider: "codex", name: "Codex · 2026-11-13 08:30 UTC", named: false, sageMode: null, autopilot: null, heartbeat: null, stopped: null },
    { id: "C5", provider: "claude", name: "Claude · 2026-11-13 08:30 UTC", named: false, sageMode: null, autopilot: null, heartbeat: null, stopped: null },
  ]);
  assert.deepEqual(model.diagnostics, [], "the new files never make the board stale");
  assert.deepEqual(model.warnings.map((w) => w.message), ["live/C5.json: invalid JSON"]);
  const overview = boardOverview(model);
  assert.deepEqual(overview.chiefs.map((c) => [c.id, c.project]), ["C1", "C2", "C3", "C4", "C5"].map((id) => [id, project.key]), "T1135: each chief names its project by key");
  assert.equal(overview.next, now - MINUTE + 30 * MINUTE + 1, "the overview wakes when the fresh chief turns quiet");
});

test("an older plugin still reads the logbook: chiefs.tsv keeps its exact columns beside the live files and the names file", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  codexSay(w, "sage mode");
  claude.sage(["chief", "name", "C1", "Main", "--project", w.project], w.env);
  const [head, ...lines] = w.chiefs().trim().split("\n"), cols = head.split("\t");
  assert.ok(chiefsWhole(cols, lines, lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split("\t")[i]])))), "the column check of every plugin accepts chiefs.tsv");
  assert.match(claude.sage(["status", "--project", w.project], w.env), /./);
  assert.match(codex.sage(["status", "--project", w.project], w.env), /./);
});

const HOUR = 60 * MINUTE, T0 = Date.parse("2026-11-17T10:00:00.000Z"), STARTED = Date.parse("2026-11-17T08:00:00.000Z");
function fakeWorld(t, probe) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-session-record-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = { locate: () => ({ dir, shared: true, row: { root: "/work/app" } }), chiefFor: () => "C1", sessionProbe: () => probe.current };
  const beat = (last, now, pid, mode = { sageMode: true, autopilot: false }) => chiefBeat({ last, mode, now, project: "/work/app", native: "s1", provider: "claude", tool, env: {}, pid });
  return { dir, tool, beat, record: () => liveRecord(json(join(dir, "live", "C1.json"))) };
}
const probeOf = (pids, { machine = "mac-1", boot = T0 - 24 * HOUR } = {}) => ({ machine, boot, alive: (pid) => pids[pid] !== undefined && pids[pid] !== null, started: (pid) => pids[pid] ?? NaN });

test("T1170: an unconfirmed record never stops by the probe: beat 1 from pid A, beat 2 from pid B (a short-lived shell)", (t) => {
  const probe = { current: probeOf({ 100: STARTED, 200: STARTED + 5000 }) }, w = fakeWorld(t, probe);
  const first = w.beat(undefined, T0, 100);
  w.beat(first, T0 + MINUTE + 1, 200);
  const record = w.record();
  assert.deepEqual([record.pid, record.confirmed], [200, false], "a new pid resets the pair, so the record is not confirmed");
  const gone = probeOf({});
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, gone), { state: "live", reason: null }, "pid A and pid B are gone, and the session is not stopped by the probe");
  assert.deepEqual(sessionState(record, {}, T0 + 2 * HOUR, gone), { state: "quiet", reason: null });
  assert.deepEqual(sessionState(record, {}, T0 + MINUTE + 1 + 8 * HOUR, gone), { state: "stopped", reason: "quiet-8h" }, "only the 8 h quiet rule stops it");
});

test("T1170: the same pid and start time in two beats at least a minute apart confirm the program; a gone program then stops the session", (t) => {
  const probe = { current: probeOf({ 100: STARTED }) }, w = fakeWorld(t, probe);
  const first = w.beat(undefined, T0, 100);
  assert.equal(w.record().confirmed, false, "one beat confirms nothing");
  const changed = w.beat(first, T0 + 10_000, 100, { sageMode: true, autopilot: true });
  assert.equal(w.record().confirmed, false, "a second beat 10 s later confirms nothing");
  w.beat(changed, T0 + 10_000 + MINUTE, 100, { sageMode: true, autopilot: true });
  const record = w.record();
  assert.deepEqual([record.pid, record.pidStart, record.machine, record.confirmed], [100, STARTED, "mac-1", true]);
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probe.current), { state: "live", reason: null }, "the program runs");
  assert.deepEqual(sessionState(record, { running: 1, gates: 1 }, T0 + 2 * MINUTE, probeOf({})), { state: "stopped", reason: "gone" }, "a confirmed program that is gone stops the session, also with a running run");
});

test("T1170: the start time is always compared: the same pid with another start time is gone, and a new start time on a beat resets the pair", (t) => {
  const probe = { current: probeOf({ 100: STARTED }) }, w = fakeWorld(t, probe);
  w.beat(w.beat(undefined, T0, 100), T0 + MINUTE, 100);
  const record = w.record();
  assert.equal(record.confirmed, true);
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 100: STARTED + 1500 })), { state: "live", reason: null }, "within 2 s is the same program");
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 100: STARTED + 3 * HOUR })), { state: "stopped", reason: "gone" }, "a reused pid is another program");
  probe.current = probeOf({ 100: STARTED + 3 * HOUR });
  w.beat({ sageMode: true, autopilot: false, at: T0 + MINUTE }, T0 + 2 * MINUTE, 100);
  assert.equal(w.record().confirmed, false, "a beat from another start time clears confirmed");
});

test("T1170: a record from another machine id, or with none, is never stopped by the probe: only the quiet rule decides", (t) => {
  const probe = { current: probeOf({ 100: STARTED }, { machine: "mac-other" }) }, w = fakeWorld(t, probe);
  w.beat(w.beat(undefined, T0, 100), T0 + MINUTE, 100);
  const other = w.record(), here = probeOf({}, { machine: "mac-1" });
  assert.equal(other.confirmed, true);
  assert.deepEqual(sessionState(other, {}, T0 + 2 * MINUTE, here), { state: "live", reason: null }, "its pid is not on this Mac, and that proves nothing");
  assert.deepEqual(sessionState(other, {}, T0 + MINUTE + 9 * HOUR, probeOf({ 100: STARTED }, { machine: "mac-1" })), { state: "stopped", reason: "quiet-8h" }, "9 h quiet with a live pid of the same number: the quiet rule");
  probe.current = probeOf({ 100: STARTED }, { machine: null });
  w.beat(w.beat({ sageMode: true, autopilot: false, at: T0 }, T0 + 3 * MINUTE, 100), T0 + 5 * MINUTE, 100);
  const none = w.record();
  assert.deepEqual([none.machine, none.confirmed], [null, false], "no machine id: never confirmed");
  assert.deepEqual(sessionState(none, {}, T0 + 6 * MINUTE, probeOf({}, { machine: null })), { state: "live", reason: null });
});

test("T1170, F-T1172-8: a reboot stops every confirmed record of this Mac by its gone program; a wall-clock step that moves the boot time alone stops nothing", (t) => {
  const probe = { current: probeOf({ 100: STARTED }) }, w = fakeWorld(t, probe);
  w.beat(w.beat(undefined, T0, 100), T0 + MINUTE, 100);
  const record = w.record();
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 100: STARTED }, { boot: T0 - 24 * HOUR + 30_000 })), { state: "live", reason: null }, "the boot time moves a little between reads");
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 100: STARTED }, { boot: T0 - 24 * HOUR + 2 * HOUR })), { state: "live", reason: null }, "a clock step of 2 h moves the boot time (now minus uptime), and the same program still runs: no false stop");
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 200: T0 + MINUTE + 5000 }, { boot: T0 + MINUTE + 1 })), { state: "stopped", reason: "gone" }, "a reboot ends the program");
  assert.deepEqual(sessionState(record, {}, T0 + 2 * MINUTE, probeOf({ 100: T0 + MINUTE + 5000 }, { boot: T0 + MINUTE + 1 })), { state: "stopped", reason: "gone" }, "after a reboot, a pid with the same number is a program of another start time");
});

test("T1170: the quiet rule (G227): 8 h with no beat stops a session only with no open gate and no running run of its chief", (t) => {
  const probe = { current: probeOf({}) }, w = fakeWorld(t, probe);
  w.beat(undefined, T0, 100);
  const record = w.record(), late = T0 + 8 * HOUR;
  assert.deepEqual(sessionState(record, {}, T0 + 31 * MINUTE, null), { state: "quiet", reason: null }, "over 30 minutes with no beat: quiet");
  assert.deepEqual(sessionState(record, {}, late - 1, null), { state: "quiet", reason: null }, "just under 8 h: quiet");
  assert.deepEqual(sessionState(record, {}, late, null), { state: "stopped", reason: "quiet-8h" }, "8 h: stopped");
  assert.deepEqual(sessionState(record, { gates: 1 }, late + HOUR, null), { state: "quiet", reason: null }, "an open gate of the chief keeps it quiet");
  assert.deepEqual(sessionState(record, { running: 1 }, late + HOUR, null), { state: "live", reason: null }, "a running run of the chief keeps it live");
});

test("F-T1170-12: a record more than 5 minutes ahead of the clock is no beat: quiet, not live, in sessionState and on the board", (t) => {
  const probe = { current: probeOf({}) }, w = fakeWorld(t, probe);
  w.beat(undefined, T0 + 6 * MINUTE, 100);
  const ahead = w.record();
  assert.deepEqual(sessionState(ahead, {}, T0, null), { state: "quiet", reason: null }, "6 minutes ahead: quiet");
  assert.deepEqual(sessionState(ahead, { running: 1 }, T0, null), { state: "live", reason: null }, "a running run of the chief still keeps it live");
  assert.equal(boardChiefs({ rows: [{ id: "C1", provider: "claude", at: new Date(T0).toISOString() }], live: { C1: ahead }, now: T0 })[0].heartbeat, null, "the board reads the same record as no beat");
  assert.deepEqual(sessionState(ahead, {}, T0 + 2 * MINUTE, null), { state: "live", reason: null }, "4 minutes ahead is clock skew: live");
});

const linkedAt = (t, pids = { [process.pid]: STARTED }) => {
  const w = linked(t);
  return { ...w, env: { ...w.env, SAGE_TEST_PIDS: JSON.stringify(pids) } };
};
const recordOf = (w, id) => liveRecord(json(w.live(id)));
const chiefRows = (w) => w.chiefs().trim().split("\n").slice(1).map((row) => row.split("\t").slice(0, 3).join(" "));

for (const reason of ["prompt_input_exit", "logout", "other"]) test(`T1170: a clean Claude SessionEnd (${reason}) marks the chief ended, and the session stops with no probe`, (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  assert.equal(recordOf(w, "C1").ended, null);
  assert.equal(claudeEvent(w, { hook_event_name: "SessionEnd", reason }), undefined, "the hook prints nothing at the end");
  const record = recordOf(w, "C1");
  assert.equal(record.ended, reason);
  assert.deepEqual(sessionState(record, { running: 1 }, Date.now(), null), { state: "stopped", reason: "ended" });
  assert.deepEqual(record.sageMode, true, "the end keeps the rest of the record");
});

test("T1170: a SessionEnd that is no clean exit (resume, clear) does not end the chief", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "resume" });
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  assert.equal(recordOf(w, "C1").ended, null);
});

for (const [name, say] of [["Claude", claudeSay], ["Codex", codexSay]]) test(`T1170: ${name}: the off phrase marks the chief ended; sage mode on again in the same session clears it`, (t) => {
  const w = linkedAt(t);
  say(w, "sage mode");
  say(w, "sage mode off");
  assert.equal(recordOf(w, "C1").ended, "off");
  assert.deepEqual(sessionState(recordOf(w, "C1"), {}, Date.now(), null), { state: "stopped", reason: "ended" });
  assert.deepEqual(sessionState(recordOf(w, "C1"), { running: 1 }, Date.now(), null), { state: "live", reason: null }, "F-T1172-13: the program stays after the off phrase, so a running agent of the session keeps it live");
  say(w, "sage mode");
  assert.equal(recordOf(w, "C1").ended, null, "the session is a chief again");
  assert.equal(chiefRows(w).length, 1);
});

test("F-T1170-9: a resumed native id is the same chief, live again at its SessionStart(resume) in its new program, with no new row", (t) => {
  const w = linkedAt(t, { [process.pid]: STARTED }), probe = probeOf({ [process.pid]: STARTED }, { machine: "test-machine" });
  claudeSay(w, "sage mode");
  writeFileSync(w.live("C1"), JSON.stringify({ ...json(w.live("C1")), pid: 4242, pidStart: STARTED - HOUR, seen: 0, confirmed: true }));
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  assert.equal(sessionState(recordOf(w, "C1"), {}, Date.now(), probe).state, "stopped");
  claudeEvent(w, { hook_event_name: "SessionStart", source: "resume" });
  const record = recordOf(w, "C1");
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1"], "the same chief, no new row");
  assert.deepEqual([record.ended, record.pid, record.confirmed], [null, process.pid, false], "the old program and the end are gone; the new program starts its pair");
  assert.deepEqual(sessionState(record, {}, Date.now(), probe), { state: "live", reason: null }, "live before its first prompt, also within a minute of its last beat");
});

test("F-T1170-9: a resumed session after the off phrase stays ended, and a resume of a session that was never a chief writes nothing", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  claudeSay(w, "sage mode off");
  claudeEvent(w, { hook_event_name: "SessionStart", source: "resume" });
  assert.equal(recordOf(w, "C1").ended, "off");
  other(w, { hook_event_name: "SessionStart", source: "resume" });
  assert.deepEqual([chiefRows(w), readdirSync(join(w.dir, "live"))], [["C1 claude claude-1"], ["C1.json"]]);
});

const other = (w, event) => claudeEvent(w, { session_id: "claude-2", ...event });
test("T1170: a Claude /clear keeps the chief: SessionEnd(clear) then SessionStart(clear) of the same program moves the chief to the new session id", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  other(w, { hook_event_name: "SessionStart", source: "clear" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-2"], "one chief, one row, now with the new session id");
  other(w, { hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.equal(claude.chiefFor(w.project, "claude-2", w.env), "C1");
  assert.equal(claude.chiefFor(w.project, "claude-1", w.env, true), undefined, "the cleared session id names no chief");
  assert.deepEqual(readdirSync(join(w.dir, "live")), ["C1.json"], "the note is used once and gone");
  const board = boardOf(w, Date.now()).project.chiefs;
  assert.deepEqual(board.map((chief) => chief.id), ["C1"], "the board shows the chief once");
  const [head, ...lines] = w.chiefs().trim().split("\n"), cols = head.split("\t");
  assert.ok(chiefsWhole(cols, lines, lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split("\t")[i]])))));
});

test("T1170: a SessionStart(clear) with no note, or from another program, makes a new chief", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  other(w, { hook_event_name: "SessionStart", source: "clear" });
  other(w, { hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1", "C2 claude claude-2"], "no note: a new chief");
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  const restarted = { ...w, env: { ...w.env, SAGE_TEST_PIDS: JSON.stringify({ [process.pid]: STARTED + HOUR }) } };
  claudeEvent(restarted, { session_id: "claude-3", hook_event_name: "SessionStart", source: "clear" });
  claudeEvent(restarted, { session_id: "claude-3", hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.deepEqual(chiefRows(w).at(-1), "C3 claude claude-3", "the same pid with another start time is another program: no link");
  const none = { ...w, env: { ...w.env, SAGE_TEST_PIDS: "{}" } };
  claudeEvent(none, { session_id: "claude-2", hook_event_name: "SessionEnd", reason: "clear" });
  claudeEvent(none, { session_id: "claude-4", hook_event_name: "SessionStart", source: "clear" });
  claudeEvent(none, { session_id: "claude-4", hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.deepEqual(chiefRows(w).at(-1), "C4 claude claude-4", "no known start time: no note and no link");
});

test("F-T1170-1: two sessions of one program that clear at the same time stay apart: neither takes a chief by the program", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  other(w, { hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1", "C2 claude claude-2"]);
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  other(w, { hook_event_name: "SessionEnd", reason: "clear" });
  for (const session of ["claude-3", "claude-4"]) {
    claudeEvent(w, { session_id: session, hook_event_name: "SessionStart", source: "clear" });
    claudeEvent(w, { session_id: session, hook_event_name: "UserPromptSubmit", prompt: "sage mode" });
  }
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1", "C2 claude claude-2", "C3 claude claude-3", "C4 claude claude-4"], "each new session id is a new chief; no chief moves to another session's id");
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  claudeEvent(w, { session_id: "claude-5", hook_event_name: "SessionStart", source: "clear" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1", "C2 claude claude-2", "C3 claude claude-3", "C4 claude claude-4"], "a third clear in the same 10 minutes links nothing either");
});

const said = (w, session, prompt) => claudeEvent(w, { session_id: session, hook_event_name: "UserPromptSubmit", prompt });
const edge = (w, session, event) => claudeEvent(w, { session_id: session, ...event });
for (const ends of [["claude-1", "claude-2"], ["claude-2", "claude-1"]]) for (const starts of [["claude-2b", "claude-1b"], ["claude-1b", "claude-2b"]])
test(`F-T1170-11: a chief and a session that is no chief, in one program, clear at once: no chief moves (ends ${ends.join(", ")}; starts ${starts.join(", ")})`, (t) => {
  const w = linkedAt(t);
  said(w, "claude-1", "sage mode");
  said(w, "claude-2", "hello");
  for (const session of ends) edge(w, session, { hook_event_name: "SessionEnd", reason: "clear" });
  for (const session of starts) edge(w, session, { hook_event_name: "SessionStart", source: "clear" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1"], "C1 keeps its old session id: neither new session takes it");
  for (const session of starts) said(w, session, "sage mode");
  assert.deepEqual(chiefRows(w), ["C1 claude claude-1", `C2 claude ${starts[0]}`, `C3 claude ${starts[1]}`], "when in doubt, a new chief");
});

test("F-T1170-11: one session that is no chief clears; its new session turns sage mode on and clears again in 10 minutes: the chief moves to the next session", (t) => {
  const w = linkedAt(t);
  said(w, "claude-1", "hello");
  edge(w, "claude-1", { hook_event_name: "SessionEnd", reason: "clear" });
  edge(w, "claude-2", { hook_event_name: "SessionStart", source: "clear" });
  assert.deepEqual(readdirSync(join(w.dir, "live")), [], "the new session used the note of the clear");
  said(w, "claude-2", "sage mode");
  edge(w, "claude-2", { hook_event_name: "SessionEnd", reason: "clear" });
  edge(w, "claude-3", { hook_event_name: "SessionStart", source: "clear" });
  assert.deepEqual(chiefRows(w), ["C1 claude claude-3"]);
});

test("F-T1172-7: after a Claude /clear the new session stays in sage mode, with the chief's text at its first prompt; with no link it starts off", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  claudeEvent(w, { hook_event_name: "SessionEnd", reason: "clear" });
  other(w, { hook_event_name: "SessionStart", source: "clear" });
  assert.equal(json(join(w.env.SAGE_HOOKS_STATE, "claude-2.json")).sage, true, "the hook copied sage mode to the new session at the link");
  assert.equal(json(join(w.env.SAGE_HOOKS_STATE, "claude-2.json")).autopilot, undefined, "autopilot does not travel: only the owner's phrase turns it on");
  const first = other(w, { hook_event_name: "UserPromptSubmit", prompt: "go on" })?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(first, /chief of staff/i, "the first prompt after the clear gets the chief's text again");
  const off = linkedAt(t);
  claudeEvent(off, { hook_event_name: "SessionEnd", reason: "clear" });
  other(off, { hook_event_name: "SessionStart", source: "clear" });
  assert.equal(existsSync(join(off.env.SAGE_HOOKS_STATE, "claude-2.json")), false, "a session that was not in sage mode gives no mode to the next");
});

test("F-T1172-9: a Codex beat records the start mark's pid only while it is still the hook's parent: a short-lived parent leaves no pid, so the probe never stops the session", (t) => {
  const w = linkedAt(t, { [process.pid]: STARTED, 4242: STARTED });
  codexThread(w, "codex-a");
  assert.equal(recordOf(w, "C1").pid, process.pid, "the parent that stays (the Codex program) is recorded");
  const marks = join(w.env.CODEX_HOME, "sage", ".hooks", "codex", "marks"), [mark] = readdirSync(marks);
  writeFileSync(join(marks, mark), JSON.stringify({ ...json(join(marks, mark)), pid: 4242 }));
  const due = join(w.env.CODEX_HOME, "sage", ".hooks", "codex", "live");
  for (const name of readdirSync(due)) writeFileSync(join(due, name), JSON.stringify({ ...json(join(due, name)), at: 0 }));
  codexEvent(w, { session_id: "codex-a", transcript_path: join(w.base, "rollout-codex-a.jsonl"), hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: {}, tool_response: {} });
  const record = recordOf(w, "C1");
  assert.deepEqual([record.pid, record.confirmed], [null, false], "the mark names pid 4242, a shell that started the session and is not this hook's parent: no pid, no trust");
  assert.deepEqual(sessionState(record, {}, Date.now() + 2 * MINUTE, { machine: "test-machine", boot: Date.now() - HOUR, alive: () => false, started: () => NaN }), { state: "live", reason: null }, "the probe never stops it");
});

test("F-T1172-6: the agent cap drops the Claude slots of a stopped session, and keeps the slots of a live one", async (t) => {
  const { slotsFor } = await import(pathToFileURL(CLAUDE_HOOK).href);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-slots-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const theirs = slotsFor(join(dir, "slots"), "claude-b", Date.now(), "claude-b"), mine = slotsFor(join(dir, "slots"), "claude-a", Date.now(), "claude-a");
  for (let k = 0; k < 3; k++) assert.deepEqual(theirs.take("app", 3, `call-${k}`, { role: "sage:implementer" }), { ok: true });
  assert.equal(mine.take("app", 3, "call-x", { role: "sage:implementer", gone: [] }).refused, "total", "3 of 3 places are taken by the other session");
  assert.equal(mine.take("app", 3, "call-y", { role: "sage:implementer", gone: ["claude-a"] }).refused, "total", "a session never drops its own slots");
  assert.deepEqual(mine.take("app", 3, "call-z", { role: "sage:implementer", gone: ["claude-b"] }), { ok: true }, "the stopped session's places are free");
  assert.deepEqual(mine.take("app", 3, "call-w", { role: "sage:implementer", caller: "agent-1", gone: ["claude-b"] }), { ok: true }, "a helper of a lead (an exact slot) takes a place too");
  assert.equal(readdirSync(join(dir, "slots")).filter((name) => name.startsWith("slot-")).length, 2);
});

function codexThread(w, session) {
  const transcript = join(w.base, `rollout-${session}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.164.0", source: "cli" } })}\n`);
  for (const event of [{ hook_event_name: "SessionStart", source: "startup" }, { hook_event_name: "UserPromptSubmit", turn_id: `turn-${++turns}`, prompt: "sage mode" }]) codexEvent(w, { session_id: session, transcript_path: transcript, ...event });
}
test("T1170: two Codex threads in one app-server process (one pid and start time) stay two chiefs, each with the program in its record", (t) => {
  const w = linkedAt(t);
  codexThread(w, "codex-a");
  codexThread(w, "codex-b");
  assert.deepEqual(chiefRows(w), ["C1 codex codex-a", "C2 codex codex-b"]);
  assert.deepEqual([recordOf(w, "C1"), recordOf(w, "C2")].map(({ pid, pidStart }) => [pid, pidStart]), [[process.pid, STARTED], [process.pid, STARTED]], "the pid that the start mark keeps");
});

test("T1170: agent actions renew the chief's record, in Claude and in Codex", (t) => {
  const w = linkedAt(t);
  claudeSay(w, "sage mode");
  codexSay(w, "sage mode");
  const stale = new Date(Date.now() - 2 * HOUR).toISOString();
  for (const id of ["C1", "C2"]) writeFileSync(w.live(id), JSON.stringify({ ...json(w.live(id)), at: stale }));
  beatDue(w);
  const codexLast = join(w.env.CODEX_HOME, "sage", ".hooks", "codex", "live");
  for (const name of readdirSync(codexLast)) writeFileSync(join(codexLast, name), JSON.stringify({ ...json(join(codexLast, name)), at: 0 }));
  claudeEvent(w, { hook_event_name: "PreToolUse", agent_id: "agent-1", agent_type: "sage:implementer", tool_name: "Read", tool_input: { file_path: join(w.project, "x") } });
  codexEvent(w, { hook_event_name: "PostToolUse", agent_id: "agent-1", tool_name: "read_file", tool_input: {}, tool_response: {} });
  for (const id of ["C1", "C2"]) assert.ok(Date.now() - recordOf(w, id).at < MINUTE, `${id}: an agent action wrote a fresh beat`);
});

test("F-T1170-18: an agent event with a due beat never writes the session hook state, so the owner's off phrase in the same moment stays", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  claudeSay(w, "autopilot on");
  const file = join(w.env.SAGE_HOOKS_STATE, "claude-1.json");
  assert.equal(json(file).autopilot, true);
  const preload = join(w.base, "owner-off-during-beat.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
    "const now = Date.now; Date.now = () => now() + 2 * 60_000;",
    "const write = fs.writeFileSync, record = `${process.env.TEST_LOGBOOK}/live/C`, state = process.env.TEST_STATE;",
    "fs.writeFileSync = function (path, ...rest) {",
    "  if (String(path).startsWith(record)) write.call(this, state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, 'utf8')), autopilot: false }));",
    "  return write.call(this, path, ...rest);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const at = json(w.live("C1")).at;
  claudeEvent({ ...w, env: { ...w.env, TEST_LOGBOOK: w.dir, TEST_STATE: file, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } },
    { hook_event_name: "PostToolUse", agent_id: "agent-1", agent_type: "sage:implementer", tool_name: "Read", tool_input: { file_path: join(w.project, "x") }, tool_response: {} });
  assert.notEqual(json(w.live("C1")).at, at, "the agent event renewed the chief's record");
  assert.equal(json(file).autopilot, false, "the owner's off phrase stays in the session hook state");
});

test("F-T1173-1: a beat that the hook kept in its session state before the beat file still counts, so the off phrase writes sage mode and autopilot off to the shared record", (t) => {
  const w = linked(t);
  claudeSay(w, "sage mode");
  claudeSay(w, "autopilot on");
  assert.deepEqual([json(w.live("C1")).sageMode, json(w.live("C1")).autopilot], [true, true]);
  const state = join(w.env.SAGE_HOOKS_STATE, "claude-1.json");
  writeFileSync(state, JSON.stringify({ ...json(state), live: json(lastBeat(w)) }));
  rmSync(lastBeat(w));
  claudeSay(w, "sage mode off");
  const record = json(w.live("C1"));
  assert.deepEqual([record.sageMode, record.autopilot, record.ended?.reason], [false, false, "off"], "the shared record shows the owner's off, not the old on");
});

test("T1173: the board gives each session its state: live, quiet with its pass-on time, quiet for the owner's question, stopped after 8 h, ended, not confirmed, and its lost runs", () => {
  const iso = (ms) => new Date(ms).toISOString(), record = (data) => liveRecord({ checkout: "/w/app", sageMode: true, autopilot: false, ...data });
  const ids = ["C1", "C2", "C3", "C4", "C5", "C6"], rows = ids.map((id) => ({ id, provider: id === "C2" ? "codex" : "claude", at: iso(T0 - 10 * HOUR) }));
  const live = {
    C1: record({ at: iso(T0 - MINUTE), confirmed: true }),
    C2: record({ at: iso(T0 - 3 * HOUR), confirmed: true }),
    C3: record({ at: iso(T0 - 9 * HOUR), confirmed: true }),
    C4: record({ at: iso(T0 - 9 * HOUR), confirmed: true }),
    C5: record({ at: iso(T0 - 2 * HOUR), confirmed: true, ended: { at: iso(T0 - 2 * HOUR), reason: "prompt_input_exit" } }),
    C6: record({ at: iso(T0 - MINUTE) }),
  };
  const runs = [{ chief: "C1", status: "running" }, { chief: "C4", status: "done" }, { chief: "C5", status: "running" }, { chief: "C5", status: "done" }];
  const chiefs = boardChiefs({ rows, live, runs, waits: ["C3"], owners: ["C1", "C1", "C2", "C4", "C5", "C5", "C5"], now: T0 });
  const pick = ({ id, session, reason, stopped, passOnAt, endedAt, confirmed, tasks, agents, lost, waitsForOwner }) => ({ id, session, reason, stopped, passOnAt, endedAt, confirmed, tasks, agents, lost, waitsForOwner });
  assert.deepEqual(chiefs.map(pick), [
    { id: "C1", session: "live", reason: null, stopped: false, passOnAt: null, endedAt: null, confirmed: true, tasks: 2, agents: 1, lost: 0, waitsForOwner: false },
    { id: "C2", session: "quiet", reason: null, stopped: false, passOnAt: iso(T0 + 5 * HOUR), endedAt: null, confirmed: true, tasks: 1, agents: 0, lost: 0, waitsForOwner: false },
    { id: "C3", session: "quiet", reason: null, stopped: false, passOnAt: null, endedAt: null, confirmed: true, tasks: 0, agents: 0, lost: 0, waitsForOwner: true },
    { id: "C4", session: "stopped", reason: "quiet-8h", stopped: true, passOnAt: null, endedAt: null, confirmed: true, tasks: 1, agents: 0, lost: 0, waitsForOwner: false },
    { id: "C5", session: "stopped", reason: "ended", stopped: true, passOnAt: null, endedAt: iso(T0 - 2 * HOUR), confirmed: true, tasks: 3, agents: 1, lost: 1, waitsForOwner: false },
    { id: "C6", session: "live", reason: null, stopped: false, passOnAt: null, endedAt: null, confirmed: false, tasks: 0, agents: 0, lost: 0, waitsForOwner: false },
  ]);
});

test("T1173: the board model marks a running run of a stopped session lost, and keeps a running run of a live session at work", (t) => {
  const w = linked(t);
  for (const session of ["a", "b"]) claude.chiefFor(w.project, session, w.env);
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  mkdirSync(join(w.dir, "live"));
  writeFileSync(w.live("C1"), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - 20 * MINUTE), ended: { at: iso(now - 10 * MINUTE), reason: "prompt_input_exit" } }));
  writeFileSync(w.live("C2"), JSON.stringify({ provider: "claude", checkout: w.project, sageMode: true, autopilot: false, at: iso(now - MINUTE) }));
  table(w, "tasks", [task("T1", "C1"), task("T2", "C2")]);
  table(w, "runs", [run("R1", "T1", "C1", iso(now - 15 * MINUTE)), run("R2", "T2", "C2", iso(now - 5 * MINUTE))]);
  const { model, project } = boardOf(w, now);
  assert.deepEqual(project.chiefs.map(({ id, session, reason, lost }) => ({ id, session, reason, lost })), [{ id: "C1", session: "stopped", reason: "ended", lost: 1 }, { id: "C2", session: "live", reason: null, lost: 0 }]);
  const agents = model.agents.projects.flatMap((one) => one.agents).map(({ runId, state }) => ({ runId, state }));
  assert.deepEqual(agents.sort((a, b) => a.runId.localeCompare(b.runId)).map(({ runId, state }) => [runId, state === "lost"]), [["R1", true], ["R2", false]]);
  const overview = boardOverview(model);
  assert.equal(overview.agents.flatMap((book) => book.runs).find((one) => one.id === "R1").state, "lost", "the Agents page shows the run as lost");
  const hhmm = (ms) => iso(ms).slice(11, 16).replace(":", "\\:"), sessions = renderBoardText(model).split("### Sessions\n")[1]?.split("\n\n### ")[0];
  assert.equal(sessions, `#### ${project.name}\n- Claude · C1 · ended ${hhmm(now - 10 * MINUTE)} UTC · **ended**\n  1 task · 1 run lost\n- Claude · C2 · since ${hhmm(Date.parse(project.chiefs[1].startedAt))} UTC · **live**\n  1 task · 1 agent · program not confirmed`, "the chat board shows the same Sessions part");
});

function modeOnWith(t, others) {
  const w = linked(t);
  for (const [session, tool] of others.map(({ provider }, i) => [`other-${i}`, provider === "codex" ? codex : claude])) tool.chiefFor(w.project, session, w.env);
  mkdirSync(join(w.dir, "live"), { recursive: true });
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString(), tasks = [], runs = [];
  others.forEach(({ provider, ago, tasks: owned = 0, agents = 0 }, i) => {
    const id = `C${i + 1}`;
    writeFileSync(w.live(id), JSON.stringify({ provider, checkout: w.project, sageMode: true, autopilot: false, at: iso(now - ago) }));
    for (let n = 0; n < owned; n++) tasks.push(task(`T${tasks.length + 1}`, id));
    for (let n = 0; n < agents; n++) runs.push(run(`R${runs.length + 1}`, tasks.find((one) => one.chief === id).id, id, iso(now - MINUTE)));
  });
  table(w, "tasks", tasks);
  table(w, "runs", runs);
  return w;
}
const modeOnLine = (output) => output.hookSpecificOutput.additionalContext.split("\n\n---\n\n").find((part) => /session/.test(part) && part.startsWith("sage: ") && !part.startsWith("sage: sage mode is on"));

test("T1173: the sage mode on line says that no other session works here when none is live", (t) => {
  const w = modeOnWith(t, [{ provider: "claude", ago: 3 * HOUR, tasks: 1 }]);
  assert.equal(modeOnLine(claudeSay(w, "sage mode")), "sage: no other sage session works on this project now.", "a quiet session is not named");
});

for (const [name, say] of [["Claude", claudeSay], ["Codex", codexSay]]) test(`T1173: ${name}: the sage mode on line names the one other live session, its tasks and agents, and the free agents`, (t) => {
  const w = modeOnWith(t, [{ provider: "claude", ago: MINUTE, tasks: 2, agents: 1 }]);
  assert.equal(modeOnLine(say(w, "sage mode")), "sage: a Claude session C1 also works on this project: 2 tasks, 1 agent. Each session keeps its own tasks. You share 10 agents; 9 are free. Tell the user this in one line.");
});

test("T1173: the sage mode on line names 2 other live sessions, and not an ended one", (t) => {
  const w = modeOnWith(t, [{ provider: "claude", ago: MINUTE, tasks: 14, agents: 3 }, { provider: "codex", ago: 2 * MINUTE, tasks: 2, agents: 1 }, { provider: "claude", ago: 9 * HOUR, tasks: 1 }]);
  assert.equal(modeOnLine(claudeSay(w, "sage mode")), "sage: 2 other sessions also work on this project: Claude session C1 (14 tasks, 3 agents) and Codex session C2 (2 tasks, 1 agent). Each session keeps its own tasks. You share 10 agents; 6 are free. Tell the user this in one line.");
});

function beatsDue(w) {
  for (const dir of [join(w.env.SAGE_HOOKS_STATE, "live"), join(w.env.CODEX_HOME, "sage", ".hooks", "codex", "live")]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) writeFileSync(join(dir, name), JSON.stringify({ ...json(join(dir, name)), at: 0 }));
  }
}
const passOn = (w, at) => writeFileSync(join(w.dir, "decisions.tsv"), ["at\ttask\tdecision\twhy\tchief\thandover",
  [new Date(at).toISOString(), "", "pick-up from C1 to C9", "pick-up", "C9", JSON.stringify({ from: "C1", to: "C9", fromProvider: "claude", toProvider: "claude", reason: "ended", since: "", tasks: ["T1"], lost: [], queued: [], gates: [] })].join("\t")].join("\n") + "\n");
const passedOnOf = (w) => boardOf(w, Date.now()).project.chiefs.find((c) => c.id === "C1").passedOn;

for (const [name, say, tool] of [["Claude", claudeSay, claudeTool], ["Codex", codexSay, codexTool]]) test(`F-T1186-10: ${name}: a stopped chief's passed-on note stays while its session keeps beating with sage mode off, and goes when sage mode comes back`, (t) => {
  const w = linkedAt(t);
  say(w, "sage mode");
  say(w, "sage mode off");
  const back = (ms) => new Date(Date.now() - ms).toISOString(), file = w.live("C1");
  writeFileSync(file, JSON.stringify({ ...json(file), at: back(20 * MINUTE), ended: { reason: "off", at: back(20 * MINUTE) }, onAt: back(20 * MINUTE) }));
  passOn(w, Date.now() - 10 * MINUTE);
  beatsDue(w);
  tool(w);
  const record = recordOf(w, "C1");
  assert.deepEqual([record.ended, record.at > Date.now() - MINUTE], ["off", true], "a new heartbeat, the ended mark kept");
  assert.equal(passedOnOf(w)?.to, "C9", "the chief is still stopped, so the note stays");
  say(w, "sage mode");
  say(w, "sage mode off");
  beatsDue(w);
  tool(w);
  assert.equal(passedOnOf(w), null, "F-T1186-9: the chief came back with sage mode on after the pass-on, so the old note goes");
});
