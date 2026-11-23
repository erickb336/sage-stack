import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { untilTheWatchersReportAWrite } from "./fixtures/board-watch.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const LOGBOOK = "sample/project-abcdef", KEY = Buffer.from(`${LOGBOOK}/T1`).toString("base64url"), GATE = Buffer.from(`${LOGBOOK}/G1`).toString("base64url");
const READING = "Reading the logbooks. The board answers when its first read ends.\n", READING_AGAIN = "The board is reading again. Try again in a moment.\n";
const APP = loadBoardApp(fileURLToPath(new URL("../plugins/sage/board/app", import.meta.url)));
const GUARD = 30_000;
const table = (name, rows = []) => `${HEADERS[name].replaceAll(" ", "\t")}\n${rows.map(row => `${row.join("\t")}\n`).join("")}`;
const tasks = title => table("tasks", [["T1", title, "small", "", "build", "framed", "codex/sample", "", "0", ""], ["T2", "Sample abandoned task", "small", "", "build", "abandoned", "", "", "0", ""]]);
const action = (i, run = "R1") => `${JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 10, 14, 12, 0, i)).toISOString(), run, tool: "Read", kind: "file", target: `src/sample-${i}.mjs`, call: i.toString(16).padStart(8, "0"), mark: "ok" })}\n`;
const has = (model, text) => JSON.stringify(model).includes(text);
const wait = ms => new Promise(wake => setTimeout(wake, ms));
const newHolds = () => new Int32Array(new SharedArrayBuffer(16));
const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not end`)), GUARD).unref())]);

function writeLogbook(root, { title = "Sample first task", running = false } = {}) {
  const project = join(root, "project-abcdef");
  mkdirSync(join(project, "actions"), { recursive: true });
  for (const name of Object.keys(HEADERS)) writeFileSync(join(project, `${name}.tsv`), table(name));
  writeFileSync(join(project, "tasks.tsv"), tasks(title));
  writeFileSync(join(project, "gates.tsv"), table("gates", [["G1", "T1", "Keep the sample format?", "keep|drop", "keep", "keep", "", "2026-11-14T10:00:00Z"]]));
  writeFileSync(join(project, "runs.tsv"), table("runs", [["R1", "T1", "qa", "0", "", "", running ? "running" : "done", "", "", running ? new Date(Date.now() - 60_000).toISOString() : "2026-11-14T10:00:00Z", running ? "" : "2026-11-14T11:00:00Z"]]));
  writeFileSync(join(project, "actions", "R1.jsonl"), action(1));
  if (running) {
    const slot = join(root, ".hooks", "slots", "slot-1");
    mkdirSync(slot, { recursive: true });
    for (const mark of ["project-project", "role-sage_qa", "run-R1", "ok"]) writeFileSync(join(slot, mark), "");
  }
  return project;
}

async function board(t, { ready = true, root, logbook, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-threads-"));
  root ??= join(dir, "source");
  const project = writeLogbook(root, logbook);
  const server = createBoardServer({ sources: [{ id: "sample", path: root, label: "Sample" }], port: 0, app: APP, settleReads: [], ...options });
  t.after(async () => { if (options.holds) { Atomics.store(options.holds, 0, 0); Atomics.notify(options.holds, 0); } await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const { port } = await server.start();
  if (ready) await within(server.ready(), "the first read");
  if (ready && !options.clock) await untilTheWatchersReportAWrite(port, project);
  return { dir, root, project, port, server };
}

function get(f, path, { method = "GET" } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path, method, agent: false, headers: { Host: `127.0.0.1:${f.port}` } }, response => {
      const parts = [];
      response.on("data", part => parts.push(part));
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString("utf8"), bytes: Buffer.concat(parts).length }));
      response.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(GUARD, () => req.destroy(new Error(`${path} did not answer`))); req.end();
  });
}

function stream(f) {
  const frames = [], waiters = new Set(), controller = new AbortController();
  const check = () => { for (const waiter of waiters) { const found = frames.find(waiter.predicate); if (found) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.accept(found); } } };
  (async () => {
    const response = await fetch(`http://127.0.0.1:${f.port}/app/events`, { signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const lines = buffer.slice(0, end).split("\n"); buffer = buffer.slice(end + 2);
        frames.push({ event: lines.find(line => line.startsWith("event: "))?.slice(7), data: JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) });
      }
      check();
    }
  })().catch(() => {});
  return {
    frames,
    models: () => frames.filter(frame => frame.event === "model").map(frame => frame.data),
    next(predicate = () => true) {
      const seen = frames.length;
      return this.find((frame, i) => i >= seen && predicate(frame));
    },
    find(predicate) {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((accept, reject) => { const waiter = { predicate, accept, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching board stream frame")); }, GUARD) }; waiters.add(waiter); });
    },
    model(predicate = () => true) { return this.find(frame => frame.event === "model" && predicate(frame.data)).then(frame => frame.data); },
    close() { controller.abort(); },
  };
}

async function readHeld(holds, count = 1) {
  for (let seen; (seen = Atomics.load(holds, 1)) < count;) {
    const { async, value } = Atomics.waitAsync(holds, 1, seen, GUARD);
    if (async && await value === "timed-out") assert.fail("no read reached the hold");
  }
}
const release = holds => { Atomics.store(holds, 0, 0); Atomics.notify(holds, 0); };
async function until(check, what) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await wait(100); }
  assert.fail(`never: ${what}`);
}

