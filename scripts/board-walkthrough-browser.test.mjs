import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLink } from "../packages/sage-board/access.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const KEY = id => `shared/sample-app-abc123/${id}`;
const taskPage = id => `/app/#task?key=${encodeURIComponent(KEY(id))}`;
const HOUR = 3_600_000;
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

function addRows(dir, table, rows) {
  const columns = readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n")[0].split("\t");
  appendFileSync(join(dir, `${table}.tsv`), rows.map(row => columns.map(column => row[column] ?? "").join("\t")).join("\n") + "\n");
}

async function board(t, { empty = false, noTasks = false, judge = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-walkthrough-")), saved = process.env.SAGE_WORKTREES, now = new Date().toISOString();
  const at = hours => new Date(Date.parse(now) - hours * HOUR).toISOString();
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  mkdirSync(join(dir, "logbooks"), { recursive: true });
  let logbook = null;
  if (!empty) {
    logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), now, { agents: true, about: true, prs: true, documents: true });
    addRows(logbook, "tasks", [{ id: "T90", title: "Sample stopped task", size: "small", route: "build,code-review,qa", state: "abandoned", priority: "P2", chief: "C1" }]);
    addRows(logbook, "runs", [
      { id: "R90", task: "T90", role: "implementer", round: "0", status: "done", started: at(30), ended: at(29), chief: "C1" },
      { id: "R91", task: "T90", role: "code-reviewer", round: "0", status: "running", started: at(28), chief: "C1" },
      { id: "R92", task: "T20", role: "lead", round: "0", status: "done", started: at(60), ended: at(51), chief: "C1" },
    ]);
    addRows(logbook, "decisions", [{ at: at(20), task: "T90", decision: "state abandoned", why: "sample" }]);
    mkdirSync(join(logbook, "for-users"));
    writeFileSync(join(logbook, "for-users", "T1.md"), "- Each install gets the same files.\n- The lock file stays as it is.\n");
    writeFileSync(join(logbook, "reports", "R92.md"), "STATUS done\nRESULT ready. Sign-in shows one clear message when a session ends.\n");
    if (judge) addRows(logbook, "runs", [{ id: "R52", task: "T11", role: "arena-judge", round: "0", status: "done", started: at(2), ended: at(1), chief: "C2" }]);
    if (judge === "report") writeFileSync(join(logbook, "reports", "R52.md"), "STATUS done\nRESULT base A, with one graft from B.\n");
    if (noTasks) for (const name of readdirSync(logbook)) if (name.endsWith(".tsv") && name !== "chiefs.tsv") writeFileSync(join(logbook, name), readFileSync(join(logbook, name), "utf8").split("\n")[0] + "\n");
  }
  const stateDir = join(dir, "state"), stops = [];
  mkdirSync(stateDir);
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port: 0, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair", onStop: () => { stops.push(Date.now()); } });
  const { port } = await server.start();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, stateDir, stops, logbook };
}

