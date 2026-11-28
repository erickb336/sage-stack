import "./test-env.mjs";
import { tname } from "./task-names.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp, withoutPaths } from "../plugins/sage/board/server.mjs";
import { writeInWorker } from "../plugins/sage/board/writes.mjs";
import { boardCommandPort } from "./fixtures/board-port.mjs";
import { QUESTION, pageQuestion } from "./fixtures/question-message.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const CLI = new URL("../plugins/sage/board/cli.mjs", import.meta.url).pathname, TEST_CHILD = new URL("./board-test-child.mjs", import.meta.url).pathname;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function call(port, path, { method = "POST", headers = {}, body } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, response => {
      const parts = [];
      response.on("data", part => parts.push(part));
      response.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        accept({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.once("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function board(t, { ready = true, ...options } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-writes-")));
  const saved = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env);
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${new Date().toISOString()}\nC2\tcodex\tcodex-1\t${new Date().toISOString()}\n`);
  const as = (...args) => claude.sage([...args, "--project", project, "--chief", "C1"], env);
  as("task", "add", "--name", tname(), "--title", "Sample share sheet", "--size", "small", "--priority", "P1");
  as("gate", "add", "--message", QUESTION, "T1", "--question", "Can a viewer copy a shared list?", "--options", "yes|no", "--recommend", "yes");
  const config = join(base, "home", ".config", "sage-board", "board.json");
  const stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = quietBoard({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port: 0, app: APP, stateDir, pairCommand: "node /sample/board/cli.mjs board --pair", ...options }, { create: createBoardServer });
  t.after(() => server.close());
  const { port } = await server.start();
  if (ready) await server.ready();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: env.SAGE_SHARED_HOME }])], { output: () => {}, env });
  const origin = `http://127.0.0.1:${port}`;
  const own = { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
  const logbook = `shared/${dir.split("/").at(-1)}`;
  const gates = () => readFileSync(join(dir, "gates.tsv"), "utf8");
  const gate = id => claude.read(dir, "gates").find(row => row.id === id);
  return { base, env, project, dir, config, stateDir, port, origin, own, logbook, gates, gate, as, server };
}

async function pair(w) {
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))[1];
  const paired = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(paired.status, 200, paired.text);
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  return { code, cookie, token: paired.json.token, headers: { ...w.own, Cookie: cookie, "X-Sage-Token": paired.json.token } };
}

async function waitFor(check, what) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 50))) if (await check()) return;
  assert.fail(`timed out: ${what}`);
}
async function needs(w) {
  const shell = await call(w.port, "/app/", { method: "GET" });
  assert.equal(shell.status, 200);
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: w.port, path: "/app/events", agent: false, headers: { Host: `127.0.0.1:${w.port}` } }, response => {
      let text = "";
      response.on("data", part => {
        text += part;
        const data = /event: model\ndata: (.*)\n\n/.exec(text);
        if (data) { req.destroy(); accept(JSON.parse(data[1])); }
      });
    });
    req.once("error", reject);
    req.end();
  });
}

test("board --pair refuses input that is not a terminal, prints a one-time code in a terminal, and keeps only hashes in the board's state folder", async t => {
  const w = await board(t);
  await assert.rejects(runBoardCli(["board", "--pair", "--config", w.config], { output: () => {}, env: w.env, input: { isTTY: false } }), /board --pair runs only in Terminal/);
  assert.equal(existsSync(join(w.stateDir, "pair-code.json")), false, "a refused pairing writes nothing");
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))?.[1];
  assert.ok(code, lines.join("\n"));
  const kept = () => readdirSync(w.stateDir).map(name => readFileSync(join(w.stateDir, name), "utf8")).join("\n");
  assert.ok(!kept().includes(code) && !kept().includes(code.replace("-", "")), "the code itself is not kept");

  for (let i = 0; i < 4; i++) assert.equal((await call(w.port, "/api/pair", { headers: w.own, body: { code: "AAAA-AAAA" } })).status, 403);
  const right = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(right.status, 200, "four wrong tries leave the code working");
  const cookie = right.headers["set-cookie"]?.[0] ?? "";
  assert.match(cookie, /^sage_board=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
  const value = cookie.split(";")[0].slice("sage_board=".length);
  assert.ok(!kept().includes(value), "only the cookie's hash is kept");
  assert.equal((await call(w.port, "/api/pair", { headers: w.own, body: { code } })).status, 403, "a code works once");

  assert.match(right.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!kept().includes(right.json.token), "only the token's hash is kept");
  const shell = await call(w.port, "/app/", { method: "GET", headers: { Cookie: `sage_board=${value}` } });
  assert.equal(shell.status, 200);
  assert.ok(!shell.text.includes(right.json.token), "F-T1059-13: the page that the cookie opens does not carry the token");

  await runBoardCli(["board", "--pair", "--config", w.config], { output: () => {}, env: w.env, input: { isTTY: true } });
  for (let i = 0; i < 5; i++) await call(w.port, "/api/pair", { headers: w.own, body: { code: "AAAA-AAAA" } });
  assert.equal(existsSync(join(w.stateDir, "pair-code.json")) ? JSON.parse(readFileSync(join(w.stateDir, "pair-code.json"), "utf8")).tries : 5, 5, "five wrong tries spend a code");
});

