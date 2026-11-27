import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, chmodSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const key = Buffer.from("sample/project-abcdef/T1").toString("base64url");
const row = (title = "Sample first task", id = "T1", state = "framed") => `${id}\t${title}\tsmall\t\tbuild\t${state}\tcodex/sample\t\t0\t\n`;
const tasks = (...rows) => `${HEADERS.tasks.replaceAll(" ", "\t")}\n${rows.join("")}`;

function populate(root, title = "Sample first task") {
  const project = join(root, "project-abcdef"); mkdirSync(project, { recursive: true });
  for (const [name, header] of Object.entries(HEADERS)) writeFileSync(join(project, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n`);
  writeFileSync(join(project, "tasks.tsv"), tasks(row(title), row("Sample abandoned task", "T2", "abandoned")));
  return project;
}

const EVENT_GUARD = 30_000, REQUEST_GUARD = 120_000;
const APP = loadBoardApp(fileURLToPath(new URL("../plugins/sage/board/app", import.meta.url)));
const has = (model, text) => JSON.stringify(model).includes(text);
const BOARD_POLICY = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";

async function fixture(t, { missing = false, id, clock, before, quiet = false, probe, maxModel } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-server-")), root = join(dir, "source");
  if (!missing) populate(root);
  before?.(join(root, "project-abcdef"));
  const sources = [{ id: "sample", path: root, label: "Sample source" }];
  const options = { sources, port: 0, id, app: APP, ...(clock ? { clock } : {}), ...(maxModel ? { maxModel } : {}) };
  const server = quiet ? quietBoard(options, probe === undefined ? {} : { probe }) : createBoardServer(options);
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const { port } = await server.start();
  await server.ready();
  return { dir, root, project: join(root, "project-abcdef"), port, sources, server };
}

function read(f, path = "/", { method = "GET", headers = {}, rawHeaders } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path, method, agent: false, headers: rawHeaders ?? { Host: `127.0.0.1:${f.port}`, ...headers } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
      response.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(REQUEST_GUARD, () => req.destroy(new Error("board request did not finish"))); req.end();
  });
}

async function keepWriting(write, seen) {
  write();
  const again = setInterval(write, 200);
  try { return await seen; } finally { clearInterval(again); }
}

function events(f, path = "/app/events") {
  const queue = [], waiters = new Set();
  let response, buffer = "", ended = false;
  const stop = error => { ended = true; for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear(); };
  const req = request({ host: "127.0.0.1", port: f.port, path, agent: false, headers: { Host: `127.0.0.1:${f.port}` } }, incoming => {
    response = incoming;
    if (incoming.statusCode !== 200) { stop(new Error(`event status ${incoming.statusCode}`)); incoming.resume(); return; }
    incoming.setEncoding("utf8");
    incoming.on("data", chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.includes("event: model\n")) continue;
        try {
          const lines = frame.split("\n"), payload = { ...JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)), revision: lines.find(line => line.startsWith("id: "))?.slice(4) };
          let consumed = false;
          for (const waiter of waiters) if (waiter.predicate(payload)) { consumed = true; clearTimeout(waiter.timer); waiters.delete(waiter); waiter.accept(payload); }
          if (!consumed) queue.push(payload);
        } catch (error) { stop(error); }
      }
    });
    incoming.on("error", stop); incoming.on("end", () => stop(new Error("event stream ended")));
  });
  req.on("error", stop); req.end();
  return {
    next(predicate = () => true) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (ended) return Promise.reject(new Error("event stream is closed"));
      return new Promise((accept, reject) => {
        const waiter = { accept, reject, predicate, timer: null };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching board event")); }, EVENT_GUARD);
        waiters.add(waiter);
      });
    },
    close() { req.destroy(); response?.destroy(); stop(new Error("event test closed")); },
  };
}

const probeOfThePluginBeforeT770 = ({ port }) => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, timeout: 2000, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    const { "content-type": type = "", "content-security-policy": policy = "", "cross-origin-resource-policy": resource, "x-sage-board": named = "" } = response.headers;
    const boardHeaders = policy.startsWith("default-src 'none'") && resource === "same-origin";
    const own = /^id=([a-f0-9]{16,64}); pid=([1-9]\d{0,9}); started=(\d{1,16})$/.exec(named);
    if (boardHeaders && response.statusCode === 200 && type.startsWith("text/html")) done(own ? { kind: "board", id: own[1], pid: Number(own[2]), started: Number(own[3]) } : { kind: "older" });
    else done({ kind: "other" });
  });
  req.once("error", error => done({ kind: error.code }));
  req.end();
});

test("T770: the board command's probe of an older plugin reads the new board as its own board, not as another program", async t => {
  const f = await fixture(t, { id: "0123456789abcdef" });
  const found = await probeOfThePluginBeforeT770(f);
  assert.deepEqual([found.kind, found.id, found.pid], ["board", "0123456789abcdef", process.pid]);
  const head = await read(f, "/", { method: "HEAD" });
  assert.deepEqual([head.status, head.headers["content-type"], head.headers.location, head.body], [200, "text/html; charset=utf-8", undefined, ""]);
  assert.equal(head.headers["content-security-policy"], BOARD_POLICY);
  assert.equal((await read(f, "/", { method: "HEAD", rawHeaders: ["Host", "evil.example"] })).status, 403, "the Host check still comes first");
});

test("T770: the board's address sends the browser to the app, the old board's pages are gone, and nothing writes the logbook", async t => {
  const f = await fixture(t), file = join(f.project, "tasks.tsv"), before = readFileSync(file);
  for (const [method, status, location] of [["GET", 302, "/app/"], ["HEAD", 200, undefined]]) {
    const page = await read(f, "/", { method });
    assert.deepEqual([page.status, page.headers.location, page.body], [status, location, ""], method);
    assert.equal(page.headers["content-security-policy"], BOARD_POLICY); assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["x-content-type-options"], "nosniff"); assert.equal(page.headers["referrer-policy"], "no-referrer"); assert.equal(page.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(f.server.address().address, "127.0.0.1"); assert.equal(f.server.address().port, f.port);
  const app = await read(f, "/app/"); assert.equal(app.status, 200); assert.match(app.body, /<div id="root"><\/div>/);
  assert.doesNotMatch(app.headers["content-security-policy"], /unsafe-inline|unsafe-eval|https:/);
  const panel = await read(f, `/app/task/${key}`); assert.equal(panel.status, 200); assert.equal(JSON.parse(panel.body).title, "Sample first task");
  const old = ["/agents", "/milestones", "/releases", "/programs", `/task/${key}`, `/milestone/${key}`, `/program/${key}`];
  for (const path of old) { const gone = await read(f, path); assert.equal(gone.status, 404, path); assert.doesNotMatch(gone.body, /Sample first task/, path); }
  for (const path of ["/?events=1", `/?events=1&task=${key}`, "/agents?events=1", "/milestones?events=1", "/releases?events=1", `/milestone/${key}?events=1`]) {
    const stream = await read(f, path);
    assert.deepEqual([stream.status, stream.headers["content-type"]], [200, "text/event-stream; charset=utf-8"], `${path}: a tab of the old board gets the note and a link, not a 404 (F-T1159-6); its status line still says "Reconnecting" (F-T1168-5)`);
    const [retry, event, data] = stream.body.split("\n");
    assert.deepEqual([retry, event], ["retry: 86400000", "event: board"], `${path}: the old tab asks again only after a day`);
    const { stale, html } = JSON.parse(data.slice("data: ".length));
    assert.equal(stale, true);
    assert.match(html, /^<div id="board-content" data-at="[^"]+"><p><b>The board was updated, and this old page no longer updates\.<\/b> <a href="\/app\/">Open the new board<\/a>\.<\/p><\/div>$/, "the old page replaces its content with the note");
    assert.doesNotMatch(stream.body, /Sample first task/);
  }
  assert.deepEqual(readFileSync(file), before);
});

test("F-T1159-15: a query on the board's address still opens the app, so the app can read the pair key in the link", async t => {
  const f = await fixture(t);
  for (const path of ["/app/?from=chat", "/app/?"]) {
    const app = await read(f, path);
    assert.equal(app.status, 200, path); assert.match(app.body, /<div id="root"><\/div>/, path);
    assert.match(app.headers["content-security-policy"], /^default-src 'none'; script-src http:\/\/127\.0\.0\.1:\d+\/app\//, path);
  }
  const root = await read(f, "/?from=chat");
  assert.deepEqual([root.status, root.headers.location], [302, "/app/"]);
  assert.equal((await read(f, "/app/nothing-here?x=1")).status, 404, "another name under /app/ is still not a page");
});

test("T1053: a request with any other Host gets 403 on every page and event route, also with a sign-in header, and discloses nothing", async t => {
  const f = await fixture(t), basic = `Basic ${Buffer.from("sage:sample board pass 01").toString("base64")}`;
  for (const path of ["/", `/task/${key}`, "/?events=1", "/agents", "/app/", "/app/events", `/app/task/${key}`]) {
    for (const rawHeaders of [["Host", "evil.example"], ["Host", "sample.tailnet.ts.net", "Authorization", basic], ["Host", `evil.example:${f.port}`]]) {
      const result = await read(f, path, { rawHeaders });
      assert.equal(result.status, 403, `${path} ${rawHeaders.join(" ")}`); assert.equal(result.body, "This request is not permitted.\n");
      assert.equal(result.headers["www-authenticate"], undefined, "no sign-in dialog"); assert.equal(result.headers["x-sage-board"], undefined);
    }
  }
  const eventHead = await read(f, "/app/events", { method: "HEAD" }); assert.equal(eventHead.status, 200); assert.equal(eventHead.body, "");
});

test("T216: on the Mac itself (a loopback Host) the board needs no sign-in, and the browser checks still hold", async t => {
  const f = await fixture(t);
  for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, `LOCALHOST:${f.port}`, `[::1]:${f.port}`]) {
    const page = await read(f, `/app/task/${key}`, { rawHeaders: ["Host", host] });
    assert.equal(page.status, 200, host); assert.match(page.body, /Sample first task/); assert.equal(page.headers["www-authenticate"], undefined);
    assert.equal((await read(f, "/", { rawHeaders: ["Host", host] })).status, 302, host);
  }
  assert.equal((await read(f, "/app/events", { method: "HEAD", rawHeaders: ["Host", `127.0.0.1:${f.port}`] })).status, 200);
  for (const extra of [["Origin", "https://attacker.test"], ["Origin", "https://sample.tailnet.ts.net"], ["Sec-Fetch-Site", "cross-site"]]) {
    const refused = await read(f, `/app/task/${key}`, { rawHeaders: ["Host", `127.0.0.1:${f.port}`, ...extra] });
    assert.equal(refused.status, 403, extra.join(": ")); assert.doesNotMatch(refused.body, /Sample first task/);
  }
  for (const host of ["attacker.test", `127.0.0.1:${f.port + 1}`, "127.0.0.1:0", `localhost`]) assert.equal((await read(f, `/app/task/${key}`, { rawHeaders: ["Host", host] })).status, 403, host);
  assert.equal((await read(f, "/", { method: "POST", rawHeaders: ["Host", `127.0.0.1:${f.port}`] })).status, 405);
});

test("T1053: a request with a forwarded header gets 403, also with a loopback Host; a vendor's own header changes nothing", async t => {
  const f = await fixture(t, { id: "0123456789abcdef" }), loopback = `127.0.0.1:${f.port}`;
  for (const proxy of [["X-Forwarded-For", "100.64.0.7"], ["X-Forwarded-Host", loopback], ["X-Forwarded-Proto", "https"], ["Forwarded", "for=100.64.0.7"], ["x-forwarded-for", "203.0.113.9"]]) {
    for (const path of ["/", "/app/", "/app/events", `/app/task/${key}`]) {
      const proxied = await read(f, path, { rawHeaders: ["Host", loopback, ...proxy] });
      assert.equal(proxied.status, 403, `${path} ${proxy[0]}`); assert.equal(proxied.body, "This request is not permitted.\n");
      assert.equal(proxied.headers["x-sage-board"], undefined, "a proxied request does not learn the board's pid");
    }
  }
  const mac = await read(f, "/", { rawHeaders: ["Host", loopback] });
  assert.equal(mac.status, 302);
  assert.match(mac.headers["x-sage-board"], new RegExp(`^id=0123456789abcdef; pid=${process.pid}; started=\\d+$`));
  const vendor = await read(f, "/", { rawHeaders: ["Host", loopback, "Tailscale-User-Login", "sample@example.test"] });
  assert.equal(vendor.status, 302); assert.match(vendor.headers["x-sage-board"], /^id=0123456789abcdef; /);
});

test("T1053: the server listens on 127.0.0.1 only: no other address of the Mac reaches it", async t => {
  const f = await fixture(t);
  assert.equal(f.server.address().address, "127.0.0.1");
  const other = await new Promise(done => {
    const req = request({ host: "::1", port: f.port, path: "/", agent: false, headers: { Host: `[::1]:${f.port}` } }, response => { response.resume(); done(response.statusCode); });
    req.on("error", error => done(error.code)); req.end();
  });
  assert.equal(typeof other, "string", `the IPv6 loopback address has no listener (got ${other})`);
});

test("board server rejects foreign, duplicate and mismatched browser authority headers", async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: "attacker.test" }, { Host: `localhost:${f.port}.attacker.test` }, { Host: `127.0.0.1:${f.port}.` },
    { Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "https://sample.tailnet.ts.net" }, { Origin: `https://127.0.0.1:${f.port}` },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  ]) assert.equal((await read(f, "/", { headers })).status, 403);
  for (const name of ["Host", "Origin", "Sec-Fetch-Site"]) {
    const value = name === "Host" ? `127.0.0.1:${f.port}` : name === "Origin" ? `http://127.0.0.1:${f.port}` : "same-origin";
    const headers = [...(name === "Host" ? [] : ["Host", `127.0.0.1:${f.port}`]), name, value, name, value];
    assert.equal((await read(f, "/", { rawHeaders: headers })).status, 403);
  }
  assert.equal((await read(f, "/", { headers: { Origin: `http://127.0.0.1:${f.port}`, "Sec-Fetch-Site": "same-origin" } })).status, 302);
  assert.equal((await read(f, "/", { headers: { Host: "sample.tailnet.ts.net", Origin: "https://sample.tailnet.ts.net", "Sec-Fetch-Site": "same-origin" } })).status, 403);
});

function slot(root, name, marks) {
  const dir = join(root, ".hooks", "slots", name); mkdirSync(dir, { recursive: true });
  for (const mark of [...marks, "ok"]) writeFileSync(join(dir, mark), "");
}

test("T308, T770: the app stream follows the hook's slots: a new running agent reaches the Agents data", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.project, "runs.tsv"), `${HEADERS.runs.replaceAll(" ", "\t")}\nR1\tT1\tqa\t0\t\t\trunning\t\t\t${new Date(Date.now() - 60_000).toISOString()}\t\n`);
  slot(f.root, "slot-1", ["project-project", "role-sage_qa", "run-R1"]);
  const stream = events(f); t.after(() => stream.close());
  const runs = model => model.agents.flatMap(book => book.runs).filter(run => run.status === "running").map(run => `${run.id} ${run.role}`);
  await stream.next(p => runs(p).includes("R1 qa"));
  writeFileSync(join(f.project, "runs.tsv"), `${readFileSync(join(f.project, "runs.tsv"), "utf8")}R2\tT1\tcode-reviewer\t0\t\t\trunning\t\t\t${new Date().toISOString()}\t\n`);
  slot(f.root, "slot-3", ["project-project", "role-sage_code-reviewer", "run-R2"]);
  const next = await stream.next(p => runs(p).includes("R2 code-reviewer"));
  assert.deepEqual(runs(next), ["R1 qa", "R2 code-reviewer"]);
});

