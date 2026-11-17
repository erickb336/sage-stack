import "./test-env.mjs";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { readerUrl } from "../packages/sage-board/reader.mjs";
import { HOSTILE_TEXT, UNICODE_TEXT, writeTasksLogbook } from "./fixtures/board-app.mjs";
import { measureContrast } from "./fixtures/contrast.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) }); });
after(async () => { await browser?.close(); });

async function openBoard(t, options = {}, path = "/app/") {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-tasks-browser-")), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  const { twin, clock, source = { id: "shared", label: "Shared" }, ...fixture } = options, written = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), fixture);
  if (twin) cpSync(written, join(dir, "logbooks", "other-app-def456"), { recursive: true });
  if (twin === "one name") for (const book of [written, join(dir, "logbooks", "other-app-def456")]) {
    const config = join(book, "config.json");
    writeFileSync(config, JSON.stringify({ ...existsSync(config) && JSON.parse(readFileSync(config, "utf8")), name: "twin" }));
  }
  const server = createBoardServer({ sources: [{ ...source, path: join(dir, "logbooks") }], port: 0, app: APP, settleReads: [] });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  if (clock) await context.clock.install({ time: Date.now() });
  t.after(async () => { await context.close(); await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  const requests = [], problems = [];
  await context.route("**/*", route => { requests.push(route.request().url()); return route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${base}${path}`);
  await page.locator("main h1").waitFor();
  return { page, base, requests, problems, logbook: join(dir, "logbooks", "sample-app-abc123") };
}

const KEY = id => `shared/sample-app-abc123/${id}`;
const row = (page, id) => page.locator(`a.row[data-task="${KEY(id)}"]`);
const taskTitle = page => page.locator(".taskpage h1");
const taskPage = id => `/app/#task?key=${encodeURIComponent(KEY(id))}`;
const groupTitles = page => page.locator(".group h2").allTextContents();
const rowIds = page => page.locator("a.row .id").allTextContents();
async function settles(read, expected, message) {
  let last;
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise(accept => setTimeout(accept, 25))) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
  }
  assert.deepEqual(last, expected, ...message ? [message] : []);
}
const filter = (page, name) => page.getByRole("combobox", { name: `Filter by ${name}`, exact: true });

test("T1061, T1064, T1059: J2 and J3 are within two clicks of the Overview, and a Needs you row opens its question view in one and the full question in two", async t => {
  const { page, base, requests, problems } = await open(t);
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };

  await click(page.getByRole("link", { name: "Milestone 1: Board redesign" }));
  await click(row(page, "T3"));
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  assert.equal(clicks, 2, "J3: a milestone, then its task");
  assert.match(page.url(), /#task\?key=shared%2Fsample-app-abc123%2FT3$/, "T1083: a row opens the task's own page");
  assert.deepEqual(await page.locator(".trail li").evaluateAll(steps => steps.map(step => [step.className, step.firstChild.textContent, step.querySelector(".sr").textContent])), [["done", "build", " (done)"], ["done", "reviews", " (done)"], ["now", "QA", " (now)"]], "T1083 F-T1083-7: the trail names the route's steps; the code review is done and QA runs, each with its word for a screen reader");
  assert.match(await page.locator(".about-s p.now").first().textContent(), /^In progress: 0 of 1 review cycle passed\./);
  await page.getByRole("tab", { name: /^Artifacts/ }).click();
  const made = await page.locator("#tab-panel .files a").allTextContents();
  assert.deepEqual(made.filter(text => !["Brief", "Report"].includes(text)), ["limits-design.html", "notes.md", "Limits design note", "R5 · code-reviewer · done"], "J3: what its agents made, one tab further (T1126: About is the first tab)");
  assert.deepEqual(await page.locator('#tab-panel h4:text-is("Briefs and reports") + ul > li').evaluateAll(list => list.map(item => [item.firstChild.textContent, [...item.querySelectorAll("a")].map(a => a.textContent).join(" ")])), [["R5 · code-reviewer", "Report"], ["R6 · qa", "Brief"], ["R7 · implementer", ""]], "T1126 S16: a Brief or Report link only where the logbook keeps one");
  assert.equal(await page.getByRole("link", { name: "limits-design.html" }).getAttribute("href"), "/pages/sample-app-abc123/T3/limits-design.html");
  assert.match(await page.getByRole("link", { name: "notes.md" }).getAttribute("href"), /^\/read\/[\w-]+\/page\/notes\.md$/, "a Markdown page opens in the reader");
  assert.match(await page.locator("#tab-panel").textContent(), /R5 · code-reviewer · done.*CLEAN\. The limits change is correct\..*sage_qa_t3_r6\.json/);

  clicks = 0;
  await page.goto(`${base}/app/`);
  await click(page.getByRole("link", { name: /^Tasks/ }));
  await click(page.getByRole("button", { name: "Priority", exact: true }));
  assert.equal(clicks, 2, "J2: tasks by priority");
  await settles(() => groupTitles(page), ["P0", "P1", "P2"]);

  clicks = 0;
  await page.goto(`${base}/app/`);
  await click(page.getByRole("link", { name: "Can a viewer copy a shared list into their own lists?" }));
  await page.locator("#question-h").filter({ hasText: "Can a viewer copy a shared list into their own lists?" }).waitFor();
  assert.equal(clicks, 1, "J1: the question view, the place to answer, in one click");
  await click(page.getByRole("link", { name: "Read the full question" }));
  await page.waitForURL(new RegExp(`/read/${Buffer.from(KEY("T10")).toString("base64url")}/question/G\\d+$`));
  await page.locator("main h1").filter({ hasText: "Can a viewer copy a shared list into their own lists?" }).waitFor();
  assert.equal((await page.request.get(page.url())).status(), 200, "the reader's question page answers 200");
  assert.equal(clicks, 2, "J1: the full question in two clicks");
  assert.match(await page.locator("main").textContent(), /Answers.*A: yes, as a new private list.*C1's pick.*B: no/s, "the chief's pick first");
  await page.getByRole("link", { name: /Back to Needs you/ }).click();
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  await page.goto(`${base}${taskPage("T10")}`);
  await taskTitle(page).filter({ hasText: "Sample sync design" }).waitFor();
  await page.getByRole("tab", { name: /Decisions/ }).click();
  assert.match(await page.locator("#tab-panel").textContent(), /Can a viewer copy a shared list.*Open: it waits for your answer/);
  assert.deepEqual(requests.filter(url => !url.startsWith(`${base}/`)), [], "no request outside 127.0.0.1");
  assert.deepEqual(problems, [], "no script error and no CSP refusal");
});

async function open(t, options, path) { return openBoard(t, options, path); }

test("T1061: the groups and filters work, and ended tasks stay collapsed until asked", async t => {
  const { page } = await open(t, {}, "/app/#tasks");
  assert.deepEqual(await groupTitles(page), ["Milestone 2: Offline sync", "Milestone 1: Board redesign", "No milestone", "Milestone 3: Sign-in rework"], "by milestone priority; an all-ended group last");
  assert.equal(await row(page, "T1").count(), 0, "T1 merged, so it is collapsed");
  await page.locator('[data-group="shared/sample-app-abc123/M1"] .more-ended').click();
  assert.equal(await row(page, "T1").count(), 1);
  assert.equal(await page.locator('[data-group="shared/sample-app-abc123/M1"] .more-ended').getAttribute("aria-expanded"), "true");
  assert.match(await row(page, "T3").textContent(), /^P2Sample shared limitsprovidersmay conflict · T40T3in progressCodex · C2Review 1 of 1PR 12/);
  assert.match(await row(page, "T40").textContent(), /may conflict · T3/);
  assert.match(await row(page, "T3").textContent(), /may conflict · T40/);

  await page.getByRole("button", { name: "Chief", exact: true }).click();
  await settles(() => groupTitles(page), ["Claude · C1", "Codex · C2"]);
  await filter(page, "provider").selectOption("Codex");
  await settles(() => groupTitles(page), ["Codex · C2"]);
  await filter(page, "kind").selectOption("ui");
  await settles(() => rowIds(page), ["T30"]);
  await filter(page, "kind").selectOption("");
  await filter(page, "state").selectOption("needs you");
  await settles(() => rowIds(page), ["T30"]);
  await filter(page, "provider").selectOption("");
  await filter(page, "priority").selectOption("P0");
  await settles(() => rowIds(page), ["T10"]);
  await filter(page, "state").selectOption("");
  await filter(page, "priority").selectOption("");
  await filter(page, "chief").selectOption("Claude · C1");
  await page.getByRole("button", { name: "State" }).click();
  await settles(() => groupTitles(page), ["needs you", "in progress", "waiting", "done"]);
});

test("T1080 (F-T1080-2, F-T1080-14): the group and the filters are in the address, so a reload or Back from a task page keeps them, and one button clears the filters", async t => {
  const { page, base } = await open(t, {}, "/app/#tasks");
  assert.equal(await page.getByRole("button", { name: "Clear filters" }).count(), 0, "no clear button while no filter is on");
  assert.equal(await page.getByRole("combobox", { name: "Chief", exact: true }).count(), 0, "the chief filter does not share the name of the Chief group button");
  await page.getByRole("button", { name: "Chief", exact: true }).click();
  await filter(page, "provider").selectOption("Codex");
  await settles(() => groupTitles(page), ["Codex · C2"]);
  assert.equal(await page.evaluate(() => location.hash), "#tasks?project=sample-app-abc123&group=chief&provider=Codex", "T1135: the address also names the project");
  await page.reload();
  await settles(() => groupTitles(page), ["Codex · C2"], "the reload keeps the group and the filter");
  assert.equal(await filter(page, "provider").inputValue(), "Codex");
  assert.equal(await page.getByRole("button", { name: "Chief", exact: true }).getAttribute("aria-pressed"), "true");
  await row(page, "T3").click();
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  await page.goBack();
  await row(page, "T3").waitFor();
  assert.equal(await page.evaluate(() => location.hash), "#tasks?project=sample-app-abc123&group=chief&provider=Codex", "Back from the task page goes back to the same view");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await settles(() => groupTitles(page), ["Claude · C1", "Codex · C2"]);
  assert.equal(await page.getByRole("button", { name: "Clear filters" }).count(), 0);
  await page.goto(`${base}/app/#tasks`);
  await settles(() => groupTitles(page), ["Milestone 2: Offline sync", "Milestone 1: Board redesign", "No milestone", "Milestone 3: Sign-in rework"], "an address with no view gives the default");
});

test("T1080 (F-T1080-13): the State filter done shows the ended tasks at once", async t => {
  const { page } = await open(t, {}, "/app/#tasks");
  await filter(page, "state").selectOption("done");
  await settles(async () => (await rowIds(page)).sort(), ["T1", "T20", "T21"]);
  assert.equal(await page.locator(".more-ended").count(), 0, "no Show button to click");
});

const books = async page => [...new Set((await page.locator("a.row[data-task]").evaluateAll(rows => rows.map(row => row.dataset.task))).map(key => key.slice(0, key.lastIndexOf("/"))))];

test("T1080, T1135: with two projects, Tasks shows one project, its chief groups, filter values and chief chips; the picker switches, and Back returns", async t => {
  const { page } = await open(t, { twin: true }, "/app/#tasks?group=chief&project=sample-app-abc123");
  await settles(() => groupTitles(page), ["Claude · C1", "Codex · C2"]);
  await settles(() => books(page), ["shared/sample-app-abc123"]);
  assert.deepEqual((await filter(page, "chief").locator("option").allTextContents()).slice(1), ["Claude · C1", "Codex · C2"]);
  assert.match(await row(page, "T3").textContent(), /^P2Sample shared limitsproviders/, "no row names a project");
  assert.deepEqual(await page.locator("button.chip[data-chief]").evaluateAll(chips => chips.map(chip => chip.dataset.chief)), ["shared/sample-app-abc123/C1", "shared/sample-app-abc123/C2"], "the chips of this project only");
  await page.locator("header.top button.picker").click();
  await page.locator('.pick-menu a[data-project="other-app-def456"]').click();
  await settles(() => books(page), ["shared/other-app-def456"]);
  assert.equal(await page.evaluate(() => location.hash), "#tasks?project=other-app-def456", "the picker keeps the page and names the project");
  await page.goBack();
  await settles(() => books(page), ["shared/sample-app-abc123"]);
});

test("T1099, T1135 (F-T1099-37, F-T1099-38): two logbooks with one display name read apart in the picker", async t => {
  const { page } = await open(t, { twin: "one name" }, "/app/#tasks?group=chief");
  await page.locator("header.top button.picker").click();
  assert.deepEqual(await page.locator(".pick-menu a b").allTextContents(), ["twin (other-app-def456)", "twin (sample-app-abc123)"]);
});

test("T1098 (R4165-2): two logbooks with one display name and the same chief ids: the chief filter of Tasks and Pull requests shows only the chosen logbook's tasks", async t => {
  const { page, problems } = await open(t, { twin: "one name" }, "/app/#tasks");
  const books = async selector => [...new Set((await page.locator(selector).evaluateAll(rows => rows.map(row => row.dataset.task ?? row.dataset.prTask))).map(key => key.slice(0, key.lastIndexOf("/"))))].sort();
  const ids = selector => page.locator(selector).evaluateAll(rows => rows.map(row => (row.dataset.task ?? row.dataset.prTask).split("/").pop()).sort());
  const seen = {};
  for (const book of ["shared/sample-app-abc123", "shared/other-app-def456"]) {
    await page.goto(`${page.url().split("#")[0]}#tasks?project=${book.split("/")[1]}`);
    await page.locator(`button.chip[data-chief="${book}/C1"]`).click();
    await page.goto(`${page.url().split("#")[0]}#tasks`);
    await settles(() => books("a.row[data-task]"), [book], `Tasks lists only ${book}'s tasks of C1`);
    await page.goto(`${page.url().split("#")[0]}#pull-requests`);
    await settles(() => books("li.prow[data-pr-task]"), [book], `Pull requests lists only ${book}'s tasks of C1`);
    seen[book] = { pulls: await ids("li.prow[data-pr-task]") };
    await page.goto(`${page.url().split("#")[0]}#tasks`);
    seen[book].tasks = await ids("a.row[data-task]");
  }
  assert.ok(seen["shared/sample-app-abc123"].tasks.length > 0 && seen["shared/sample-app-abc123"].pulls.length > 0, "C1 owns tasks and pull requests");
  assert.deepEqual(seen["shared/other-app-def456"], seen["shared/sample-app-abc123"], "the twin logbook is a copy, so each C1 shows the same task ids once");
  assert.deepEqual(problems, []);
});

test("T1061, T1083: the task page opens from the keyboard, its tabs move with the arrow keys, and Back or the back link returns the focus to the row", async t => {
  const { page } = await open(t, {}, "/app/#tasks");
  await row(page, "T3").focus();
  await page.keyboard.press("Enter");
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1", "the focus moves to the page's title");
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Log 8");
  assert.equal(await page.getByRole("tab", { name: /Log/ }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Decisions 1", "End goes to the last tab (F-T1080-21)");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "About", "Home goes to the first tab");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator("#tab-panel").textContent(), /qa started/);
  assert.match(page.url(), /&tab=log$/, "the tab is in the address");
  await page.goBack();
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T3"));
  assert.equal(await page.evaluate(() => location.hash), "#tasks?project=sample-app-abc123", "a tab change adds no Back step");
  await page.keyboard.press("Enter");
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "‹ Tasks", "Shift+Tab reaches the back link");
  await page.keyboard.press("Enter");
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T3"));
});

test("T1061 (F-T1061-1): markup, quotes, newlines and javascript: links in agent text, paths and branch names show as text, never as page code", async t => {
  const { page, problems } = await open(t, { hostile: true }, "/app/#tasks");
  assert.equal(await row(page, "T50").locator(".text").textContent(), HOSTILE_TEXT.title);
  await row(page, "T50").click();
  await taskTitle(page).filter({ hasText: HOSTILE_TEXT.title }).waitFor();
  const panel = page.locator(".taskpage");
  assert.match(await panel.textContent(), /sage\/t50-<b>bold<\/b>/, "the branch name is text");
  assert.deepEqual(await panel.locator(".callout code").allTextContents(), ["<script>window.hacked=3</script>\\nsrc/evil\\u202egnp\\u009b.js", "src/a\\u061cb\\u2060c\\u00add\\u180ee\\u{e0001}f.js", "javascript:window.hacked=4", "src/shared.js"], "a path shows its newline, its right-to-left override, its C1 control and every other invisible or format character, also outside the BMP, as escapes");
  await page.getByRole("tab", { name: /Artifacts/ }).click();
  assert.match(await panel.locator("#tab-panel").textContent(), /sage_x_t50_r9 <img src=x onerror=window\.hacked=9>\.json/);
  assert.match(await panel.locator("#tab-panel").textContent(), /<img src=x onerror="window\.hacked=6">label/);
  await page.getByRole("tab", { name: /Log/ }).click();
  assert.match(await panel.locator("#tab-panel").textContent(), /state building <a href="javascript:window\.hacked=5">click<\/a> · <i>why<\/i>/);
  await page.getByRole("tab", { name: /Decisions/ }).click();
  assert.match(await panel.locator("#tab-panel").textContent(), /Ship "it"\? <b>now<\/b>.*You answered: <script>window\.hacked=7<\/script>/);
  const injected = await page.evaluate(() => ({ hacked: window.hacked ?? null, markup: document.querySelectorAll("main img, main script, main b, main i, main [onerror]").length, scripted: [...document.querySelectorAll("main a")].filter(a => !/^(?:#|\/|https:)/.test(a.getAttribute("href") ?? "")).length }));
  assert.deepEqual(injected, { hacked: null, markup: 0, scripted: 0 });
  assert.deepEqual(problems, []);
});

test("T1061, T1083: text meets AA contrast on the task page and its tabs, in the dark and the light theme", async t => {
  const { page } = await open(t, {}, taskPage("T3"));
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Switch to the light theme" }).click();
    for (const tab of ["Artifacts", "Log", "Decisions"]) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      const low = (await page.evaluate(measureContrast)).filter(item => item.ratio < item.need);
      assert.deepEqual(low, [], `${theme}, ${tab}: every text meets AA`);
    }
  }
});

test("T1061: with 370 tasks the page shows the open ones and collapses the ended ones, and a group opens on demand", async t => {
  const { page } = await open(t, { many: 370 }, "/app/#tasks");
  assert.equal(await page.locator("a.row").count(), 7, "only the 7 open tasks render");
  assert.match(await page.locator(".toolbar [role=status]").textContent(), /^7 open · 363 ended$/);
  await page.locator('[data-group="none"] .more-ended').click();
  assert.equal(await page.locator('[data-group="none"] a.row').count(), 2 + 360, "T30, T40 and the 360 ended tasks with no milestone");
});

test("T1061: an open task page reads the task again when the logbook changes", async t => {
  const { page, logbook } = await open(t, {}, `${taskPage("T3")}&tab=log`);
  await page.locator("#tab-panel").filter({ hasText: "qa started" }).waitFor();
  appendFileSync(join(logbook, "decisions.tsv"), `${new Date().toISOString()}\tT3\tsample decision after the panel opened\t\n`);
  await page.locator("#tab-panel .log li").first().filter({ hasText: "chief" }).filter({ hasText: "sample decision after the panel opened" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1", "a live update does not move the focus");
});

function editTasks(logbook, edit) {
  const file = join(logbook, "tasks.tsv"), [head, ...lines] = readFileSync(file, "utf8").trimEnd().split("\n"), columns = head.split("\t");
  const rows = lines.map(line => Object.fromEntries(line.split("\t").map((value, i) => [columns[i], value]))).flatMap(edit);
  writeFileSync(`${file}.new`, [head, ...rows.map(task => columns.map(column => task[column]).join("\t"))].join("\n") + "\n");
  renameSync(`${file}.new`, file);
}

function insideItsCell(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter(box => box.width > 0), boxes = [];
  for (let node = element; node && !node.matches("a.row"); node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible" || node.parentElement.matches("a.row")) boxes.push(node.getBoundingClientRect());
  }
  return lines.length > 0 && lines.every(line => boxes.every(box => line.left >= box.left - 0.5 && line.right <= box.right + 0.5 && line.top >= box.top - 0.5 && line.bottom <= box.bottom + 0.5));
}

test("T1061 (F-T1061-7, F-T1061-10): the may-conflict flag and the chief tag show in full at 1440 and 1280 px", async t => {
  const { page, base } = await open(t, { edge: true }, "/app/#tasks");
  const cells = [["T3", ".badge.warn", "may conflict · T40"], ["T40", ".badge.warn", "may conflict · T3"], ["T3", ".chief", "Codex · C2"], ["T40", ".chief", "Claude · C1 (waits for you)"]];
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/app/#tasks`);
    await row(page, "T3").waitFor();
    for (const [id, cell, text] of cells) {
      const element = row(page, id).locator(cell);
      assert.equal(await element.textContent(), text);
      assert.equal(await element.evaluate(insideItsCell), true, `${width} px: ${id}'s "${text}" shows in full`);
    }
  }
});

test("T1061 (F-T1061-12), T1083: a title of 3,000 characters with no space wraps in full on the task page", async t => {
  const { page } = await open(t, { edge: true }, taskPage("T60"));
  const heading = taskTitle(page).filter({ hasText: "SampleSample" });
  await heading.waitFor();
  assert.equal(await heading.evaluate(element => element.firstChild.textContent.length), 3000);
  const box = await heading.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, page: document.documentElement.scrollWidth - innerWidth }));
  assert.deepEqual(box, { scroll: box.client, client: box.client, page: 0 }, "the whole title shows, with no sideways scroll");
});

test("T1061 (F-T1061-3, F-T1061-11): an open task page says so when its task leaves the board, or when it cannot refresh", async t => {
  const { page, logbook } = await open(t, {}, taskPage("T30"));
  await taskTitle(page).filter({ hasText: "Sample crash reports" }).waitFor();
  assert.equal(await page.locator(".stale").count(), 0, "no notice while the page is current");
  editTasks(logbook, task => task.id === "T30" ? [] : [task]);
  await page.locator(".stale").filter({ hasText: "This task is no longer on the board. The page shows what it read last." }).waitFor();
  assert.equal(await taskTitle(page).textContent(), "Sample crash reportsT30", "the page keeps what it read, under the notice");

  await page.goto(page.url().replace(/T30$/, "T3"));
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  await page.route("**/app/task/**", route => route.fulfill({ status: 500, body: "" }));
  appendFileSync(join(logbook, "decisions.tsv"), `${new Date().toISOString()}\tT3\tsample decision after the panel opened\t\n`);
  await page.locator(".stale").filter({ hasText: "The page could not refresh. It shows what it read last, and tries again when the logbook changes." }).waitFor();
});

test("T1061 (F-T1061-13): a task with no route shows the route as unknown and no steps", async t => {
  const { page, logbook } = await open(t, {}, "/app/#tasks");
  editTasks(logbook, task => [task.id === "T40" ? { ...task, route: "" } : task]);
  await page.goto(`${page.url().split("#")[0]}${taskPage("T40").slice("/app/".length)}`);
  await taskTitle(page).filter({ hasText: "Sample crash fix" }).waitFor();
  await page.locator(".about-s p.now").filter({ hasText: /^In progress: the logbook records no route for this task\./ }).waitFor();
  assert.equal(await page.locator(".trail li").count(), 0);
});

test("T1061 (F-T1061-33): a row's chief dot is green only for a live chief; a stopped chief is grey, a chief of unknown liveness has a hollow dot named so, and no chief has no dot", async t => {
  const { page } = await open(t, { chiefCases: true }, "/app/#tasks");
  const colour = name => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
  const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(part => parseInt(part, 16)).join(", ")})`;
  const [live, grey] = [rgb(await colour("--done")), rgb(await colour("--faint"))];
  const dot = id => row(page, id).locator(".chief").evaluate(cell => {
    const element = cell.querySelector(".dot"), style = element && getComputedStyle(element);
    return { text: cell.textContent, fill: style?.backgroundColor ?? null, ring: style ? style.boxShadow !== "none" || style.borderStyle !== "none" : null };
  });
  const unknown = async id => assert.equal(await row(page, id).getByRole("img", { name: "Chief unknown" }).count(), 1, `${id}: the hollow dot has a text alternative`);
  assert.deepEqual(await dot("T3"), { text: "Codex · C2", fill: live, ring: false }, "a live chief (a run is running)");
  assert.deepEqual(await dot("T70"), { text: "Claude · C3 (stopped)", fill: grey, ring: false }, "a stopped chief (no heartbeat for 2 h)");
  assert.deepEqual(await dot("T40"), { text: "Claude · C1", fill: "rgba(0, 0, 0, 0)", ring: true }, "a listed chief with no heartbeat: liveness unknown");
  await unknown("T40");
  assert.deepEqual(await dot("T71"), { text: "C9", fill: "rgba(0, 0, 0, 0)", ring: true }, "a chief that chiefs.tsv does not list");
  await unknown("T71");
  assert.deepEqual(await dot("T72"), { text: "No chief", fill: null, ring: null }, "no chief, so no dot");
});

test("T1061 (F-T1061-26): a milestone problem in Needs you links to the Tasks page at its milestone", async t => {
  const { page } = await open(t, { stuck: true });
  const link = page.getByRole("link", { name: "Milestone 3: Sign-in rework is stuck" });
  assert.equal(await link.getAttribute("href"), `#tasks?milestone=${encodeURIComponent(KEY("M3"))}`);
  await link.click();
  await page.locator(`.group.focus[data-group="${KEY("M3")}"]`).waitFor();
});

test("T1064 (F-T1064-64, F-T1064-65, F-T1064-66): at 390 px each reader page shows one text column at nearly full width and scrolls only up and down; at 1280 px the side column stays", async t => {
  const { page, base, problems, logbook } = await open(t, { documents: true }, readerUrl(KEY("T3"), "brief", "R7"));
  const gate = join(logbook, "gates", "G4.json"), kept = JSON.parse(readFileSync(gate, "utf8"));
  kept.message.blocks.push({ t: "picture", title: "Where the work is", key: "The double box is the task that runs now.", frame: { box: "milestone", name: "Offline sync", state: "active", items: [{ box: "task", name: "T10 Share sheet", state: "building", here: true }] } });
  writeFileSync(gate, JSON.stringify(kept));
  const pages = { brief: [readerUrl(KEY("T3"), "brief", "R7"), "details[open] .body"], report: [readerUrl(KEY("T3"), "report", "R5"), ".result"], markdown: [readerUrl(KEY("T3"), "page", "retry-design.md"), ".doc .md"],
    compare: [readerUrl(KEY("T10"), "design", null, { view: "compare" }), ".pair .version"], question: [readerUrl(KEY("T10"), "question", "G4"), "main pre.md"] };
  const measure = text => page.evaluate(selector => ({ scroll: document.documentElement.scrollWidth, view: innerWidth, pre: document.querySelectorAll("main pre.md").length,
    text: [...document.querySelectorAll(selector)].map(e => { const s = getComputedStyle(e); return Math.round(e.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)); }) }), text);
  for (const [name, [path, text]] of Object.entries(pages)) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}${path}`);
    const narrow = await measure(text);
    assert.ok(narrow.scroll <= narrow.view, `${name} at 390 px scrolls sideways: ${narrow.scroll} px wide`);
    assert.ok(narrow.text.length > 0 && narrow.text.every(width => width >= 300), `${name} at 390 px: each text column is at least 300 px wide, saw ${narrow.text}`);
    if (name === "question") assert.ok(narrow.pre > 0, "the question shows its frame");
    if (name === "compare") assert.ok(await page.evaluate(() => { const [a, b] = document.querySelectorAll(".pair .version"); return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom; }), "the two versions stack");
    await page.setViewportSize({ width: 1280, height: 900 });
    const wide = await measure(text);
    assert.ok(wide.scroll <= wide.view, `${name} at 1280 px scrolls sideways`);
    if (name === "brief" || name === "report") assert.equal(await page.locator(".cols > .side").evaluate(e => Math.round(e.getBoundingClientRect().width)), 260, `${name}: the side column stays at 1280 px`);
    if (name === "compare") assert.ok(await page.evaluate(() => { const [a, b] = document.querySelectorAll(".pair .version"); return a.getBoundingClientRect().top === b.getBoundingClientRect().top; }), "the two versions stand side by side at 1280 px");
  }
  assert.deepEqual(problems, []);
});

const heights = page => page.locator("a.row").evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));

test("T1080 (F-T1080-5): with many may-conflict partners, a row names one and counts the rest, and rows keep an even height at 1440 and 1280 px", async t => {
  const { page, base } = await open(t, { crowd: 13 }, "/app/#tasks");
  assert.equal(await row(page, "T80").locator(".badge.warn").textContent(), "may conflict · T81 +11");
  assert.equal(await row(page, "T80").locator(".badge.warn").getAttribute("title"), `May conflict with ${Array.from({ length: 12 }, (_, i) => `T${81 + i}`).join(", ")}`);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/app/#tasks`);
    await row(page, "T80").waitFor();
    const all = await heights(page), plain = Math.min(...all);
    assert.ok(all.every(height => height <= plain * 1.6), `${width} px: no row is much taller than a one-line row (${plain} px), saw ${all}`);
    assert.equal(await row(page, "T80").locator(".badge.warn").evaluate(insideItsCell), true, `${width} px: T80's flag shows in full`);
  }
});