test("T1215: a task page asked while a read runs answers at once from the last finished read; the read's end updates the page", async t => {
  const holds = newHolds(), f = await board(t, { holds }), events = stream(f); t.after(() => events.close());
  await events.model(model => has(model, "Sample first task"));
  Atomics.store(holds, 0, 1);
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample title of the next read"));
  await readHeld(holds);
  const during = await get(f, `/app/task/${KEY}`);
  assert.deepEqual([during.status, JSON.parse(during.body).title], [200, "Sample first task"], "the read waits at its hold, so this answer did not wait for it");
  assert.equal((await get(f, "/app/stats")).status, 200, "stats answer from the bytes of the last read");
  assert.ok(!events.models().some(model => has(model, "Sample title of the next read")), "no page shows the read that has not ended");
  release(holds);
  await events.model(model => has(model, "Sample title of the next read"));
  assert.equal(JSON.parse((await get(f, `/app/task/${KEY}`)).body).title, "Sample title of the next read");
});

test("T1215 (C5): before its first read ends the board listens, its shell answers, model pages, stats and pages say Reading the logbooks, and ready() waits for the read", async t => {
  const holds = newHolds();
  Atomics.store(holds, 0, 1);
  const f = await board(t, { holds, ready: false }), events = stream(f); t.after(() => events.close());
  await readHeld(holds);
  let ready = false;
  f.server.ready().then(() => { ready = true; });
  assert.equal((await get(f, "/", { method: "HEAD" })).status, 200, "the chief's 1 s probe of the board answers at once");
  assert.equal((await get(f, "/app/")).status, 200);
  for (const path of [`/app/task/${KEY}`, `/app/gate/${GATE}`, "/app/stats", `/api/actions/R1?logbook=${LOGBOOK}`, `/read/${KEY}/brief/R1`, "/pages/project-abcdef/T1/"]) {
    const reply = await get(f, path);
    assert.deepEqual([reply.status, reply.body], [503, READING], path);
  }
  assert.equal((await get(f, "/app/task/YR")).status, 404, "a key that is not a key is refused at once, as before");
  assert.equal(ready, false);
  assert.equal(events.models().length, 0, "the stream sends no model before the first read ends");
  release(holds);
  await within(f.server.ready(), "the first read");
  await events.model(model => has(model, "Sample first task"));
  assert.equal(JSON.parse((await get(f, `/app/task/${KEY}`)).body).title, "Sample first task");
});