test("board server exposes only canonical read routes and refuses invalid configuration", async t => {
  const f = await fixture(t);
  for (const path of ["/tasks.tsv", "/../config.json", "/%2e%2e/config.json", "//", "/index.html", "/app/x.js", `/app/task/${key}=`, "/app/task/_w", `/app/task/${Buffer.from("missing").toString("base64url")}`, "/app/task/YR"]) {
    const result = await read(f, path); assert.equal(result.status, 404, path); assert.doesNotMatch(result.body, /Sample first task/);
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) for (const path of ["/", "/app/", "/app/events", `/app/task/${key}`]) {
    const refused = await read(f, path, { method });
    assert.equal(refused.status, 405, `${method} ${path}`); assert.equal(refused.headers.allow, "GET, HEAD");
  }
  const options = { sources: f.sources, port: f.port };
  for (const changed of [{ port: 1023 }, { port: 65536 }, { port: 1.5 }, { port: "43123" }, { sources: [] }, { sources: Array(1) }, { sources: [{ id: 2, path: f.root }] }, { sources: [{ id: "one", path: f.root, label: {} }] }]) assert.throws(() => createBoardServer({ ...options, ...changed }), TypeError);
});

test("board server fails on an occupied fixed port and closes without changing another listener", async t => {
  const f = await fixture(t), other = createBoardServer({ sources: f.sources, port: f.port });
  t.after(() => other.close());
  await assert.rejects(other.start(), { code: "EADDRINUSE", message: `Board port ${f.port} is already in use.` });
  assert.equal((await read(f)).status, 302);
  assert.deepEqual(await f.server.start(), f.server.address());
  await Promise.all([f.server.close(), f.server.close()]); assert.equal(f.server.address(), null);
  await assert.rejects(f.server.start(), /closed/);
});