test("T1080 (F-T1080-23, F-T1080-26): a group name in the address that is a built-in object key gives the default view, and the other pages still show", async t => {
  const { page, base, problems } = await open(t, {}, "/app/#tasks");
  for (const name of ["constructor", "toString", "__proto__"]) {
    await page.goto(`${base}/app/#tasks?group=${name}`);
    await settles(() => groupTitles(page), ["Milestone 2: Offline sync", "Milestone 1: Board redesign", "No milestone", "Milestone 3: Sign-in rework"], `group=${name} gives the milestone groups`);
    await page.evaluate(() => { location.hash = "#overview"; });
    await page.locator("main h1").filter({ hasText: "Overview" }).waitFor();
  }
  assert.deepEqual(problems, []);
});

test("T1080 (F-T1080-8, F-T1080-9, F-T1080-12): invisible characters show as escapes in paths and in prose, while emoji, flags and joined words show whole", async t => {
  const { page } = await open(t, { unicode: true }, taskPage("T40"));
  await taskTitle(page).filter({ hasText: "Sample \\u202eevil title" }).waitFor();
  assert.equal(await taskTitle(page).evaluate(element => element.firstChild.textContent), "Sample \\u202eevil title", "the title shows the override as an escape");
  assert.deepEqual(await page.locator(".callout code").allTextContents(), [
    "src/a\\u034fb\\u115fc\\u3164d\\uffa0e\\u180bf\\u17b4g\\u200dh\\u200ci\\ufe0fj\\u{e0100}k.js",
    UNICODE_TEXT.emoji,
    UNICODE_TEXT.word,
    "src/shared.js",
  ]);
  await page.getByRole("tab", { name: /Decisions/ }).click();
  assert.match(await page.locator("#tab-panel").textContent(), /Ship \\u2066now\\u2069\?/);
  await page.getByRole("tab", { name: /Log/ }).click();
  assert.match(await page.locator("#tab-panel").textContent(), /state building \\u202eevil/);
});

