import "./test-env.mjs";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateTool } from "../packages/sage-core/index.mjs";
import { createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "logbooks"), config = join(dir, "settings/board.json");
  const tool = createStateTool({ defaultRoot: () => root });
  tool.sage(["init", "--project", dir], { ...process.env, SAGE_HOME: root });
  tool.sage(["task", "add", "--priority", "P2", "--title", "Sample CLI task", "--size", "small", "--project", dir], { ...process.env, SAGE_HOME: root });
  const value = createBoardConfig(config, { sources: [{ id: "sample", path: root }] });
  return { dir, root, config, value };
}
test("T229, T1053: standalone config has no secret, no password and no allowed hosts, private mode and no logbook output path", t => {
  const { config, root, value } = fixture(t);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(config, "utf8"))).sort(), ["port", "sources", "version"]);
  assert.throws(() => createBoardConfig(join(root, "low-port.json"), { sources: [{ id: "sample", path: root }], port: 1023 }), /1024 to 65535/);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(readBoardConfig(config), value);
  assert.throws(() => createBoardConfig(join(root, "settings.json"), { sources: [{ id: "sample", path: root }] }), /outside logbook roots/);
  assert.throws(() => createBoardConfig(config, { sources: [{ id: "sample", path: root }] }), /exists, and setup does not change it/);
});
test("T395, T1079: setup on an existing config names the file and the command that moves the board, and leaves the file as it was", async t => {
  const { config } = fixture(t), before = readFileSync(config, "utf8");
  const cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  await assert.rejects(runBoardCli(["board", "--setup", "--config", config, "--port", "43200"], { output: () => {} }), {
    message: `the board config ${config} exists, and setup does not change it. To move the board to another port, run node ${cli} board --port <port> --config ${config}. To change another setting, first run node ${cli} board --stop --config ${config}, then edit that file, then ask for the board again. To set the board up again, remove the file first.`,
  });
  assert.equal(readFileSync(config, "utf8"), before);
});
test("T395, T1053: setup with --config prints the start command with that --config, also when it is the default path of this HOME", async t => {
  const { dir, root } = fixture(t), home = join(dir, "home"), config = join(home, ".config/sage-board/board.json"), lines = [];
  const cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  await runBoardCli(["board", "--setup", "--config", config, "--sources", JSON.stringify([{ id: "sample", path: root }])], { output: line => lines.push(line), env: { HOME: home } });
  assert.deepEqual(lines, [`Board config created: ${config}. Start the board with node ${cli} board --ensure --config ${config}`]);
});
test("T770: the HTML file export is gone: --html, --out and --pages say so, a config with the old pagesDir still loads, and status needs no server", async t => {
  const { dir, root, config } = fixture(t), lines = [];
  for (const args of [["board", "all", "--html", "--config", config], ["board", "all", "--out", join(dir, "board.html"), "--config", config], ["board", "--setup", "--config", join(dir, "new.json"), "--pages", join(dir, "pages")]]) {
    const option = args.find(arg => ["--html", "--out", "--pages"].includes(arg));
    await assert.rejects(runBoardCli(args, { output: () => {} }), { message: `${option} is gone: the board has no HTML file export. Open the board in the browser, or ask for the board in the chat.` });
  }
  assert.equal(existsSync(join(dir, "board.html")) || existsSync(join(dir, "new.json")) || existsSync(join(dir, "pages")), false);
  const old = join(dir, "old.json");
  writeFileSync(old, JSON.stringify({ version: 1, sources: [{ id: "sample", path: root }], pagesDir: join(dir, "pages") }), { mode: 0o600 });
  assert.deepEqual(Object.keys(readBoardConfig(old)).sort(), ["port", "sources", "version"], "the old export folder is dropped on load");
  await runBoardCli(["board", "all", "--status", "--config", config], { output: line => lines.push(line) });
  assert.ok(lines[0].includes("framed 1"));
  await assert.rejects(runBoardCli(["board", "--config", config, "--config", config]), /repeated/);
});