async function open(t, w, path, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  const problems = [];
  await context.route("**/*", route => route.request().url().startsWith(`${w.base}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  await page.goto(`${w.base}${path}`);
  await page.locator("main h1").first().waitFor();
  return { page, problems };
}
const shoot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name) }); };
const rowIds = page => page.locator("a.row[data-task]").evaluateAll(list => list.map(row => row.dataset.task.split("/").pop()));

test("T1126 S5: the Merged count opens the tasks merged since then, newest first", async t => {
  const w = await board(t), { page, problems } = await open(t, w, "/app/");
  const count = Number(await page.locator('[data-count="merged"] .n').textContent());
  await page.locator('[data-count="merged"] a', { hasText: "Merged" }).click();
  await page.locator("main h1", { hasText: "Tasks" }).waitFor();
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.deepEqual(await rowIds(page), ["T1", "T9"], "T1 merged 2 h ago and T9 3 h ago; T21 (30 h) and T20 (50 h) are older than the last 24 hours");
  assert.equal(count, 2, "the list holds exactly the tasks that the count counts");
  assert.match(await page.locator(".focus-note").textContent(), /^Merged since .+ 2 tasks · newest first Show all tasks$/);
  assert.equal(await page.getByRole("button", { name: "Newest first" }).getAttribute("aria-pressed"), "true");
  await shoot(page, "S5-merged-1440.png");
  await page.getByRole("link", { name: "Show all tasks" }).click();
  await page.waitForFunction(() => !document.querySelector(".focus-note"));
  const all = await rowIds(page);
  assert.ok(all.length > 2 && !all.includes("T1"), `every open task shows again, and the ended ones fold: ${all.join(" ")}`);
  await page.getByRole("button", { name: "Priority first" }).click();
  await page.waitForFunction(() => !location.hash.includes("sort="));
  assert.deepEqual(problems, []);
});

test("T1126 S17, S18: Tasks opens at its top; a milestone shows only its tasks, and Show all tasks shows the rest again", async t => {
  const w = await board(t), { page, problems } = await open(t, w, "/app/", { height: 500 });
  await page.evaluate(() => scrollTo(0, 400));
  await page.locator('nav a[href="#tasks"]').click();
  await page.locator("main h1", { hasText: "Tasks" }).waitFor();
  assert.equal(await page.evaluate(() => scrollY), 0, "S18: a new page opens at its top");
  const groups = await page.locator("section.group").count();
  assert.ok(groups > 1, "Tasks shows every group");
  await page.goto(`${w.base}/app/`);
  await page.locator("main h1", { hasText: "Overview" }).waitFor();
  await page.evaluate(() => scrollTo(0, 300));
  await page.locator(`a[href="#tasks?milestone=${encodeURIComponent(KEY("M1"))}"]`).first().click();
  await page.locator(".focus-note").waitFor();
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.deepEqual(await page.locator("section.group h2").allTextContents(), ["Milestone 1: Board redesign"], "S17: only the milestone's own tasks");
  assert.ok((await page.locator("section.group h2").boundingBox()).y > 52, "the milestone's heading is below the top bar, not under it");
  await shoot(page, "S17-milestone-1440.png");
  await page.getByRole("link", { name: "Show all tasks" }).click();
  await page.waitForFunction(count => document.querySelectorAll("section.group").length === count, groups);
  assert.deepEqual(problems, []);
});

test("T1126 S13: an empty board shows one card with the first steps, and no empty lists", async t => {
  const w = await board(t, { empty: true });
  for (const width of [1440, 390]) {
    const { page, problems } = await open(t, w, "/app/", { width, height: 844 });
    await page.locator("h2", { hasText: "Start your first task" }).waitFor();
    assert.deepEqual(await page.locator(".start ol > li > b").allTextContents(), ["Start a chief in the project", "Ask for a change in your words", "Come back here"]);
    assert.equal(await page.locator(".start code").textContent(), "sage mode");
    assert.equal(await page.locator("#needs-h, #milestones-h, #counts-h").count(), 0, "no empty Needs you, Milestones or counts");
    const box = await page.locator(".start").boundingBox();
    assert.ok(box.y + box.height <= 844 * 1.5, `${width} px: the card starts on the first screen`);
    await shoot(page, `S13-empty-${width}.png`);
    assert.deepEqual(problems, []);
  }
});

test("T1126 S14: on a phone the chiefs fold into one chip, and Needs you starts on the first screen", async t => {
  const w = await board(t), { page, problems } = await open(t, w, "/app/", { width: 390, height: 844 });
  const top = (await page.locator("#needs-h").boundingBox()).y;
  assert.ok(top < 600, `Needs you starts at ${top} px of 844`);
  const fold = page.locator(".chips .chip.fold");
  assert.equal(await fold.textContent(), "C1 · autopilot on C2 · autopilot off ▾", "the fold names each chief with its state");
  assert.equal(await page.locator(".chips button.chip[data-chief]").first().isVisible(), false, "the chips are folded");
  await shoot(page, "S14-overview-390.png");
  await fold.click();
  assert.equal(await page.locator(".chips button.chip[data-chief]").first().isVisible(), true, "one tap unfolds them");
  assert.equal(await fold.getAttribute("aria-expanded"), "true");
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await fold.isVisible(), false, "a wide window shows every chip and no fold");
  assert.deepEqual(problems, []);
});

test("T1126 S15, S12: the tabs sit under the title with About first; a merged task shows what changed for you, from its source", async t => {
  const w = await board(t);
  for (const width of [1440, 390]) {
    const { page, problems } = await open(t, w, taskPage("T3"), { width, height: 844 });
    await page.locator(".about-card").waitFor();
    assert.deepEqual(await page.getByRole("tab").allTextContents(), ["About", "Artifacts 14", "Log 13", "Decisions 1"]);
    assert.equal(await page.getByRole("tab", { name: "About" }).getAttribute("aria-selected"), "true");
    const tabs = (await page.locator('[role="tablist"]').boundingBox()).y;
    assert.ok(tabs < (width < 760 ? 700 : 400), `${width} px: the tabs start at ${tabs} px, before About's parts`);
    assert.equal(await page.locator(".about-s h3", { hasText: "What changed for you" }).count(), 0, "an open task has no What changed part");
    await shoot(page, `S15-task-${width}.png`);
    assert.deepEqual(problems, []);
  }
  const parts = async (id, title) => {
    const { page } = await open(t, w, taskPage(id));
    await page.locator(".taskpage h1", { hasText: title }).waitFor();
    const part = page.locator(".about-s").first();
    assert.equal(await part.locator("h3").textContent(), "What changed for you", `${id}: the first part of About`);
    return { page, items: await part.locator("li").allTextContents(), from: await part.locator("p.faint").textContent() };
  };
  const pr = await parts("T1", "Sample pinned bundle");
  assert.deepEqual(pr.items, ["Each install gets the same files.", "The lock file stays as it is."]);
  assert.equal(pr.from, `From its pull request's description, part "What changes for users".`);
  await shoot(pr.page, "S12-merged-pr-1440.png");
  const lead = await parts("T20", "Sample sign-in screen");
  assert.deepEqual(lead.items, ["ready. Sign-in shows one clear message when a session ends."]);
  assert.equal(lead.from, `From the lead's report (RESULT of R92). The logbook kept no "What changes for users" part of its pull request.`);
  const none = await parts("T21", "Sample passkeys");
  assert.deepEqual(none.items, []);
  assert.equal(none.from, `The board has no text for this change: the logbook kept no "What changes for users" part of its pull request, and the lead kept no report.`);
});

