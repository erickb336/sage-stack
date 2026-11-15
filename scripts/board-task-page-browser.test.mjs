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
import { ABOUT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const KEY = id => `shared/sample-app-abc123/${id}`;
const taskPage = id => `/app/#task?key=${encodeURIComponent(KEY(id))}`;
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

async function board(t) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-task-page-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, chiefCases: true, about: true, prs: true });
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}

async function open(t, base, path, { theme = "dark", width = 1440, motion = "reduce" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: motion });
  t.after(() => context.close());
  const problems = [];
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  if (theme === "light") await page.addInitScript(() => localStorage.setItem("board-theme", "light"));
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  return { page, context, problems };
}
const shoot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
const aboutPart = (page, label) => page.locator(".about-s").filter({ has: page.locator("h3", { hasText: new RegExp(`^${label}`) }) });

test("T1083: a card's title and About have one address, the task page; Back returns to the same scroll and focus; a modifier click opens a new tab", async t => {
  const base = await board(t), { page, context, problems } = await open(t, base, "/app/#agents", { width: 1024 });
  await page.locator(".chief-box").first().waitFor();
  const cards = await page.locator("section.acard").evaluateAll(list => list.filter(card => card.querySelector(".acard-h .ttl")).map(card => [card.querySelector(".acard-h .ttl").getAttribute("href"), card.querySelector(".acard-h .about").getAttribute("href")]));
  assert.ok(cards.length >= 4, "the lead and arena cards");
  assert.deepEqual(cards.filter(([title, about]) => title !== about || !title.startsWith("#task?key=")), [], "each title and its About open the same task page");
  const about = page.locator(`section.acard .acard-h .about[data-task="${KEY("T11")}"]`);
  await about.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 40));
  const scroll = await page.evaluate(() => scrollY);
  assert.ok(scroll > 200, `the arena card is down the page, at ${scroll}`);
  await about.click();
  await page.locator(".taskpage h1", { hasText: "Sample sync build" }).waitFor();
  assert.equal(new URL(page.url()).hash, `#task?key=${encodeURIComponent(KEY("T11"))}`);
  assert.deepEqual([await page.evaluate(() => scrollY), await page.evaluate(() => document.activeElement.tagName)], [0, "H1"], "the page opens at its top, with the focus on its title");
  assert.equal(await page.locator(".taskpage .back").textContent(), "‹ Agents");
  await page.goBack();
  await page.waitForFunction(key => document.activeElement?.matches(`.acard-h .about[data-task="${key}"]`), KEY("T11"));
  assert.equal(await page.evaluate(() => scrollY), scroll, "Back returns to the same scroll");
  await page.goForward();
  await page.locator(".taskpage h1", { hasText: "Sample sync build" }).waitFor();
  await page.locator(".taskpage .back").click();
  await page.waitForFunction(key => document.activeElement?.matches(`.acard-h .about[data-task="${key}"]`), KEY("T11"));
  const opened = context.waitForEvent("page");
  await page.locator(`section.acard .acard-h .ttl[data-task="${KEY("T2")}"]`).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  const tab = await opened;
  await tab.locator(".taskpage h1", { hasText: "Sample chief records" }).waitFor();
  assert.equal(await tab.locator(".taskpage .back").textContent(), "‹ Tasks", "a new tab has no page to go back to, so the back link opens the Tasks page");
  assert.equal(new URL(page.url()).hash, "#agents", "the first tab stays on the Agents page");
  assert.deepEqual(problems, []);
});

test("T1083: the task page shows each part from the logbook and the brief, in one column, in the approved order", async t => {
  const base = await board(t), { page, problems } = await open(t, base, taskPage("T2"));
  await page.locator(".about-card").waitFor();
  assert.deepEqual(await page.locator(".about-s h3").evaluateAll(list => list.map(h => h.firstChild.textContent)), ["Milestone", "Before and after", "Goal", "Why", "Criteria", "Status", "Cost"]);
  const lefts = await page.locator(".about-s").evaluateAll(list => list.map(part => part.getBoundingClientRect()).map((box, i, all) => [Math.round(box.left), i === 0 || box.top >= all[i - 1].bottom - 0.5]));
  assert.deepEqual(new Set(lefts.map(([left, below]) => `${left} ${below}`)).size, 1, "every part is under the one before it, on the same left edge");
  assert.match(await aboutPart(page, "Milestone").textContent(), /^MilestoneMilestone 1: Board redesignOne board for every chief\d+ of \d+ tasks merged$/);
  assert.equal(await aboutPart(page, "Before and after").textContent(), "Before and afterComes after: Sample pinned bundle (done).Needed by: Sample queue.");
  assert.equal(await aboutPart(page, "Goal").textContent(), `Goal${ABOUT.goal.replace("\n", "")}`);
  assert.equal(await aboutPart(page, "Why").textContent(), `Why${ABOUT.request}`);
  assert.deepEqual(await aboutPart(page, "Criteria").locator(".crit li").allTextContents(), [`${ABOUT.criteria[0]} · met`, `${ABOUT.criteria[1]} · not checked yet`, `${ABOUT.criteria[2]} · not checked yet`]);
  assert.equal(await aboutPart(page, "Criteria").locator("h3 .extra").textContent(), "1 of 3 met");
  await aboutPart(page, "Criteria").getByText("Who checked each line").click();
  assert.equal(await aboutPart(page, "Criteria").locator(".who li").textContent(), `${ABOUT.criteria[0]} · R45`);
  assert.match(await aboutPart(page, "Status").locator("p.now").textContent(), /^In progress: .*\. Next: /);
  assert.match(await aboutPart(page, "Cost").textContent(), /^Cost\d+ runsAgent time: .+ of 2 h \(\d+ %\)Tokens: 2\d\d k of 1\.5 M \(\d+ %\)$/);
  assert.deepEqual(await page.locator(".links > *").allTextContents(), ["Brief R20", "Reports · 1", "Pull request · none yet", "Milestone"]);
  await page.getByRole("tab", { name: /Log/ }).click();
  assert.match(page.url(), /&tab=log$/);
  await page.reload();
  await page.locator(".about-card").waitFor();
  assert.equal(await page.getByRole("tab", { name: /Log/ }).getAttribute("aria-selected"), "true", "a reload keeps the tab");
  await shoot(page, "task-T2-dark-1440.png");
  assert.deepEqual(problems, []);
});