test("standalone setup and installation stay explicit, with no service operation", async t => {
  const { dir, root } = fixture(t), config = join(dir, "extra/board.json"), lines = [];
  await runBoardCli(["board", "--setup", "--config", config, "--sources", JSON.stringify([{ id: "sample", path: root }])], { output: line => lines.push(line) });
  assert.deepEqual(lines, [`Board config created: ${config}. Start the board with node ${fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url))} board --ensure --config ${config}`]);
  const install = join(dir, "installed"), plist = join(dir, "login/board.plist");
  await assert.rejects(runBoardCli(["board", "--install", "--install-dir", install, "--login-file", join(root, "board.plist"), "--config", config]), /outside logbook roots/);
  assert.equal(existsSync(install), false);
  const bin = join(dir, "bin"), stableNode = join(bin, "node"), savedPath = process.env.PATH;
  mkdirSync(bin); symlinkSync(process.execPath, stableNode);
  process.env.PATH = join(dir, "empty-bin");
  try {
    await assert.rejects(runBoardCli(["board", "--install", "--install-dir", install, "--login-file", plist, "--config", config]), /upgrade-stable Node/);
    process.env.PATH = bin;
    await runBoardCli(["board", "--install", "--install-dir", install, "--login-file", plist, "--config", config], { output: line => lines.push(line) });
  } finally { process.env.PATH = savedPath; }
  assert.ok(readFileSync(join(install, "packages/sage-board/cli.mjs"), "utf8").includes("runBoardCli"));
  assert.ok(readFileSync(plist, "utf8").includes("dev.sage.board"));
  assert.ok(readFileSync(plist, "utf8").includes(`<string>${stableNode}</string>`));
  const installed = spawnSync(process.execPath, [join(install, "packages/sage-board/cli.mjs"), "board", "all", "--status", "--config", config], { cwd: dir, env: process.env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes("framed 1"));
});


test("malformed settings and setup JSON never expose input in diagnostics", async t => {
  const { dir } = fixture(t), malformed = join(dir, "bad.json"), privateText = "SAMPLE_SECRET_DO_NOT_LOG";
  writeFileSync(malformed, privateText);
  assert.throws(() => readBoardConfig(malformed), error => error.message === "board JSON is invalid" && !error.message.includes(privateText));
  await assert.rejects(runBoardCli(["board", "--setup", "--config", join(dir, "unused.json"), "--sources", privateText]), { message: "board JSON is invalid" });
  assert.equal(existsSync(join(dir, "unused.json")), false);
});


test("settings reads reject linked ancestors and service commands reject ignored task scope", async t => {
  const { dir, config } = fixture(t), link = join(dir, "settings-link");
  symlinkSync(join(dir, "settings"), link);
  assert.throws(() => readBoardConfig(join(link, "board.json")), /ordinary directory/);
  await assert.rejects(runBoardCli(["board", "--serve", "--scope", "sample/project", "--config", config]), /only for a task lookup/);
});


test("standalone current-checkout board and task commands work without explicit project", t => {
  const { dir, config } = fixture(t), cli = fileURLToPath(new URL("../packages/sage-board/cli.mjs", import.meta.url));
  for (const scope of ["this", "T1"]) {
    const result = spawnSync(process.execPath, [cli, "board", scope, "--config", config], { cwd: dir, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("Sample CLI task"));
    if (scope === "T1") assert.ok(result.stdout.includes("**Brief**"));
  }
});

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}
const get = (port, host) => new Promise((accept, reject) => {
  const req = request({ host: "127.0.0.1", port, path: "/", agent: false, headers: { Host: host } }, response => {
    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
    response.on("end", () => accept({ status: response.statusCode, location: response.headers.location, body }));
  });
  req.on("error", reject); req.end();
});

test("T229, T1053: a config with the keys of the old phone access still loads and starts the board, which ignores them", async t => {
  const { dir, root } = fixture(t), config = join(dir, "old/board.json"), port = await freePort();
  mkdirSync(join(dir, "old"));
  const password = { scheme: "scrypt", N: 32768, r: 8, p: 1, salt: "c2FtcGxlLXNhbHQtc2FtcGxl", hash: "not-a-valid-hash" };
  writeFileSync(config, JSON.stringify({ version: 1, sources: [{ id: "sample", path: root }], port, allowedHosts: ["sample.tailnet.ts.net"], secret: "sampleOldSecretSampleOldSecretSampleOldSecr", password }), { mode: 0o600 });
  assert.deepEqual(Object.keys(readBoardConfig(config)).sort(), ["port", "sources", "version"], "the old keys are dropped on load, so no server gets them");
  const lines = [];
  await runBoardCli(["board", "all", "--status", "--config", config], { output: line => lines.push(line) });
  assert.ok(lines[0].includes("framed 1"));
  const server = await runBoardCli(["board", "--serve", "--config", config], { output: line => lines.push(line) });
  t.after(() => server.close());
  assert.equal(lines.at(-1), `Sage board: http://127.0.0.1:${port}/ · only on this Mac.`);
  const page = await get(port, `127.0.0.1:${port}`);
  assert.deepEqual([page.status, page.location], [302, "/app/"], "the board's address opens the app");
  assert.equal((await get(port, "sample.tailnet.ts.net")).status, 403, "the old allowed host gets nothing");
});

test("T1053, F-T1065-24: board --set-password and --allowed-hosts are gone, and the answer says so", async t => {
  const { dir, config } = fixture(t);
  await assert.rejects(runBoardCli(["board", "--set-password", "--config", config], { output: () => {} }), { message: "--set-password is gone: the board is for a browser on this Mac only, with no password and no other host." });
  await assert.rejects(runBoardCli(["board", "--setup", "--config", join(dir, "new.json"), "--allowed-hosts", "[]"], { output: () => {} }), { message: "--allowed-hosts is gone: the board is for a browser on this Mac only, with no password and no other host." });
  await assert.rejects(runBoardCli(["board", "--config", config, "--tunnel"], { output: () => {} }), { message: "unknown or repeated board option" });
  await assert.rejects(runBoardCli(["boards"], { output: () => {} }), { message: /--ensure\|--stop\|--setup\|--serve\|--pair\|--install/ });
  assert.equal(existsSync(join(dir, "new.json")), false);
});

test("T1125: --link goes with --ensure only", async t => {
  const { config } = fixture(t);
  for (const other of [[], ["--stop"], ["--status"], ["--pair"], ["--setup"]]) {
    await assert.rejects(runBoardCli(["board", ...other, "--link", "--config", config], { output: () => {}, input: { isTTY: true } }), { message: "--link goes with --ensure only" }, other.join(" "));
  }
});
