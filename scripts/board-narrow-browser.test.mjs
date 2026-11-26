import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const chromium = requireBrowser();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const KEY = id => `shared/sample-app-abc123/${id}`;
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function board(t, { question = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-narrow-")), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, chiefCases: true, about: true, prs: true, stuck: true });
  if (question) {
    const runs = join(dir, "logbooks", "sample-app-abc123", "runs.tsv"), columns = readFileSync(runs, "utf8").split("\n")[0].split("\t");
    const row = { id: "R90", task: "T2", role: "implementer", round: "0", status: "question", started: new Date(Date.now() - 50 * 60_000).toISOString(), ended: new Date(Date.now() - 20 * 60_000).toISOString(), chief: "C1" };
    appendFileSync(runs, `${columns.map(column => row[column] ?? "").join("\t")}\n`);
  }
  const server = quietBoard({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port: 0, app: APP });
  const { port } = await server.start();
  await server.ready();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}

const PAGES = [
  ["overview", "/app/#", ".needs .q", ".needs .q, .ms .name a"],
  ["tasks", "/app/#tasks", ".row", ".row .text"],
  ["pull-requests", "/app/#pull-requests", ".prow", ".prow .ttl"],
  ["agents", "/app/#agents", ".chief-box", ".acard .ttl, .queue .ttl, .lane-l > span:last-child"],
  ["stats", "/app/#stats", ".chart", ".chart h2, .stat-tiles .l"],
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
  assert.ok((await page.locator(".timeline .legend li").allTextContents()).some(text => text.startsWith("needs you")), "the legend names the colour");
  const card = page.locator("section.acard", { has: page.locator(".mono", { hasText: "lead · R20" }) });
  await card.locator("button", { hasText: /ended helper/ }).click();
  const tile = card.locator(".badge", { hasText: /^needs you$/ });
  assert.equal(await tile.count(), 1, "the ended helper's badge says needs you");
  assert.equal(await tile.evaluate(element => getComputedStyle(element).color), need, "in the question colour, not red");
});

test("T1099 F-T1099-54: in the Tasks rows, a step that needs you carries ? and a step with a problem carries !, so it reads without colour", async t => {
  const base = await board(t);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/app/#tasks`);
  await page.locator(".row").first().waitFor();
  const steps = await page.locator(".row .step").evaluateAll(list => list.map(step => ({ status: step.className.replace("step", "").trim(), shown: step.querySelector('[aria-hidden="true"]')?.textContent.trim() ?? "", heard: step.querySelector(".sr")?.textContent ?? "" })));
  const of = status => steps.filter(step => step.status === status);
  assert.ok(of("need").length && of("fail").length && of("run").length, `the sample has each kind of step: ${JSON.stringify(steps)}`);
  assert.deepEqual([...new Set(of("need").map(step => step.shown + step.heard))], ["?needs you: "]);
  assert.deepEqual([...new Set(of("fail").map(step => step.shown + step.heard))], ["!done · failed: "]);
  assert.deepEqual([...new Set(of("run").map(step => step.shown))], [""], "a step in progress needs no mark");
});

test("T1159 (F-T1159-50): on a phone the board's shell is compact and never covers the page: the header ends in the top third of the screen (283 of 844 px before on macOS), scrolls away with the page, and keeps 44 px targets", async t => {
  const base = await board(t);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  t.after(() => context.close());
  const page = await context.newPage();
  for (const [name, path] of [["overview", "/app/#"], ["tasks", "/app/#tasks"], ["question", `/app/#question?key=${encodeURIComponent(KEY("G4"))}`], ["stats", "/app/#stats"]]) {
    await page.goto(`${base}${path}`);
    await page.locator("main h1").waitFor();
    const shell = await page.evaluate(() => {
      const top = document.querySelector("header.top"), box = element => element.getBoundingClientRect();
      return { bottom: Math.round(box(top).bottom), third: Math.floor(innerHeight / 3), position: getComputedStyle(top).position, small: [...document.querySelectorAll(".nav a, header.top button")].filter(item => box(item).height < 44).map(item => item.textContent) };
    });
    assert.ok(shell.bottom <= shell.third, `${name}: the header ends at ${shell.bottom} px, below the top third of the screen (${shell.third} px)`);
    assert.equal(shell.position, "static", `${name}: the header scrolls away, so it covers nothing`);
    assert.deepEqual(shell.small, [], `${name}: each page link and header button is at least 44 px high`);
  }
});

test("F-T1168-7: at 390 px each control on Overview, Tasks and a task page is a 44 px touch target: chips, filters, tabs and buttons", async t => {
  const base = await board(t);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  t.after(() => context.close());
  const page = await context.newPage();
  for (const [name, path, ready] of [["overview", "/app/#", ".needs .q"], ["tasks", "/app/#tasks", ".row"], ["task", `/app/#task?key=${encodeURIComponent(KEY("T2"))}`, ".about-card"]]) {
    await page.goto(`${base}${path}`);
    await page.locator(ready).first().waitFor();
    const small = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=radio], [type=checkbox]), summary, [role=tab], .chip, a.limit")]
      .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== "hidden")
      .map(item => [item.tagName.toLowerCase(), item.className, item.textContent.trim().slice(0, 30), Math.round(item.getBoundingClientRect().height)])
      .filter(([, , , height]) => height < 44));
    assert.deepEqual(small, [], `${name}: each control is at least 44 px high`);
  }
});

test("F-T1159-50 in CI (a flaky test): on a phone the side bar keeps its own height when the page is shorter than the screen, also while a page loads", async t => {
  const base = await board(t);
  const context = await browser.newContext({ viewport: { width: 390, height: 3000 }, colorScheme: "dark" });
  t.after(() => context.close());
  const page = await context.newPage();
  for (const [name, path] of [["overview", "/app/#"], ["question", `/app/#question?key=${encodeURIComponent(KEY("G4"))}`], ["stats", "/app/#stats"]]) {
    await page.goto(`${base}${path}`);
    await page.locator("main h1").waitFor();
    const { side, nav } = await page.evaluate(() => ({ side: Math.round(document.querySelector(".side").getBoundingClientRect().height), nav: Math.round(document.querySelector(".side > nav").getBoundingClientRect().height) }));
    assert.ok(side <= nav + 60, `${name}: the side bar is ${side} px high for a ${nav} px page list: the grid gave it the empty space of the screen`);
  }
});