test("board event streams deliver initial and atomic file updates and reconnect", async t => {
  const f = await fixture(t), board = events(f);
  t.after(() => board.close());
  const first = await board.next();
  assert.equal(first.stale, false); assert.deepEqual(first.problems, []); assert.ok(has(first, "Sample first task"));
  const temporary = join(f.project, "tasks.pending"), target = join(f.project, "tasks.tsv");
  writeFileSync(temporary, tasks(row("Sample replaced title"))); renameSync(temporary, target);
  const updated = await board.next(p => has(p, "Sample replaced title") && !p.stale);
  assert.ok(Number(updated.revision) > Number(first.revision));
  const panel = JSON.parse((await read(f, `/app/task/${key}`)).body); assert.equal(panel.title, "Sample replaced title");
  const reconnect = events(f); t.after(() => reconnect.close());
  const snapshot = await reconnect.next(); assert.ok(Number(snapshot.revision) >= Number(updated.revision)); assert.ok(has(snapshot, "Sample replaced title"));
});

test("T305 R1023-3: a file event that does not change the page sends nothing; the next change sends the new page", async t => {
  const f = await fixture(t, { clock: () => "2026-10-18T12:00:00Z" }), stream = events(f); t.after(() => stream.close());
  const first = await stream.next(); assert.ok(has(first, "Sample first task"));
  writeFileSync(join(f.project, "unrelated.txt"), "sample\n");
  await new Promise(wake => setTimeout(wake, 1000));
  const temporary = join(f.project, "tasks.pending"); writeFileSync(temporary, tasks(row("Sample changed title"))); renameSync(temporary, join(f.project, "tasks.tsv"));
  const next = await stream.next();
  assert.ok(has(next, "Sample changed title"), "the next event is the change, not a copy of the model");
});

