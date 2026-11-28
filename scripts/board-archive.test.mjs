import "./test-env.mjs";
import { tname } from "./task-names.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { ownerWrite, writeInWorker } from "../plugins/sage/board/writes.mjs";
import { QUESTION } from "./fixtures/question-message.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function repository(base, name) {
  const path = join(base, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", `first commit of ${name}`], { env: gitEnv });
  return realpathSync(path);
}

async function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-archive-")));
  const saved = { ...process.env };
  t.after(() => {
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
  const own = { ...env };
  const lantern = repository(base, "lantern"), harbor = repository(base, "harbor"), meadow = repository(base, "meadow");
  claude.sage(["link", "--separate", "--project", lantern], own);
  const lanternDir = claude.storeDir(lantern, own);
  writeFileSync(join(lanternDir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${new Date().toISOString()}\n`);
  claude.sage(["task", "add", "--name", tname(), "--title", "Sample shared task", "--size", "small", "--priority", "P1", "--project", lantern, "--chief", "C1"], own);
  const inClaude = { ...own, SAGE_HOME: join(env.CLAUDE_CONFIG_DIR, "sage") }, inCodex = { ...own, SAGE_HOME: join(env.CODEX_HOME, "sage") };
  claude.sage(["init", "--project", harbor], inClaude);
  claude.sage(["task", "add", "--name", tname(), "--title", "Sample Claude task", "--size", "small", "--priority", "P2", "--project", harbor], inClaude);
  codex.sage(["init", "--project", meadow], inCodex);
  codex.sage(["task", "add", "--name", tname(), "--title", "Sample Codex task", "--size", "small", "--priority", "P2", "--project", meadow], inCodex);
  const dirs = { lantern: lanternDir, harbor: claude.storeDir(harbor, inClaude), meadow: codex.storeDir(meadow, inCodex) };
  for (const dir of Object.values(dirs)) assert.ok(existsSync(join(dir, "tasks.tsv")), `${dir} is a logbook`);
  const config = join(base, "home", ".config", "sage-board", "board.json");
  const sources = [{ id: "claude", label: "Claude", provider: "claude", path: join(env.CLAUDE_CONFIG_DIR, "sage") }, { id: "codex", label: "Codex", provider: "codex", path: join(env.CODEX_HOME, "sage") }, { id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }];
  const server = quietBoard({ sources, port: 0, app: APP, stateDir: join(base, "home", ".config", "sage-board", "state"), pairCommand: "node /sample/board/cli.mjs board --pair" }, { create: createBoardServer });
  t.after(() => server.close());
  const { port } = await server.start();
  await server.ready();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify(sources)], { output: () => {}, env });
  const origin = `http://127.0.0.1:${port}`, headers = { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
  return { base, env, own, inClaude, port, config, headers, dirs, sources, checkouts: { lantern, harbor, meadow } };
}

async function pair(w) {
  const lines = [];
  await runBoardCli(["board", "--pair", "--config", w.config], { output: line => lines.push(line), env: w.env, input: { isTTY: true } });
  const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))[1];
  const paired = await call(w.port, "/api/pair", { headers: w.headers, body: { code } });
  assert.equal(paired.status, 200, paired.text);
  return { ...w.headers, Cookie: paired.headers["set-cookie"][0].split(";")[0], "X-Sage-Token": paired.json.token };
}

function model(w) {
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
async function until(w, check, what) {
  let last;
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 100))) if (check(last = await model(w))) return last;
  assert.fail(`timed out: ${what}: ${JSON.stringify(last?.projects)}`);
}
const projectOf = (all, name) => all.projects.find(project => project.name === name);
const configOf = dir => existsSync(join(dir, "config.json")) ? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) : {};
const archiveRows = dir => claude.read(dir, "decisions").filter(row => !row.task).map(row => row.decision);