test("F-T1119-1, F-T1119-2: the pairing command on the page quotes a path with !, quotes, $, a backtick, a backslash and a space for an interactive shell, and names a config that is not the default with --config", async t => {
  const w = await board(t), odd = "it's $HOME `x` \"q\" !! copy";
  for (const part of ["board", "core"]) cpSync(new URL(`../plugins/sage/${part}/`, import.meta.url), join(w.base, odd, part), { recursive: true });
  const config = join(w.base, "config \\ folder", "board.json"), port = await boardCommandPort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])], { output: () => {}, env: w.env });
  const server = await (await import(pathToFileURL(join(w.base, odd, "board", "cli.mjs")).href)).runBoardCli(["board", "--serve", "--config", config], { output: () => {}, env: w.env });
  t.after(() => server.close());
  const shell = await call(port, "/app/", { method: "GET" });
  const shown = /<meta name="sage-pair" content="([^"]*)">/.exec(shell.text)[1].replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
  assert.equal(shown, `node '${w.base}/it'\\''s $HOME \`x\` "q" !! copy/board/cli.mjs' board --pair --config '${w.base}/config \\ folder/board.json'`);
});

test("F-T1059-13: the pairing cookie alone writes nothing: a server on another port that got it reads /app/ and forges the headers from node http", async t => {
  const w = await board(t), p = await pair(w), before = w.gates();
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const page = await call(w.port, "/app/", { method: "GET", headers: { Cookie: p.cookie } });
  const token = /name="sage-token" content="([^"]*)"/.exec(page.text)?.[1] ?? "";
  const forged = await call(w.port, "/api/answer", { headers: { ...w.own, Cookie: p.cookie, "X-Sage-Token": token }, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(forged.status, 403, forged.text);
  assert.match(forged.json.problem, /pair/i, "the refusal says to pair again");
  assert.equal(w.gates(), before, "the forged write changed nothing");
  const own = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(own.status, 200, `the paired browser, with its token, still writes: ${own.text}`);
  const other = await pair(w);
  assert.equal((await call(w.port, "/api/name", { headers: { ...other.headers, "X-Sage-Token": p.token }, body: {} })).status, 403, "a token works only with the cookie of the same browser");
});

test("every forged write is refused before it reaches the logbook: a plain curl, another port, a sandboxed /pages page, a cross-site form, no cookie, no token", async t => {
  const w = await board(t), p = await pair(w), before = w.gates();
  const body = { logbook: w.logbook, gate: "G1", option: 1, digest: "0".repeat(16) };
  const cases = [
    ["a plain curl: no Origin", { "Content-Type": "application/json", Cookie: p.cookie, "X-Sage-Token": p.token }, 403],
    ["a page on another port", { ...p.headers, Origin: `http://127.0.0.1:${w.port + 1}`, "Sec-Fetch-Site": "same-site" }, 403],
    ["another port that claims same-origin", { ...p.headers, Origin: `http://127.0.0.1:${w.port + 1}` }, 403],
    ["a /pages page that runs scripts: Origin null", { ...p.headers, Origin: "null" }, 403],
    ["a cross-site fetch", { ...p.headers, "Sec-Fetch-Site": "cross-site" }, 403],
    ["no fetch metadata", { ...p.headers, "Sec-Fetch-Site": undefined }, 403],
    ["a form post", { ...p.headers, "Content-Type": "application/x-www-form-urlencoded" }, 415],
    ["text/plain", { ...p.headers, "Content-Type": "text/plain" }, 415],
    ["no cookie", { ...w.own, "X-Sage-Token": p.token }, 401],
    ["a cookie that was never paired", { ...p.headers, Cookie: `sage_board=${"A".repeat(43)}` }, 401],
    ["no token", { ...p.headers, "X-Sage-Token": undefined }, 403],
    ["a wrong token", { ...p.headers, "X-Sage-Token": "x".repeat(43) }, 403],
  ];
  for (const [what, headers, status] of cases) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const got = await call(w.port, "/api/answer", { headers: clean, body });
    assert.equal(got.status, status, `${what}: ${got.text}`);
    assert.equal(got.headers["access-control-allow-origin"], undefined, what);
  }
  const preflight = await call(w.port, "/api/answer", { method: "OPTIONS", headers: { Origin: `http://127.0.0.1:${w.port + 1}`, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 403, "the server answers no CORS preflight");
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const get = await call(w.port, "/api/answer", { method: "GET", headers: p.headers });
  assert.equal(get.status, 405);
  assert.equal(w.gates(), before, "no forged write changed the logbook");
});

test("the owner answers, undoes and answers again from the board; a changed question and an earlier chat answer are refused, and each refusal names why", async t => {
  const w = await board(t), p = await pair(w);
  const open = await needs(w);
  assert.match(open.tasks.find(task => task.id === "T1").addedAt, /^\d{4}-\d\d-\d\dT/, "task add keeps the time when the task was added");
  const need = open.needs.find(item => item.gate === "G1");
  assert.deepEqual([need.logbook, need.options, need.owner, typeof need.digest], [w.logbook, ["yes", "no"], "C1", "string"]);

  const stale = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: "f".repeat(16) } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.text, /^G1 changed after the owner read it/);
  assert.equal(w.gate("G1").answered ?? "", "", "a refused answer writes nothing");

  const sent = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest } });
  assert.equal(sent.status, 200, sent.text);
  assert.match(sent.json.text, /^G1 recorded · no · from the board, at .*sage gate undo G1 takes it back\.$/);
  assert.equal(JSON.parse(w.gate("G1").answered).via, "board");
  assert.equal(w.gate("G1").answer, "", "a board answer only records: the chief applies it at pickup");
  await waitFor(async () => (await needs(w)).answered.some(item => item.gateId === "G1"), "the model lists the pending answer");
  const after = await needs(w);
  assert.equal(after.needs.some(item => item.gate === "G1"), false, "F-T1059-9: a pending board answer is not a question that needs you");
  assert.equal(after.answered.find(item => item.gateId === "G1").answer, "no");
  assert.match(claude.sage(["status", "--project", w.project], w.env), /gates {3}0 open · 1 answered on the board, not picked up yet · G1 .* \(board answer: no\)/);

  const undo = await call(w.port, "/api/undo", { headers: p.headers, body: { logbook: w.logbook, gate: "G1" } });
  assert.equal(undo.status, 200, undo.text);
  assert.match(undo.json.text, /^G1 undone/);
  assert.equal(w.gate("G1").answered ?? "", "");

  claude.sage(["gate", "answer", "G1", "--option", "1", "--via", "chat", "--project", w.project], w.env);
  const late = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest } });
  assert.equal(late.status, 409);
  assert.match(late.json.text, /^G1 has the answer "yes" already, from the chat at .*: the first answer wins, so this answer is not recorded\./);
  const detail = await call(w.port, `/app/gate/${Buffer.from(`${w.logbook}/G1`).toString("base64url")}`, { method: "GET" });
  await waitFor(async () => (await call(w.port, `/app/gate/${Buffer.from(`${w.logbook}/G1`).toString("base64url")}`, { method: "GET" })).json?.answer === "yes", "the gate detail shows the chat answer");
  assert.equal(detail.status, 200);
});

