import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { boardCommandPort } from "./fixtures/board-port.mjs";
import { LOG, OWNER_PORT } from "./fixtures/owner-board-guard.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_CHILD = join(ROOT, "scripts/board-test-child.mjs");
const owned = new Set();

function runner(file, args, env, input) {
  const child = spawn(process.execPath, [TEST_CHILD, file, ...args], { cwd: env.HOME, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const exited = new Promise(done => { child.once("exit", () => done(true)); child.once("error", () => done(true)); });
  const closed = Promise.all([exited, finished(child.stdout), finished(child.stderr)]);
  const record = { child, closed, exited };
  owned.add(record);
  child.stdout.resume(); child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  record.result = new Promise((resolve, reject) => {
    child.on("message", message => { if (message.kind === "result") resolve(message); });
    child.once("close", status => reject(new Error(`${file} exited before its result (${status})`)));
  });
  return record;
}
async function closeAll() {
  await Promise.all([...owned].map(async record => {
    if (record.child.connected) record.child.send({ kind: "close-tree" }, () => {});
    await record.closed;
    owned.delete(record);
  }));
}

const get = (port, path = "/app/") => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path, agent: false, timeout: 2000, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    done({ status: response.statusCode, board: response.headers["x-sage-board"] });
  });
  req.once("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  req.once("error", error => done({ error: error.code }));
  req.end();
});
async function until(port, path, wanted) {
  for (let end = Date.now() + 15_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 100))) if ((await get(port, path)).status === wanted) return;
  assert.fail(`${path} did not answer ${wanted} within 15 s`);
}

