import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { HOSTILE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { graphProblems } from "./fixtures/graph-geometry.mjs";
import { addRecords, editTable } from "./fixtures/logbook-edit.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const REPOSITORY = "https://github.com/sample-owner/sample-app";
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

async function open(t, { edit, width = 1440, ...options } = {}, path = "/app/") {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-prs-browser-")), port = await freePort(), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { prs: true, ...options });
  edit?.(join(dir, "logbooks", "sample-app-abc123"), join(dir, "logbooks"));
  const server = createBoardServer({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port, app: APP, settleReads: [] });
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: "dark" });
  t.after(async () => { await context.close(); await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  return { page, base, requests, problems };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const row = (page, id) => page.locator(`li.prow[data-pr-task="${KEY(id)}"]`);
const groups = page => page.locator("section.group h2").allTextContents();
const ids = (page, group) => page.locator(`section[data-group="${group}"] li.prow .meta .mono`).allTextContents();
const graphFile = url => /\/app\/graph-[A-Z0-9]{8}\.js$/.test(url);

test("T1063: J5 is within two clicks of the Overview, and the graph's file loads only when the graph opens", async t => {
  const { page, base, requests, problems } = await open(t);
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };
  await click(page.getByRole("link", { name: /^Pull requests/ }));
  await page.locator("main h1", { hasText: "Pull requests" }).waitFor();
  assert.deepEqual(await groups(page), ["In review", "Repairing", "Ready to merge", "Waiting for another task", "Merged recently"], "T1120 S8: T8's failed checks are the chief's repair, so no PR needs you");
  assert.equal(requests.filter(graphFile).length, 0, "the list does not load the graph's file");
  await click(page.getByRole("button", { name: "Graph" }));
  await page.locator(".gnode").first().waitFor();
  assert.equal(clicks, 2, "J5: Pull requests, then Graph");
  assert.equal(requests.filter(graphFile).length, 1, "the graph's file loads once, when the graph opens");
  assert.deepEqual(await page.locator(".gnode .g-head b").allTextContents(), ["T2 · no PR yet", "T10 · no PR yet", "PR 14 · T5", "PR 12 · T3", "PR 17 · T8", "T4 · no PR yet", "T11 · no PR yet", "PR 15 · T6", "T13 · no PR yet"]);
  assert.equal(await page.locator(".react-flow__edge.waits").count(), 4, "T6 waits for T5, T13 for T6, T4 for T2 and T11 for T10, which have no PR and are not on the page");
  assert.equal(await page.locator(".react-flow__edge.conflict").count(), 1, "T3 and T8 may conflict");
  assert.match(await page.locator(".legend").textContent(), /2 other items have no link: the list shows them\./);
  await page.getByRole("button", { name: "List" }).click();
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  assert.equal(requests.filter(graphFile).length, 1, "a second opening reuses the loaded file");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

const linksThroughBoxes = page => page.evaluate(() => {
  const boxes = [...document.querySelectorAll(".react-flow__node")].map(node => ({ id: node.dataset.id.split("/").pop(), rect: node.getBoundingClientRect() }));
  return [...document.querySelectorAll(".react-flow__edge")].map(edge => {
    const path = edge.querySelector(".react-flow__edge-path"), length = path.getTotalLength(), through = new Set();
    for (let at = 0; at <= length; at += 2) {
      const point = new DOMPoint(path.getPointAtLength(at).x, path.getPointAtLength(at).y).matrixTransform(path.getScreenCTM());
      for (const { id, rect } of boxes) if (point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2) through.add(id);
    }
    return { link: edge.getAttribute("aria-label").replace(/shared\/sample-app-abc123\//g, ""), label: edge.querySelector(".react-flow__edge-text")?.textContent ?? "", through: [...through] };
  });
});

test("T1063: no link of the graph passes through a box, and a loop or a task that waits for itself shows its way back with a mark", async t => {
  const cases = [
    ["T3 to T13 skips a column, and T6 is in T3's row there", { waits: { T6: "T5", T7: "T5", T13: "T3,T7" } }, null],
    ["T3 and T8 may conflict, with T50 between them in one column", { hostile: true }, null],
    ["T6 and T13 wait for each other", { waits: { T6: "T13", T13: "T6" } }, ["Edge from T13 to T6", "loop"]],
    ["T6 waits for itself", { waits: { T6: "T6" } }, ["Edge from T6 to T6", "waits for itself"]],
  ];
  for (const [name, options, mark] of cases) {
    const { page, problems } = await open(t, options, "/app/#pull-requests");
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
    const links = await linksThroughBoxes(page);
    assert.deepEqual(links.filter(link => link.through.length), [], name);
    if (mark) assert.deepEqual(links.filter(link => link.label === mark[1]).map(link => link.link), [mark[0]], `${name}: the link that goes back carries the mark`);
    assert.deepEqual(problems, [], name);
  }
});

const drawnProblems = async page => graphProblems(await page.evaluate(() => ({
  boxes: [...document.querySelectorAll(".react-flow__node")].map(node => { const [x, y] = node.style.transform.match(/-?[\d.]+/g).map(Number); return { id: node.dataset.id.split("/").pop(), x, y, w: node.offsetWidth, h: node.offsetHeight }; }),
  links: [...document.querySelectorAll(".react-flow__edge")].map(edge => ({ id: edge.dataset.id.replace(/shared\/sample-app-abc123\//g, ""), d: edge.querySelector(".react-flow__edge-path").getAttribute("d") })),
})));

test("T1063: each link of the graph keeps its own line: two links never share a track, and a wait and a conflict of one pair both show", async t => {
  const cases = [
    ["F-T1063-15: T7 waits for T5; T6 for T5, T3 and T7; T13 for T5 and T7", { waits: { T7: "T5", T6: "T5,T3,T7", T13: "T5,T7" } }, "T5>T7 T5>T6 T3>T6 T7>T6 T5>T13 T7>T13 T3|T8 T2>T4 T10>T11"],
    ["F-T1063-17: T6 waits for T5, T13 for T7, T4 for T7 and T6, T2 for T3 and T13", { waits: { T6: "T5", T13: "T7", T4: "T7,T6", T2: "T3,T13" } }, "T5>T6 T7>T13 T7>T4 T6>T4 T3>T2 T13>T2 T3|T8 T10>T11"],
    ["F-T1063-19: T8 waits for T3, and the two may conflict", { waits: { T8: "T3" } }, "T5>T6 T6>T13 T3>T8 T3|T8 T2>T4 T10>T11"],
    ["F-T1063-20: ten tasks in one column all may conflict", { crowd: 10 }, `T5>T6 T6>T13 T3|T8 T2>T4 T10>T11 ${Array.from({ length: 10 }, (_, a) => Array.from({ length: 9 - a }, (_, k) => `T${80 + a}|T${81 + a + k}`)).flat().join(" ")}`],
  ];
  const sorted = text => text.split(" ").map(link => link.includes("|") ? link.split("|").sort().join("|") : link).sort();
  for (const [name, options, expected] of cases) {
    const { page, problems } = await open(t, options, "/app/#pull-requests");
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
    const drawn = await page.locator(".react-flow__edge").evaluateAll(edges => edges.map(edge => edge.dataset.id.replace(/^\w+:|shared\/sample-app-abc123\//g, "")));
    assert.deepEqual(sorted(drawn.join(" ")), sorted(expected), `${name}: the graph draws each link of the logbook, and no other`);
    assert.deepEqual(await drawnProblems(page), { through: [], shared: [] }, name);
    assert.deepEqual(problems, [], name);
  }
});

test("T1063: the list groups each PR by its next action and shows its task, chief, clean cycles, CI state, findings and may-conflict flag", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  assert.deepEqual(await ids(page, "need"), [], "T1120 S8: failed checks are the chief's repair, not a question for you");
  assert.deepEqual(await ids(page, "review"), ["T3", "T8"]);
  assert.deepEqual(await ids(page, "repair"), ["T7"]);
  assert.deepEqual(await ids(page, "ready"), ["T5"]);
  assert.deepEqual((await ids(page, "wait")).sort(), ["T11", "T13", "T4", "T6"]);
  assert.deepEqual(await ids(page, "merged"), ["T9"], "T12 merged 9 days ago, so it is not recent");
  const text = async id => (await row(page, id).innerText()).replace(/\s+/g, " ");
  assert.match(await text("T8"), /^PR 17 Sample search highlight Claude · C1 T8 may conflict · T3 · PR 12 Checks failed on the recorded PR head; the chief repairs it\. 0 of 1 clean cycles CI fails 0 open \d+ h ago$/);
  assert.match(await text("T3"), /^PR 12 Sample shared limits Codex · C2 T3 Milestone 1: Board redesign may conflict · T40 may conflict · T8 · PR 17 0 of 1 clean cycles CI passes 0 open \d+ min ago$/);
  assert.match(await text("T7"), /^PR 16 Sample offline banner Codex · C2 T7 .* Clean cycles unknown · 1 needed CI unknown 0 open age unknown$/);
  assert.match(await text("T5"), /^PR 14 Sample retry backoff Claude · C1 T5 .* 1 of 1 clean cycles CI passes 0 open \d+ h ago$/);
  assert.match(await text("T6"), /^PR 15 Sample sync log .* Waits for T5 \(in progress\)\. 0 of 1 clean cycles CI unknown 0 open age unknown$/);
  assert.match(await text("T13"), /^no PR Sample sync export .* Waits for T6 \(in progress\)\. age unknown$/);
  assert.match(await text("T9"), /^PR 11 Sample conflict rule .* 1 clean cycle CI passes 0 open merged 5 h ago$/);
  assert.equal(await page.getByRole("status").filter({ hasText: /open PRs?$/ }).textContent(), "5 open PRs");
  assert.equal(await page.locator(".nav a", { hasText: "Pull requests" }).locator(".count").textContent(), "5");
});

test("T1059, T1063: the chief filter holds on the Pull requests page: it lists only that chief's tasks, and All chiefs lists each again", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  await row(page, "T8").waitFor();
  await page.locator('.chip[data-chief$="/C2"]').click();
  await row(page, "T8").waitFor({ state: "detached" });
  const shown = async () => (await page.locator("li.prow .meta .mono").allTextContents()).sort();
  assert.deepEqual(await shown(), ["T11", "T3", "T7"], "C2's tasks with a PR or a wait");
  await page.getByRole("button", { name: "All chiefs" }).click();
  await row(page, "T8").waitFor();
  assert.deepEqual(await shown(), ["T11", "T13", "T3", "T4", "T5", "T6", "T7", "T8", "T9"]);
});

test("T1063, T1083: each PR number links to GitHub, each title opens the task's page, and Back returns to the page", async t => {
  const { page, requests, base } = await open(t, {}, "/app/#pull-requests");
  const pr = row(page, "T5").getByRole("link", { name: "Pull request 14 on GitHub" });
  assert.deepEqual([await pr.getAttribute("href"), await pr.getAttribute("target"), await pr.getAttribute("rel")], [`${REPOSITORY}/pull/14`, "_blank", "noopener noreferrer"]);
  assert.equal(await row(page, "T7").locator(".num a").count(), 0, "no repository known: the number is plain text");
  await row(page, "T5").getByRole("link", { name: "Sample retry backoff" }).click();
  await page.locator(".taskpage h1", { hasText: "Sample retry backoff" }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#task?key=${encodeURIComponent(KEY("T5"))}`);
  assert.equal(await page.locator(".taskpage .back").textContent(), "‹ Pull requests");
  await page.goBack();
  assert.equal(await page.evaluate(() => location.hash), "#pull-requests?project=sample-app-abc123");
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T5"));
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(`.gnode[data-task="${KEY("T6")}"]`).click();
  await page.locator(".taskpage h1", { hasText: "Sample sync log" }).waitFor();
  await page.goBack();
  await page.locator(".gnode").first().waitFor();
  assert.equal(await page.locator(".gnode").count(), 9, "Back returns to the graph");
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), []);
});

test("T1063: the keyboard reaches each link of the list and the graph, and Enter opens the task", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  await page.getByRole("button", { name: "List" }).focus();
  const stops = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); stops.push(await page.evaluate(() => document.activeElement.textContent)); }
  assert.deepEqual(stops, ["Graph", "PR 12", "Sample shared limits", "PR 17"], "the view switch, then each row's number and title");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.locator(".taskpage h1", { hasText: "Sample shared limits" }).waitFor();
  await page.goBack();
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T3"));
  await page.getByRole("button", { name: "Graph" }).focus();
  await page.keyboard.press("Enter");
  await page.locator(".gnode").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Graph" }).getAttribute("aria-pressed"), "true");
  let reached = null;
  for (let i = 0; i < 6 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => document.activeElement.closest(".gnode") && document.activeElement.dataset.task); }
  assert.equal(reached, KEY("T2"), "Tab reaches the first box of the graph");
  await page.keyboard.press("Enter");
  await page.locator(".taskpage h1", { hasText: "Sample chief records" }).waitFor();
});

test("T1063: markup in a title, a question, a branch name and a path shows as text on the page, in the graph and on the task page", async t => {
  const { page, problems } = await open(t, { hostile: true }, "/app/#pull-requests");
  const hostile = row(page, "T50");
  assert.equal(await hostile.locator(".ttl").textContent(), HOSTILE_TEXT.title);
  assert.equal(await hostile.locator(".why").textContent(), `<img src=x onerror="window.hacked=11">Merge <b>now</b>?`);
  assert.match(await hostile.locator(".meta").textContent(), /may conflict · T8 · PR 17/);
  await hostile.locator(".ttl").click();
  const panel = page.locator(".taskpage");
  await page.locator(".taskpage h1", { hasText: HOSTILE_TEXT.title }).waitFor();
  assert.match(await panel.textContent(), /sage\/t50-<b>bold<\/b>/, "the branch name is text");
  assert.ok((await panel.locator(".callout code").allTextContents()).includes("<script>window.hacked=3</script>\\nsrc/evil\\u202egnp\\u009b.js"), "a path shows its newline and invisible characters as escapes");
  await page.goBack();
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(`.gnode[data-task="${KEY("T50")}"]`).waitFor();
  assert.equal(await page.locator(`.gnode[data-task="${KEY("T50")}"] .g-title`).textContent(), HOSTILE_TEXT.title);
  const injected = await page.evaluate(() => ({ hacked: window.hacked ?? null, markup: document.querySelectorAll("main img, main script, main b:not(.g-head b), main i, main [onerror]").length, scripted: [...document.querySelectorAll("main a")].filter(a => !/^(?:#|\/|https:)/.test(a.getAttribute("href") ?? "")).length }));
  assert.deepEqual(injected, { hacked: null, markup: 0, scripted: 0 });
  assert.deepEqual(problems, []);
});

test("T1063: text meets AA contrast on the list and the graph, in the dark and the light theme", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to the light theme" }).click();
    await page.getByRole("button", { name: "List" }).click();
    await row(page, "T5").waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}, list`);
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".gnode").first().waitFor();
    assert.deepEqual((await page.evaluate(measureContrast)).filter(item => item.ratio < item.need), [], `${theme}, graph`);
  }
});

const HOUR = 3_600_000, hoursFromNow = hours => new Date(Date.now() + hours * HOUR).toISOString();
const task = (id, title, state, extra = {}) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state, branch: `sage/${id.toLowerCase()}`, pr: "", round: "0", keys: "", hold: "", extra: "", priority: "P2", kind: "", waits: "", milestone: "", chief: "C1", ...extra });
const gate = (id, on, question) => ({ id, task: on, question, options: "A|B", recommendation: "A", default: "", answer: "", at: hoursFromNow(-0.5) });
const finding = (key, severity, status) => ({ task: "T3", key, round: "0", source: "code-reviewer", severity, summary: "sample", triage: "fix", reason: "", status, run: "R5", class: "other" });

function edgeCases(logbook, root) {
  const changes = { T40: { pr: "41" }, T8: { waits: "T6" }, T6: { waits: "T5,T99,T9" } };
  editTable(logbook, "tasks", rows => [...rows.map(row => ({ ...row, ...changes[row.id] })), task("T90", "Sample framed with a PR", "framed", { pr: "90" })]);
  editTable(logbook, "gates", rows => [...rows, gate("G20", "T4", "Keep the queue order?"), gate("G21", "T7", "Ship ‮it now?")]);
  editTable(logbook, "decisions", rows => [...rows, { at: hoursFromNow(3), task: "T9", decision: "state merged", why: "a clock ahead" }]);
  editTable(logbook, "findings", () => [finding("F1", "low", "open"), finding("F2", "medium", "open"), finding("F3", "high", "closed")]);
  addRecords(logbook, [{ task: "T40", kind: "pr", source: "gh pr view", basis: "observed", observedAt: hoursFromNow(-1), recordedAt: hoursFromNow(-1), data: { repository: REPOSITORY, number: 41, state: "open", head: "c".repeat(40) } }]);
  writeFileSync(join(root, "config.json"), JSON.stringify({ "cycles.small": 12 }));
}

test("F-T1081-2, -9, -14, -8, -25, -7, -3, -20, -21, -1: each edge case goes to the group that says what happens next, and its row says why", async t => {
  const { page, problems } = await open(t, { edit: edgeCases }, "/app/#pull-requests");
  await row(page, "T90").waitFor();
  assert.deepEqual(await groups(page), ["Needs you", "In review", "Building", "Waiting for another task", "Merged recently"], "T5 has 1 of 12 clean cycles now, so it is not ready");
  assert.deepEqual((await ids(page, "wait")).sort(), ["T11", "T13", "T4", "T6", "T8"], "F-T1081-2: T4 has no PR, so it waits, also with a question for you; T1120 S8: T8's failed checks do not ask you, so it waits for T6");
  assert.deepEqual((await ids(page, "build")).sort(), ["T40", "T90"], "F-T1081-9, -14: a framed or building task with a PR is not in review");
  assert.deepEqual((await ids(page, "need")).sort(), ["T7"], "T1120 S8: T8's failed checks are the chief's repair");
  const text = async id => (await row(page, id).innerText()).replace(/\s+/g, " ");
  assert.match(await text("T9"), / 1 clean cycle CI passes 0 open merge time is in the future$/, "F-T1081-8, -25: no false 'just now', and no 'of 12' from today's config");
  assert.match(await text("T5"), / 1 of 12 clean cycles /, "an open task still counts against today's config");
  assert.equal(await row(page, "T7").locator(".why").textContent(), "Ship \\u202eit now?", "F-T1081-7: the override shows as an escape and reverses nothing");
  assert.match(await text("T3"), / 2 open · medium /, "F-T1081-3: the open findings and the worst open severity");
  assert.equal(await page.locator("section.group .card-h svg.grp").count(), 5, "F-T1081-3: each group has its icon");
  assert.equal(await page.locator("li.prow > svg.grp").count(), await page.locator("li.prow").count(), "F-T1081-3: each row has its group's icon");
  assert.match(await row(page, "T7").locator(".meta").innerText(), /No GitHub link: the logbook names no repository for this PR\./, "F-T1081-20: the reason is on the page, not only in a tooltip");
  assert.equal(await row(page, "T8").locator(".why").textContent(), "Checks failed on the recorded PR head; the chief repairs it.");
  assert.equal(await row(page, "T8").locator(".waits").textContent(), "Waits for T6 (in progress).", "F-T1081-21: the why line does not hide the waits line");
  assert.equal(await row(page, "T6").locator(".waits").textContent(), "⊘ Waits for T99 (not in the logbook) and T5 (in progress): it cannot start.", "F-T1081-1: a wait for a missing task shows in the row");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  const box = id => page.locator(`.gnode[data-task="${KEY(id)}"]`);
  assert.deepEqual(await box("T99").locator(".g-head b, .g-state").allTextContents(), ["T99", "Not in the logbook"], "F-T1081-1: the graph draws the missing task");
  assert.equal(await page.locator(`.react-flow__edge[data-id="wait:${KEY("T99")}>${KEY("T6")}"]`).count(), 1);
  assert.equal(await box("T2").locator(".g-state").textContent(), "Not on this page", "F-T1081-1: T4 waits for T2, which has no PR");
  assert.match(await page.locator(".legend").textContent(), /waits for a task that is done \(met\)/, "F-T1081-23: T6 waits for T9, which merged");
  assert.deepEqual(problems, []);
});

test("F-T1081-22, T1135: with two projects, the list and the graph show the chosen project's pull requests only", async t => {
  const second = (logbook, root) => {
    cpSync(logbook, join(root, "other-app-def456"), { recursive: true });
    appendFileSync(join(root, "projects.tsv"), `other-app-def456\t${hoursFromNow(-90)}\tinit\n`);
  };
  const { page } = await open(t, { edit: second }, "/app/#pull-requests?project=other-app-def456");
  const books = async selector => [...new Set((await page.locator(selector).evaluateAll(items => items.map(item => item.dataset.prTask ?? item.dataset.task))).map(key => key.slice(0, key.lastIndexOf("/"))))];
  await page.locator("li.prow").first().waitFor();
  assert.deepEqual(await books("li.prow"), ["shared/other-app-def456"]);
  assert.equal(await page.locator("li.prow").filter({ hasText: "Sample shared limits" }).count(), 1, "the twin's row is not on this page");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  assert.deepEqual(await books(".gnode[data-task]"), ["shared/other-app-def456"]);
  assert.doesNotMatch((await page.locator(".gnode .g-head").allTextContents()).join(" "), /sample-app|other-app/, "no box names a project");
});

const inCanvas = page => page.evaluate(() => {
  const canvas = document.querySelector(".g-canvas").getBoundingClientRect();
  return [...document.querySelectorAll(".react-flow__node")].filter(node => { const r = node.getBoundingClientRect(); return r.left < canvas.left || r.right > canvas.right + 1 || r.top < canvas.top || r.bottom > canvas.bottom + 1; }).length;
});

test("F-T1081-13, -18, -16, -10: the graph keeps its links, links nowhere outside, and fits a large graph; the list keeps its facts", async t => {
  const { page, base, requests } = await open(t, { crowd: 12 }, "/app/#pull-requests");
  assert.match(await row(page, "T5").locator(".facts").innerText(), /1 of 1 clean cycles\s+CI passes\s+0 open\s+\d+ h ago/, "F-T1081-18: the facts stay in the row");
  assert.ok(await row(page, "T5").locator(".age").isVisible());
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector(".react-flow__viewport")?.style.transform);
  assert.equal(await inCanvas(page), 0, "F-T1081-10: the fit shows each of the 18 boxes");
  const edges = await page.locator(".react-flow__edge").count(), counts = [];
  for (let i = 0; i < 10; i++) { counts.push(await page.locator(".react-flow__edge").count()); await page.waitForTimeout(30); }
  assert.deepEqual([...new Set(counts)], [edges], "F-T1081-13: no link goes away while the graph shows");
  assert.equal(await page.locator('main a[href*="reactflow"], .react-flow__attribution').count(), 0, "F-T1081-16: no link to React Flow's site");
  assert.match(await page.locator(".legend .credit").textContent(), /React Flow/);
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), []);
});

test("F-T1081-6, -19: the view choice holds after a reload, the age shows in a narrow window, and an empty project shows no view switch", async t => {
  const { page } = await open(t, { width: 1100 }, "/app/#pull-requests");
  assert.ok(await row(page, "T9").locator(".age").isVisible(), "the age shows below 1280 px");
  assert.match(await row(page, "T9").locator(".age").textContent(), /^merged 5 h ago$/);
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  await page.reload();
  await page.locator(".gnode").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Graph" }).getAttribute("aria-pressed"), "true");
  const empty = await open(t, { edit: logbook => editTable(logbook, "tasks", () => []) }, "/app/#pull-requests");
  await empty.page.locator(".empty", { hasText: "No pull request yet" }).waitFor();
  assert.equal(await empty.page.getByRole("group", { name: "View" }).count(), 0);
  assert.equal(await empty.page.getByRole("status").filter({ hasText: /open PRs?$/ }).count(), 0);
});

const shownBoxes = page => page.evaluate(() => {
  const canvas = document.querySelector(".g-canvas").getBoundingClientRect();
  return [...document.querySelectorAll(".react-flow__node")].filter(node => { const r = node.getBoundingClientRect(); return r.right > canvas.left && r.left < canvas.right && r.bottom > canvas.top && r.top < canvas.bottom; }).map(node => node.dataset.id.split("/").pop());
});
const firstBox = page => page.evaluate(() => [...document.querySelectorAll(".react-flow__node")].map(node => [node.dataset.id.split("/").pop(), ...node.style.transform.match(/-?[\d.]+/g).map(Number)]).sort((a, b) => a[1] - b[1] || a[2] - b[2])[0][0]);
const chain = n => logbook => editTable(logbook, "tasks", rows => [...rows, ...Array.from({ length: n }, (_, i) => task(`T${300 + i}`, `Sample chain ${i + 1}`, "reviewing", { pr: String(300 + i), waits: i ? `T${299 + i}` : "" }))]);

test("F-T1081-10: a graph too large to fit starts at its first column and says that it continues; a graph that fits says nothing", async t => {
  const NOTICE = "The graph is larger than the view. It starts at the first column: drag it to see the rest.";
  const seen = {};
  for (const [name, options] of [["a chain of 30 tasks", { edit: chain(30) }], ["a chain of 120 tasks and 25 tasks in one column", { edit: chain(120), crowd: 25 }]]) {
    const { page, problems } = await open(t, options, "/app/#pull-requests");
    await page.getByRole("button", { name: "Graph" }).click();
    await page.locator(".react-flow__edge-path").first().waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector(".react-flow__viewport")?.style.transform);
    await page.waitForTimeout(300);
    const first = await firstBox(page), shown = await shownBoxes(page), notice = (await page.locator(".graph").innerText()).includes(NOTICE);
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.waitForTimeout(300);
    seen[name] = { blank: !shown.length, firstColumn: shown.includes(first), notice, afterFitButton: (await shownBoxes(page)).includes(first), problems };
  }
  const want = { blank: false, firstColumn: true, notice: true, afterFitButton: true, problems: [] };
  assert.deepEqual(seen, { "a chain of 30 tasks": want, "a chain of 120 tasks and 25 tasks in one column": want });
  const { page } = await open(t, { crowd: 12 }, "/app/#pull-requests");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  assert.equal(await page.locator(".graph").getByText(NOTICE).count(), 0, "18 boxes fit: no notice");
});

test("F-T1081-30: a logbook change keeps the pan and the zoom of the graph, and a resize of the window still refits it", async t => {
  let logbook;
  const { page } = await open(t, { edit: path => { logbook = path; } }, "/app/#pull-requests");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.locator(".gnode").first().waitFor();
  await page.waitForTimeout(300);
  const view = () => page.locator(".react-flow__viewport").evaluate(node => node.style.transform);
  const fitted = await view();
  await page.getByRole("button", { name: "Zoom In" }).click();
  const box = await page.locator(".g-canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2 - 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moved = await view();
  assert.notEqual(moved, fitted, "the drag and the zoom move the view");
  editTable(logbook, "tasks", rows => rows.map(row => row.id === "T5" ? { ...row, title: `${row.title} (renamed)` } : row));
  await page.locator(".graph").getByText("(renamed)").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  assert.equal(await view(), moved, "the logbook change keeps the pan and the zoom");
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.waitForFunction(before => document.querySelector(".react-flow__viewport").style.transform !== before, moved);
  assert.equal(await inCanvas(page), 0, "a resize of the window refits the graph");
});

test("F-T1081-27: a held task and a task that you answered, each with a PR, show their state in the Building group, and the hint covers them", async t => {
  const edit = logbook => editTable(logbook, "tasks", rows => [...rows, task("T91", "Sample held change", "held", { pr: "91" }), task("T92", "Sample answered change", "awaiting-you", { pr: "92" }), task("T93", "Sample built change", "building", { pr: "93" })]);
  const answered = logbook => { edit(logbook); editTable(logbook, "gates", rows => [...rows, { ...gate("G30", "T92", "Keep the old layout?"), answer: "A" }]); };
  const { page } = await open(t, { edit: answered }, "/app/#pull-requests");
  await row(page, "T91").waitFor();
  assert.deepEqual((await ids(page, "build")).sort(), ["T91", "T92", "T93"]);
  assert.match(await page.locator('section[data-group="build"] .card-h').innerText(), /the chief moves it on/i);
  assert.deepEqual(await row(page, "T91").locator(".meta .badge").allTextContents(), ["held"]);
  assert.deepEqual(await row(page, "T92").locator(".meta .badge").allTextContents(), ["you answered"]);
  assert.deepEqual(await row(page, "T93").locator(".meta .badge").allTextContents(), [], "agents build it: the group says so, and the row needs no note");
});

test("F-T1081-28: when the graph fails to draw, the page says so and the list still works", async t => {
  const { page } = await open(t, {}, "/app/#pull-requests");
  await row(page, "T5").waitFor();
  await page.evaluate(() => { window.ResizeObserver = class { constructor() { throw new Error("sample failure"); } }; });
  await page.getByRole("button", { name: "Graph" }).click();
  await page.getByRole("alert").filter({ hasText: "The board could not draw the graph. The list view shows each pull request." }).waitFor({ timeout: 5_000 });
  assert.equal(await page.locator("main h1").textContent(), "Pull requests", "the rest of the page stays");
  await page.getByRole("button", { name: "List" }).click();
  await row(page, "T5").waitFor({ timeout: 5_000 });
});
