import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const WIDTHS = [1440, 390];
const KEY = id => `shared/sample-app-abc123/${id}`;
let browser, base, close;

async function freePort() {
  for (;;) {
    const socket = createServer();
    await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
    const { port } = socket.address();
    await new Promise(accept => socket.close(accept));
    if (![4173, 43123].includes(port)) return port;
  }
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-jobs-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, about: true, prs: true, documents: true });
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
  close = async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); };
});
after(async () => { await browser?.close(); await close?.(); });

async function walk(t, job, width, steps) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage(), problems = [];
  page.on("pageerror", error => problems.push(String(error)));
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };
  await page.goto(`${base}/`);
  assert.equal(new URL(page.url()).pathname, "/app/", "the board's address opens the app");
  await page.locator("main h1", { hasText: "Overview" }).waitFor();
  await steps(page, click);
  assert.ok(clicks <= 2, `${job} at ${width} px took ${clicks} clicks from the Overview`);
  assert.deepEqual(problems, []);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${job}-${width}.png`), fullPage: width < 1000 ? false : true }); }
  return clicks;
}

for (const width of WIDTHS) {
  test(`J1 at ${width} px: one click on a Needs you row opens the question with its full context and its answers`, async t => {
    const clicks = await walk(t, "J1", width, async (page, click) => {
      const needs = page.locator("section", { has: page.locator("h2", { hasText: "Needs you" }) }).first();
      await click(needs.locator(`a[href="#question?key=${encodeURIComponent(KEY("G4"))}"]`));
      await page.locator("main h1", { hasText: "Can a viewer copy a shared list into their own lists?" }).waitFor();
      await page.locator("main h2", { hasText: "Answers" }).waitFor();
      assert.ok(await page.locator("main").getByText("A: yes, as a new private list").count() > 0, "the answers show");
      await page.locator("main a", { hasText: "Read the full question" }).waitFor();
    });
    assert.equal(clicks, 1);
  });

  test(`J2 at ${width} px: the milestones stand by priority on the Overview, and Tasks groups the tasks by priority in two clicks`, async t => {
    const clicks = await walk(t, "J2", width, async (page, click) => {
      const rows = await page.locator("li[data-milestone]").evaluateAll(list => list.map(item => item.textContent));
      assert.ok(rows.length === 3 && /P0/.test(rows[0]) && /P1/.test(rows[1]) && /done/.test(rows[2]), rows.join(" | "));
      await click(page.locator('nav a[href="#tasks"]').first());
      await page.locator("main h1", { hasText: "Tasks" }).waitFor();
      await click(page.locator("main button", { hasText: /^Priority$/ }));
      await page.waitForFunction(() => /^P0/.test(document.querySelector("main section.group h2")?.textContent ?? ""));
      const groups = await page.locator("main section.group h2").allTextContents();
      assert.deepEqual(groups.map(text => text.slice(0, 2)).filter(text => /^P\d$/.test(text)), ["P0", "P1", "P2", "P3"], groups.join(" | "));
    });
    assert.equal(clicks, 2);
  });

  test(`J3 at ${width} px: a milestone, then a task, shows the task's dev cycle and what its agents made`, async t => {
    const clicks = await walk(t, "J3", width, async (page, click) => {
      const milestone = page.locator(`a[href="#tasks?milestone=${encodeURIComponent(KEY("M1"))}"]`);
      await click(milestone);
      await page.locator("main h1", { hasText: "Tasks" }).waitFor();
      await click(page.locator(`a.row[href="#task?key=${encodeURIComponent(KEY("T3"))}"]`));
      await page.locator(".taskpage h1", { hasText: "Sample shared limits" }).waitFor();
      assert.deepEqual((await page.locator(".taskpage [role=tab]").allTextContents()).map(text => text.replace(/\s*\d+$/, "")), ["Artifacts", "Log", "Decisions"]);
      await page.locator(".taskpage").getByText("Build", { exact: false }).first().waitFor();
      await page.locator("#tab-panel").getByText("Limits design note").first().waitFor();
    });
    assert.equal(clicks, 2);
  });

  test(`J4 at ${width} px: the top bar counts the agents of each chief against the limit, and one click opens the Agents page`, async t => {
    const clicks = await walk(t, "J4", width, async (page, click) => {
      const limit = page.locator("a.limit", { hasText: /^Agents/ });
      assert.match(await limit.textContent(), /^Agents \d+ of \d+ · C1 \d+ · C2 \d+/);
      assert.match(await page.locator("a.limit", { hasText: /^Leads/ }).textContent(), /^Leads \d+ of \d+$/);
      await click(limit);
      await page.locator("main h1", { hasText: "Agents" }).waitFor();
      assert.ok(await page.locator(".chief-box").count() >= 2, "a box for each chief");
    });
    assert.equal(clicks, 1);
  });

  test(`J5 at ${width} px: Pull requests groups each PR by its next action, and the graph shows what waits for what`, async t => {
    const clicks = await walk(t, "J5", width, async (page, click) => {
      await click(page.locator('nav a[href="#pull-requests"]').first());
      await page.locator("main h1", { hasText: "Pull requests" }).waitFor();
      const groups = await page.locator("main h2").allTextContents();
      for (const group of ["Needs you", "In review", "Ready to merge", "Waiting for another task", "Merged recently"]) assert.ok(groups.includes(group), `${group}: ${groups.join(" | ")}`);
      await click(page.locator("main button", { hasText: /^Graph$/ }));
      await page.locator("section.graph .g-title", { hasText: "Sample sync build" }).first().waitFor();
    });
    assert.equal(clicks, 2);
  });

  test(`J6 at ${width} px: the Overview counts what changed, with no click`, async t => {
    const clicks = await walk(t, "J6", width, async page => {
      const counts = page.locator("section.counts");
      assert.match(await counts.locator("h2").textContent(), /In the last 24 hours|Since you looked/);
      assert.match(await counts.textContent(), /\d+\s*Merged/);
      assert.match(await counts.textContent(), /\d+\s*failed/);
    });
    assert.equal(clicks, 0);
  });

  test(`J7 at ${width} px: each chief's chip says whether it runs and whether its autopilot is on, with no click`, async t => {
    const clicks = await walk(t, "J7", width, async page => {
      const chips = await page.locator(".chips button.chip[data-chief]").allTextContents();
      assert.equal(chips.length, 2, chips.join(" | "));
      assert.ok(chips.some(text => /Claude · C1/.test(text) && /autopilot on/.test(text)), chips.join(" | "));
      assert.ok(chips.some(text => /Codex · C2/.test(text) && /autopilot off/.test(text)), chips.join(" | "));
      assert.equal(await page.locator(".chips .dot.live").count(), 2, "both chiefs run");
    });
    assert.equal(clicks, 0);
  });
}
