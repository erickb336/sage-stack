import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { tool as codex } from "../plugins/sage-codex/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";

const chromium = requireBrowser();
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const PROJECTS = ["harbor", "orchard", "quarry", "summit", "tundra", "valley", "willow"];
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

function repository(base, name) {
  const path = join(base, name);
  mkdirSync(path);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", `first commit of ${name}`], { env: gitEnv });
  return realpathSync(path);
}

async function openBoard(t, { viewport = { width: 1440, height: 1000 }, duringRead = null } = {}) {
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
  const meadow = repository(base, "meadow"), inCodex = { ...env, SAGE_HOME: join(env.CODEX_HOME, "sage") };
  codex.sage(["init", "--project", meadow], inCodex);
  codex.sage(["task", "add", "--title", "Sample meadow task", "--size", "small", "--priority", "P2", "--project", meadow], inCodex);
  claude.sage(["init", "--project", meadow], inClaude);
  dirs.meadow = codex.storeDir(meadow, inCodex);
  dirs.meadowClaude = claude.storeDir(meadow, inClaude);
  const sources = [{ id: "claude", label: "Claude", provider: "claude", path: inClaude.SAGE_HOME }, { id: "codex", label: "Codex", provider: "codex", path: inCodex.SAGE_HOME }, { id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }];
  const config = join(base, "home", ".config", "sage-board", "board.json"), stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = createBoardServer({ sources, port: 0, app: APP, settleReads: [], duringRead, stateDir, pairCommand: "node /sample/board/cli.mjs board --pair" });
  const { port } = await server.start();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify(sources)], { output: () => {}, env });
  const context = await browser.newContext({ viewport, colorScheme: "dark", timezoneId: "America/New_York" });
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
const focused = page => page.evaluate(() => { const at = document.activeElement; return { text: at?.textContent?.trim().slice(0, 60), inDialog: !!at?.closest("[role=dialog]"), tag: at?.tagName }; });
const contrast = locator => locator.evaluate(element => {
  const { color, backgroundColor } = getComputedStyle(element);
  const lum = rgb => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(n => { const c = Number(n) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(color), lum(backgroundColor)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
});
const clear = (page, target) => (typeof target === "string" ? page.locator(target).first() : target).evaluate(element => element.getBoundingClientRect().top - document.querySelector("header.top").getBoundingClientRect().bottom);
const archiveAlert = page => page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Try again", exact: true }) });
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
  assert.equal(await confirm.getAttribute("aria-modal"), "true", "F-T1137-6: the confirm is a modal dialog");
  assert.deepEqual(await focused(page), { text: "Archive lantern?", inDialog: true, tag: "H2" }, "F-T1137-6: focus moves into the confirm when it opens");
  assert.match(await confirm.textContent(), /This browser cannot write to the logbook yet\. Pair it here, then archive\. Or ask the chief in the chat to archive lantern\./);
  assert.equal(await confirm.getByRole("button", { name: "Archive", exact: true }).count(), 0, "an unpaired browser gets no Archive button");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 3 ? "Tab" : "Shift+Tab");
    assert.equal((await focused(page)).inDialog, true, `F-T1137-6: Tab ${i + 1} stays inside the confirm`);
  }
  await w.shot("t1137-confirm-unpaired");
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "detached" });
  assert.match((await focused(page)).text, /^lantern/, "F-T1137-6: Escape closes the confirm, and focus goes back to the picker that opened it");

  await page.getByRole("button", { name: "Archive project" }).click();
  await confirm.waitFor();
  await confirm.getByPlaceholder("ABCD-EFGH").fill(await w.code());
  await confirm.getByRole("button", { name: "Pair", exact: true }).click();
  await confirm.getByText("It moves to the Archived list.").waitFor();
  assert.deepEqual(await focused(page), { text: "Archive lantern?", inDialog: true, tag: "H2" }, "F-T1137-6: after pairing in the confirm, focus is in its paired form");
  const text = await confirm.textContent();
  for (const part of ["2 tasks", "0 milestones", "The logbook keeps all of it.", "1 pull request stays open on GitHub. Nothing closes or merges them.", "1 question waits for you. It waits in the archive."]) assert.ok(text.includes(part), `the confirm says ${part}: ${text}`);
  assert.ok(!text.includes("agents run now"), "no agent runs, so the confirm names none");
  const archiveButton = confirm.getByRole("button", { name: "Archive", exact: true });
  await archiveButton.hover();
  assert.ok(await contrast(archiveButton) >= 4.5, `F-T1137-5: the hovered primary button is readable in the dark theme (${await contrast(archiveButton)})`);
  await w.shot("t1137-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.equal(w.archived("lantern"), false, "Cancel writes nothing");
  assert.equal((await focused(page)).text, "Archive project", "F-T1137-6: Cancel returns focus to the button that opened the confirm");

  await page.getByRole("button", { name: "Archive project" }).click();
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("lantern is archived.").waitFor();
  assert.equal(w.archived("lantern"), true);
  assert.equal((await focused(page)).text, "Undo", "focus moves to Undo when the confirm closes");
  const banner = page.locator(".banner.archived");
  await banner.waitFor();
  assert.match(await banner.textContent(), /^Archived on (?:\w+ \d+|\d+ \w+), just now\. Nothing runs here\. The logbook is whole\./);
  const needs = page.locator("section", { has: page.getByRole("heading", { name: "Needs you" }) });
  const needsText = await needs.textContent();
  for (const part of ["1 waits", "answers wait until Restore", "Restore to answer"]) assert.ok(needsText.includes(part), `F-T1137-9: the Needs you card of an archived project says ${part}: ${needsText}`);
  assert.ok(!needsText.includes("open a question to answer it here"), "F-T1137-9: the Needs you card does not offer an answer that waits");
  await w.shot("t1137-archived");
  await page.goto(`${w.origin}/app/#tasks?project=${basename(w.dirs.lantern)}`);
  await banner.waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo" }).count(), 1, "Undo stays while the page moves");
  await page.getByRole("button", { name: "Undo" }).click();
  await banner.waitFor({ state: "detached" });
  assert.equal(w.archived("lantern"), false, "Undo restores the project");

  const welcome = page.locator(".welcome");
  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.lantern)}`);
  await needs.waitFor();
  assert.equal(await welcome.count(), 0, "F-T1137-3: Undo opens no Welcome back");
  await page.reload();
  await needs.waitFor();
  assert.equal(await welcome.count(), 0, "F-T1137-3: Undo opens no Welcome back, also after a reload");

  await page.getByRole("button", { name: "Archive project" }).click();
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await banner.getByRole("button", { name: "Restore" }).click();
  await welcome.waitFor();
  assert.equal(w.archived("lantern"), false, "Restore restores the project");
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
  await page.getByText("harbor is restored.").waitFor();
  assert.equal(await page.locator(".pick-menu").count(), 0, "F-T1156-39: Restore closes the picker");
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

test("T1137 at 390 px: a stale notice cannot satisfy the partial archive assertion; the archive note clears the header and tries again", { timeout: 60_000 }, async t => {
  let readFailure = false;
  const w = await openBoard(t, { viewport: { width: 390, height: 844 }, duringRead: () => { if (readFailure) throw new Error("Sample controlled read failure"); } }), { page } = w;
  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.meadow)}`);
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.getByPlaceholder("ABCD-EFGH").fill(await w.code());
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("button", { name: "Archive project" }).waitFor();
  await page.locator("button.theme").click();
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));

  const row = await pick(page, "meadow");
  await row.getByRole("button", { name: "Archive meadow" }).click();
  const confirm = page.getByRole("dialog", { name: "Archive meadow?" });
  await confirm.waitFor();
  assert.ok(await clear(page, ".confirm") >= 0, `F-T1137-8: the header does not cover the confirm (${await clear(page, ".confirm")} px)`);
  const archiveButton = confirm.getByRole("button", { name: "Archive", exact: true });
  await archiveButton.hover();
  assert.ok(await contrast(archiveButton) >= 4.5, `F-T1137-5: the hovered primary button is readable in the light theme (${await contrast(archiveButton)})`);

  assert.equal(await page.locator(".banner.fail").count(), 0, "the board has a good model before the controlled read failure");
  rmSync(join(w.dirs.meadow, "config.json"), { force: true });
  mkdirSync(join(w.dirs.meadow, "config.json"));
  readFailure = true;
  const tasks = join(w.dirs.meadow, "tasks.tsv");
  writeFileSync(tasks, readFileSync(tasks));
  const stale = page.getByRole("alert").filter({ hasText: "The board cannot read the logbook." });
  await stale.waitFor();
  assert.match(await stale.textContent(), /Sample controlled read failure/);
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route("**/api/archive", async route => { reached.resolve(); await release.promise; await route.continue(); }, { times: 1 });
  const response = page.waitForResponse(reply => reply.url() === `${w.origin}/api/archive` && reply.request().method() === "POST");
  const partial = archiveAlert(page);
  try {
    await archiveButton.click();
    await reached.promise;
    assert.match(await page.locator(".banner.fail").textContent(), /The board cannot read the logbook\./, "the old broad selector accepts the unrelated stale notice before the archive response");
    assert.equal(await partial.count(), 0, "the scoped archive alert waits for the real archive response");
  } finally { release.resolve(); }
  const result = await response, body = await result.json();
  assert.equal(result.status(), 409);
  assert.equal(body.landed, 1);
  assert.equal(body.logbooks, 2);
  assert.deepEqual(body.failed, ["Codex"]);
  await partial.waitFor();
  assert.equal(await partial.textContent(), "Archived in 1 of 2 logbooks. The Codex logbook of meadow did not save. The project stays shown until both agree. Try again", "F-T1137-7, F-T1137-16: the partial note names the logbook that did not save, in the words of the design");
  assert.equal((await focused(page)).text, "Try again", "F-T1137-11: the partial note has Try again, with focus on it");
  assert.ok(await clear(page, partial) >= 0, "F-T1137-8: the header does not cover the partial note");
  await w.shot("t1137-partial-390");
  assert.equal(w.archived("meadowClaude"), true, "the Claude logbook of meadow landed");

  readFailure = false;
  rmSync(join(w.dirs.meadow, "config.json"), { recursive: true });
  await partial.getByRole("button", { name: "Try again" }).click();
  await page.getByText("meadow is archived.").waitFor();
  await partial.waitFor({ state: "detached" });
  assert.equal(w.archived("meadow"), true, "Try again archives the logbook that did not save");
  assert.equal(w.archived("meadowClaude"), true, "Try again preserves the Claude archive write");
  const undo = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Undo", exact: true }) });
  assert.ok(await clear(page, undo) >= 0, `F-T1137-8: the header does not cover the Undo note (${await clear(page, undo)} px)`);
  await w.shot("t1137-undo-390");
  assert.deepEqual(w.problems.filter(problem => !/status of 409/.test(problem)), []);
});