test("T1083: a field with no data says unknown and why, never a blank", async t => {
  const base = await board(t);
  const cases = [
    ["T40", "Sample crash fix", { Goal: "unknown · The logbook keeps no brief of R25: sage keeps briefs only for newer runs.", Why: /^unknown · The logbook keeps no request for this task/, Criteria: "unknown · The logbook keeps no brief of R25: sage keeps briefs only for newer runs." }, /of an unknown budget: the brief is not read/],
    ["T4", "Sample queue", { Goal: "unknown · No agent has run on this task yet, so there is no brief.", Criteria: "unknown · No agent has run on this task yet, so there is no brief." }, /Agent time: unknown · no run of this task has a start timeTokens: unknown · no run of this task recorded its tokens/],
  ];
  for (const [id, title, parts, cost] of cases) {
    const { page, problems } = await open(t, base, taskPage(id));
    await page.locator(".taskpage h1", { hasText: title }).waitFor();
    await page.locator(".about-card").waitFor();
    for (const [label, text] of Object.entries(parts)) {
      const shown = await aboutPart(page, label).locator(".unk").textContent();
      if (text instanceof RegExp) assert.match(shown, text, `${id} ${label}`); else assert.equal(shown, text, `${id} ${label}`);
    }
    assert.match(await aboutPart(page, "Cost").textContent(), cost, `${id}: the cost says why`);
    const blank = await page.locator(".about-s").evaluateAll(list => list.filter(part => part.textContent.trim() === part.querySelector("h3").textContent.trim()).length);
    assert.equal(blank, 0, `${id}: no part is empty`);
    assert.deepEqual(problems, []);
  }
  const { page } = await open(t, base, "/app/#task?key=shared%2Fsample-app-abc123%2FT999");
  await page.locator(".taskpage h1", { hasText: "This task is not on the board" }).waitFor();
});

test("T1083 F-T1083-1: the Agents page and the task page read at 390, 768, 1024 and 1440 px with no sideways scroll, meet AA contrast and show the focus ring, in both themes", async t => {
  const base = await board(t);
  for (const theme of ["dark", "light"]) for (const width of [390, 768, 1024, 1440]) {
    const { page, problems } = await open(t, base, "/app/#agents", { theme, width });
    for (const [name, path] of [["agents", "/app/#agents"], ["task", taskPage("T2")]]) {
      await page.goto(`${base}${path}`);
      await page.locator(name === "agents" ? ".chief-box" : ".about-card").first().waitFor();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.equal(wide, 0, `${name}, ${theme}, ${width} px: no sideways scroll`);
      if (width === 390 || width === 1440) {
        assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${name}, ${theme}, ${width} px: every text meets AA`);
        await shoot(page, `${name}-${theme}-${width}.png`);
      }
    }
    const link = page.locator(".links a.btn").first();
    await link.focus();
    assert.equal(await link.evaluate(element => getComputedStyle(element).outlineStyle), "solid", `${theme} ${width}: the focus ring shows`);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid");
    assert.deepEqual(problems, []);
  }
});

test("T1083: only a running agent's outline moves, and reduced motion stops it", async t => {
  const base = await board(t);
  const moving = page => page.locator(".av .ar").evaluateAll(list => list.filter(ring => getComputedStyle(ring).animationName !== "none").map(ring => ring.closest(".av").className));
  const { page } = await open(t, base, "/app/#agents", { motion: "no-preference" });
  await page.locator(".chief-box").first().waitFor();
  const moves = await moving(page);
  assert.ok(moves.length > 0 && moves.every(name => /\bs-run\b/.test(name)), `only running outlines move, saw ${[...new Set(moves)]}`);
  const still = await open(t, base, "/app/#agents", { motion: "reduce" });
  await still.page.locator(".chief-box").first().waitFor();
  assert.deepEqual(await moving(still.page), [], "with reduced motion, no outline moves");
});

test("T1083: the arena card shows the candidates, then the judge, and says when its scores come", async t => {
  const base = await board(t), { page } = await open(t, base, "/app/#agents");
  const arena = page.locator(`section.acard.arena[aria-label="Arena of T11"]`);
  await arena.waitFor();
  assert.deepEqual(await arena.locator(".squad > *").evaluateAll(list => list.map(item => item.dataset.run ?? item.className)), ["R50", "R51", "ar-arrow", "ag ended wait"], "the candidates in order, the arrow, then the judge that waits");
  assert.equal(await arena.locator(".tot b").textContent(), "1 of 2 ended");
  assert.match(await arena.locator(".ar-res").textContent(), /^The scores, the base and the grafts show when the judge ends\./);
  assert.equal(await arena.locator('a.ag[data-run="R51"] .bd').count(), 0);
  assert.equal(await arena.locator('a.ag[data-run="R50"] .bd').textContent(), "✓");
});
