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

async function open(t, options = {}, { path = "/app/", theme = "dark", width = 1440, failed = [], seen, twin = false, limits = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-agents-page-")), port = await freePort(), saved = process.env.SAGE_WORKTREES, now = Date.now();
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date(now).toISOString(), { agents: true, chiefCases: true, ...options });
  const at = minutes => new Date(now - minutes * 60_000).toISOString(), columns = readFileSync(join(logbook, "runs.tsv"), "utf8").split("\n")[0].split("\t");
  appendFileSync(join(logbook, "runs.tsv"), failed.map(([id, task, role, chief, started, ended]) => {
    const row = { id, task, role, chief, round: "0", status: "failed", started: at(started), ended: at(ended) };
    return `${columns.map(column => row[column] ?? "").join("\t")}\n`;
  }).join(""));
  if (limits) writeFileSync(join(logbook, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(logbook, "config.json"), "utf8")), ...limits }));
  if (twin) {
    const other = join(dir, "logbooks", "other-app-def456");
    cpSync(writeTasksLogbook(join(dir, "other"), join(dir, "worktrees2"), new Date(now).toISOString(), { agents: true, chiefCases: true }), other, { recursive: true });
    writeFileSync(join(other, "tasks.tsv"), readFileSync(join(other, "tasks.tsv"), "utf8").replace("Sample stopped chief", "Task of the other logbook"));
    for (const book of [logbook, other]) writeFileSync(join(book, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(book, "config.json"), "utf8")), name: "twin" }));
  }
  const stateDir = seen === undefined ? null : join(dir, "state");
  if (stateDir) { mkdirSync(stateDir, { mode: 0o700 }); writeFileSync(join(stateDir, "seen.json"), JSON.stringify({ at: at(seen) }), { mode: 0o600 }); }
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair" });
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
  assert.deepEqual(await counts.allTextContents(), ["Agents 7 of 20 · C1 4 · C2 3 · 3 waiting", "Leads 4 of 5"], "running agents of both chiefs against the logbook's limit");
  let clicks = 0;
  await counts.first().click(); clicks++;
  await page.locator("main h1", { hasText: "Agents" }).waitFor();
  assert.equal(clicks, 1, "J4: one click from the Overview");
  assert.deepEqual(await page.locator(".agents-kpis .kpi").allTextContents(), ["agents in progress7 of 20", "leads4 of 5", "waiting3", "! with a problem flag4"], "2 failed runs, and the Codex runs R30 and R6 with no logbook write for 30 min");
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["Claude · C1", "Codex · C2", "Claude · C3"], "every chief, Claude and Codex alike");
  assert.deepEqual(await box(page, "C1").locator(".acard-h .sub .mono").allTextContents(), ["lead · R25", "lead · R20"], "the oldest lead first");
  const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
  assert.deepEqual(await r20.locator("a.ag .r1").allTextContents(), ["code-reviewerR22", "security-reviewerR23"], "a lead's running helpers; the ended one is collapsed");
  assert.match(await r20.locator(".acard-f").textContent(), /^Lead's own work: 1 h 1\d min · opus2 in progress · 1 waiting · 4 helpers$/);
  assert.match(await r20.locator(".acard-h").textContent(), /^Sample chief recordslead · R20 in progress · Build1 h 1\d min210 k tok · with helpersAbout ›$/, "the tokens of the lead and its helpers: R21 has 210 k");
  assert.equal(await r20.locator("button.more-ended").textContent(), "Show 1 ended helper");
  await r20.getByRole("button", { name: "Show 1 ended helper" }).click();
  assert.match(await r20.locator("a.ag.ended").textContent(), /^✓implementerR21done38 min · 210 ksonnet$/);
  assert.deepEqual(await box(page, "C2").locator(".acard.own a.ag .r1").allTextContents(), ["designerR31"], "a chief's own run with no lead");
  assert.deepEqual(await box(page, "C1").locator(".queue a.ag").evaluateAll(rows => rows.map(row => row.dataset.run + " " + row.querySelector(".mdl").textContent.split(" · ")[1])), ["R24 1st in line", "R33 3rd in line"]);
  assert.match(await box(page, "C2").locator(".queue a.ag").textContent(), /^leadT30 · R32waiting · 2nd in the queuewaits 1 minT30 · Sample crash reportsqueued \d\d:\d\d · 2nd in line$/);
  assert.match(await box(page, "C3").textContent(), /stopped0 leads · 0 in progressNo agent is running\. Last event \d\d:\d\d: the heartbeat stopped\. Nothing moves on its own\.It owns T70 · Sample stopped chief\./, "a stopped chief shows as stopped, with its tasks");
  assert.equal(await box(page, "C3").getByRole("button").count(), 0, "the page only reads: no write action");
  assert.equal(await page.locator(".timeline .lane-group").count(), 2, "a lane group for each chief with agents");
  assert.deepEqual(await page.locator(".timeline .lane-group").first().locator(".lane-l").evaluateAll(lanes => lanes.map(lane => lane.textContent)),
    ["lead R25", "implementer R26", "ux-reviewer R27", "lead R20", "implementer R21", "code-reviewer R22", "security-reviewer R23", "qa R24", "implementer R33"]);
  assert.equal(await page.locator(".timeline .lbar.queued").count() - 1, 3, "a dashed bar for each queued run, and one in the legend");
  assert.deepEqual(await page.locator(".timeline .legend li").allTextContents(), ["in progress", "done", "needs you", "stopped · failed", "in progress · may be stuck, or stopped · run still open", "waiting"], "F-T1096-7: the legend uses the table's words");
  await shoot(page, "agents-dark.png");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

test("T1083: a click on an agent opens its task's page, and Back returns to the Agents page", async t => {
  const { page, problems } = await open(t, {}, { path: "/app/#agents" });
  await page.locator('a.ag[data-run="R31"]').click();
  await page.locator("main h1", { hasText: "Sample sync build" }).waitFor();
  assert.match(page.url(), /#task\?key=shared%2Fsample-app-abc123%2FT11$/);
  await page.goBack();
  await page.locator("main h1", { hasText: "Agents" }).waitFor();
  await page.waitForFunction(() => document.activeElement?.dataset.run === "R31");
  assert.deepEqual(problems, []);
});

test("T1099 (F-T1099-27): a count over its limit says over the limit, not at the limit", async t => {
  const { page, problems } = await open(t, {}, { path: "/app/#agents", limits: { max_agents: 5, max_leads: 3 } });
  assert.deepEqual(await page.locator(".agents-kpis .kpi.full .l").allTextContents(), ["agents in progress · over the limit", "leads · over the limit", "waiting"]);
  assert.deepEqual(problems, []);
});

test("T1062: at the limit the counts turn amber, and the chief filter hides other chiefs' agents but keeps the counts whole", async t => {
  const { page, problems } = await open(t, { atLimit: true }, { path: "/app/#agents" });
  assert.deepEqual(await page.locator("header.top a.limit.full").allTextContents(), ["Agents 7 of 7 · C1 4 · C2 3 · 3 waiting", "Leads 4 of 4"]);
  assert.deepEqual(await page.locator(".agents-kpis .kpi.full .l").allTextContents(), ["agents in progress · at the limit", "leads · at the limit", "waiting"]);
  await shoot(page, "agents-at-limit-dark.png");
  await page.locator('button.chip[data-chief="shared/sample-app-abc123/C2"]').click();
  assert.deepEqual(await page.locator("section.chief-box h2").allTextContents(), ["Codex · C2"]);
  assert.equal(await page.locator(".agents-kpis .kpi").first().textContent(), "agents in progress · at the limit7 of 7", "the limit is shared, so the counts stay whole");
  assert.deepEqual(problems, []);
});

test("T1062: agent text from the logbook is text, never markup", async t => {
  const { page, problems } = await open(t, { hostile: true }, { path: "/app/#agents" });
  const row = page.locator('a.ag[data-run="R40"]');
  assert.equal(await page.locator(`.own-h a.ttl[data-task="${KEY("T50")}"]`).textContent(), HOSTILE_TEXT.title);
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
  assert.equal(await r25.locator(".acard-h .badge.look").textContent(), "! 1 helper with a problem flag", "the lead card is marked");
  assert.match(await r25.locator('a.ag[data-run="R27"]').textContent(), /^!ux-reviewerR27stopped · failed/, "the failed helper is a row, not hidden in the ended list, with the table's word and flag (F-T1096-1, F-T1096-7)");
  const failed = box(page, "C1").locator('section.acard.own[aria-label="Failed in the last 24 hours"]');
  assert.deepEqual(await failed.locator("a.ag .r1").allTextContents(), ["designerR1"], "a failed run with no running lead shows too");
  assert.deepEqual(problems, []);
});

test("T1062 F-T1062-8, F-T1062-14, F-T1062-17, F-T1062-18, F-T1062-19: every counted agent is a row, the queue text never overlaps, and the long lists say what they hide", async t => {
  for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 1024]]) {
    const { page, problems } = await open(t, { agentEdges: true }, { path: "/app/#agents", theme, width });
    await page.locator(".chief-box").first().waitFor();
    const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
    assert.equal(await r20.locator('a.ag[data-run="R36"]').count(), 1, "a running helper with no chief shows under its lead");
    const rows = await page.locator("main [data-run]").evaluateAll(links => links.map(link => link.dataset.run));
    const running = await page.locator("main [data-run]").evaluateAll(links => links.filter(link => /\b(running|look)\b/.test((link.closest(".acard-h") ?? link).querySelector(".badge").className)).map(link => link.dataset.run));
    assert.equal(new Set(running).size, Number((await page.locator('.agents-kpis .kpi[data-count="agents"] .n').textContent()).split(" ")[0]), "each running agent that the counts name is a row");
    assert.ok(["R34", "R35"].every(id => rows.includes(id)), "a pe run and a run of the lead's second show as the chief's own runs");
    assert.match(await r20.locator("button.more-ended").textContent(), /^Show the last 20 of 1,300 ended helpers$/);
    assert.match(await page.locator('a.ag[data-run="R38"]').textContent(), /^!qaR38stopped · failed.*no agent started within 10 minutes of its admission/, "a failed run shows its reason");
    assert.match(await box(page, "C3").locator(".stopped-note").textContent(), /^No run of this chief shows activity, although the logbook lists the runs below\. Last event/, "a stopped chief with listed runs does not say it has none");
    const overlaps = await page.locator(".queue").evaluateAll(queues => queues.flatMap(queue => {
      const edge = queue.getBoundingClientRect();
      return [...queue.querySelectorAll("a.ag")].flatMap(row => {
        const parts = [...row.children].map(part => { const text = document.createRange(); text.selectNodeContents(part); return text.getBoundingClientRect(); });
        return parts.flatMap((a, i) => [
          ...(a.left < edge.left || a.right > edge.right - 8 ? [`${row.dataset.run} part ${i} leaves the queue box`] : []),
          ...parts.slice(i + 1).filter(b => a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top).map(() => `${row.dataset.run} part ${i} overlaps`),
        ]);
      });
    }));
    assert.deepEqual(overlaps, [], `${theme} ${width}: queued rows keep their text apart and inside the queue`);
    assert.match(await page.locator('.queue a.ag[data-run="R37"]').textContent(), /waits 8 h 45 min/);
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

test("T1098 (R4165-1): two logbooks with one display name and the same chief ids: the Overview's stopped chief lists and gives only its own logbook's tasks", async t => {
  const { page, problems } = await open(t, {}, { twin: true });
  const owns = chief => page.locator(`li[data-stopped="${chief}"] ul.owned > li`).evaluateAll(rows => rows.map(row => `${row.querySelector("a").textContent} ${row.querySelector("a").getAttribute("href")} [${row.querySelector("button")?.textContent}]`));
  await page.locator('li[data-stopped="shared/other-app-def456/C3"] ul.owned').waitFor();
  assert.deepEqual(await owns(KEY("C3")), [`T70 · Sample stopped chief #task?key=${encodeURIComponent(KEY("T70"))} [Give to another chief]`], "C3 of the first logbook lists and offers only its own T70");
  assert.deepEqual(await owns("shared/other-app-def456/C3"), [`T70 · Task of the other logbook #task?key=${encodeURIComponent("shared/other-app-def456/T70")} [Give to another chief]`], "C3 of the second logbook lists and offers only its own T70");
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
  const boxes = Object.fromEntries((await page.locator("section.chief-box").evaluateAll(list => list.map(box => [box.querySelector("h2").textContent.split(" · ").at(-1), box.querySelector(".card-h .hint").textContent])))
    .flatMap(([chief, hint]) => { const n = Number(/(\d+) in progress/.exec(hint)[1]); return n ? [[chief === "No chief recorded" ? "no chief" : chief, n]] : []; }));
  assert.deepEqual(top, boxes, "each chief's running count is the same in both places");
  assert.deepEqual(top, { C1: 7, C2: 3 });
  const r20 = box(page, "C1").locator("section.acard", { has: page.locator('[data-run="R20"]') });
  assert.equal(await r20.locator(".acard-h .badge.look").count(), 0, "T1120 S3: each of the 30 failed qa helpers has a later qa run (R24), so none has a problem flag");
  assert.equal(await r20.locator("p.more-done").count(), 0, "no failed helper hides behind 'more'");
  const long = page.locator('a.ag[data-run="R22"] .badge');
  assert.deepEqual([await long.textContent(), await long.getAttribute("class")], ["in progress · running long", "badge running"], "running long is calm: it does not need a look");
  assert.equal(await page.locator('a.ag[data-run="R22"] .awhy').getAttribute("class"), "awhy", "and so is its note");
  const looks = await page.locator('.agents-kpis .kpi[data-count="look"] .n').textContent();
  assert.equal(Number(looks), 4 + 1, "the base 4 and R38; T1120 S3: not the 30 failed helpers that ran again");
  const marked = await page.locator("main [data-run]").evaluateAll(list => list.filter(mark => /\b(look|failed)\b/.test((mark.closest(".acard-h") ?? mark).querySelector(".badge").className)).length);
  assert.equal(marked, Number(looks), "each counted row, and nothing else, has the look colour");
  await shoot(page, "agents-round2-dark.png");
  assert.deepEqual(problems, []);
});