test("T1137: a paired browser archives and restores a shared, a Claude-only and a Codex-only project, and each write lands only in that project's own logbook", async t => {
  const w = await world(t), headers = await pair(w), names = Object.keys(w.dirs);
  let all = await until(w, all => names.every(name => projectOf(all, name)), "the board shows the three projects");
  for (const name of names) {
    const key = projectOf(all, name).key, others = names.filter(other => other !== name);
    const archived = await call(w.port, "/api/archive", { headers, body: { project: key } });
    assert.equal(archived.status, 200, archived.text);
    assert.equal(archived.json.ok, true);
    assert.match(archived.json.text, /^Archived: the project starts no agent and merges nothing/);
    assert.equal(configOf(w.dirs[name]).archived, true, `${name} is archived in its own logbook`);
    assert.deepEqual(archiveRows(w.dirs[name]), ["project archived"]);
    for (const other of others) assert.equal(configOf(w.dirs[other]).archived, undefined, `archiving ${name} leaves ${other} alone`);
    all = await until(w, all => projectOf(all, name).archived, `${name} shows archived`);
    assert.equal(projectOf(all, name).list, "archived");
    assert.ok(Date.parse(projectOf(all, name).archivedAt) > 0, "the board reads the archive date from the decisions row");
    assert.equal(projectOf(all, name).welcome, null);
    assert.deepEqual(projectOf(all, name).kept, { tasks: 1, milestones: 0, findings: 0, answers: 0 });
    assert.equal(projectOf(all, name).archives, 1, "the board counts each archive, so each restore has its own Welcome back");

    const restored = await call(w.port, "/api/restore", { headers, body: { project: key } });
    assert.equal(restored.status, 200, restored.text);
    assert.match(restored.json.text, /^Restored: the project takes new tasks and runs/);
    assert.equal(configOf(w.dirs[name]).archived, undefined);
    assert.deepEqual(archiveRows(w.dirs[name]), ["project archived", "project restored"]);
    all = await until(w, all => !projectOf(all, name).archived && projectOf(all, name).welcome, `${name} shows restored`);
    assert.ok(Date.parse(projectOf(all, name).welcome) >= Date.parse(projectOf(all, name).archivedAt), "Welcome back names the restore, after the archive");
  }
});

test("T1137: an unpaired browser, a page without the token and another origin cannot archive; nothing changes", async t => {
  const w = await world(t), headers = await pair(w);
  const all = await until(w, all => projectOf(all, "harbor"), "the board shows harbor"), body = { project: projectOf(all, "harbor").key };
  const refused = [
    [await call(w.port, "/api/archive", { headers: w.headers, body }), 401],
    [await call(w.port, "/api/archive", { headers: { ...headers, "X-Sage-Token": "0".repeat(43) }, body }), 403],
    [await call(w.port, "/api/archive", { headers: { ...headers, Origin: "http://127.0.0.1:1" }, body }), 403],
    [await call(w.port, "/api/archive", { headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body }), 403],
  ];
  for (const [reply, status] of refused) assert.equal(reply.status, status, reply.text);
  assert.equal(configOf(w.dirs.harbor).archived, undefined);
  assert.deepEqual(archiveRows(w.dirs.harbor), []);
});

test("T1137: a write names a project of the board, never a logbook or a path: an unknown project, a logbook key or a path is refused", async t => {
  const w = await world(t), headers = await pair(w);
  await until(w, all => projectOf(all, "harbor"), "the board shows harbor");
  for (const project of ["nope", `claude/${basename(w.dirs.harbor)}`, w.checkouts.harbor, "constructor", 7]) {
    const reply = await call(w.port, "/api/archive", { headers, body: { project } });
    assert.equal(reply.status, 400, `${project}: ${reply.text}`);
    assert.match(reply.json.problem, /names no project of this board/);
  }
  for (const dir of Object.values(w.dirs)) assert.equal(configOf(dir).archived, undefined);
});