test("T1126 S21: a stopped task shows no step as now", async t => {
  const w = await board(t), { page, problems } = await open(t, w, taskPage("T90"));
  await page.locator(".trail").waitFor();
  assert.deepEqual(await page.locator(".trail li").evaluateAll(list => list.map(step => step.textContent)), ["build (not started)", "reviews (not started)", "QA (not started)"]);
  assert.match(await page.locator(".about-s p.now").first().textContent(), /^Stopped:/);
  assert.deepEqual(problems, []);
});

test("T1126 S22: the pairing card under the answers covers no answer", async t => {
  const w = await board(t);
  for (const [width, height] of [[1440, 700], [390, 844]]) {
    const { page, problems } = await open(t, w, `/app/#question?key=${encodeURIComponent(KEY("G4"))}`, { width, height });
    await page.locator(".send .pair").waitFor();
    for (const y of [0, 300, 600]) {
      await page.evaluate(y => scrollTo(0, y), y);
      const covered = await page.evaluate(() => {
        const send = document.querySelector(".send").getBoundingClientRect();
        return [...document.querySelectorAll(".answer")].filter(answer => { const box = answer.getBoundingClientRect(); return box.bottom > send.top && box.top < send.bottom && box.top < innerHeight; }).length;
      });
      assert.equal(covered, 0, `${width} px, scrolled ${y} px: no answer under the pairing card`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await shoot(page, `S22-question-${width}.png`);
    assert.deepEqual(problems, []);
  }
});

test("T1126 S23: a paired browser stops the board after it confirms; a browser that only reads is told to ask the chief", async t => {
  const w = await board(t);
  const reader = await open(t, w, "/app/");
  assert.equal(await reader.page.locator(".side .foot").getByText("Ask the chief to stop the board.").count(), 1);
  assert.equal(await reader.page.getByRole("button", { name: "Stop the board" }).count(), 0, "no Stop control for a browser that only reads");
  const { page, problems } = await open(t, w, `/app/#pair=${startLink(w.stateDir)}`);
  await page.getByRole("button", { name: "Stop the board" }).waitFor();
  await page.getByRole("button", { name: "Stop the board" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop the board?" });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Cancel", "the focus starts on Cancel");
  await shoot(page, "S23-confirm-1440.png");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Stop the board", "F-T1126-6: Escape returns the focus to the button that opened the question");
  assert.deepEqual(w.stops, [], "Cancel stops nothing");
  await shoot(page, "F9-paired-1440.png");
  await page.getByRole("button", { name: "Stop the board" }).click();
  await dialog.getByRole("button", { name: "Stop the board" }).click();
  await page.locator("h1", { hasText: "The board stopped" }).waitFor();
  assert.match(await page.locator(".stopped-page").textContent(), /^The board stoppedYou stopped it at \d\d:\d\d\. The chiefs and their agents keep working\.To open it again, type show board in a chief's chat\. You can close this tab\.$/);
  assert.equal(w.stops.length, 1, "the server got one stop");
  await shoot(page, "S23-stopped-1440.png");
  assert.deepEqual(problems, []);
});

test("T1126 F-T1126-9, F-T1126-6: on a phone a paired browser has Stop the board and its question fits the screen; a browser that only reads is told to ask the chief", async t => {
  const w = await board(t), phone = { width: 390, height: 844 };
  const reader = await open(t, w, "/app/", phone);
  assert.equal(await reader.page.getByText("Ask the chief to stop the board.").isVisible(), true, "the unpaired line shows on a phone");
  const { page, problems } = await open(t, w, `/app/#pair=${startLink(w.stateDir)}`, phone);
  const stop = page.getByRole("button", { name: "Stop the board" });
  await stop.waitFor();
  assert.equal(await stop.isVisible(), true, "the Stop control shows on a phone");
  assert.equal(await page.locator(".nav").getByRole("button", { name: "Stop the board" }).count(), 0, "the control is not one of the page links");
  assert.equal(await page.locator('.nav a[href="#stats"]').isVisible(), true, "the Stats link still shows");
  await shoot(page, "F9-paired-390.png");
  await stop.click();
  const dialog = page.getByRole("dialog", { name: "Stop the board?" });
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= phone.width && box.y + box.height <= phone.height, `the question fits the screen: ${JSON.stringify(box)}`);
  await shoot(page, "F9-confirm-390.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Stop the board", "F-T1126-6: Cancel returns the focus to the button that opened the question");
  assert.deepEqual(w.stops, []);
  await stop.click();
  await dialog.getByRole("button", { name: "Stop the board" }).click();
  await page.locator("h1", { hasText: "The board stopped" }).waitFor();
  assert.equal(w.stops.length, 1, "the server got one stop");
  assert.deepEqual(problems, []);
});

test("T1126 F-T1126-12: a project with a chief and no task shows the first steps, with the chief's step done", async t => {
  const w = await board(t, { noTasks: true });
  for (const width of [1440, 390]) {
    const { page, problems } = await open(t, w, "/app/", { width, height: 844 });
    await page.locator("h2", { hasText: "Start your first task" }).waitFor();
    assert.deepEqual(await page.locator(".start ol > li > b").allTextContents(), ["Start a chief in the project", "Ask for a change in your words", "Come back here"]);
    assert.equal(await page.locator(".start ol > li").first().locator(".hint").textContent(), "Done: a chief works in this project.");
    assert.equal(await page.locator(".start code").count(), 0, "no phrase to copy: the chief has started");
    assert.equal(await page.locator("#needs-h, #milestones-h, #counts-h").count(), 0, "no empty Needs you, Milestones or counts");
    await shoot(page, `F12-no-task-${width}.png`);
    assert.deepEqual(problems, []);
  }
});

test("T1126 F-T1126-13: one long word in a lead's RESULT wraps, and the task page does not scroll sideways", async t => {
  const w = await board(t);
  writeFileSync(join(w.logbook, "reports", "R92.md"), `STATUS done\nRESULT ${"x".repeat(6000)}\n`);
  for (const width of [1440, 390]) {
    const { page, problems } = await open(t, w, taskPage("T20"), { width, height: 844 });
    await page.locator(".changed li").waitFor();
    assert.equal((await page.locator(".changed li").textContent()).length, 6000);
    const [scroll, view] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(scroll <= view, `${width} px: the page is ${scroll} px wide in a ${view} px window`);
    assert.deepEqual(problems, []);
  }
});

test("T1126 F-T1126-10: the arena card links the judge's report only when the logbook keeps it", async t => {
  for (const [judge, kept] of [["none", false], ["report", true]]) {
    const w = await board(t, { judge }), { page, problems } = await open(t, w, "/app/#agents");
    const said = page.locator('section.acard.arena[aria-label="Arena of T11"] .ar-res');
    await said.waitFor();
    assert.equal(await said.getByRole("link", { name: "the judge's report R52" }).count(), kept ? 1 : 0);
    assert.equal(/No report of R52/.test(await said.textContent()), !kept);
    assert.deepEqual(problems, []);
  }
});