test("T1222: a board answer to a design question sends the owner's words with choice 2 as hex, and the state tool keeps them as one answer", async t => {
  const w = await board(t), p = await pair(w);
  const pages = w.as("pages", "T1");
  mkdirSync(join(pages, "designs", "final"), { recursive: true });
  writeFileSync(join(pages, "designs", "final", "index.html"), "<p>SAMPLE receipt mail</p>");
  w.as("gate", "add", "T1", "--design", "designs/final", "--question", "Approve design v1 of the receipt mail?", "--recommend", "1", "--message", pageQuestion("T1", "designs/final/index.html"));
  let need;
  await waitFor(async () => (need = (await needs(w)).needs.find(item => item.gate === "G2")), "the model lists the design question");
  assert.deepEqual(need.options, ["Approve", "Approve with your words", "New version"]);
  const body = extra => ({ logbook: w.logbook, gate: "G2", option: 2, digest: need.digest, ...extra });
  const bare = await call(w.port, "/api/answer", { headers: p.headers, body: body({}) });
  assert.equal(bare.status, 409);
  assert.match(bare.json.text, /^G2 is a design question, so its answer is one of its three choices: .* after choice 2, ask the owner for the words\. Nothing changed\.$/);
  const long = await call(w.port, "/api/answer", { headers: p.headers, body: body({ words: "x".repeat(1001) }) });
  assert.equal(long.status, 400, "words over the limit do not reach the state tool");
  assert.equal(w.gate("G2").answered ?? "", "", "a refused answer writes nothing");
  const sent = await call(w.port, "/api/answer", { headers: p.headers, body: body({ words: "Use the shop's logo, not \"Shop\"; keep — the dash." }) });
  assert.equal(sent.status, 200, sent.text);
  assert.match(sent.json.text, /^G2 recorded · Approve with your words: Use the shop's logo, not "Shop"; keep — the dash\. · from the board/);
  assert.equal(JSON.parse(w.gate("G2").answered).answer, "Approve with your words: Use the shop's logo, not \"Shop\"; keep — the dash.");
});

test("T1219: each owner write that reaches the state tool after an archive, while the board's read still shows the project as not archived, is refused by the state tool with one text and writes nothing", async t => {
  let w, during = false;
  const archive = word => claude.sage(["config", `archived=${word}`, "--project", w.project], w.env);
  w = await board(t, { write: async job => {
    if (!during) return writeInWorker(job);
    archive("yes");
    try { return await writeInWorker(job); } finally { archive("no"); }
  } });
  const p = await pair(w), need = (await needs(w)).needs.find(item => item.gate === "G1");
  const send = (job, body) => call(w.port, `/api/${job}`, { headers: p.headers, body });
  const answer = { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest }, shut = "This project is archived, so it takes no answer and no other owner write. Restore it first, on the board or with sage config archived=no in its own chat when the owner asks for it, then try again. Nothing changed.";
  const tables = () => ["gates", "tasks"].map(table => readFileSync(join(w.dir, `${table}.tsv`), "utf8")).join("\n");
  const open = () => waitFor(async () => (({ projects = [] }) => projects.length === 1 && !projects[0].archived)(await needs(w)), "the board reads the project as not archived");
  const refusedDuringArchive = async (job, body) => {
    await open();
    const before = tables();
    during = true;
    const got = await send(job, body).finally(() => { during = false; });
    assert.deepEqual([got.status, got.json.text], [409, shut], `${job}: the state tool refuses it, not the board's own check`);
    assert.equal(tables(), before, `${job}: a refused write writes nothing`);
  };

  await refusedDuringArchive("answer", answer);
  await open();
  const recorded = await send("answer", answer);
  assert.equal(recorded.status, 200, `with no archive, the same answer records: ${recorded.text}`);
  await refusedDuringArchive("undo", { logbook: w.logbook, gate: "G1" });
  await refusedDuringArchive("give", { logbook: w.logbook, task: "T1", to: "C2" });
  await refusedDuringArchive("name", { logbook: w.logbook, chief: "C2", name: "Codex desk" });
  assert.equal(existsSync(join(w.dir, "chief-names.json")), false, "the refused name is not kept");
  await open();
  const undo = await send("undo", { logbook: w.logbook, gate: "G1" });
  assert.equal(undo.status, 200, `with no archive, the undo lands: ${undo.text}`);
});

async function readHeld(holds) {
  for (let seen; (seen = Atomics.load(holds, 1)) < 1;) {
    const { async, value } = Atomics.waitAsync(holds, 1, seen, 30_000);
    if (async && await value === "timed-out") assert.fail("no read reached the hold");
  }
}
const release = holds => { Atomics.store(holds, 0, 0); Atomics.notify(holds, 0); };

test("T1215 (C5): a write before the board's first read ends gets 503 Reading the logbooks and writes nothing; after the read, it lands", async t => {
  const holds = new Int32Array(new SharedArrayBuffer(16));
  Atomics.store(holds, 0, 1);
  t.after(() => release(holds));
  const w = await board(t, { holds, ready: false }), p = await pair(w);
  await readHeld(holds);
  const before = w.gates(), reading = "Reading the logbooks. The board answers when its first read ends.";
  for (const [job, body] of [["answer", { logbook: w.logbook, gate: "G1", option: 1, digest: "0".repeat(16) }], ["undo", { logbook: w.logbook, gate: "G1" }], ["name", { logbook: w.logbook, chief: "C2", name: "Codex desk" }], ["archive", { project: "project" }]]) {
    const refused = await call(w.port, `/api/${job}`, { headers: p.headers, body });
    assert.deepEqual([refused.status, refused.json.problem], [503, reading], job);
  }
  assert.equal(w.gates(), before, "nothing reached the logbook");
  release(holds);
  await w.server.ready();
  const need = (await needs(w)).needs.find(item => item.gate === "G1");
  const answered = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(answered.status, 200, answered.text);
});

test("T1215 (C1): a write sent during the read that follows an archive gets the state tool's refusal; after that read ends, the board refuses it itself", async t => {
  const holds = new Int32Array(new SharedArrayBuffer(16));
  t.after(() => release(holds));
  const w = await board(t, { holds }), p = await pair(w), need = (await needs(w)).needs.find(item => item.gate === "G1");
  const answer = { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest }, before = w.gates();
  Atomics.store(holds, 0, 1);
  claude.sage(["config", "archived=yes", "--project", w.project], w.env);
  await readHeld(holds);
  const during = await call(w.port, "/api/answer", { headers: p.headers, body: answer });
  assert.deepEqual([during.status, during.json.text], [409, "This project is archived, so it takes no answer and no other owner write. Restore it first, on the board or with sage config archived=no in its own chat when the owner asks for it, then try again. Nothing changed."], "the board still shows the last read, so the state tool refuses it");
  release(holds);
  await waitFor(async () => (await needs(w)).projects[0]?.archived, "the board reads the archive");
  const after = await call(w.port, "/api/answer", { headers: p.headers, body: answer });
  assert.deepEqual([after.status, after.json.text], [409, "project is archived, so the board records no answer or other write for it. Restore it first, then try again. Nothing changed."]);
  assert.equal(w.gates(), before, "no answer reached the logbook");
});

test("the owner renames a chief and gives a task to another chief", async t => {
  const w = await board(t), p = await pair(w);
  const named = await call(w.port, "/api/name", { headers: p.headers, body: { logbook: w.logbook, chief: "C2", name: "Codex desk" } });
  assert.equal(named.status, 200, named.text);
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")), { C2: "Codex desk" });
  for (const name of ["--via board", "-dash", " -x"]) {
    const bad = await call(w.port, "/api/name", { headers: p.headers, body: { logbook: w.logbook, chief: "C2", name } });
    assert.equal(bad.status, 400, `a name that reads as an option is refused before the state tool: ${name}`);
    assert.match(bad.json.problem, /cannot start with "-"/, "F-T1059-24: the refusal names the real reason");
  }
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")), { C2: "Codex desk" });

  const given = await call(w.port, "/api/give", { headers: p.headers, body: { logbook: w.logbook, task: "T1", to: "C2" } });
  assert.equal(given.status, 200, given.text);
  assert.match(given.json.text, /^G2 open · Hand T1 from C1 \(claude\) to C2 \(codex\)\?/);
  assert.equal(claude.read(w.dir, "tasks").find(row => row.id === "T1").chief, "C1", "giving only opens the takeover question: nothing moves before the owner's answer");

  const elsewhere = await call(w.port, "/api/give", { headers: p.headers, body: { logbook: "shared/other-abcdef", task: "T1", to: "C2" } });
  assert.equal(elsewhere.status, 409, "a logbook with no checkout on this Mac is refused");
});

const linkPair = (w, link, headers = w.own) => call(w.port, "/api/pair", { headers, body: { link } });
const cookieOf = got => got.headers["set-cookie"]?.[0].split(";")[0];
const probe = (w, headers) => call(w.port, "/api/name", { headers, body: {} }).then(got => got.status);

test("T1125: a link pairs a fresh browser once, and each other outcome says why: used, already paired, replaced, expired, refused", async t => {
  const w = await board(t);
  for (const link of ["A".repeat(43), 5, "short", `${"A".repeat(43)}x`]) {
    const got = await linkPair(w, link);
    assert.deepEqual([got.status, got.json, cookieOf(got)], [403, { outcome: "refused" }, undefined], `a key that no link has: ${JSON.stringify(link)}`);
  }
  const key = startLink(w.stateDir);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, "256 random bits, base64url");
  assert.doesNotMatch(readFileSync(join(w.stateDir, "pair-link.json"), "utf8"), new RegExp(key), "the board keeps only the key's hash");
  const paired = await linkPair(w, key);
  assert.equal(paired.status, 200, paired.text);
  assert.equal(paired.json.outcome, "paired");
  const first = { ...w.own, Cookie: cookieOf(paired), "X-Sage-Token": paired.json.token };
  assert.equal(await probe(w, first), 400, "the browser that clicked the link writes");

  const again = await linkPair(w, key);
  assert.deepEqual([again.status, again.json.outcome, cookieOf(again)], [200, "used", undefined], "a second browser cannot use the same link");
  assert.match(again.json.at, /^\d{4}-\d\d-\d\dT/, "the used note gives when the link was used");

  const second = startLink(w.stateDir);
  const already = await linkPair(w, second, first);
  assert.deepEqual([already.json.outcome, cookieOf(already), already.json.token], ["already", undefined, undefined], "a paired browser gets nothing new");
  assert.equal((await linkPair(w, second)).json.outcome, "used", "the paired browser ended the link unused, so no other browser can use it");
  assert.equal((await linkPair(w, "A".repeat(43), first)).json.outcome, "already", "a paired browser reads 'already' for any link");

  const older = startLink(w.stateDir), newer = startLink(w.stateDir);
  assert.equal((await linkPair(w, older)).json.outcome, "replaced", "a new link ends the older one");
  const usedThenReplaced = await linkPair(w, second);
  assert.deepEqual([usedThenReplaced.json.outcome, typeof usedThenReplaced.json.at], ["used", "string"], "F-T1125-1: a used link still reads used, with its time, after newer links replaced it");
  assert.equal((await linkPair(w, newer)).json.outcome, "paired");

  const expired = startLink(w.stateDir, Date.now() - 10 * 60_000 - 1);
  const late = await linkPair(w, expired);
  assert.deepEqual([late.json.outcome, cookieOf(late)], ["expired", undefined]);
  assert.ok(Date.parse(late.json.at) < Date.now(), "the expired note gives when the link ended");

  const token = startLink(w.stateDir);
  assert.equal((await linkPair(w, token, { ...w.own, Cookie: first.Cookie })).json.outcome, "paired", "a cookie without its page's token is not paired, so the link pairs that browser again");
  const forged = await linkPair(w, startLink(w.stateDir), { ...w.own, Origin: `http://127.0.0.1:${w.port + 1}` });
  assert.equal(forged.status, 403, "the link form keeps the origin checks");
});