const busy = dir => { mkdirSync(join(dir, ".lock")); writeFileSync(join(dir, ".lock", "held"), "sample holder\n"); };
const free = dir => rmSync(join(dir, ".lock"), { recursive: true, force: true });
async function openMeadow(t) {
  const w = await openBoard(t), { page } = w;
  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.meadow)}`);
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.getByPlaceholder("ABCD-EFGH").fill(await w.code());
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const archive = async () => { await page.getByRole("button", { name: "Archive project" }).click(); await page.getByRole("dialog", { name: "Archive meadow?" }).getByRole("button", { name: "Archive", exact: true }).click(); };
  const restore = () => page.locator(".banner.archived").getByRole("button", { name: "Restore" }).click();
  const again = () => archiveAlert(page).getByRole("button", { name: "Try again" }).click();
  const books = () => [w.archived("meadowClaude"), w.archived("meadow")];
  const settled = async want => { for (let i = 0; i < 100 && JSON.stringify(books()) !== JSON.stringify(want); i++) await page.waitForTimeout(100); return books(); };
  return { ...w, archive, restore, again, books, settled };
}
async function partialNote({ page }, shown, expected, message) {
  const note = archiveAlert(page);
  await note.waitFor();
  await page.locator(".banner.archived").waitFor({ state: shown === "archived" ? "attached" : "detached" });
  const text = await note.textContent();
  assert.equal(text, expected, message);
  assert.doesNotMatch(text, /\/|\.lock|config\.json|checkout\.txt/, "F-T1137-16: the partial note shows no file path");
  assert.equal((await focused(page)).text, "Try again", "the partial note offers Try again, with focus on it");
}
const SHOWN = "The project stays shown until both agree. Try again", RESTORED = "The board shows the project as restored. Try again so that both agree. Try again", ARCHIVED = "The board shows the project as archived. Try again so that both agree. Try again";

test("T1137: a partial Archive that the board does not show says that the project stays shown, in the words of the design", async t => {
  const w = await openMeadow(t);
  busy(w.dirs.meadowClaude);
  await w.archive();
  await partialNote(w, "shown", `Archived in 1 of 2 logbooks. The Claude logbook of meadow did not save. ${SHOWN}`, "F-T1137-16: the Claude logbook failed, the Codex logbook saved");
  assert.deepEqual(w.books(), [false, true]);
  await w.shot("t1137-partial-archive");
  free(w.dirs.meadowClaude);
  await w.again();
  await w.page.getByText("meadow is archived.").waitFor();
  assert.deepEqual(w.books(), [true, true], "Try again archives the logbook that did not save");
});

test("T1137: a partial Restore that the board shows as restored says restored, not archived", async t => {
  const w = await openMeadow(t);
  await w.archive();
  await w.page.getByText("meadow is archived.").waitFor();
  busy(w.dirs.meadow);
  await w.restore();
  await partialNote(w, "shown", `Restored in 1 of 2 logbooks. The Codex logbook of meadow did not save. ${RESTORED}`, "F-T1137-15: the note agrees with the board after a partial Restore");
  assert.deepEqual(w.books(), [false, true]);
  await w.shot("t1137-partial-restore");
  free(w.dirs.meadow);
  await w.again();
  assert.deepEqual(await w.settled([false, false]), [false, false], "Try again restores the logbook that did not save");
});

test("T1137: a partial Undo says what the board shows", async t => {
  const w = await openMeadow(t);
  await w.archive();
  await w.page.getByText("meadow is archived.").waitFor();
  busy(w.dirs.meadowClaude);
  await w.page.getByRole("button", { name: "Undo" }).click();
  await partialNote(w, "shown", `Restored in 1 of 2 logbooks. The Claude logbook of meadow did not save. ${RESTORED}`, "the note agrees with the board after a partial Undo");
  assert.deepEqual(w.books(), [true, false]);
  free(w.dirs.meadowClaude);
  await w.again();
  assert.deepEqual(await w.settled([false, false]), [false, false]);
});

test("T1137: a partial Archive from a missing checkout.txt that the board shows as archived says archived; its Restore says restored", async t => {
  const w = await openMeadow(t);
  rmSync(join(w.dirs.meadow, "checkout.txt"));
  await w.archive();
  await partialNote(w, "archived", `Archived in 1 of 2 logbooks. The Codex logbook of meadow did not save. ${ARCHIVED}`, "F-T1137-17: the note agrees with the board, which reads only the logbook that names its checkout");
  assert.deepEqual(w.books(), [true, false]);
  await w.shot("t1137-partial-archive-no-checkout");
  await w.restore();
  await partialNote(w, "shown", `Restored in 1 of 2 logbooks. The Codex logbook of meadow did not save. ${RESTORED}`, "the note agrees with the board after a partial Restore");
  assert.deepEqual(w.books(), [false, false]);
  assert.deepEqual(w.problems.filter(problem => !/status of 409/.test(problem)), []);
});

test("T1159 F-T1159-22, -37, -38, -19: the picker keeps the focus on its button after a keyboard pick and after Restore, names the project on Restore, and a plain link never reopens an archived project", async t => {
  const w = await openBoard(t), { page } = w;
  await page.goto(`${w.origin}/app/#pair=${startLink(w.stateDir)}&project=${basename(w.dirs.quarry)}`);
  await page.getByText(/^This browser is paired\./).waitFor();
  const onPicker = () => page.evaluate(() => document.activeElement?.matches("header .picker") ?? false);

  await picker(page).click();
  await page.locator(`.pick-menu a[data-project="${basename(w.dirs.orchard)}"]`).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".pick-menu"));
  await picker(page).filter({ hasText: "orchard" }).waitFor();
  assert.equal(await onPicker(), true, "F-T1159-22: after a keyboard pick the focus is on the picker, not on the page body");

  const row = await pick(page, "harbor");
  await row.getByRole("button", { name: "Archive harbor" }).click();
  await page.getByRole("dialog", { name: "Archive harbor?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("harbor is archived.").waitFor();
  await picker(page).click();
  const archivedRow = page.locator(".pick-menu details", { hasText: "Archived · 1 project" });
  await archivedRow.locator("summary").click();
  await archivedRow.getByRole("button", { name: "Restore harbor", exact: true }).click();
  await page.getByText("harbor is restored.").waitFor();
  await page.waitForFunction(() => !document.querySelector(".pick-menu"));
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.activeElement === document.body), false, "F-T1159-37, -38: Restore names its project, and then the focus stays on the board's note, not on the page body");

  const quarry = await pick(page, "quarry");
  await quarry.getByRole("button", { name: "Archive quarry" }).click();
  await page.getByRole("dialog", { name: "Archive quarry?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("quarry is archived.").waitFor();
  await page.goto(`${w.origin}/app/#?project=${basename(w.dirs.quarry)}`);
  await picker(page).filter({ hasText: "quarry" }).waitFor();
  await page.locator(`.banner.archived[data-archived$="${basename(w.dirs.quarry)}"]`).waitFor();
  await page.goto(`${w.origin}/app/`);
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  assert.doesNotMatch(await picker(page).textContent(), /quarry/, "F-T1159-19: a plain link opens a project that is not archived, not the last one");
  assert.deepEqual(w.problems, []);
});

