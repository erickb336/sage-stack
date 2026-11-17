import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const helper = () => import("./browser-prerequisite.mjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "browser-prerequisite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "chromium_headless_shell-1193"), executable = join(directory, "chrome-headless-shell"), marker = join(directory, "INSTALLATION_COMPLETE");
  const calls = [];
  const data = { pin: "1.55.1", version: "1.55.1", coreVersion: "1.55.1", coreDependency: "1.55.1", directory, executable, marker, cli: join(root, "cli.js"), chromium: { launch: async options => { calls.push(options); return { close: async () => calls.push("closed") }; } } };
  const complete = () => { mkdirSync(directory, { recursive: true }); writeFileSync(executable, "fixture only"); chmodSync(executable, 0o755); writeFileSync(marker, ""); };
  return { root, data, complete, calls, load: () => data };
}

test("every browser test checks the shared prerequisite before it can start a board", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const files = pkg.scripts["test:browser"].split(/\s+/).filter(word => word.endsWith("-browser.test.mjs"));
  assert.equal(files.length, 14);
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(/const chromium = requireBrowser\(\);/.test(source), file);
    assert.ok(!/BOARD_BROWSER_PATH|from "playwright"|require\("playwright"\)/.test(source), file);
    assert.ok(source.indexOf("const chromium = requireBrowser();") < source.indexOf(".start()"), file);
  }
  assert.match(pkg.scripts["test:browser"], /browser-prerequisite\.mjs check/);
});

test("installed pinned metadata selects its exact cache revision; all browser entries fail before a launch or listener", async t => {
  const f = fixture(t), root = new URL("../", import.meta.url).pathname;
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(f.root, "cache") };
  const metadata = `import { loadPinnedBrowser, requireBrowser } from './scripts/browser-prerequisite.mjs'; import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'; import { dirname } from 'node:path'; const data = loadPinnedBrowser(); console.log(JSON.stringify({ version: data.version, executable: data.executable, marker: data.marker })); mkdirSync(dirname(data.executable), { recursive: true }); writeFileSync(data.executable, 'synthetic fixture, never execute'); chmodSync(data.executable, 0o755); writeFileSync(data.marker, ''); requireBrowser();`;
  const healthy = spawnSync(process.execPath, ["--input-type=module", "-e", metadata], { cwd: root, env, encoding: "utf8" });
  assert.equal(healthy.status, 0, healthy.stderr);
  const seen = JSON.parse(healthy.stdout);
  assert.equal(seen.version, "1.55.1");
  assert.ok(seen.executable.startsWith(env.PLAYWRIGHT_BROWSERS_PATH));
  assert.match(seen.executable, /chromium_headless_shell-1193/);
  rmSync(env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of pkg.scripts["test:browser"].split(/\s+/).filter(word => word.endsWith("-browser.test.mjs"))) {
    const probe = `import net from 'node:net'; import { chromium } from 'playwright'; let browsers = 0, listeners = 0; chromium.launch = async () => { browsers++; throw new Error('unexpected browser'); }; net.Server.prototype.listen = function () { listeners++; throw new Error('unexpected listener'); }; try { await import(${JSON.stringify(`./${file}`)}); throw new Error('prerequisite did not fail'); } catch (error) { if (!String(error).includes('Browser prerequisite:')) throw error; } console.log(JSON.stringify({ browsers, listeners }));`;
    const failed = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: root, env, encoding: "utf8" });
    assert.equal(failed.status, 0, `${file}: ${failed.stderr}`);
    assert.deepEqual(JSON.parse(failed.stdout), { browsers: 0, listeners: 0 }, file);
  }
});

test("absent, partial and wrong-revision installations start neither browser nor board", async t => {
  const { requireBrowser } = await helper(), f = fixture(t);
  let boards = 0;
  const start = async () => { const browser = requireBrowser({ load: f.load, env: {} }); await browser.launch(); boards++; };
  await assert.rejects(start, /browser prerequisite/i);
  mkdirSync(f.data.directory); writeFileSync(f.data.executable, "partial"); chmodSync(f.data.executable, 0o755);
  await assert.rejects(start, /completion/i);
  rmSync(f.data.directory, { recursive: true });
  mkdirSync(join(f.root, "chromium_headless_shell-1208"));
  writeFileSync(join(f.root, "chromium_headless_shell-1208", "INSTALLATION_COMPLETE"), "");
  await assert.rejects(start, /browser prerequisite/i);
  assert.deepEqual([boards, f.calls.length], [0, 0]);
  f.complete();
  await start();
  assert.deepEqual([boards, f.calls.length], [1, 1]);
});

test("the pinned fixture launches with the calling environment and closes; overrides and package disagreement refuse", async t => {
  const { requireBrowser } = await helper(), f = fixture(t); f.complete();
  const env = { HOME: f.root, PLAYWRIGHT_BROWSERS_PATH: f.root };
  const browser = await requireBrowser({ load: f.load, env }).launch();
  try { assert.deepEqual(f.calls, [{ headless: true, env }]); } finally { await browser.close(); }
  assert.equal(f.calls.at(-1), "closed");
  assert.throws(() => requireBrowser({ load: f.load, env: { BOARD_BROWSER_PATH: f.data.executable } }), /BOARD_BROWSER_PATH/);
  for (const key of ["pin", "version", "coreVersion", "coreDependency"]) {
    const old = f.data[key]; f.data[key] = "1.56.0";
    assert.throws(() => requireBrowser({ load: f.load, env }), /1\.55\.1/);
    f.data[key] = old;
  }
  const ready = requireBrowser({ load: f.load, env });
  rmSync(f.data.executable);
  assert.throws(() => requireBrowser({ load: f.load, env }), /executable/i);
  f.complete();
  rmSync(f.data.marker);
  await assert.rejects(ready.launch(), /completion/i);
});