test("board event streams keep the last valid content while an incomplete write is stale, then recover", async t => {
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  const initial = await stream.next(); assert.equal(initial.stale, false);
  const file = join(f.project, "tasks.tsv"); writeFileSync(file, "incomplete header\nprivate partial data\n");
  const stale = await stream.next(p => p.stale);
  assert.ok(has(stale, "Sample first task")); assert.ok(!has(stale, "private partial data"));
  assert.ok(stale.problems.some(problem => /tasks/.test(problem))); assert.ok(Number(stale.revision) > Number(initial.revision));
  writeFileSync(file, tasks(row("Sample repaired title")));
  const repaired = await stream.next(p => !p.stale && has(p, "Sample repaired title")); assert.deepEqual(repaired.problems, []);
});

test("R1506-F1: a table written in place after an earlier rename onto it still updates the board, on Linux too", async t => {
  const f = await fixture(t, { quiet: true }), stream = events(f); t.after(() => stream.close());
  assert.equal((await stream.next()).stale, false);
  const target = join(f.project, "tasks.tsv"), temporary = join(f.project, "tasks.pending");
  const renamed = () => { writeFileSync(temporary, tasks(row("Sample renamed title"))); renameSync(temporary, target); };
  await keepWriting(renamed, stream.next(p => !p.stale && has(p, "Sample renamed title")));
  const stale = await keepWriting(() => writeFileSync(target, "Sample invalid table header\nSample incomplete write\n"), stream.next(p => p.stale));
  assert.ok(has(stale, "Sample renamed title")); assert.ok(!has(stale, "Sample incomplete write"));
  await keepWriting(() => writeFileSync(target, tasks(row("Sample written in place"))), stream.next(p => !p.stale && has(p, "Sample written in place")));
});

test("T348: a write that no watcher reports still reaches the board through the reads after a new watch", async t => {
  const original = fs.watch;
  fs.watch = () => Object.assign(new EventEmitter(), { close() {} });
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close());
  await stream.next(p => !p.stale);
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample write with no event")));
  await stream.next(p => has(p, "Sample write with no event"));
});

test("T314 R1042-2: a bad name or archived value in a logbook's config.json is a warning: the board stays live", async t => {
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  const initial = await stream.next(); assert.equal(initial.stale, false);
  writeFileSync(join(f.project, "config.json"), JSON.stringify({ name: "bad\ttab", archived: "yes" }));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample title after the bad config")));
  const live = await stream.next(p => has(p, "Sample title after the bad config"));
  assert.equal(live.stale, false); assert.deepEqual(live.problems, []);
});