test("F-T1159-31: after a reload, a project whose logbooks disagree still says so, and offers Archive and Restore", async t => {
  const w = await openMeadow(t);
  busy(w.dirs.meadowClaude);
  await w.archive();
  await partialNote(w, "shown", `Archived in 1 of 2 logbooks. The Claude logbook of meadow did not save. ${SHOWN}`, "the note right after the write");
  assert.equal(await w.page.locator("[data-mixed]").count(), 0, "one note at a time: the banner waits while the note shows");
  await w.page.reload();
  const mixed = w.page.locator("[data-mixed]");
  await mixed.waitFor();
  assert.equal(await mixed.textContent(), "The Codex logbook of meadow is archived, and the Claude logbook is not. The project stays shown until both agree. Archive Restore", "the reload keeps the mixed state in view");
  await w.page.locator(".nav a", { hasText: "Tasks" }).click();
  await w.page.locator("main h1", { hasText: "Tasks" }).waitFor();
  assert.equal(await mixed.count(), 1, "each page of the project shows it");
  free(w.dirs.meadowClaude);
  await mixed.getByRole("button", { name: "Archive" }).click();
  await w.page.getByText("meadow is archived.").waitFor();
  assert.deepEqual(w.books(), [true, true], "Archive brings the other logbook along");
  await mixed.waitFor({ state: "detached" });
  assert.deepEqual(w.problems.filter(problem => !/status of 409/.test(problem)), []);
});

