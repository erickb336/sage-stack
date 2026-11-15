import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const { slotsFor } = await import(HOOK);
const { storeDir } = await import("../plugins/sage/skills/sage/sage.mjs");
const REPORT = ["STATUS done", "RESULT sample", "EVIDENCE none", "FINDINGS none", "QUESTIONS none", "NOT VERIFIED none", "BRANCH none"].join("\n");

function scene(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-actions-hook-"))), project = join(dir, "project");
  t.after(() => { try { chmodSync(join(storeDir(project, env), "actions"), 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), SAGE_HOOKS_STATE: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const logbook = storeDir(project, env);
  mkdirSync(logbook, { recursive: true });
  const slots = slotsFor(join(env.SAGE_HOOKS_STATE, "slots"), "s1", Date.now(), "s1");
  slots.take("project", 20, "toolu_start", { role: "sage:implementer", input: { prompt: "Run R5 · task T1 (implementer)" } });
  slots.result("toolu_start", undefined, { status: "async_launched", agentId: "agent-1" });
  const hook = event => {
    const done = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "s1", cwd: project, ...event }), encoding: "utf8", env, timeout: 60_000 });
    assert.equal(done.status, 0, done.stderr);
    return done.stdout;
  };
  const lines = () => { try { return readFileSync(join(logbook, "actions", "R5.jsonl"), "utf8").trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { dir, project, env, logbook, hook, lines };
}

const agent = { agent_id: "agent-1", agent_type: "sage:implementer" };
const EVENTS = [
  { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_1", tool_input: { file_path: "src/sample.mjs" }, ...agent },
  { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "SAMPLE_TOKEN=s3cr3t-sample npm run build" }, ...agent },
  { hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_use_id: "toolu_3", tool_input: { task_id: "lead-T9" }, ...agent },
  { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "SAMPLE_TOKEN=s3cr3t-sample npm run build" }, error: "s3cr3t-sample failed", ...agent },
  { hook_event_name: "SubagentStop", last_assistant_message: REPORT, stop_hook_active: false, ...agent },
];

test("T1088: a sage agent's tool calls give redacted lines with ok, refused, failed and end; the logbook path is looked up once and kept in the slot", t => {
  const s = scene(t), slots = join(s.env.SAGE_HOOKS_STATE, "slots"), kept = () => readdirSync(slots).flatMap(slot => existsSync(join(slots, slot, "actions")) ? [readFileSync(join(slots, slot, "actions"), "utf8")] : []);
  assert.deepEqual(kept(), [], "no logbook path before the first action");
  s.hook(EVENTS[0]);
  assert.deepEqual(kept(), [s.logbook], "the first action keeps the logbook path in the agent's slot");
  const outputs = EVENTS.map(s.hook);
  assert.match(outputs[2], /"permissionDecision":"deny"/, "the hook refuses an agent's stop of a lead");
  assert.deepEqual(s.lines().map(line => [line.tool, line.kind, line.target, line.mark]), [
    ["Read", "file", "src/sample.mjs", "ok"], ["Read", "file", "src/sample.mjs", "ok"], ["Bash", "command", "npm run", "ok"], ["TaskStop", "other", null, "refused"], ["Bash", "command", "npm run", "failed"], ["end", "end", null, "end"]]);
  assert.equal(s.lines()[2].call, s.lines()[4].call, "a failure pairs with its action by the call hash");
  assert.ok(!readFileSync(join(s.logbook, "actions", "R5.jsonl"), "utf8").includes("s3cr3t"), "no tool input reaches the file");
});

test("T1088 K5: the hook's answers are the same when actions/ is read-only, and nothing is written there", t => {
  const writable = scene(t), shut = scene(t);
  mkdirSync(join(shut.logbook, "actions"), { mode: 0o500 });
  assert.deepEqual(EVENTS.map(shut.hook), EVENTS.map(writable.hook));
  assert.deepEqual(readdirSync(join(shut.logbook, "actions")), []);
  assert.equal(writable.lines().length, EVENTS.length);
});

test("T1088: the main session, a non-sage agent and an agent with no bound run write nothing", t => {
  const s = scene(t);
  const main = EVENTS.map(({ agent_id, agent_type, ...event }) => event);
  for (const event of [...main, ...EVENTS.map(event => ({ ...event, agent_id: "agent-other", agent_type: "Explore" })), ...EVENTS.map(event => ({ ...event, agent_id: "agent-2" }))]) s.hook(event);
  assert.equal(existsSync(join(s.logbook, "actions")), false, "no actions folder: no line");
  s.hook(EVENTS[0]);
  assert.equal(s.lines().length, 1, "the bound agent's line, for contrast");
});