function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return { setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: time + ms, fn }); return key; }, clearTimeout(key) { timers.delete(key); },
    tick(ms) { const end = time + ms; for (;;) { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; timers.delete(next[0]); time = next[1].at; next[1].fn(); } time = end; } };
}
function child() {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough(); handle.stderr = new PassThrough(); handle.exitCode = null; handle.signalCode = null;
  handle.signals = []; handle.kill = signal => { handle.signals.push(signal); return true; };
  return handle;
}
async function setup(t, options = {}) {
  const { setupBrowser } = await helper(), f = fixture(t), handle = child(), timers = clock(), chunks = [];
  let invocation;
  const promise = setupBrowser({ load: f.load, env: { HOME: f.root }, spawn: (command, args, opts) => { invocation = { command, args, opts }; return handle; }, timers, deadlineMs: 100, cleanupMs: 20, output: (stream, text) => chunks.push([stream, text]), ...options });
  return { ...f, handle, timers, chunks, promise, invocation };
}

test("installer success waits for close and retains output after exit", async t => {
  const s = await setup(t); s.handle.emit("spawn"); s.complete();
  assert.deepEqual(s.invocation.args.slice(1), ["install", "--only-shell", "chromium"]);
  assert.match(s.invocation.opts.env.DEBUG, /pw:install/);
  s.handle.stdout.write("100%\n"); s.handle.emit("exit", 0, null);
  let settled = false; s.promise.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  s.handle.stderr.write("final diagnostic\n"); s.handle.emit("close", 0, null);
  const result = await s.promise;
  assert.equal(result.status, "complete"); assert.equal(result.cleanup, "closed"); assert.equal(result.descendants, "unknown");
  assert.deepEqual(result.exit, { code: 0, signal: null }); assert.deepEqual(result.close, { code: 0, signal: null });
  assert.equal(result.stdout, "100%\n"); assert.equal(result.stderr, "final diagnostic\n");
  assert.deepEqual(s.chunks, [["stdout", "100%\n"], ["stderr", "final diagnostic\n"]]);
  assert.deepEqual(s.handle.signals, []);
});

test("100 percent and a zero close do not replace the completion marker", async t => {
  const s = await setup(t); s.handle.emit("spawn"); s.handle.stdout.write("100%\n"); s.handle.emit("exit", 0, null); s.handle.emit("close", 0, null);
  const result = await s.promise;
  assert.equal(result.status, "incomplete"); assert.equal(result.stdout, "100%\n"); assert.match(result.error, /browser prerequisite/i);
});

test("spawn throws, spawn errors and nonzero exits retain distinct evidence", async t => {
  const first = await setup(t, { spawn: () => { throw new Error("cannot spawn"); } });
  const thrown = await first.promise;
  assert.equal(thrown.status, "spawn-error"); assert.equal(thrown.cleanup, "not-started");
  const second = await setup(t); second.handle.emit("error", new Error("ENOENT")); second.handle.emit("close", -2, null);
  const failed = await second.promise; assert.equal(failed.status, "spawn-error"); assert.match(failed.error, /ENOENT/); assert.equal(failed.cleanup, "closed");
  const third = await setup(t); third.handle.emit("spawn"); third.handle.stderr.write("download failed"); third.handle.emit("exit", 2, null); third.handle.emit("close", 2, null);
  const nonzero = await third.promise; assert.equal(nonzero.status, "failed"); assert.equal(nonzero.close.code, 2); assert.equal(nonzero.stderr, "download failed");
});

test("deadline and failed termination leave cleanup unknown after its bounded wait", async t => {
  for (const failure of [false, "throws", "false"]) {
    const s = await setup(t); s.handle.emit("spawn");
    if (failure) s.handle.kill = signal => { s.handle.signals.push(signal); if (failure === "throws") throw new Error("refused"); return false; };
    s.handle.stdout.write("100%\n"); s.timers.tick(100);
    assert.deepEqual(s.handle.signals, ["SIGTERM"]);
    let settled = false; s.promise.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    s.handle.stderr.write("last output\n"); s.timers.tick(20);
    const result = await s.promise; assert.equal(result.status, "deadline"); assert.equal(result.cleanup, "unknown"); assert.equal(result.close, null);
    assert.equal(result.termination.accepted, !failure); assert.equal(result.stderr, "last output\n");
    s.handle.stderr.write("late final output\n"); s.handle.emit("close", null, "SIGTERM");
    assert.deepEqual(s.chunks.at(-1), ["stderr", "late final output\n"]);
    assert.equal(result.cleanup, "unknown", "a returned unknown result never changes behind its reader");
    assert.equal(result.close, null);
  }
});

test("close during cleanup proves direct-child close only, and timeout remains failure", async t => {
  const s = await setup(t); s.handle.emit("spawn"); s.timers.tick(100);
  s.handle.emit("exit", null, "SIGTERM"); s.handle.stderr.write("closing\n"); s.handle.emit("close", null, "SIGTERM");
  const result = await s.promise;
  assert.equal(result.status, "deadline"); assert.equal(result.cleanup, "closed"); assert.equal(result.descendants, "unknown"); assert.equal(result.stderr, "closing\n");
});

test("an observed exit is never signaled while output waits for close", async t => {
  const s = await setup(t); s.handle.emit("spawn"); s.handle.emit("exit", 0, null); s.timers.tick(100);
  assert.deepEqual(s.handle.signals, []); s.timers.tick(20);
  const result = await s.promise; assert.equal(result.cleanup, "unknown"); assert.equal(result.exit.code, 0); assert.equal(result.termination.requested, false);
});