test("T1215: a failed read keeps the newest good read, not an older one, marked as not updated; the next good read clears the mark", async t => {
  const f = await board(t), events = stream(f); t.after(() => events.close());
  await events.model(model => has(model, "Sample first task"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample second title"));
  await events.model(model => !model.stale && has(model, "Sample second title"));
  writeFileSync(join(f.project, "tasks.tsv"), "incomplete header\nprivate partial data\n");
  const stale = await events.model(model => model.stale);
  assert.ok(has(stale, "Sample second title") && !has(stale, "Sample first task"), "the pages keep the newest good read, which the other thread holds");
  assert.ok(!has(stale, "private partial data"));
  assert.equal(JSON.parse((await get(f, `/app/task/${KEY}`)).body).title, "Sample second title");
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample repaired title"));
  const repaired = await events.model(model => !model.stale && has(model, "Sample repaired title"));
  assert.deepEqual(repaired.problems, []);
});

test("T1215 (C7): when the answering thread stops, the request that it held gets 'reading again'; the pages answer after the next read, and a new thread reads the next change", async t => {
  const holds = newHolds(), f = await board(t, { holds }), events = stream(f); t.after(() => events.close());
  await events.model(model => has(model, "Sample first task"));
  Atomics.store(holds, 2, 1);
  const stopped = await get(f, `/app/task/${KEY}`);
  assert.deepEqual([stopped.status, stopped.body], [503, READING_AGAIN]);
  await until(async () => (await get(f, `/app/task/${KEY}`)).status === 200, "the task page answers again");
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample title after the stop"));
  await events.model(model => has(model, "Sample title after the stop"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample second title after the stop"));
  await events.model(model => has(model, "Sample second title after the stop"));
  assert.equal(JSON.parse((await get(f, `/app/task/${KEY}`)).body).title, "Sample second title after the stop", "both threads answer and read again");
});

test("T1215: when the reading thread stops, the pages still answer from the last read, and a new thread reads the change", async t => {
  const holds = newHolds(), f = await board(t, { holds }), events = stream(f); t.after(() => events.close());
  await events.model(model => has(model, "Sample first task"));
  Atomics.store(holds, 3, 1); Atomics.store(holds, 0, 1);
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample title after the reader stopped"));
  await readHeld(holds);
  assert.equal(Atomics.load(holds, 3), 0, "the reading thread stopped at the start of its read, and the new thread reads now");
  const during = await get(f, `/app/task/${KEY}`);
  assert.deepEqual([during.status, JSON.parse(during.body).title], [200, "Sample first task"]);
  release(holds);
  await events.model(model => has(model, "Sample title after the reader stopped"));
});

test("T1215 (C8): the threads in one thread and in worker threads give the same answers", async t => {
  const clock = () => "2026-11-14T12:00:00.000Z", dir = mkdtempSync(join(tmpdir(), "sage-board-threads-same-")), root = join(dir, "source");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = [`/app/task/${KEY}`, `/app/gate/${GATE}`, "/app/stats", "/app/stats?project=project-abcdef", `/api/actions/R1?logbook=${LOGBOOK}`, `/app/task/${Buffer.from(`${LOGBOOK}/T9`).toString("base64url")}`];
  const answers = async options => {
    const f = await board(t, { root, clock, ...options }), events = stream(f);
    try {
      const model = await events.model();
      return [model, ...await Promise.all(paths.map(async path => { const reply = await get(f, path); return [path, reply.status, reply.headers["content-type"], reply.body]; }))];
    } finally { events.close(); await f.server.close(); }
  };
  const workers = await answers({}), one = await answers({ duringRead: () => {} });
  assert.deepEqual(workers.slice(1).map(([path, status]) => [path, status]), paths.map((path, i) => [path, i === 5 ? 404 : 200]), "each kind of answer is there");
  assert.deepEqual(one, workers);
});

test("T1215 (C4): an answer from a thread is exactly its JSON, also a small one that Node would cut from its shared pool", async t => {
  const f = await board(t);
  for (const path of ["/app/stats?project=project-abcdef", `/api/actions/R1?logbook=${LOGBOOK}`, `/app/task/${KEY}`, `/app/gate/${GATE}`]) {
    const reply = await get(f, path);
    assert.equal(reply.status, 200, path);
    assert.equal(Number(reply.headers["content-length"]), reply.bytes, path);
    assert.equal(reply.bytes, Buffer.byteLength(JSON.stringify(JSON.parse(reply.body))), `${path}: the body is its JSON and nothing more`);
  }
});

test("T1215 (C2): the light thread alone keeps the activity map: light reads go on during a full read, and the read's end keeps the newer action, in order", async t => {
  const holds = newHolds(), f = await board(t, { holds, lightEvery: 50, logbook: { running: true } }), events = stream(f); t.after(() => events.close());
  const file = join(f.project, "actions", "R1.jsonl"), run = `${LOGBOOK}/R1`, slot = join(f.root, ".hooks", "slots", "slot-1");
  const nowOf = () => events.frames.filter(frame => frame.event === "activity" && frame.data[run]).map(frame => frame.data[run].now?.call ?? null);
  await events.model(model => has(model, "Sample first task"));
  await events.find(frame => frame.event === "activity" && frame.data[run]?.now?.call === "00000001");
  Atomics.store(holds, 0, 1);
  writeFileSync(join(f.project, "tasks.tsv"), tasks("Sample title of the held read"));
  await readHeld(holds);
  appendFileSync(file, action(2));
  const renewed = new Date(); utimesSync(slot, renewed, renewed);
  await events.find(frame => frame.event === "activity" && frame.data[run]?.now?.call === "00000002");
  release(holds);
  await events.model(model => has(model, "Sample title of the held read"));
  appendFileSync(file, action(3));
  await events.find(frame => frame.event === "activity" && frame.data[run]?.now?.call === "00000003");
  const later = stream(f); t.after(() => later.close());
  await later.model();
  const seed = await later.find(frame => frame.event === "activity");
  assert.equal(seed.data[run].now.call, "00000003", "a new stream gets the newest action, not one from before the read");
  const calls = nowOf().filter(Boolean);
  assert.deepEqual(calls, [...calls].sort(), `the actions came in order: ${calls.join(", ")}`);
});

test("T1215 (C5): close() stops the threads, so a process whose board closed ends by itself", t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-threads-close-")), root = join(dir, "source");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeLogbook(root);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/board-close.mjs", import.meta.url)), root], { encoding: "utf8", timeout: 60_000, env: { ...process.env } });
  assert.deepEqual([child.status, child.signal, child.stdout], [0, null, "closed\n"], child.stderr);
});