test("T1080 (F-T1080-24): only a whole subdivision flag keeps its tag characters; any other tag character shows as an escape", async t => {
  const tags = text => [...text].map(c => String.fromCodePoint(0xe0000 + c.codePointAt(0))).join("");
  const escaped = text => [...text].map(c => /[\u{e0000}-\u{e007f}]/u.test(c) ? `\\u{${c.codePointAt(0).toString(16)}}` : c).join("");
  const flag = "\u{1f3f4}", scotland = `docs/${flag}${tags("gbsct")}\u{e007f}.md`, long = `src/${flag}${tags("run rm -rf now")}\u{e007f}.js`, uncancelled = `src/${flag}${tags("gbsct")}.js`, bare = `src/a${tags("gb")}\u{e007f}.js`;
  const { page } = await open(t, { unicode: [scotland, long, uncancelled, bare] }, taskPage("T40"));
  await taskTitle(page).filter({ hasText: "Sample \\u202eevil title" }).waitFor();
  assert.deepEqual(await page.locator(".callout code").allTextContents(), [scotland, escaped(long), escaped(uncancelled), escaped(bare), "src/shared.js"]);
});

test("T1080 (F-T1080-15, F-T1080-20): a milestone link from Needs you lands on a group that says why it is stuck and shows its ended tasks, or on a note when no task is there", async t => {
  const { page, base } = await open(t, { stuck: true }, `/app/#tasks?milestone=${encodeURIComponent(KEY("M3"))}`);
  const group = page.locator(`.group.focus[data-group="${KEY("M3")}"]`);
  await group.waitFor();
  assert.equal(await group.locator(".why").textContent(), "Milestone 3: Sign-in rework is stuck. The pilot T20 was abandoned. Choose a new pilot, or drop the milestone.");
  assert.deepEqual(await group.locator("a.row .id").allTextContents(), ["T22", "T20", "T21"], "the abandoned pilot shows without a click");
  await page.goto(`${base}/app/#tasks?milestone=${encodeURIComponent(KEY("M10"))}`);
  const lost = page.locator(".lost");
  await lost.waitFor();
  assert.equal(await lost.locator("h2").textContent(), "Milestone 10: Empty stuck");
  assert.match(await lost.textContent(), /The breakdown gate G11 of M10 is not in the logbook\. Ask the chief to repair the logbook, or to propose M10 again\..*The logbook links no task to this milestone\./);
});

