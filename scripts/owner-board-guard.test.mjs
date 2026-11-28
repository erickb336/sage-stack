import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_PORT } from "../packages/sage-core/message.mjs";
import { boardCommandPort } from "./fixtures/board-port.mjs";
import { GUARD, LOG, OWNER_PORT } from "./fixtures/owner-board-guard.mjs";

const PROBE = new URL("../packages/sage-core/board-probe.mjs", import.meta.url).href;
const TRIES = `
import { createServer } from "node:net";
import { Worker } from "node:worker_threads";
import { probeBoard } from ${JSON.stringify(PROBE)};
const port = Number(process.argv[1]);
const listened = await new Promise((done) => createServer().once("error", (error) => done(error.code)).listen(port, "127.0.0.1", () => done("listening")));
const inWorker = 'import { connect } from "node:net"; import { parentPort } from "node:worker_threads"; connect(' + port + ', "127.0.0.1").once("error", (e) => parentPort.postMessage(e.code)).once("connect", () => parentPort.postMessage("connected"));';
const worker = await new Promise((done) => new Worker(inWorker, { eval: true }).once("message", done));
console.log(JSON.stringify({ probe: (await probeBoard({ port })).kind, listened, worker, fetched: await fetch("http://127.0.0.1:" + port + "/").then(() => "answered", (error) => error.cause?.code) }));
`;

async function guarded(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-owner-guard-")));
  const port = await boardCommandPort(), accepted = [];
  const holder = createServer((socket) => { accepted.push(socket.remotePort); socket.destroy(); });
  await new Promise((done) => holder.listen(port, "127.0.0.1", done));
  t.after(async () => { await new Promise((done) => holder.close(done)); rmSync(dir, { recursive: true, force: true }); });
  const run = (vars) => spawnSync(process.execPath, ["--input-type=module", "-e", TRIES, String(port)], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, SAGE_HOME: join(dir, "sage"), NODE_OPTIONS: GUARD, SAGE_TEST_GUARDED_PORTS: String(port), ...vars } });
  return { dir, port, accepted, run };
}

test("T1218: the guard watches the board's default port, the owner's board", () => {
  assert.equal(OWNER_PORT, BOARD_PORT);
});

test("T1218: under the guard, no connection and no listener reaches a guarded port, from the board probe, a worker thread or fetch, and each try goes to the run's log", async (t) => {
  const { dir, port, accepted, run } = await guarded(t);
  const log = join(dir, "owner-port.log");
  const tried = run({ [LOG]: log });
  assert.equal(tried.status, 0, tried.stderr);
  assert.deepEqual(JSON.parse(tried.stdout), { probe: "other", listened: "ESAGEOWNERPORT", worker: "ESAGEOWNERPORT", fetched: "ESAGEOWNERPORT" });
  assert.deepEqual(accepted, [], "the holder of the port saw no connection");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.deepEqual(lines.map((line) => / (connects to|listens on) port (\d+):/.exec(line)?.slice(1)), [["listens on", String(port)], ["connects to", String(port)], ["connects to", String(port)], ["connects to", String(port)]]);
});

test("T1218: a test process that reaches a guarded port fails at its exit with one line for each try, also when the code under test swallows the error", async (t) => {
  const { accepted, run } = await guarded(t);
  const tried = run({});
  assert.equal(tried.status, 1, "the process fails");
  assert.match(tried.stderr, /^A test reached the owner's board port 43123 \(T1218\)\. Nothing connected: the guard refused each try\. Give each test a free board port:\n- process \d+ listens on port \d+: /);
  assert.equal(tried.stderr.match(/^- process /gm).length, 4);
  assert.deepEqual(accepted, []);
  const quiet = spawnSync(process.execPath, ["--input-type=module", "-e", "await fetch('http://127.0.0.1:9/').catch(() => {})"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmpdir(), NODE_OPTIONS: GUARD } });
  assert.deepEqual([quiet.status, quiet.stderr], [0, ""], "a process that reaches no guarded port passes and prints nothing");
  assert.equal(existsSync(join(tmpdir(), `sage-test-owner-port-${quiet.pid}.log`)), false, "and leaves no log");
});