test("T1137: a provider write reaches only the logbook that its checkout locates: another checkout, a link, a moved copy and any other command are refused", async t => {
  const w = await world(t), shared = w.env.SAGE_SHARED_HOME, claudeRoot = join(w.env.CLAUDE_CONFIG_DIR, "sage");
  const write = (folder, argv = ["config", "archived=yes"], root = claudeRoot) => ownerWrite({ shared, folder, argv, root }, w.env);
  const harbor = basename(w.dirs.harbor);

  for (const argv of [["config", "archived=yes", "start=sage-mode"], ["config", "start=sage-mode"], ["gate", "answer", "G1", "--option", "1"], ["config", "archived=maybe"], ["config", "max_agents=99"]]) {
    const done = write(harbor, argv);
    assert.equal(done.code, 1, argv.join(" "));
    assert.match(done.text, /only the owner's commands|only to archive or restore/);
  }

  const UNNAMED = /^This logbook does not name its checkout, so the board cannot check that the write reaches this project's own logbook\. Ask the chief in this project's own chat to archive it\.$/;
  const OTHER = /^The checkout that this logbook names uses another logbook now, so the board does not write this one\./;
  const stray = join(claudeRoot, "stray-abc123");
  mkdirSync(stray);
  writeFileSync(join(stray, "tasks.tsv"), "id\ttitle\n");
  writeFileSync(join(stray, "checkout.txt"), `${w.checkouts.harbor}\n`);
  assert.match(write("stray-abc123").text, OTHER, "a folder whose checkout locates another logbook is refused, and the refusal says so");
  assert.equal(configOf(w.dirs.harbor).archived, undefined, "the other project's logbook stays as it was");
  assert.equal(existsSync(join(stray, "config.json")), false);

  rmSync(join(stray, "checkout.txt"));
  symlinkSync(join(w.dirs.harbor, "checkout.txt"), join(stray, "checkout.txt"));
  assert.match(write("stray-abc123").text, UNNAMED, "a checkout.txt that is a link is refused");

  assert.match(write(harbor, ["config", "archived=yes"], join(w.env.CODEX_HOME, "sage")).text, UNNAMED, "the folder of a Claude logbook under the Codex root is refused");
  assert.match(write(basename(w.dirs.lantern)).text, UNNAMED, "a shared project's folder under a provider root is refused");

  writeFileSync(join(w.dirs.harbor, "moved.json"), "{}\n");
  assert.match(write(harbor).text, OTHER, "a logbook that moved to the shared root is an old copy, and the board does not write it");
  rmSync(join(w.dirs.harbor, "moved.json"));
  assert.equal(configOf(w.dirs.harbor).archived, undefined);

  const done = write(harbor);
  assert.equal(done.code, 0, done.text);
  assert.equal(configOf(w.dirs.harbor).archived, true);
});

test("T1137: Welcome back ends when a run starts after the restore", async t => {
  const w = await world(t), headers = await pair(w);
  let all = await until(w, all => projectOf(all, "harbor"), "the board shows harbor");
  const key = projectOf(all, "harbor").key;
  assert.equal(projectOf(all, "harbor").welcome, null, "a project that was never archived has no Welcome back");
  assert.equal((await call(w.port, "/api/archive", { headers, body: { project: key } })).status, 200);
  assert.equal((await call(w.port, "/api/restore", { headers, body: { project: key } })).status, 200);
  all = await until(w, all => projectOf(all, "harbor").welcome, "Welcome back shows");
  claude.sage(["run", "add", "T1", "--role", "implementer", "--branch", "sage/t1-sample", "--project", w.checkouts.harbor], w.inClaude);
  all = await until(w, all => projectOf(all, "harbor").welcome === null, "Welcome back ends");
  assert.ok(projectOf(all, "harbor").archivedAt);
});

test("T1137: a project with a Claude and a Codex logbook archives in both; when one refuses, the reply names the part that landed", async t => {
  const w = await world(t), headers = await pair(w);
  claude.sage(["init", "--project", w.checkouts.meadow], w.inClaude);
  const twin = claude.storeDir(w.checkouts.meadow, w.inClaude);
  let all = await until(w, all => projectOf(all, "meadow")?.books.length === 2, "meadow shows two logbooks");
  const key = projectOf(all, "meadow").key;
  const archived = await call(w.port, "/api/archive", { headers, body: { project: key } });
  assert.equal(archived.status, 200, archived.text);
  assert.deepEqual([configOf(twin).archived, configOf(w.dirs.meadow).archived], [true, true]);
  all = await until(w, all => projectOf(all, "meadow").archived, "meadow shows archived");

  rmSync(join(w.dirs.meadow, "config.json"));
  mkdirSync(join(w.dirs.meadow, "config.json"));
  writeFileSync(join(twin, "config.json"), "{}\n");
  const partial = await call(w.port, "/api/archive", { headers, body: { project: key } });
  assert.equal(partial.status, 409, partial.text);
  assert.deepEqual([partial.json.ok, partial.json.landed, partial.json.logbooks, partial.json.failed], [false, 1, 2, ["Codex"]], "F-T1137-7: the reply names the logbook that did not save");
  assert.match(partial.json.text, /not a regular file/);
  assert.equal(configOf(twin).archived, true, "the Claude logbook landed");
});

test("F-T1137-2: a provider logbook without checkout.txt is refused with its true cause and the chat route; a checkout that is gone keeps the old text", async t => {
  const w = await world(t), headers = await pair(w), shared = w.env.SAGE_SHARED_HOME, claudeRoot = join(w.env.CLAUDE_CONFIG_DIR, "sage"), harbor = basename(w.dirs.harbor);
  const told = readFileSync(join(w.dirs.harbor, "checkout.txt"), "utf8");
  rmSync(join(w.dirs.harbor, "checkout.txt"));
  const all = await until(w, all => projectOf(all, "harbor"), "the board shows harbor"), key = projectOf(all, "harbor").key;
  const refused = await call(w.port, "/api/archive", { headers, body: { project: key } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.text, "This logbook does not name its checkout, so the board cannot check that the write reaches this project's own logbook. Ask the chief in this project's own chat to archive it.");
  assert.doesNotMatch(refused.json.text, /No checkout of this project is on this Mac/, "the checkout is on this Mac: only the logbook does not name it");
  assert.equal(configOf(w.dirs.harbor).archived, undefined, "the refusal stays: nothing changed");
  assert.match(ownerWrite({ shared, folder: harbor, argv: ["config", "archived=no"], root: claudeRoot }, w.env).text, /Ask the chief in this project's own chat to restore it\.$/, "a restore names the restore");

  writeFileSync(join(w.dirs.harbor, "checkout.txt"), `${join(w.base, "gone")}\n`);
  assert.equal(ownerWrite({ shared, folder: harbor, argv: ["config", "archived=yes"], root: claudeRoot }, w.env).text,
    "No checkout of this project is on this Mac, so the board cannot write its logbook. Ask the chief in this project's own chat to archive it.", "a checkout that is gone keeps the old text, where it is true");
  writeFileSync(join(w.dirs.harbor, "checkout.txt"), told);
  assert.equal((await call(w.port, "/api/archive", { headers, body: { project: key } })).status, 200, "with its checkout.txt back, the board archives harbor");
});

test("T1152: a Claude or Codex logbook without checkout.txt can be archived on the board after one normal write of the chief", async t => {
  const w = await world(t), headers = await pair(w), inCodex = { ...w.own, SAGE_HOME: join(w.env.CODEX_HOME, "sage") };
  const gate = project => ["gate", "add", "--message", QUESTION, "T1", "--question", "Keep the sample format?", "--options", "keep|drop", "--recommend", "keep", "--project", project];
  for (const [name, sage, env] of [["harbor", claude.sage, w.inClaude], ["meadow", codex.sage, inCodex]]) {
    rmSync(join(w.dirs[name], "checkout.txt"));
    const key = projectOf(await until(w, all => projectOf(all, name), `the board shows ${name}`), name).key;
    assert.equal((await call(w.port, "/api/archive", { headers, body: { project: key } })).status, 409, `${name} without checkout.txt is refused`);
    sage(gate(w.checkouts[name]), env);
    const archived = await call(w.port, "/api/archive", { headers, body: { project: key } });
    assert.equal(archived.status, 200, `${name}: ${archived.text}`);
    assert.equal(configOf(w.dirs[name]).archived, true, `the board archived ${name}`);
  }
});

test("F-T1137-12: the server records no answer or other write for an archived project, and records it again after Restore", async t => {
  const w = await world(t), headers = await pair(w);
  claude.sage(["gate", "add", "--message", QUESTION, "T1", "--question", "Keep the sample format?", "--options", "keep|drop", "--recommend", "keep", "--project", w.checkouts.lantern, "--chief", "C1"], w.own);
  let all = await until(w, all => all.needs?.some(need => need.gate === "G1" && need.digest), "the board shows G1");
  const key = projectOf(all, "lantern").key, need = all.needs.find(item => item.gate === "G1");
  const body = { logbook: need.logbook, gate: "G1", option: 1, digest: need.digest };
  assert.equal((await call(w.port, "/api/archive", { headers, body: { project: key } })).status, 200);
  await until(w, all => projectOf(all, "lantern").archived, "lantern shows archived");
  const gates = () => readFileSync(join(w.dirs.lantern, "gates.tsv"), "utf8");
  const before = gates();
  for (const [job, write] of [["answer", body], ["undo", { logbook: need.logbook, gate: "G1" }], ["name", { logbook: need.logbook, chief: "C1", name: "Sample" }]]) {
    const refused = await call(w.port, `/api/${job}`, { headers, body: write });
    assert.equal(refused.status, 409, `${job}: ${refused.text}`);
    assert.equal(refused.json.text, "lantern is archived, so the board records no answer or other write for it. Restore it first, then try again. Nothing changed.");
  }
  assert.equal(gates(), before, "the answer did not reach the logbook");
  assert.equal((await call(w.port, "/api/restore", { headers, body: { project: key } })).status, 200);
  await until(w, all => !projectOf(all, "lantern").archived, "lantern shows restored");
  const answered = await call(w.port, "/api/answer", { headers, body });
  assert.equal(answered.status, 200, answered.text);
});

test("F-T1159-35: an Archive and a Restore sent at once, as from two tabs, run one after the other, so both logbooks of the project agree", async t => {
  const w = await world(t), headers = await pair(w);
  claude.sage(["init", "--project", w.checkouts.meadow], w.inClaude);
  const twin = claude.storeDir(w.checkouts.meadow, w.inClaude);
  const key = projectOf(await until(w, all => projectOf(all, "meadow")?.books.length === 2, "meadow shows two logbooks"), "meadow").key;
  const steps = [];
  const write = async job => {
    steps.push(`${job.argv[1]} starts`);
    await new Promise(wake => setTimeout(wake, 100));
    const done = await writeInWorker(job);
    steps.push(`${job.argv[1]} ends`);
    return done;
  };
  const second = quietBoard({ sources: w.sources, port: 0, app: APP, stateDir: join(w.base, "home", ".config", "sage-board", "state"), pairCommand: "node /sample/board/cli.mjs board --pair", write }, { create: createBoardServer });
  t.after(() => second.close());
  const { port } = await second.start(), tab = { ...headers, Origin: `http://127.0.0.1:${port}` };
  await second.ready();
  await until({ port }, all => projectOf(all, "meadow")?.books.length === 2, "the second server shows two logbooks");
  const [archived, restored] = await Promise.all([call(port, "/api/archive", { headers: tab, body: { project: key } }), call(port, "/api/restore", { headers: tab, body: { project: key } })]);
  assert.deepEqual([archived.status, restored.status], [200, 200], `${archived.text} ${restored.text}`);
  const first = steps[0].split(" ")[0], last = first === "archived=yes" ? "archived=no" : "archived=yes", group = verb => [`${verb} starts`, `${verb} ends`, `${verb} starts`, `${verb} ends`];
  assert.deepEqual(steps, [...group(first), ...group(last)], "the second write starts only after the first one wrote both logbooks, whichever arrived first");
  const shown = last === "archived=yes";
  assert.deepEqual([!!configOf(twin).archived, !!configOf(w.dirs.meadow).archived], [shown, shown], "both logbooks agree, on the write that came second");
  const rows = last === "archived=yes" ? ["project restored", "project archived"] : ["project archived", "project restored"];
  assert.deepEqual([archiveRows(twin).slice(-2), archiveRows(w.dirs.meadow).slice(-2)], [rows, rows], "each logbook recorded both writes in the same order");
});
