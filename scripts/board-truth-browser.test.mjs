import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { boardOverview, buildBoardModel, readBoardSources } from "../packages/sage-core/index.mjs";
import { writeSampleLogbooks } from "./board-sample.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = loadBoardApp(join(dirname(fileURLToPath(import.meta.url)), "..", "plugins/sage/board/app"));
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function board(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-truth-"))), now = new Date().toISOString();
  const sources = writeSampleLogbooks(join(dir, "sample"), { now }).map(({ id, label, path }) => ({ id, label, path }));
  const server = createBoardServer({ sources, port: 0, app: APP, settleReads: [] });
  const { port } = await server.start();
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const tasks = boardOverview(buildBoardModel(readBoardSources(sources, { now: Date.parse(now) }), { now })).tasks;
  const key = id => tasks.find(task => task.id === id && task.key.startsWith("claude/sage-")).key;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage(), problems = [];
  page.on("pageerror", error => problems.push(String(error)));
  const base = `http://127.0.0.1:${port}/app/`;
  const go = async hash => { await page.goto(`${base}${hash}`); await page.locator("main h1").waitFor(); };
  return { page, go, key, taskPage: id => `#task?key=${encodeURIComponent(key(id))}`, problems };
}
const part = (page, label) => page.locator(".about-s").filter({ has: page.locator("h3", { hasText: new RegExp(`^${label}`) }) });

test("T1120 S2, S8: the Overview's problem count opens the Agents page, which uses the same label; a failed check asks the owner nothing", async t => {
  const { page, go, problems } = await board(t);
  await go("");
  const count = page.locator('[data-count="stuck"]');
  await count.waitFor();
  const link = count.getByRole("link", { name: "With a problem flag" });
  assert.equal(await link.getAttribute("href"), "#agents");
  assert.doesNotMatch(await page.locator("main").innerText(), /Checks failed/, "S8: Needs you has no row for the chief's repair");
  await link.click();
  await page.locator('.agents-kpis [data-count="look"]').first().waitFor();
  assert.equal(await page.locator('.agents-kpis [data-count="look"] .l').first().textContent(), "! with a problem flag", "one label for the same runs on both pages");
  assert.deepEqual(problems, []);
});

test("T1120 S6: a task that waits for an abandoned task shows ⊘ cannot start on its row and its page", async t => {
  const { page, go, key, taskPage, problems } = await board(t);
  await go("#tasks");
  const row = page.locator(`a.row[data-task="${key("T211")}"]`);
  await row.waitFor();
  assert.equal(await row.locator(".title .badge").last().innerText(), "⊘ cannot start");
  assert.equal(await row.locator(".title .badge").last().getAttribute("title"), "Waits for T208 (stopped): it cannot start.");
  await go(taskPage("T211"));
  await part(page, "Before and after").waitFor();
  assert.equal(await part(page, "Before and after").locator("p.waits").innerText(), "⊘ Waits for T208 (stopped): it cannot start.");
  assert.deepEqual(problems, []);
});

test("T1120 S10, S20: the task page links its open question to the question view, and says plainly when no request is recorded", async t => {
  const { page, go, key, taskPage, problems } = await board(t);
  await go(taskPage("T305"));
  const ask = part(page, "Status").getByRole("link", { name: "Sample: picker design A, B or C?" });
  await ask.waitFor();
  assert.equal(await ask.getAttribute("href"), `#question?key=${encodeURIComponent(`${key("T305").slice(0, -"/T305".length)}/G4`)}`);
  assert.equal(await part(page, "Why").locator("p").textContent(), "Not recorded. The chief did not record your request for this task.", "no state-tool command for the owner");
  await ask.click();
  await page.waitForURL(/#question\?key=/);
  await page.getByText("Sample: picker design A, B or C?").first().waitFor();
  assert.deepEqual(problems, []);
});

test("T1120 S11: a merged PR counts the clean cycle that carried over a clean merge of main, and names the reviewed head", async t => {
  const { page, go, key, problems } = await board(t);
  await go("#pull-requests");
  const row = page.locator("li.prow").filter({ has: page.locator(`a.ttl[data-task="${key("T206")}"]`) });
  await row.waitFor();
  assert.match(await row.locator(".cyc").innerText(), /^1 clean cycle · carried from [0-9a-f]{7}$/);
  assert.deepEqual(problems, []);
});
