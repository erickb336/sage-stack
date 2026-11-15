import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const KEY = id => `shared/sample-app-abc123/${id}`;
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

async function board(t, { question = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-narrow-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, chiefCases: true, about: true, prs: true, stuck: true });
  if (question) {
    const runs = join(dir, "logbooks", "sample-app-abc123", "runs.tsv"), columns = readFileSync(runs, "utf8").split("\n")[0].split("\t");
    const row = { id: "R90", task: "T2", role: "implementer", round: "0", status: "question", started: new Date(Date.now() - 50 * 60_000).toISOString(), ended: new Date(Date.now() - 20 * 60_000).toISOString(), chief: "C1" };
    appendFileSync(runs, `${columns.map(column => row[column] ?? "").join("\t")}\n`);
  }
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}

// Wide, a title may end in an ellipsis that keeps room for its first words; narrow, it wraps.
// Each app page, the element that is ready when its rows show, and the elements that carry a task's title.
const PAGES = [
  ["overview", "/app/#", ".needs .q", ".needs .q, .ms .name a"],
  ["tasks", "/app/#tasks", ".row", ".row .text"],
  ["pull-requests", "/app/#pull-requests", ".prow", ".prow .ttl"],
  ["agents", "/app/#agents", ".chief-box", ".acard .ttl, .queue .ttl, .lane-l > span:last-child"],
  ["task", `/app/#task?key=${encodeURIComponent(KEY("T2"))}`, ".about-card", ".taskpage h1"],
];

test("T1099 F-T1099-46, F-T1099-36, F-T1099-44, F-T1099-65, F-T1099-69: every app page reads at 380, 390, 768, 1024 and 1440 px with no sideways scroll, nothing cut at the right edge, and a visible task title", async t => {
  const base = await board(t);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage(), problems = [], wrong = [];
  page.on("pageerror", error => problems.push(String(error)));
  for (const width of [380, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path, ready, titles] of PAGES) {
      await page.goto(`${base}${path}`);
      await page.locator(ready).first().waitFor();
      const seen = await page.evaluate(titles => {
        const view = document.documentElement.clientWidth;
        // An element that ends past the window's right edge is cut, also when an ancestor hides the overflow.
        const cut = [...document.querySelectorAll("body *")].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.right > view + 0.5 && getComputedStyle(element).position !== "fixed";
        }).map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
        const shown = [...document.querySelectorAll(titles)].map(element => {
          const box = element.getBoundingClientRect();
          const lines = Math.round(box.height / parseFloat(getComputedStyle(element).lineHeight));
          return { text: element.textContent.trim().slice(0, 20), width: Math.round(box.width), cut: element.scrollWidth > element.clientWidth + 1, lines };
        });
        return { wide: document.documentElement.scrollWidth - view, cut: [...new Set(cut)].slice(0, 8), shown };
      }, titles);
      const where = `${name} at ${width} px`, room = Math.min(120, width / 4);
      // Below 760 px a title wraps instead of ending in an ellipsis; a wrapped title keeps room for whole words.
      const narrow = seen.shown.filter(title => title.width < 1 || (title.cut && (width <= 760 || title.width < room)) || (title.lines > 1 && title.width < room));
      if (seen.wide > 0) wrong.push(`${where}: scrolls sideways by ${seen.wide} px`);
      if (seen.cut.length) wrong.push(`${where}: cut at the right edge: ${seen.cut.join(", ")}`);
      if (!seen.shown.length) wrong.push(`${where}: shows no task title`);
      if (narrow.length) wrong.push(`${where}: titles with no room: ${narrow.map(title => `${title.text} (${title.width} px)`).join(", ")}`);
      if (SHOTS && (width === 390 || width === 1440)) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true }); }
    }
  }
  assert.deepEqual(wrong, [], "each page reads at each width");
  assert.deepEqual(problems, []);
});

test("T1099 F-T1099-49: a run that ended on a product question reads needs you, in the question colour, not done and not red", async t => {
  const base = await board(t, { question: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/app/#agents`);
  const bar = page.locator('.timeline .lanes .lbar[title^="implementer R90"]');
  await bar.waitFor();
  assert.match(await bar.getAttribute("title"), /^implementer R90 · needs you · /);
  const colours = await page.evaluate(() => {
    const colour = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return { question: colour('.timeline .lanes .lbar[title^="implementer R90"]'), need: getComputedStyle(document.documentElement).getPropertyValue("--need").trim(), failed: colour(".legend .lbar.failed"), done: colour(".legend .lbar.done") };
  });
  const need = await page.evaluate(value => { const probe = document.createElement("i"); probe.style.color = value; document.body.append(probe); const rgb = getComputedStyle(probe).color; probe.remove(); return rgb; }, colours.need);
  assert.equal(colours.question, need, "the bar has the question colour");
  assert.notEqual(colours.question, colours.failed); assert.notEqual(colours.question, colours.done);
  assert.ok((await page.locator(".timeline .legend li").allTextContents()).includes("needs you"), "the legend names the colour");
  const card = page.locator("section.acard", { has: page.locator(".mono", { hasText: "lead · R20" }) });
  await card.locator("button", { hasText: /ended helper/ }).click();
  const tile = card.locator(".badge", { hasText: /^needs you$/ });
  assert.equal(await tile.count(), 1, "the ended helper's badge says needs you");
  assert.equal(await tile.evaluate(element => getComputedStyle(element).color), need, "in the question colour, not red");
});