test("T1080 (F-T1080-19): a live chief's dot has a name, and the task page says the chief's liveness", async t => {
  const { page, base } = await open(t, { chiefCases: true }, "/app/#tasks");
  assert.equal(await row(page, "T3").getByRole("img", { name: "Chief in progress" }).count(), 1);
  for (const [id, title, text] of [["T3", "Sample shared limits", "Codex · C2 \\(chief in progress\\)"], ["T70", "Sample stopped chief", "Claude · C3 \\(chief stopped\\)"], ["T40", "Sample crash fix", "Claude · C1 \\(chief unknown\\)"]]) {
    await page.goto(`${base}${taskPage(id)}`);
    await taskTitle(page).filter({ hasText: title }).waitFor();
    assert.match(await page.locator(".facts-line").textContent(), new RegExp(`Run by ${text}(?: ·|$)`));
  }
});

test("T770 (F-T770-9): the task page of a task with no chief says \"No chief\", not \"Run by No chief\"", async t => {
  const { page, base } = await open(t, { chiefCases: true }, "/app/#tasks");
  await page.goto(`${base}${taskPage("T72")}`);
  const facts = page.locator(".facts-line").first();
  await facts.waitFor();
  const text = await facts.textContent();
  assert.match(text, /· No chief(?: ·|$)/);
  assert.doesNotMatch(text, /Run by/);
});

