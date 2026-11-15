import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startPairing } from "../packages/sage-board/access.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { HOSTILE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
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

async function open(t, options = {}, { path = "/app/", theme = "dark", width = 1440, failed = [], seen, twin = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-agents-page-")), port = await freePort(), saved = process.env.SAGE_WORKTREES, now = Date.now();
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date(now).toISOString(), { agents: true, chiefCases: true, ...options });
  const at = minutes => new Date(now - minutes * 60_000).toISOString(), columns = readFileSync(join(logbook, "runs.tsv"), "utf8").split("\n")[0].split("\t");
  appendFileSync(join(logbook, "runs.tsv"), failed.map(([id, task, role, chief, started, ended]) => {
    const row = { id, task, role, chief, round: "0", status: "failed", started: at(started), ended: at(ended) };
    return `${columns.map(column => row[column] ?? "").join("\t")}\n`;
  }).join(""));
  if (twin) {
    const other = join(dir, "logbooks", "other-app-def456");
    cpSync(writeTasksLogbook(join(dir, "other"), join(dir, "worktrees2"), new Date(now).toISOString(), { agents: true, chiefCases: true }), other, { recursive: true });
    writeFileSync(join(other, "tasks.tsv"), readFileSync(join(other, "tasks.tsv"), "utf8").replace("Sample stopped chief", "Task of the other logbook"));
    for (const book of [logbook, other]) writeFileSync(join(book, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(book, "config.json"), "utf8")), name: "twin" }));
  }
  const stateDir = seen === undefined ? null : join(dir, "state");
  if (stateDir) { mkdirSync(stateDir, { mode: 0o700 }); writeFileSync(join(stateDir, "seen.json"), JSON.stringify({ at: at(seen) }), { mode: 0o600 }); }
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [], stateDir });
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
  t.after(async () => { await context.close(); await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  if (theme === "light") await page.addInitScript(() => localStorage.setItem("board-theme", "light"));
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  if (stateDir) {
    await page.getByPlaceholder("ABCD-EFGH").fill(startPairing(stateDir));
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.locator("#counts-h", { hasText: "Since you looked" }).waitFor();
  }
  return { page, base, requests, problems };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const shoot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
const box = (page, chief) => page.locator(`section.chief-box[data-chief="${KEY(chief)}"]`);

test("T1062: J4 is one click from the Overview: the top bar counts open the Agents page, with each chief, its leads and helpers, and the queue", async t => {
  const { page, base, requests, problems } = await open(t);
  const counts = page.locator("header.top a.limit");
  assert.deepEqual(await counts.allTextContents(), ["Agents 7 of 20 · C1 4 · C2 3 · 3 queued", "Leads 4 of 5"], "running agents of both chiefs against the logbook's limit");
  let clicks = 0;
  await counts.first().click(); clicks++;
  await page.locator("main h1", { hasText: "Agents" }).waitFor();
  assert.equal(clicks, 1, "J4: one click from the Overview");
  assert.deepEqual(await page.locator(".agents-kpis .kpi").allTextContents(), ["7 of 20agents running", "4 of 5leads", "3queued", "4need a look"], "2 failed runs, and the Codex runs R30 and R6 with no logbook write for 30 min");
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["C1 · Claude", "C2 · Codex", "C3 · Claude"], "every chief, Claude and Codex alike");
  assert.deepEqual(await box(page, "C1").locator(".acard-h .lead-id b").allTextContents(), ["lead · R25", "lead · R20"], "the oldest lead first");
  const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
  assert.deepEqual(await r20.locator(".arow .who").allTextContents(), ["code-reviewerR22", "security-reviewerR23"], "a lead's running helpers; the ended one is collapsed");
  assert.match(await r20.locator(".acard-f").textContent(), /^2 helpers running · 1 queuedShow 1 ended helper$/);
  assert.match(await r20.locator(".acard-h").textContent(), /^lead · R20 running1 h 1\d minT2 · Sample chief recordsopus$/);
  await r20.getByRole("button", { name: "Show 1 ended helper" }).click();
  assert.match(await r20.locator(".arow.ended").textContent(), /^implementerR21Donesonnet38 min210 k$/);
  assert.deepEqual(await box(page, "C2").locator(".acard.own .arow .who").allTextContents(), ["designerR31"], "a chief's own run with no lead");
  assert.deepEqual(await box(page, "C1").locator(".queue .arow").evaluateAll(rows => rows.map(row => row.dataset.run + " " + row.querySelector(".num:last-child").textContent)), ["R24 1st in line", "R33 3rd in line"]);
  assert.match(await box(page, "C2").locator(".queue .arow").textContent(), /^leadR32Queued · 2ndT30 · Sample crash reportsqueued \d\d:\d\dwaits 1 min2nd in line$/);
  assert.match(await box(page, "C3").textContent(), /Stopped0 leads · 0 runningNo agent is running\. Last event \d\d:\d\d: the heartbeat stopped\. Nothing moves on its own\.It owns T70 · Sample stopped chief\./, "a stopped chief shows as stopped, with its tasks");
  assert.equal(await box(page, "C3").getByRole("button").count(), 0, "the page only reads: no write action");
  assert.equal(await page.locator(".timeline .lane-group").count(), 2, "a lane group for each chief with agents");
  assert.deepEqual(await page.locator(".timeline .lane-group").first().locator(".lane-l").evaluateAll(lanes => lanes.map(lane => lane.textContent)),
    ["lead R25", "implementer R26", "ux-reviewer R27", "lead R20", "implementer R21", "code-reviewer R22", "security-reviewer R23", "qa R24", "implementer R33"]);
  assert.equal(await page.locator(".timeline .lbar.queued").count() - 1, 3, "a dashed bar for each queued run, and one in the legend");
  await shoot(page, "agents-dark.png");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

test("T1062: a row opens its task's side panel on the Agents page, and Escape closes it back to the row", async t => {
  const { page, problems } = await open(t, {}, { path: "/app/#agents" });
  const row = page.locator('.arow[data-run="R31"]');
  await row.click();
  await page.locator(".panel h2", { hasText: "Sample sync build" }).waitFor();
  assert.match(page.url(), /#agents\?task=shared%2Fsample-app-abc123%2FT11$/);
  assert.equal(await page.locator("main h1").textContent(), "Agents", "the panel opens beside the Agents page");
  await page.keyboard.press("Escape");
  await page.locator(".panel").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.task), KEY("T11"), "the focus returns to the row's task");
  assert.deepEqual(problems, []);
});

test("T1062: at the limit the counts turn amber, and the chief filter hides other chiefs' agents but keeps the counts whole", async t => {
  const { page, problems } = await open(t, { atLimit: true }, { path: "/app/#agents" });
  assert.deepEqual(await page.locator("header.top a.limit.full").allTextContents(), ["Agents 7 of 7 · C1 4 · C2 3 · 3 queued", "Leads 4 of 4"]);
  assert.deepEqual(await page.locator(".agents-kpis .kpi.full .l").allTextContents(), ["agents running · at the limit", "leads · at the limit", "queued"]);
  await shoot(page, "agents-at-limit-dark.png");
  await page.locator('button.chip[data-chief="shared/sample-app-abc123/C2"]').click();
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["C2 · Codex"]);
  assert.equal(await page.locator(".agents-kpis .kpi").first().textContent(), "7 of 7agents running · at the limit", "the limit is shared, so the counts stay whole");
  assert.deepEqual(problems, []);
});

test("T1062: agent text from the logbook is text, never markup", async t => {
  const { page, problems } = await open(t, { hostile: true }, { path: "/app/#agents" });
  const row = page.locator('.arow[data-run="R40"]');
  assert.equal(await row.locator(".tline").textContent(), `T50 · ${HOSTILE_TEXT.title}`);
  assert.equal(await row.locator(".mdl").textContent(), `<img src=x onerror="window.hacked=12">model`);
  assert.equal(await page.evaluate(() => window.hacked ?? null), null);
  assert.equal(await page.locator("main img").count(), 0);
  assert.deepEqual(problems, []);
});

test("T1062: the Agents page meets AA contrast in both themes, at 1024 px too, and the keyboard reaches each row in order", async t => {
  for (const theme of ["dark", "light"]) {
    const { page, problems } = await open(t, {}, { path: "/app/#agents", theme });
    await page.locator(".chief-box").first().waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}: every text meets AA`);
    if (theme === "light") await shoot(page, "agents-light.png");
    assert.deepEqual(problems, []);
  }
  const { page } = await open(t, {}, { path: "/app/#agents", width: 1024 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 1024 px");
  await shoot(page, "agents-1024.png");
  await page.locator("header.top a.limit").first().focus();
  const seen = [];
  for (let i = 0; i < 60 && seen.length < 4; i++) {
    await page.keyboard.press("Tab");
    const run = await page.evaluate(() => document.activeElement?.dataset.run ?? null);
    if (run) seen.push(run);
  }
  assert.deepEqual(seen, ["R25", "R27", "R20", "R22"], "Tab moves through the lead cards and their rows in reading order");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "the focus ring shows");
});

test("T1062 F-T1062-13: 'need a look' equals the Overview's Stuck count, and a failed helper marks its lead and shows as a row", async t => {
  const { page, problems } = await open(t);
  const stuck = await page.locator('.counts .kpi[data-count="stuck"] .n').textContent();
  await page.locator("header.top a.limit").first().click();
  await page.locator("main h1", { hasText: "Agents" }).waitFor();
  assert.equal(await page.locator('.agents-kpis .kpi[data-count="look"] .n').textContent(), stuck, "one count on both pages");
  const r25 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R25"]') });
  assert.equal(await r25.locator(".acard-h .badge.look").textContent(), "1 helper needs a look", "the lead card is marked");
  assert.match(await r25.locator('.arow[data-run="R27"]').textContent(), /^ux-reviewerR27Failed/, "the failed helper is a row, not hidden in the ended list");
  const failed = box(page, "C1").locator('section.acard.own[aria-label="Failed in the last 24 hours"]');
  assert.deepEqual(await failed.locator(".arow .who").allTextContents(), ["implementerR1"], "a failed run with no running lead shows too");
  assert.deepEqual(problems, []);
});

test("T1062 F-T1062-8, F-T1062-14, F-T1062-17, F-T1062-18, F-T1062-19: every counted agent is a row, the queue text never overlaps, and the long lists say what they hide", async t => {
  for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 1024]]) {
    const { page, problems } = await open(t, { agentEdges: true }, { path: "/app/#agents", theme, width });
    await page.locator(".chief-box").first().waitFor();
    const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
    assert.equal(await r20.locator('.arow[data-run="R36"]').count(), 1, "a running helper with no chief shows under its lead");
    const rows = await page.locator("main .arow[data-run], main .acard-h[data-run]").evaluateAll(links => links.map(link => link.dataset.run));
    const running = await page.locator("main [data-run]").evaluateAll(links => links.filter(link => /\b(running|look)\b/.test(link.querySelector(".badge").className)).map(link => link.dataset.run));
    assert.equal(new Set(running).size, Number((await page.locator('.agents-kpis .kpi[data-count="agents"] .n').textContent()).split(" ")[0]), "each running agent that the counts name is a row");
    assert.ok(["R34", "R35"].every(id => rows.includes(id)), "a pe run and a run of the lead's second show as the chief's own runs");
    assert.match(await r20.locator("button.more-ended").textContent(), /^Show the last 20 of 1,300 ended helpers$/);
    assert.match(await page.locator('.arow[data-run="R38"]').textContent(), /^qaR38Failedno agent started within 10 minutes of its admission/, "a failed run shows its reason");
    assert.match(await box(page, "C3").locator(".stopped-note").textContent(), /^No run of this chief shows activity, although the logbook lists the runs below\. Last event/, "a stopped chief with listed runs does not say it has none");
    const overlaps = await page.locator(".queue").evaluateAll(queues => queues.flatMap(queue => {
      const edge = queue.getBoundingClientRect();
      return [...queue.querySelectorAll(".arow")].flatMap(row => {
        const parts = [...row.children].map(part => { const text = document.createRange(); text.selectNodeContents(part); return text.getBoundingClientRect(); });
        return parts.flatMap((a, i) => [
          ...(a.left < edge.left || a.right > edge.right - 8 ? [`${row.dataset.run} part ${i} leaves the queue box`] : []),
          ...parts.slice(i + 1).filter(b => a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top).map(() => `${row.dataset.run} part ${i} overlaps`),
        ]);
      });
    }));
    assert.deepEqual(overlaps, [], `${theme} ${width}: queued rows keep their text apart and inside the queue`);
    assert.match(await page.locator('.queue .arow[data-run="R37"]').textContent(), /waits 8 h 45 min/);
    if (width === 1440) await shoot(page, `agents-round1-${theme}.png`);
    assert.deepEqual(problems, []);
  }
});

test("F-T1062-42: two logbooks with one display name and the same chief ids: a stopped chief lists only its own logbook's tasks", async t => {
  const { page, problems } = await open(t, {}, { path: "/app/#agents", twin: true });
  const owns = chief => page.locator(`section.chief-box.stopped[data-chief="${chief}"] .stopped-note a`).evaluateAll(links => links.map(link => `${link.textContent} ${link.dataset.task}`));
  await page.locator('section.chief-box.stopped[data-chief="shared/other-app-def456/C3"]').waitFor();
  assert.deepEqual(await owns(KEY("C3")), [`T70 · Sample stopped chief ${KEY("T70")}`], "C3 of the first logbook owns only its own T70");
  assert.deepEqual(await owns("shared/other-app-def456/C3"), ["T70 · Task of the other logbook shared/other-app-def456/T70"], "C3 of the second logbook owns only its own T70");
  assert.deepEqual(problems, []);
});

test("F-T1062-44: a chief with no agent says that no agent is running", async t => {
  const { page, problems } = await open(t, { agents: false }, { path: "/app/#agents" });
  await box(page, "C1").waitFor();
  assert.equal(await box(page, "C1").locator("p.empty").textContent(), "No agent is running now.");
  assert.match(await box(page, "C3").locator(".stopped-note").textContent(), /^No agent is running\. Last event/);
  assert.deepEqual(problems, []);
});

test("F-T1062-26, F-T1062-29: in a paired browser, the Overview's Stuck counts the Agents page's list, for a last look 10 min or 3 days ago", async t => {
  const failed = [["R97", "T40", "qa", "C1", 2900, 2880], ["R98", "T40", "qa", "C1", 10, -30]];
  for (const seen of [10, 3 * 1440]) {
    const { page, problems } = await open(t, {}, { seen, failed });
    const stuck = await page.locator('.counts .kpi[data-count="stuck"] .n').textContent();
    if (seen === 10) await shoot(page, "overview-round2-paired.png");
    await page.locator("header.top a.limit").first().click();
    await page.locator("main h1", { hasText: "Agents" }).waitFor();
    const look = await page.locator('.agents-kpis .kpi[data-count="look"] .n').textContent();
    assert.deepEqual([stuck, look], ["4", "4"], `last look ${seen} min ago: R97 failed 2 days ago and R98 ends after now, so neither counts on either page`);
    assert.deepEqual(problems, []);
  }
});

test("F-T1062-22, F-T1062-24, F-T1062-32: each chief's count is the same in the top bar and its box; only what the count counts has the look colour; long lists of failed runs say how many more", async t => {
  const failed = Array.from({ length: 30 }, (_, i) => [`R${3000 + i}`, "T2", "qa", "C1", 60 - i, 10]);
  const { page, problems } = await open(t, { agentEdges: true }, { path: "/app/#agents", failed });
  await page.locator(".chief-box").first().waitFor();
  const top = Object.fromEntries([...(await page.locator("header.top a.limit").first().textContent()).matchAll(/ · (\S+(?: chief)?) (\d+)(?= ·|$)/g)].map(([, chief, n]) => [chief, Number(n)]));
  const boxes = Object.fromEntries((await page.locator("section.chief-box").evaluateAll(list => list.map(box => [box.querySelector("h2").textContent.split(" · ")[0], box.querySelector(".card-h .hint").textContent])))
    .flatMap(([chief, hint]) => { const n = Number(/(\d+) running/.exec(hint)[1]); return n ? [[chief === "No chief recorded" ? "no chief" : chief, n]] : []; }));
  assert.deepEqual(top, boxes, "each chief's running count is the same in both places");
  assert.deepEqual(top, { C1: 7, C2: 3 });
  const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
  assert.equal(await r20.locator(".acard-h .badge.look").textContent(), "30 helpers need a look", "the lead counts every failed helper");
  assert.equal(await r20.locator(".arow.ended .badge.failed").count(), 20, "20 failed helpers are rows");
  assert.equal(await r20.locator("p.more-done").textContent(), "and 10 more failed");
  const long = page.locator('.arow[data-run="R22"] .badge');
  assert.deepEqual([await long.textContent(), await long.getAttribute("class")], ["running long", "badge running"], "running long is calm: it does not need a look");
  assert.equal(await page.locator('.arow[data-run="R22"] .why').getAttribute("class"), "why", "and so is its note");
  const looks = await page.locator('.agents-kpis .kpi[data-count="look"] .n').textContent();
  assert.equal(Number(looks), 4 + 1 + 30, "the base 4, R38 and the 30 failed helpers");
  const marked = await page.locator("main [data-run]").evaluateAll(list => list.filter(mark => /\b(look|failed)\b/.test(mark.querySelector(".badge").className)).length);
  assert.equal(marked, Number(looks) - 10, "each counted row, and nothing else, has the look colour; 10 hide behind 'and 10 more failed'");
  await shoot(page, "agents-round2-dark.png");
  assert.deepEqual(problems, []);
});