test("T1125: 'Unpair every browser' works without pairing, removes every pairing, and keeps the origin checks", async t => {
  const w = await board(t), byCode = await pair(w), byLink = await linkPair(w, startLink(w.stateDir));
  const linked = { ...w.own, Cookie: cookieOf(byLink), "X-Sage-Token": byLink.json.token };
  assert.deepEqual([await probe(w, byCode.headers), await probe(w, linked)], [400, 400], "both browsers are paired");
  assert.equal((await call(w.port, "/api/unpair", { headers: { ...w.own, Origin: `http://127.0.0.1:${w.port + 1}` }, body: {} })).status, 403, "a page on another port cannot unpair");
  assert.deepEqual([await probe(w, byCode.headers), await probe(w, linked)], [400, 400], "a refused unpair changes nothing");
  const unpaired = await call(w.port, "/api/unpair", { headers: w.own, body: {} });
  assert.equal(unpaired.status, 200, unpaired.text);
  assert.match(unpaired.json.text, /^Every browser is unpaired/);
  assert.deepEqual([await probe(w, byCode.headers), await probe(w, linked)], [401, 401], "every browser reads only now");
  assert.equal((await pair(w)).token.length, 43, "a browser pairs again after it");
});

test("T1125: the last visit is no longer on the Mac: /api/seen is gone, and an old seen.json or a broken pair-link.json does not break the board", async t => {
  const w = await board(t);
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(join(w.stateDir, "seen.json"), JSON.stringify({ at: "2026-11-01T10:00:00.000Z" }));
  writeFileSync(join(w.stateDir, "pair-link.json"), "{ not json");
  assert.equal((await call(w.port, "/app/", { method: "GET" })).status, 200);
  assert.equal((await linkPair(w, "A".repeat(43))).json.outcome, "refused", "a broken link file pairs nothing");
  const p = await pair(w);
  const seen = await call(w.port, "/api/seen", { headers: p.headers, body: {} });
  assert.equal(seen.status, 400, `the route is gone: ${seen.text}`);
  assert.equal(readFileSync(join(w.stateDir, "seen.json"), "utf8"), JSON.stringify({ at: "2026-11-01T10:00:00.000Z" }), "the board neither reads nor writes seen.json");
  const key = startLink(w.stateDir);
  assert.equal((await linkPair(w, key)).json.outcome, "paired", "a new link replaces the broken file");
});