test("T1099 (F-T1099-56): a task in a logbook that records no chief names the logbook's provider and an unknown chief once, not \"Chief unknown (chief unknown)\"", async t => {
  const { page, base } = await open(t, { source: { id: "claude", label: "Claude", provider: "claude" } }, "/app/#tasks");
  await page.goto(`${base}/app/#task?key=${encodeURIComponent("claude/sample-app-abc123/T3")}`);
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  const facts = await page.locator(".facts-line").textContent();
  assert.match(facts, /Run by Claude · chief unknown(?: ·|$)/);
  assert.doesNotMatch(facts, /\(chief unknown\)/);
});

test("T1099 (F-T1099-47): no Tasks, Pull requests or Agents row shows a bare dash: an absent value is blank, an unknown one says unknown", async t => {
  const { page, base } = await open(t, { agents: true, prs: true, chiefCases: true }, "/app/#tasks");
  const dash = /(^|[\s·])[–—]([\s·]|$)/;
  for (const [hash, cells] of [["tasks", "a.row > span"], ["pull-requests", ".facts > span, .meta > span"], ["agents", ".acard-f, .tot, a.ag .num, .chief-box .cm"]]) {
    await page.goto(`${base}/app/#${hash}`);
    await page.locator(cells).first().waitFor();
    const texts = await page.locator(cells).allTextContents();
    assert.ok(texts.length > 3, `${hash}: the page has rows`);
    assert.deepEqual(texts.filter(text => dash.test(text.trim())), [], `${hash}: no bare dash`);
  }
  await page.goto(`${base}/app/#tasks`);
  assert.equal(await row(page, "T72").locator(".pr").textContent(), "", "a task with no PR leaves the PR cell blank");
});