const PROVIDERS = {
  claude(dir, env) {
    const plugin = join(ROOT, "plugins/sage");
    const vars = { ...env, SAGE_HOOKS_STATE: join(dir, "hook-state"), CLAUDE_CONFIG_DIR: join(dir, "claude") };
    return (fields) => runner(join(plugin, "hooks/launcher.mjs"), ["sage-hook.mjs"], vars, JSON.stringify({ session_id: "board-links-1", cwd: dir, hook_event_name: "Stop", stop_hook_active: false, ...fields }));
  },
  codex(dir, env) {
    const codex = join(dir, ".codex"), cache = join(codex, "plugins/cache/sage/sage/0.1.0");
    mkdirSync(join(codex, "plugins/cache/sage/sage"), { recursive: true });
    cpSync(join(ROOT, "plugins/sage-codex"), cache, { recursive: true });
    const vars = { ...env, CODEX_HOME: codex };
    const installed = spawnSync(process.execPath, [join(cache, "skills/sage/sage.mjs"), "hooks", "install"], { cwd: dir, env: vars, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    return (fields) => runner(join(codex, "sage-hooks/launch.mjs"), ["Stop"], vars, JSON.stringify({ session_id: "019b0001-0000-7000-8000-000000000000", turn_id: "turn-1", transcript_path: null, cwd: dir, model: "fixture", permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false, ...fields }));
  },
};

async function scratch(t, provider, { setup = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-links-")));
  t.after(async () => { await closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const { CODEX_HOME, SAGE_SHARED_HOME, ...inherited } = process.env;
  const env = { ...inherited, HOME: dir, SAGE_HOME: join(dir, "sage-home"), SAGE_SHARED_HOME: join(dir, "shared"), DO_NOT_TRACK: "1", [LOG]: join(dir, "owner-port.log") };
  const port = await boardCommandPort(), cli = join(ROOT, "plugins/sage/board/cli.mjs"), config = join(dir, ".config/sage-board/board.json");
  const made = setup && spawnSync(process.execPath, [cli, "board", "--setup", "--port", String(port)], { cwd: dir, env, encoding: "utf8" });
  if (made) assert.equal(made.status, 0, made.stderr);
  const stop = PROVIDERS[provider](dir, env);
  const hook = async (fields) => {
    const run = stop(fields), { status, stdout, stderr } = await run.result;
    assert.equal(status, 0, stderr);
    return { output: stdout ? JSON.parse(stdout) : undefined, run };
  };
  const startBoard = async () => {
    const { stdout, status, stderr } = await runner(cli, ["board", "--ensure"], env).result;
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^Sage board started/);
  };
  const readyLines = () => readFileSync(join(dir, ".config/sage-board/board.log"), "utf8").split("\n").filter(line => line.startsWith("Sage board: ")).length;
  return { dir, port, config, hook, startBoard, readyLines };
}

for (const provider of Object.keys(PROVIDERS)) {
  test(`T1256 ${provider}: the board is up, so the chief's message with board links passes, and the hook starts nothing`, async (t) => {
    const s = await scratch(t, provider);
    await s.startBoard();
    await until(s.port, "/app/", 200);
    const before = (await get(s.port)).board;
    const message = `The page: http://127.0.0.1:${s.port}/app/. The board: http://localhost:${s.port}/ (it opens the app).`;
    const { output, run } = await s.hook({ last_assistant_message: message });
    assert.equal(output, undefined, "nothing blocks the stop");
    assert.equal(await run.exited, true, "the hook process ended: it holds no board of its own");
    assert.equal((await get(s.port)).board, before, "the same board answers: no restart");
    assert.equal(s.readyLines(), 1, "one board start in the log: the hook started none");
  });

  test(`T1256 ${provider}: the board is down, so the hook starts it once, the link answers 200, and the message passes; a message with no board link starts nothing`, async (t) => {
    const s = await scratch(t, provider);
    const link = `http://127.0.0.1:${s.port}/app/`;
    assert.deepEqual(await get(s.port), { error: "ECONNREFUSED" }, "no board runs at the start");
    const other = await s.hook({ last_assistant_message: "The preview: http://localhost:5199/index.html, and no board link." });
    assert.equal(other.output, undefined);
    assert.deepEqual(await get(s.port), { error: "ECONNREFUSED" }, "a link to another port starts no board");
    const agent = await s.hook({ agent_id: "agent-1", last_assistant_message: `See ${link}` });
    assert.equal(agent.output, undefined);
    assert.deepEqual(await get(s.port), { error: "ECONNREFUSED" }, "an agent's stop is not checked: it starts no board");
    const { output } = await s.hook({ last_assistant_message: `Open the board: ${link}` });
    assert.equal(output, undefined, "the link works now, so nothing blocks the stop");
    assert.equal((await get(s.port, "/app/")).status, 200, "the link answers 200 after the stop");
    assert.equal(s.readyLines(), 1, "the hook started one board");
  });

  test(`T1256 ${provider}: a board link that stays bad stops the message once with the link and the reason, and the next stop passes`, async (t) => {
    const s = await scratch(t, provider);
    await s.startBoard();
    await until(s.port, "/app/", 200);
    const bad = `http://127.0.0.1:${s.port}/pages/no-such-logbook-ec273a/T115/index.html`;
    const message = `Here is the page: ${bad}, and the board: http://127.0.0.1:${s.port}/app/.`;
    const first = await s.hook({ last_assistant_message: message });
    assert.equal(first.output?.decision, "block", "the stop is blocked");
    assert.ok(first.output.reason.includes(bad) && /\b404\b/.test(first.output.reason), `the reason names the bad link and its answer: ${first.output.reason}`);
    assert.ok(!first.output.reason.includes(`${s.port}/app/ `), "the good link is not named");
    const second = await s.hook({ stop_hook_active: true, last_assistant_message: message });
    assert.equal(second.output, undefined, "the next stop passes: never two blocks in a row");
    assert.equal(s.readyLines(), 1, "the check started no second board");
  });

  test(`T1218 ${provider}: with no board config, a link to the default port stops the message once and says so, and the hook tries no connection to the owner's board`, async (t) => {
    const s = await scratch(t, provider, { setup: false });
    const link = `http://127.0.0.1:${OWNER_PORT}/app/`;
    const { output } = await s.hook({ last_assistant_message: `Open the board: ${link}` });
    assert.equal(output?.decision, "block");
    assert.ok(output.reason.startsWith(`sage: a board link in your message does not work: ${link}. The board has no config yet. Run node `), output.reason);
    assert.equal(existsSync(join(s.dir, "owner-port.log")), false, "no connection to the default port was tried");
    assert.equal(existsSync(s.config), false, "the check made no config");
  });
}