test("the state tool's lock never runs on the server's event thread: a read answers while a write waits for the lock", async t => {
  const w = await board(t), p = await pair(w);
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const lock = join(w.dir, ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ pid: 424242, host: hostname(), machineId: "test-machine", boot: Date.now() - uptime() * 1000, start: 0, at: Date.now() }));
  const started = Date.now();
  let wrote = null;
  const write = call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } }).then(result => { wrote = Date.now(); return result; });
  await new Promise(wake => setTimeout(wake, 300));
  const read = await call(w.port, "/app/", { method: "GET" });
  const readAt = Date.now();
  assert.equal(read.status, 200);
  const result = await write;
  assert.equal(result.status, 409);
  assert.match(result.json.text, /the logbook is busy/);
  assert.ok(readAt < wrote, `the read (${readAt - started} ms) answered before the write that waited for the lock (${wrote - started} ms)`);
  rmSync(lock, { recursive: true, force: true });
});

test("F-T1059-52, F-T1059-28: the real board process answers a clear 500 and stays up when its state folder cannot be written or paired.json is a symlink", async t => {
  const w = await board(t);
  const config = join(w.base, "serve", "board.json"), stateDir = join(w.base, "serve", "state"), port = await boardCommandPort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])], { output: () => {}, env: w.env });
  const child = spawn(process.execPath, [TEST_CHILD, CLI, "board", "--serve", "--config", config], { env: w.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let exited = null;
  const closed = new Promise(done => child.once("exit", code => { exited = { code }; done(); }));
  try {
    await waitFor(async () => (await call(port, "/app/", { method: "GET" }).catch(() => null))?.status === 200, "the board process listens");
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
    const own = { ...w.own, Origin: `http://127.0.0.1:${port}` };
    const paired = await call(port, "/api/pair", { headers: own, body: { code: /Pairing code: (\S+)/.exec(lines.join("\n"))[1] } });
    const headers = { ...own, Cookie: paired.headers["set-cookie"][0].split(";")[0], "X-Sage-Token": paired.json.token };
    assert.equal((await call(port, "/api/name", { headers, body: {} })).status, 400, "the browser is paired");
    const broken = async (what, code) => {
      const unpair = await call(port, "/api/unpair", { headers, body: {} });
      assert.equal(unpair.status, 500, `${what}: ${unpair.text}`);
      assert.match(unpair.json.problem, new RegExp(`^The board could not do this on this Mac \\(${code}\\), so nothing changed\\.`), what);
      assert.equal((await call(port, "/app/", { method: "GET" })).status, 200, `${what}: the board still serves pages`);
      assert.equal(exited, null, `${what}: the board process still runs`);
    };
    const rootWritesAnyFolder = process.getuid?.() === 0;
    if (!rootWritesAnyFolder) {
      chmodSync(stateDir, 0o500);
      await broken("a state folder that cannot be written", "EACCES");
      chmodSync(stateDir, 0o700);
    }
    renameSync(join(stateDir, "paired.json"), join(stateDir, "kept.json"));
    symlinkSync("kept.json", join(stateDir, "paired.json"));
    await broken("a paired.json that is a symlink", "ELOOP");
  } finally {
    chmodSync(stateDir, 0o700);
    if (child.connected) child.send({ kind: "close-tree" }, () => {});
    await closed;
  }
});