test("F-T216-19: a root that appears while the board starts does not stop the start, and close ends", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-server-")), root = join(dir, "source");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createBoardServer({ sources: [{ id: "sample", path: root, label: "Sample source" }], port: 0 });
  const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish`)), 10_000).unref())]);
  const started = server.start();
  await new Promise(wake => setTimeout(wake, 30));
  populate(root);
  try { assert.equal((await within(started, "start")).port, server.address().port); }
  finally { await within(server.close(), "close"); }
  assert.equal(server.address(), null);
});

test("board watches a missing root and reattaches after root replacement without polling", async t => {
  const f = await fixture(t, { missing: true }), stream = events(f); t.after(() => stream.close());
  const missing = await stream.next(); assert.equal(missing.stale, false); assert.deepEqual(missing.problems, []); assert.deepEqual(missing.tasks, []);
  populate(f.root, "Sample created source");
  await stream.next(p => !p.stale && has(p, "Sample created source"));
  const old = join(f.dir, "old-source"); renameSync(f.root, old);
  const removed = await stream.next(p => !p.tasks.length); assert.equal(removed.stale, false); assert.deepEqual(removed.problems, []);
  populate(f.root, "Sample replacement source");
  await stream.next(p => !p.stale && has(p, "Sample replacement source"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample replacement changed")));
  await stream.next(p => !p.stale && has(p, "Sample replacement changed"));
});

test("board watcher errors publish a stale diagnostic and recover on an observed root change", async t => {
  const original = fs.watch, captured = [];
  fs.watch = (...args) => { const watcher = original(...args); captured.push({ path: args[0], watcher }); return watcher; };
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close()); await stream.next();
  const root = captured.find(item => item.path === f.root); assert.ok(root);
  root.watcher.emit("error", new Error("sample watcher failure"));
  const stale = await stream.next(p => p.stale && p.problems.some(problem => /File watching/.test(problem)));
  assert.ok(has(stale, "Sample first task")); assert.ok(!has(stale, "sample watcher failure"));
  renameSync(f.root, join(f.dir, "old-source"));
  await stream.next(p => !p.tasks.length);
  populate(f.root, "Sample watcher restored");
  await stream.next(p => !p.stale && has(p, "Sample watcher restored"));
});

test("T1222: the board watches no designs folder of a logbook, so approved design copies cause no reads", async t => {
  const original = fs.watch, watched = [];
  fs.watch = (path, ...rest) => { watched.push(String(path)); return original(path, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { fs.watch = original; syncBuiltinESMExports(); });
  const f = await fixture(t, { before: project => { mkdirSync(join(project, "designs", "T1", "G1"), { recursive: true }); mkdirSync(join(project, "reports")); } });
  assert.ok(watched.includes(join(f.project, "reports")), "the board watches the other folders of a logbook");
  assert.deepEqual(watched.filter(path => path.includes(`${join(f.project, "designs")}`)), [], "and no folder in designs");
});

test("a folder that is gone before the board can watch it (a write's short lock) is no watch failure: the board does not go stale", async t => {
  const original = fs.watch;
  fs.watch = (path, ...rest) => { if (String(path).endsWith("/.lock")) rmSync(path, { recursive: true, force: true }); return original(path, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { fs.watch = original; syncBuiltinESMExports(); });
  const f = await fixture(t), stream = events(f); t.after(() => stream.close()); await stream.next();
  mkdirSync(join(f.project, ".lock"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample after the lock")));
  const next = await stream.next(p => p.stale || has(p, "Sample after the lock"));
  assert.deepEqual([next.stale, next.problems], [false, []], "the lock folder went away between the board's list and its watch");
});


test("a parent rename that names only the destination refreshes the missing board root", async t => {
  const original = fs.watch, captured = [];
  fs.watch = (path, callback) => {
    const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; };
    captured.push({ path, callback, watcher });
    return watcher;
  };
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t, { quiet: true, probe: null }); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close());
  await stream.next(p => !p.stale);
  renameSync(f.root, join(f.dir, "renamed-source"));
  const parent = captured.find(entry => entry.path === f.dir);
  assert.ok(parent);
  parent.callback("rename", "renamed-source");
  const missing = await stream.next(p => !p.tasks.length);
  assert.equal(missing.stale, false); assert.ok(!has(missing, "Sample first task"));
  populate(f.root, "Sample recreated source");
  parent.callback("rename", "source");
  await stream.next(p => !p.stale && has(p, "Sample recreated source"));
});

const wait = ms => new Promise(wake => setTimeout(wake, ms));
const call = i => i.toString(16).padStart(8, "0");
const action = (i, run = "R1") => `${JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 10, 14, 12, 0, i)).toISOString(), run, tool: "Read", kind: "file", target: `src/sample-${i}.mjs`, call: call(i), mark: "ok" })}\n`;
const R1 = "sample/project-abcdef/R1";

async function lightBoard(t, { lightEvery, quiet = false, slotOnly = false, hooks = true, slotAge = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-light-")), root = join(dir, "source"), project = populate(root);
  writeFileSync(join(project, "runs.tsv"), `${HEADERS.runs.replaceAll(" ", "\t")}\nR1\tT1\tqa\t0\t\t\trunning\t\t\t${new Date(Date.now() - 60 * 60_000).toISOString()}\t\nR2\tT1\timplementer\t0\t\t\tdone\t\t\t2026-11-14T10:00:00Z\t2026-11-14T11:00:00Z\n${[11, 12, 13, 14, 15].map(n => `R${n}\tT1\tqa\t0\t\t\tdone\t\t\t2026-11-14T10:00:00Z\t2026-11-14T10:10:00Z\n`).join("")}`);
  if (hooks) slot(root, "slot-1", ["project-project", "role-sage_qa", "run-R1"]);
  if (slotOnly) slot(root, "slot-2", ["project-project", "role-sage_explore"]);
  if (slotAge) { const then = new Date(Date.now() - slotAge * 60_000); utimesSync(join(root, ".hooks", "slots", "slot-1"), then, then); }
  if (quiet) { const long = new Date(Date.now() - 40 * 60_000); for (const name of slotOnly ? ["slot-2", "slot-1"] : ["slot-1"]) utimesSync(join(root, ".hooks", "slots", name), long, long); }
  mkdirSync(join(project, "actions"));
  let reads = 0;
  const server = quietBoard({ sources: [{ id: "sample", path: root, label: "Sample" }], port: 0, ...(lightEvery ? { lightEvery } : {}), duringRead: () => { reads++; },
    app: loadBoardApp(fileURLToPath(new URL("../plugins/sage/board/app", import.meta.url))) });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const { port } = await server.start();
  await server.ready();
  return { dir, root, project, port, file: join(project, "actions", "R1.jsonl"), slot: join(root, ".hooks", "slots", "slot-1"), reads: () => reads };
}

function appFrames(f) {
  const controller = new AbortController(), frames = [], activity = {}, waiters = new Set();
  const check = () => { for (const waiter of waiters) if (waiter.predicate()) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.accept(); } };
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
        const frame = { event: lines.find(line => line.startsWith("event: "))?.slice(7), data: JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6)) };
        frames.push(frame);
        if (frame.event === "activity") for (const [key, entry] of Object.entries(frame.data)) activity[key] = entry;
      }
      check();
    }
  })().catch(() => {});
  return {
    frames, activity,
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((accept, reject) => { const waiter = { predicate, accept, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching app stream frame")); }, EVENT_GUARD) }; waiters.add(waiter); });
    },
    close() { controller.abort(); },
  };
}

test("T1100: 100 action appends and 100 slot renewals cause at most 1 full read of the logbook, and the app stream gets coalesced activity events", async t => {
  const every = 400, f = await lightBoard(t, { lightEvery: every }), stream = appFrames(f); t.after(() => stream.close());
  await stream.until(() => stream.frames.some(frame => frame.event === "model"));
  await wait(500);
  const reads = f.reads(), models = () => stream.frames.filter(frame => frame.event === "model").length, shown = models();
  const start = performance.now();
  for (let i = 1; i <= 100; i++) { appendFileSync(f.file, action(i)); const now = new Date(); utimesSync(f.slot, now, now); await wait(20); }
  await wait(every + 500);
  const full = f.reads() - reads;
  assert.ok(full <= 1, `${full} full reads of the logbook for 100 appends and 100 slot renewals; the light path makes none`);
  const renewed = lstatSync(f.slot).mtimeMs;
  await stream.until(() => stream.activity[R1]?.now?.call === call(100) && stream.activity[R1]?.activity === renewed);
  assert.deepEqual(stream.activity[R1].now, JSON.parse(action(100)), "the event carries the run's last action, as the file has it");
  const sent = stream.frames.filter(frame => frame.event === "activity"), elapsed = performance.now() - start;
  assert.ok(sent.length >= 2 && sent.length <= Math.floor(elapsed / every) + 3, `timing-ok: the light reads are at least ${every} ms apart, so ${elapsed.toFixed(0)} ms hold at most ${Math.floor(elapsed / every) + 3} events, not one for each change; saw ${sent.length}`);
  assert.ok(sent.every(frame => Object.keys(frame.data).every(key => key === R1)), "an activity event names only the runs that changed");
  assert.equal(models(), shown, "the light path sends no model");
  const later = appFrames(f); t.after(() => later.close());
  await later.until(() => later.activity[R1]?.now?.call === call(100));
  assert.deepEqual(later.frames.map(frame => frame.event), ["model", "activity"], "a new stream gets the model, then the activity of each running agent");
});

test("T1100: a quiet agent that wakes, also one whose slot names no run, and a slot that comes, still get a full read, so the Agents data shows the new state", async t => {
  const f = await lightBoard(t, { lightEvery: 200, quiet: true, slotOnly: true }), stream = appFrames(f); t.after(() => stream.close());
  const runs = () => stream.frames.filter(frame => frame.event === "model").at(-1)?.data.agents.flatMap(book => book.runs) ?? [];
  const r1 = () => runs().find(run => run.id === "R1");
  await stream.until(() => r1()?.flag?.text === "Look at it" && /^no note for 40 min, and past 10 min/.test(r1().why));
  const reads = f.reads(), renew = path => { const now = new Date(); utimesSync(path, now, now); };
  renew(join(f.root, ".hooks", "slots", "slot-2"));
  for (let i = 0; i < 600 && f.reads() === reads; i++) await wait(50);
  assert.ok(f.reads() > reads, "the agent of the slot with no run works again, and that is a full read (F-T1100-1)");
  renew(f.slot);
  await stream.until(() => r1() && !r1().flag);
  writeFileSync(join(f.project, "runs.tsv"), `${readFileSync(join(f.project, "runs.tsv"), "utf8")}R3\tT1\tcode-reviewer\t0\t\t\trunning\t\t\t${new Date().toISOString()}\t\n`);
  slot(f.root, "slot-3", ["project-project", "role-sage_code-reviewer", "run-R3"]);
  await stream.until(() => runs().some(run => run.id === "R3" && run.role === "code-reviewer" && run.status === "running"));
});

test("T1099 (F-T1088-2): a board that starts before the hook's folder exists sees the slots made after it", async t => {
  const f = await lightBoard(t, { lightEvery: 50, hooks: false }), stream = appFrames(f); t.after(() => stream.close());
  const r1 = () => stream.frames.filter(frame => frame.event === "model").at(-1)?.data.agents.flatMap(book => book.runs).find(run => run.id === "R1");
  await stream.until(() => r1() !== undefined);
  assert.doesNotMatch(r1().why ?? "", /no note for 40 min/, "no hook folder yet: the run has no slot");
  mkdirSync(join(f.root, ".hooks"));
  await wait(400);
  slot(f.root, "slot-1", ["project-project", "role-sage_qa", "run-R1"]);
  const long = new Date(Date.now() - 40 * 60_000); utimesSync(f.slot, long, long);
  await stream.until(() => /^no note for 40 min/.test(r1()?.why ?? ""));
});

test("T1100: GET /api/actions/R<n> gives a known run's last 20 actions, and refuses path tricks, unknown runs and links", async t => {
  const f = await lightBoard(t), logbook = "sample/project-abcdef", url = (run, query = `logbook=${logbook}`) => `/api/actions/${run}?${query}`;
  const get = async (path, options) => { const reply = await read(f, path, options); return { ...reply, json: reply.body && reply.headers["content-type"]?.startsWith("application/json") ? JSON.parse(reply.body) : null }; };
  assert.deepEqual((await get(url("R1"))).json, { logbook, run: "R1", actions: [], dropped: 0 }, "the hook has written no action yet");
  rmSync(join(f.project, "actions"), { recursive: true });
  assert.deepEqual((await get(url("R1"))).json, { logbook, run: "R1", actions: [], dropped: 0 }, "no actions folder yet: no writer before task B");
  mkdirSync(join(f.project, "actions"));
  writeFileSync(f.file, Array.from({ length: 25 }, (_, i) => action(i + 1)).join("") + `${JSON.stringify({ ...JSON.parse(action(26)), input: "secret" })}\n${action(27, "R2")}{"partial`);
  const full = await get(url("R1"));
  assert.equal(full.status, 200); assert.match(full.headers["content-type"], /^application\/json/);
  assert.deepEqual(full.json.actions, Array.from({ length: 20 }, (_, i) => JSON.parse(action(i + 6))), "the last 20 valid lines; a partial last line waits for its writer");
  assert.equal(full.json.dropped, 2, "a line with an extra key and a line of another run are not readable");
  assert.equal((await get(url("R1", "logbook=sample%2Fproject-abcdef"))).status, 200, "an encoded slash is the same logbook");
  assert.deepEqual((await get(url("R2"))).json.actions, [], "an ended run of the logbook is known");
  assert.equal((await get(url("R1"), { method: "HEAD" })).status, 200);
  const refused = [url("R3"), url("R0"), url("r1"), url("R1", "logbook=sample/other-abcdef"), url("R1", "logbook=other/project-abcdef"),
    "/api/actions/R1", `/api/actions/R1/../R2?logbook=${logbook}`, `/api/actions/..%2F..%2Fconfig.json?logbook=${logbook}`, `/api/actions/R1.jsonl?logbook=${logbook}`,
    url("R1", "logbook=sample/../project-abcdef"), url("R1", "logbook=sample%2F..%2Fproject-abcdef"), url("R1", `logbook=${logbook}&logbook=${logbook}`), url("R1", `logbook=${logbook}&x=1`)];
  for (const path of refused) { const reply = await get(path); assert.equal(reply.status, 404, path); assert.doesNotMatch(reply.body, /sample-\d+\.mjs/, path); }
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await get(url("R1"), { method })).status, 405, method);
  assert.equal((await get(url("R1"), { rawHeaders: ["Host", "sample.tailnet.ts.net"] })).status, 403);
  assert.equal((await get(url("R1"), { rawHeaders: ["Host", `127.0.0.1:${f.port}`, "X-Forwarded-For", "100.64.0.7"] })).status, 403);
  const outside = join(f.dir, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "R1.jsonl"), action(99));
  rmSync(f.file); symlinkSync(join(outside, "R1.jsonl"), f.file);
  const file = await get(url("R1")); assert.equal(file.status, 403, "a linked action file"); assert.doesNotMatch(file.body, /sample-99/);
  rmSync(f.file); linkSync(join(outside, "R1.jsonl"), f.file);
  const hard = await get(url("R1")); assert.equal(hard.status, 403, "a hard link to a file outside the logbook"); assert.doesNotMatch(hard.body, /sample-99/);
  rmSync(join(f.project, "actions"), { recursive: true }); symlinkSync(outside, join(f.project, "actions"));
  const folder = await get(url("R1")); assert.equal(folder.status, 403, "a linked actions folder"); assert.doesNotMatch(folder.body, /sample-99/);
});

