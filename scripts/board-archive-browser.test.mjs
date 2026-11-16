import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const PROJECTS = ["harbor", "orchard", "quarry", "summit", "tundra", "valley", "willow"];
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const { port } = socket.address();
  await new Promise(accept => socket.close(accept));
  return port;
}

function repository(base, name) {
  const path = join(base, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", `first commit of ${name}`], { env: gitEnv });
  return realpathSync(path);
}

async function openBoard(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-archive-browser-")));
  const saved = { ...process.env };
  const fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const lantern = repository(base, "lantern");
  claude.sage(["link", "--separate", "--project", lantern], env);
  const dir = claude.storeDir(lantern, env);
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${new Date().toISOString()}\n`);
  const as = (...args) => claude.sage([...args, "--project", lantern, "--chief", "C1"], env);
  as("task", "add", "--title", "Sample import recipes", "--size", "small", "--priority", "P1");
  as("task", "T1", "set", "pr=12", "branch=sage/t1-import");
  as("task", "add", "--title", "Sample print a recipe", "--size", "small", "--priority", "P2");
  as("gate", "add", "T1", "--question", "Keep the old export format?", "--options", "keep|drop", "--recommend", "keep");
  const inClaude = { ...env, SAGE_HOME: join(env.CLAUDE_CONFIG_DIR, "sage") }, dirs = { lantern: dir };
  for (const name of PROJECTS) {
    const path = repository(base, name);
    claude.sage(["init", "--project", path], inClaude);
    claude.sage(["task", "add", "--title", `Sample ${name} task`, "--size", "small", "--priority", "P2", "--project", path], inClaude);
    dirs[name] = claude.storeDir(path, inClaude);
  }
  const sources = [{ id: "claude", label: "Claude", provider: "claude", path: inClaude.SAGE_HOME }, { id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }];
  const config = join(base, "home", ".config", "sage-board", "board.json"), port = await freePort();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify(sources)], { output: () => {}, env });
  const stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = createBoardServer({ sources, port, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair" });
  await server.start();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", timezoneId: "America/New_York" });
  t.after(async () => {
    await context.close(); await server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, problems = [];
  await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  const code = async () => {
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env, input: { isTTY: true } });
    return /Pairing code: (\S+)/.exec(lines.join("\n"))[1];
  };
  const shot = async name => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
  const archived = name => existsSync(join(dirs[name], "config.json")) && JSON.parse(readFileSync(join(dirs[name], "config.json"), "utf8")).archived === true;
  return { page, origin, dirs, stateDir, code, shot, archived, problems };
}

const picker = page => page.locator("header .picker");
async function pick(page, name) {
  if (!await page.locator(".pick-menu").count()) await picker(page).click();
  const row = page.locator(".pick-menu .pick-row", { has: page.locator(`b:text-is("${name}")`) });
  await row.hover();
  return row;
}

test("T1137: Archive from the picker asks first, names what the logbook keeps and what still runs; the banner, Undo, Restore and Welcome back follow; the picker finds a project", async t => {
  const w = await openBoard(t), { page } = w;
  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.lantern)}`);
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();

  await picker(page).click();
  const find = page.getByRole("searchbox", { name: "Find a project" });
  await find.fill("tund");
  assert.deepEqual(await page.locator(".pick-menu [data-project] b").allTextContents(), ["tundra"], "F-T1137-1: the find field shows at 8 projects and filters the rows");
  await find.fill("");
  await picker(page).click();

  let row = await pick(page, "lantern");
  await row.getByRole("button", { name: "Archive lantern" }).click();
  const confirm = page.getByRole("dialog", { name: "Archive lantern?" });
  await confirm.waitFor();
  assert.match(await confirm.textContent(), /This browser cannot write to the logbook yet\..*Or ask the chief in the chat to archive lantern\./s);
  assert.equal(await confirm.getByRole("button", { name: "Archive", exact: true }).count(), 0, "an unpaired browser gets no Archive button");
  await w.shot("t1137-confirm-unpaired");
  await confirm.getByRole("link", { name: "Pair this browser" }).click();
  await page.getByPlaceholder("ABCD-EFGH").fill(await w.code());
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await confirm.getByText("It moves to the Archived list.").waitFor();
  const text = await confirm.textContent();
  for (const part of ["2 tasks", "0 milestones", "The logbook keeps all of it.", "1 pull request stays open on GitHub. Nothing closes or merges them.", "1 question waits for you. It waits in the archive."]) assert.ok(text.includes(part), `the confirm says ${part}: ${text}`);
  assert.ok(!text.includes("agents run now"), "no agent runs, so the confirm names none");
  await w.shot("t1137-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.equal(w.archived("lantern"), false, "Cancel writes nothing");

  await page.getByRole("button", { name: "Archive project" }).click();
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("lantern is archived.").waitFor();
  assert.equal(w.archived("lantern"), true);
  const banner = page.locator(".banner.archived");
  await banner.waitFor();
  assert.match(await banner.textContent(), /^Archived on (?:\w+ \d+|\d+ \w+), just now\. Nothing runs here\. The logbook is whole\./);
  await w.shot("t1137-archived");
  await page.goto(`${w.origin}/app/#tasks?project=${basename(w.dirs.lantern)}`);
  await banner.waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo" }).count(), 1, "Undo stays while the page moves");
  await page.getByRole("button", { name: "Undo" }).click();
  await banner.waitFor({ state: "detached" });
  assert.equal(w.archived("lantern"), false, "Undo restores the project");

  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.lantern)}`);
  const welcome = page.locator(".welcome");
  await welcome.waitFor();
  const words = await welcome.textContent();
  for (const part of ["Welcome back to lantern", "Where it stood", "T1 · Sample import recipes", "T2 · Sample print a recipe", "What waits for you", "Keep the old export format?",
    "1 pull request is open. Main may have moved since you archived, so it may need a merge of main and fresh checks. The chief checks this first.", "Ask the chief in the chat of lantern to go on."]) assert.ok(words.includes(part), `Welcome back says ${part}: ${words}`);
  assert.ok(!/commits/.test(words), "R6: the board runs no git, so it counts no commits of main");
  await w.shot("t1137-welcome");
  await welcome.getByRole("button", { name: "Close" }).click();
  await welcome.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  assert.equal(await welcome.count(), 0, "Close keeps Welcome back closed after a reload");

  row = await pick(page, "harbor");
  await row.getByRole("button", { name: "Archive harbor" }).click();
  await page.getByRole("dialog", { name: "Archive harbor?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("harbor is archived.").waitFor();
  assert.equal(w.archived("harbor"), true, "the picker archives a Claude-only project that is not the open one");
  await picker(page).click();
  const archivedRow = page.locator(".pick-menu details", { hasText: "Archived · 1 project" });
  assert.match(await archivedRow.textContent(), /harbor\s*since (?:\w+ \d+|\d+ \w+) · 1 open task\s*Restore/);
  await archivedRow.locator("summary").click();
  await w.shot("t1137-picker-archived");
  await archivedRow.getByRole("button", { name: "Restore" }).click();
  await archivedRow.waitFor({ state: "detached" });
  assert.equal(w.archived("harbor"), false);

  const link = startLink(w.stateDir);
  row = await pick(page, "quarry");
  await row.getByRole("button", { name: "Archive quarry" }).click();
  await page.getByRole("dialog", { name: "Archive quarry?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("quarry is archived.").waitFor();
  const other = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  t.after(() => other.close());
  const fresh = await other.newPage();
  await fresh.goto(`${w.origin}/app/#pair=${link}&project=${basename(w.dirs.quarry)}`);
  await fresh.getByText("The chat that sent this link works in quarry, and quarry is archived.").waitFor();
  await fresh.locator(".banner.archived").getByRole("button", { name: "Restore" }).click();
  await fresh.locator(".welcome").waitFor();
  assert.equal(w.archived("quarry"), false, "a browser paired by the chat's link restores the chat's project");
  assert.match(await fresh.locator(".welcome").textContent(), /T1 · Sample quarry task/);
  assert.deepEqual(w.problems, []);
});