test("T1126, F-T1159-40: Stop from a paired browser closes the real board process: its port is free, its board.pid is gone and the process ends; a browser that is not paired and a page on another port cannot stop it", async t => {
  const w = await board(t);
  const config = join(w.base, "serve", "board.json"), port = await boardCommandPort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: w.env.SAGE_SHARED_HOME }])], { output: () => {}, env: w.env });
  const child = spawn(process.execPath, [TEST_CHILD, CLI, "board", "--serve", "--config", config], { env: w.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(done => child.once("exit", code => done(code)));
  try {
    await waitFor(async () => (await call(port, "/app/", { method: "GET" }).catch(() => null))?.status === 200, "the board process listens");
    assert.ok(existsSync(join(w.base, "serve", "board.pid")), "the running board keeps its board.pid");
    const own = { ...w.own, Origin: `http://127.0.0.1:${port}` };
    assert.equal((await call(port, "/api/stop", { headers: own, body: {} })).status, 401, "a browser that is not paired cannot stop the board");
    assert.equal((await call(port, "/api/stop", { headers: { ...own, Origin: `http://127.0.0.1:${port + 1}` }, body: {} })).status, 403, "a page on another port cannot stop the board");
    assert.equal((await call(port, "/app/", { method: "GET" })).status, 200, "the board still runs after both refusals");
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
    const paired = await call(port, "/api/pair", { headers: own, body: { code: /Pairing code: (\S+)/.exec(lines.join("\n"))[1] } });
    const stopped = await call(port, "/api/stop", { headers: { ...own, Cookie: paired.headers["set-cookie"][0].split(";")[0], "X-Sage-Token": paired.json.token }, body: {} });
    assert.equal(stopped.status, 200, stopped.text);
    assert.match(stopped.json.text, /^The board stopped\. To start it again, type show board in a chief's chat\.$/);
    await waitFor(async () => (await call(port, "/app/", { method: "GET" }).catch(error => error.code)) === "ECONNREFUSED", "the port is free");
    await waitFor(() => !existsSync(join(w.base, "serve", "board.pid")), "board.pid is gone");
    child.send({ kind: "stopped" });
    assert.equal(await closed, 0, "F-T1159-40: the board process ends on its own after Stop, within 10 s, with nothing left that holds it");
  } finally {
    if (child.connected) child.send({ kind: "close-tree" }, () => {});
    await closed;
  }
});

test("F-T1059-46: a shadow sage_board cookie that comes first does not hide the paired cookie after it", async t => {
  const w = await board(t), p = await pair(w);
  const shadow = `sage_board=${"B".repeat(43)}`;
  assert.equal(await probe(w, { ...p.headers, Cookie: `${shadow}; ${p.cookie}` }), 400, "the paired cookie after the shadow still counts");
  assert.equal(await probe(w, { ...p.headers, Cookie: shadow }), 401, "the shadow cookie alone is still not paired");
});

test("F-T1059-47: while a takeover question for a task is open, to any chief, a give of that task to another chief is refused; after the answer, it opens", async t => {
  const w = await board(t), p = await pair(w);
  appendFileSync(join(w.dir, "chiefs.tsv"), `C3\tclaude\tclaude-3\t${new Date().toISOString()}\n`);
  const give = to => call(w.port, "/api/give", { headers: p.headers, body: { logbook: w.logbook, task: "T1", to } });
  assert.match((await give("C2")).json.text, /^G2 open · Hand T1 from C1/);
  const before = w.gates();
  const second = await give("C3");
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.text, "G2 is open already: it asks to hand T1 to C2 (codex). A task has one open takeover question at a time: answer G2 first (or undo your board answer to it), then give T1 again. Nothing changed.");
  assert.equal(w.gates(), before, "no second takeover question");
  assert.match((await give("C2")).json.text, /^G2 is open already · /, "the same give names the same question");
  claude.sage(["gate", "answer", "G2", "--option", "1", "--via", "board", "--project", w.project], w.env);
  assert.equal((await give("C3")).status, 409, "a board answer that waits for pickup still holds the task");
  claude.sage(["gate", "undo", "G2", "--project", w.project], w.env);
  claude.sage(["gate", "answer", "G2", "--option", "2", "--via", "chat", "--project", w.project], w.env);
  assert.match((await give("C3")).json.text, /^G3 open · Hand T1 from C1 \(claude\) to C3 \(claude\)\?/, "after the decline, the task can be given again");
});