test("T1138: GET /app/stats gives the numbers of all projects or of one, names a logbook that it cannot read, and refuses other queries", async t => {
  const f = await fixture(t, { before: project => writeFileSync(join(project, "runs.tsv"), `${HEADERS.runs.replaceAll(" ", "\t")}\nR1\tT1\timplementer\t0\t\t\tdone\t5000\t\t2020-01-01T00:00:00Z\t${new Date().toISOString()}\n`) });
  const get = async path => { const reply = await read(f, path); return { ...reply, json: reply.status === 200 ? JSON.parse(reply.body) : null }; };
  const all = await get("/app/stats");
  assert.equal(all.status, 200); assert.match(all.headers["content-type"], /^application\/json/);
  assert.deepEqual([all.json.project, all.json.total.open, all.json.total.tokens, all.json.total.measure.peak, all.json.total.runs, all.json.gaps], [null, 1, 0, 5000, 1, []]);
  const one = await get("/app/stats?project=project-abcdef");
  assert.deepEqual([one.status, one.json.project, one.json.projects.map(row => row.key)], [200, "project-abcdef", ["project-abcdef"]]);
  for (const [path, status] of [["/app/stats?project=other-abcdef", 404], ["/app/stats?project=", 404], ["/app/stats?project=a&project=b", 400], ["/app/stats?logbook=x", 400]]) assert.equal((await get(path)).status, status, path);
  assert.equal((await read(f, "/app/stats", { rawHeaders: ["Host", "attacker.test"] })).status, 403);
  assert.equal((await read(f, "/app/stats", { method: "POST" })).status, 405);
  chmodSync(join(f.project, "runs.tsv"), 0);
  appendFileSync(join(f.project, "tasks.tsv"), row("Sample new task", "T3"));
  let gaps = [];
  for (let i = 0; i < 100 && !gaps.length; i++) { await new Promise(done => setTimeout(done, 100)); gaps = (await get("/app/stats")).json.gaps; }
  assert.deepEqual(gaps, [{ project: "project", what: "the agent time and tokens of project (Sample source logbook)" }], "the stats read the new logbook, not the board's last good copy; F-T1158-10: only the runs are left out; F-T1158-7: the project keeps its name");
  assert.equal((await get("/app/stats")).json.total.open, 2, "the rest still counts, with the new task");
});