test("F-T1159-36: an Archive that saves in no logbook keeps the confirm open with the reason and Try again; a lost connection says that the write may have landed", async t => {
  const w = await openMeadow(t);
  busy(w.dirs.meadowClaude); busy(w.dirs.meadow);
  await w.archive();
  const dialog = w.page.getByRole("dialog", { name: "Archive meadow?" }), refused = dialog.locator("p.refused");
  await refused.waitFor();
  assert.match(await refused.textContent(), /^Archive did not save\. \S/, "the head, then the state tool's reason");
  assert.ok(!(await refused.textContent()).includes(w.dirs.meadow) && !(await refused.textContent()).includes(w.dirs.meadowClaude), "no full path of a logbook, only a short …/name");
  assert.equal(await dialog.getByRole("button", { name: "Try again" }).count(), 1);
  assert.deepEqual(w.books(), [false, false], "nothing changed");
  free(w.dirs.meadowClaude); free(w.dirs.meadow);
  await w.page.route("**/api/archive", route => route.abort());
  await dialog.getByRole("button", { name: "Try again" }).click();
  const pending = w.page.locator(".banner:not(.fail):not(.archived)", { hasText: "lost its connection" });
  await pending.waitFor();
  assert.equal(await pending.textContent(), "The board lost its connection to its server on this Mac, so it cannot say whether the write landed. Reload the board to see it before you try again.");
  assert.equal(await pending.getByRole("button").count(), 0, "no Try again: the write may have landed");
  assert.deepEqual(w.problems.filter(problem => !/status of 409|ERR_FAILED/.test(problem)), []);
});