const LOCAL_PATH = /(?:^|[\s(])~?\/(?:Users|home|private|tmp|var|Volumes)\//;
function holdLock(w) {
  const lock = join(w.dir, ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ pid: 424242, host: hostname(), machineId: "test-machine", boot: Date.now() - uptime() * 1000, start: 0, at: Date.now() }));
  return function moveAsideSoAWaitingWriteNeverMeetsAHalfDeletedLock() { renameSync(lock, `${lock}-released`); rmSync(`${lock}-released`, { recursive: true }); };
}

test("F-T1076-7: a question whose message file cannot be read opens without the message, and the board stays up", async t => {
  const w = await board(t);
  const fields = ["Where", "Approve", "Choice", "Default", "Due", "Next"].map(label => ({ t: "field", label, text: `Sample: ${label}.` }));
  const table = { t: "table", head: ["Answer", "Next", "Cost"], rows: [["yes", "The chief ships it.", "None."], ["no", "The chief waits.", "None."]], pick: 0 };
  writeFileSync(join(w.base, "message.json"), JSON.stringify({ kind: "question", title: "Ship the share sheet?", blocks: [...fields.slice(0, 3), table, ...fields.slice(3)] }));
  w.as("gate", "add", "T1", "--question", "Ship the share sheet?", "--options", "yes|no", "--recommend", "yes", "--message", join(w.base, "message.json"));
  const url = `/app/gate/${Buffer.from(`${w.logbook}/G2`).toString("base64url")}`;
  await waitFor(async () => (await call(w.port, url, { method: "GET" })).json?.message?.title === "Ship the share sheet?", "the question view has its message");
  renameSync(join(w.dir, "gates", "G2.json"), join(w.dir, "gates", "kept.json"));
  symlinkSync("kept.json", join(w.dir, "gates", "G2.json"));
  const linked = await call(w.port, url, { method: "GET" });
  assert.equal(linked.status, 200, linked.text);
  assert.deepEqual([linked.json.question, linked.json.message], ["Ship the share sheet?", null], "the question shows without the message that the board cannot open");
  assert.equal((await call(w.port, "/app/", { method: "GET" })).status, 200, "the board still serves pages");
});