test("F-T1158-3: while the board shows its last good copy, a read that changes the numbers still sends an event, so Stats fetches them", async t => {
  const f = await fixture(t), stream = events(f);
  t.after(() => stream.close());
  const good = await stream.next(model => !model.stale);
  assert.match(good.stats, /^[A-Za-z0-9+/]{43}=$/, "a digest of the numbers");
  chmodSync(join(f.project, "runs.tsv"), 0);
  appendFileSync(join(f.project, "tasks.tsv"), row("Sample second task", "T3"));
  const stale = await stream.next(model => model.stale);
  assert.notEqual(stale.stats, good.stats);
  appendFileSync(join(f.project, "tasks.tsv"), row("Sample third task", "T4"));
  const later = await stream.next(model => model.stale && model.stats !== stale.stats);
  assert.equal(later.at, stale.at, "the board still shows its last good copy");
  assert.equal(JSON.parse((await read(f, "/app/stats")).body).total.open, 3, "Stats of the newest read count the new tasks");
});

test("F-T1215-16, F-T1215-19: every script that starts a board with no settle reads starts it through quietBoard", () => {
  const scripts = fileURLToPath(new URL(".", import.meta.url)), helper = join("fixtures", "quiet-board.mjs");
  const files = fs.readdirSync(scripts, { recursive: true }).filter(name => name.endsWith(".mjs") && name !== helper && !name.split("/").includes("node_modules"));
  assert.ok(files.length > 50, "the scan reads the scripts folder");
  const theOptionNotNamedInThisFile = /settle[R]eads/;
  assert.deepEqual(files.filter(name => theOptionNotNamedInThisFile.test(readFileSync(join(scripts, name), "utf8"))), [], "pass no settle reads to createBoardServer: use quietBoard from scripts/fixtures/quiet-board.mjs, whose ready() waits until the watchers report its probe files and the reads end");
});