test("T1099 (F-T1099-64, F-T1099-72): a task address with a bad percent key, then a good one, still shows the task and its back link", async t => {
  const { page, base, problems } = await open(t, {}, "/app/#tasks");
  await page.goto(`${base}/app/#task?key=%E0%A4%A`);
  await page.locator(".taskpage h1").waitFor();
  await page.evaluate(key => { location.hash = `#task?key=${encodeURIComponent(key)}`; }, KEY("T3"));
  await taskTitle(page).filter({ hasText: "Sample shared limits" }).waitFor();
  assert.match(await page.locator(".taskpage a.back").textContent(), /^‹ Task /);
  assert.deepEqual(problems.filter(problem => !/status of 404/.test(problem)), [], "no page error; the 404 is the board's answer for the bad key");
});

test("T1080 (F-T1080-3, F-T1080-22): the task page puts the question, the recommendation and the next step on their own lines; Back from an ended task puts the focus on its row", async t => {
  const { page } = await open(t, {}, taskPage("T30"));
  await taskTitle(page).filter({ hasText: "Sample crash reports" }).waitFor();
  assert.deepEqual(await page.locator(".about-s p.now").allTextContents(), ["Needs you: Crash reports: send them on their own, or ask each time?", "I recommend: A: ask each time", "Next: The build is briefed after your answer."]);
  await page.goto(page.url().replace(/#.*$/, "#tasks"));
  await page.locator('[data-group="shared/sample-app-abc123/M1"] .more-ended').click();
  await row(page, "T1").click();
  await taskTitle(page).filter({ hasText: "Sample pinned bundle" }).waitFor();
  assert.deepEqual(await page.locator(".about-s p.now").allTextContents(), ["Done: Merged."], "a merged task says Merged once");
  await page.goBack();
  await page.waitForFunction(key => document.activeElement?.dataset.task === key, KEY("T1"));
});

test("T1080: a row's age counts from now, so it grows while the logbook does not change", async t => {
  const { page } = await open(t, { clock: true }, "/app/#tasks");
  assert.equal(await row(page, "T3").locator(".age").textContent(), "30 min ago");
  await page.clock.runFor(2 * 3_600_000);
  await settles(() => row(page, "T3").locator(".age").textContent(), "3 h ago");
});