test("F-T1076-12: a write whose body holds an object or an array is refused as a bad body, not blamed on the state folder", async t => {
  const w = await board(t), p = await pair(w), before = w.gates();
  for (const [path, body, headers] of [["pair", { code: { toString: 1 } }, w.own], ["undo", { logbook: w.logbook, gate: { toString: "G1" } }, p.headers], ["undo", { logbook: w.logbook, gate: ["G1"] }, p.headers], ["give", { logbook: w.logbook, task: "T1", to: ["C2"] }, p.headers]]) {
    const got = await call(w.port, `/api/${path}`, { headers, body });
    assert.equal(got.status, 400, `${path} ${JSON.stringify(body)}: ${got.text}`);
    assert.equal(got.text, "A write is one JSON object of strings and numbers, of at most 16 KiB.\n");
  }
  assert.equal(w.gates(), before, "nothing reached the logbook");
});

test("F-T1076-8: a pairing that cannot write paired.json keeps its code, so the same code pairs once the file is fixed", async t => {
  const w = await board(t);
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: (\S+)/.exec(lines.join("\n"))[1];
  writeFileSync(join(w.stateDir, "kept.json"), JSON.stringify({ browsers: [] }));
  symlinkSync("kept.json", join(w.stateDir, "paired.json"));
  const failed = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(failed.status, 500, failed.text);
  assert.match(failed.json.problem, /so nothing changed\./);
  rmSync(join(w.stateDir, "paired.json"));
  const again = await call(w.port, "/api/pair", { headers: w.own, body: { code } });
  assert.equal(again.status, 200, `the code still works, as the refusal said: ${again.text}`);
});

test("F-T1076-11: a busy logbook and an unexpected state tool error reach the board with no stack trace and no local path", async t => {
  const w = await board(t), p = await pair(w);
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const answer = () => call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  const free = holdLock(w);
  const busy = await answer();
  free();
  assert.equal(busy.status, 409, busy.text);
  assert.match(busy.json.text, /^the logbook is busy: .* remove …\/\.lock first\.$/);
  assert.doesNotMatch(busy.text, LOCAL_PATH);
  assert.equal((await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G9", option: 1, digest: need.digest } })).json.text, "no gate G9. The latest: G1.", "a refusal comes through as the state tool says it");
  if (process.getuid?.() === 0) return t.skip("root writes into any folder");
  chmodSync(w.dir, 0o500);
  const broken = await answer().finally(() => chmodSync(w.dir, 0o700));
  assert.equal(broken.status, 202, `F-T1076-16: the board cannot say whether the write landed, so it does not answer as a refusal (which the page shows as "Not recorded."): ${broken.text}`);
  assert.equal(broken.json.pending, true, "F-T1076-16: the page shows it as a note that the write may have landed");
  assert.equal(broken.json.text, "The logbook write stopped with an unexpected error, so the board cannot say whether it landed. Reload the board to see it before you try again.");
  assert.doesNotMatch(broken.json.text, /\n\s+at |\.mjs:\d+/, "no stack trace");
  assert.doesNotMatch(broken.json.text, LOCAL_PATH);
});

test("F-T1076-21: no full local path leaves the board after a colon, in a file URL or with spaces in a folder name; a web address and an owner/repo name stay", () => {
  const cases = [
    ["remove /Users/sample/work/.lock first.", "remove …/.lock first."],
    ["path:/Users/sample/work/logbook", "path:…/logbook"],
    ["see file:///Users/sample/work/plan.md now", "see file:…/plan.md now"],
    ["held /Users/sample/My Big Folder/logbook/.lock for 1.2 s.", "held …/.lock for 1.2 s."],
    ["no checkout at ~/My Projects/app here", "no checkout at …/app here"],
    ["open http://127.0.0.1:43124/pages/T1/plan.html for sample-owner/sage", "open http://127.0.0.1:43124/pages/T1/plan.html for sample-owner/sage"],
  ];
  for (const [text, shown] of cases) {
    assert.equal(withoutPaths(text), shown, text);
    assert.doesNotMatch(withoutPaths(text), /(?:Users|My Projects)\//, text);
  }
});

test("F-T1076-9: about 12 KiB of other apps' cookies for 127.0.0.1 do not stop the board's reads or writes", async t => {
  const w = await board(t), p = await pair(w);
  const cookies = [0, 1, 2].map(i => `sample_auth.${i}=${"a".repeat(4000)}`).concat(p.cookie).join("; ");
  assert.ok(cookies.length > 12_000, `${cookies.length} bytes of cookies`);
  for (const [path, status] of [["/app/", 200], ["/", 302]]) assert.equal((await call(w.port, path, { method: "GET", headers: { Cookie: cookies } })).status, status, `GET ${path}`);
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const answered = await call(w.port, "/api/answer", { headers: { ...p.headers, Cookie: cookies }, body: { logbook: w.logbook, gate: "G1", option: 1, digest: need.digest } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "yes", "the answer landed");
});

test("F-T1076-2: closing the board waits for a write that the board stopped waiting for, so the write ends before the board does", async t => {
  const w = await board(t, { write: job => writeInWorker(job, { timeout: 0 }) }), p = await pair(w);
  const open = await needs(w), need = open.needs.find(item => item.gate === "G1");
  const free = holdLock(w);
  const sent = await call(w.port, "/api/answer", { headers: p.headers, body: { logbook: w.logbook, gate: "G1", option: 2, digest: need.digest } });
  assert.equal(sent.status, 202, sent.text);
  const closing = w.server.close();
  await new Promise(wake => setTimeout(wake, 300));
  assert.equal(w.gate("G1").answered ?? "", "", "the write waits for the logbook lock");
  free();
  await closing;
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no", "the board closed only after its open write ended");
});