test("F-T1215-16: a quiet board's ready() waits for the read that its probe file started (held 500 ms, as on a loaded Mac), so a new stream's next model is the test's own write", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-quiet-")), root = join(dir, "source"), project = populate(root);
  const holds = new Int32Array(new SharedArrayBuffer(16)), release = () => { Atomics.store(holds, 0, 0); Atomics.notify(holds, 0); };
  const server = quietBoard({ sources: [{ id: "sample", path: root, label: "Sample" }], port: 0, app: APP, holds });
  t.after(async () => { release(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = { port: (await server.start()).port }, first = events(f);
  await first.next(); first.close();
  Atomics.store(holds, 0, 1);
  const ready = server.ready();
  while (Atomics.load(holds, 1) < 1) await new Promise(wake => setTimeout(wake, 10));
  let released = Infinity;
  setTimeout(() => { released = Date.now(); release(); }, 500);
  await ready;
  const stream = events(f); t.after(() => stream.close());
  const current = await stream.next();
  assert.ok(Date.parse(current.at) >= released, "ready() returned after the held read ended, and a new stream starts with that read");
  writeFileSync(join(project, "tasks.tsv"), tasks(row("Sample title after ready")));
  assert.ok(has(await stream.next(), "Sample title after ready"), "the model after the current one is the test's write, not a read of a probe file");
});

function frames(f) {
  const seen = [], waiters = new Set();
  let ended = false;
  const check = () => { for (const waiter of waiters) { const found = seen.find(waiter.predicate); if (found || ended) { clearTimeout(waiter.timer); waiters.delete(waiter); found ? waiter.accept(found) : waiter.reject(new Error("event stream ended")); } } };
  const req = request({ host: "127.0.0.1", port: f.port, path: "/app/events", agent: false, headers: { Host: `127.0.0.1:${f.port}` } }, incoming => {
    let buffer = ""; incoming.setEncoding("utf8");
    incoming.on("data", chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        seen.push({ type: /^event: (\w+)$/m.exec(frame)?.[1] ?? null, data: /^data: (.*)$/m.exec(frame)?.[1] ?? "" });
      }
      check();
    });
    incoming.on("end", () => { ended = true; check(); });
  });
  req.on("error", () => { ended = true; check(); }); req.end();
  return {
    seen, ended: () => ended,
    next: predicate => new Promise((accept, reject) => { const waiter = { predicate, accept, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching board event")); }, EVENT_GUARD) }; waiters.add(waiter); check(); }),
    close() { req.destroy(); },
  };
}

test("T1223: a model over the size limit sends a red notice, not an ended stream, and the next model that fits clears it", async t => {
  const measure = await fixture(t), first = frames(measure); t.after(() => first.close());
  const size = Buffer.byteLength((await first.next(frame => frame.type === "model")).data);
  const wide = "Sample long title ".repeat(300);
  const f = await fixture(t, { maxModel: size + 2000, before: project => writeFileSync(join(project, "tasks.tsv"), tasks(row(wide))) }), stream = frames(f); t.after(() => stream.close());
  const notice = JSON.parse((await stream.next(frame => frame.type === "notice")).data).text;
  assert.match(notice, /^The board could not send its newest read: its data is \d+(\.\d)? MB, and the limit is \d+(\.\d)? MB\./);
  assert.match(notice, / No read fit since this page opened, so the page has nothing to show yet\. /, "F-T1216-34: a page with no earlier read is not told that it shows one");
  assert.deepEqual([stream.seen.some(frame => frame.type === "model"), stream.ended()], [false, false], "no model over the limit, and the stream stays open");
  writeFileSync(join(f.project, "tasks.pending"), tasks(row("Sample short title"))); renameSync(join(f.project, "tasks.pending"), join(f.project, "tasks.tsv"));
  const model = JSON.parse((await stream.next(frame => frame.type === "model")).data);
  assert.ok(has(model, "Sample short title"));
  assert.equal(JSON.parse((await stream.next(frame => frame.type === "notice" && frame !== stream.seen.find(item => item.type === "notice"))).data).text, null, "the notice clears");
  assert.equal(stream.ended(), false);
  writeFileSync(join(f.project, "tasks.pending"), tasks(row(wide))); renameSync(join(f.project, "tasks.pending"), join(f.project, "tasks.tsv"));
  const again = JSON.parse((await stream.next(frame => frame.type === "notice" && JSON.parse(frame.data).text !== null && frame !== stream.seen.find(item => item.type === "notice"))).data).text;
  assert.match(again, / The page shows the last read that fit\. /, "F-T1216-34: a page that has a read keeps it, and the note says so");
});
