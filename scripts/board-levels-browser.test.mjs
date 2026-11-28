import "./test-env.mjs";
import { tname } from "./task-names.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";
import { boardOverview, buildBoardModel, readBoardSources } from "../packages/sage-core/index.mjs";
import { writeSampleLogbooks } from "./board-sample.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";
import { QUESTION, pageQuestion } from "./fixtures/question-message.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const chromium = requireBrowser();
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const WIDTHS = [1440, 390];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function newPage(t, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => /^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url()) ? route.continue() : route.abort());
  const page = await context.newPage(), problems = [];
  page.on("pageerror", error => problems.push(String(error)));
  t.after(() => assert.deepEqual(problems, [], "no script error on the page"));
  return { page, context };
}
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } };

async function answering(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-levels-"))), saved = { ...process.env }, fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const project = join(base, "sample-app");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env), chief = claude.chiefFor(project, "s-a", env);
  const as = (...args) => claude.sage([...args, "--project", project, "--chief", chief], env);
  for (const title of ["Sample shared list permissions", "Receipt mail", "Sample crash report screen"]) as("task", "add", "--name", tname(), "--title", title, "--size", "small", "--priority", "P1");
  as("gate", "add", "--message", QUESTION, "T1", "--question", "Can a viewer copy a shared list?", "--options", "yes|no", "--recommend", "yes");
  as("task", "T2", "set", "state=designing");
  const pages = as("pages", "T2");
  mkdirSync(join(pages, "designs", "final"), { recursive: true });
  writeFileSync(join(pages, "designs", "final", "index.html"), "<h1>Receipt mail, SAMPLE</h1>\n");
  as("task", "T2", "set", "state=awaiting-you");
  as("gate", "add", "T2", "--design", "designs/final", "--question", "Approve design v1 of the receipt mail?", "--recommend", "1", "--message", pageQuestion("T2", "designs/final/index.html"));
  as("gate", "add", "--message", QUESTION, "T3", "--question", "Send crash reports on their own?", "--options", "yes|no", "--recommend", "yes");
  const config = join(base, "home", ".config", "sage-board", "board.json"), stateDir = join(base, "home", ".config", "sage-board", "state");
  const server = quietBoard({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port: 0, app: APP, stateDir, pairCommand: "node /sample/board/cli.mjs board --pair" }, { create: createBoardServer });
  const { port } = await server.start();
  await server.ready();
  await runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: env.SAGE_SHARED_HOME }])], { output: () => {}, env });
  t.after(async () => {
    await server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const pair = async page => {
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env, input: { isTTY: true } });
    await page.getByPlaceholder("ABCD-EFGH").first().fill(/Pairing code: (\S+)/.exec(lines.join("\n"))[1]);
    await page.getByRole("button", { name: "Pair", exact: true }).first().click();
    await page.getByRole("heading", { name: "Pair this browser to act from the board" }).first().waitFor({ state: "detached" });
  };
  const answered = id => JSON.parse(claude.read(dir, "gates").find(row => row.id === id).answered || "null");
  const key = id => `shared/${basename(dir)}/${id}`;
  return { origin: `http://127.0.0.1:${port}`, pair, answered, key, need: id => `[data-need="${key(id)}"]` };
}

for (const width of WIDTHS) {
  test(`T1216 J1 at ${width} px: one click on a choice of a Needs you row answers it, with Undo, and records the same answer as the question page`, async t => {
    const w = await answering(t), { page } = await newPage(t, width);
    await page.goto(`${w.origin}/app/`);
    await page.locator("main h1", { hasText: "All projects" }).waitFor();
    const row = page.locator(w.need("G1"));
    assert.equal(await row.getByRole("button", { name: "yes (recommended)" }).isDisabled(), true, "an unpaired browser cannot answer");
    await w.pair(page);
    let clicks = 0;
    clicks++; await row.getByRole("button", { name: "yes (recommended)" }).click();
    const answeredRow = page.locator(`${w.need("G1")}, [data-answered="${w.key("G1")}"]`);
    await answeredRow.getByText("You chose yes").waitFor();
    assert.equal(clicks, 1, "J1: one click answers a question with fixed choices");
    const onRow = w.answered("G1");
    assert.deepEqual([onRow.via, onRow.answer], ["board", "yes"]);
    await answeredRow.getByRole("button", { name: "Undo" }).click();
    for (let i = 0; i < 50 && w.answered("G1"); i++) await page.waitForTimeout(100);
    assert.equal(w.answered("G1"), null, "Undo on the row takes the answer back");
    await shot(page, `answered-${width}`);

    await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(w.key("G3"))}`);
    await page.getByRole("radio", { name: /^yes/ }).check();
    await page.getByRole("button", { name: "Send answer" }).click();
    await page.locator("#said").waitFor();
    const onPage = w.answered("G3");
    assert.deepEqual(Object.keys(onRow).sort(), Object.keys(onPage).sort(), "the row writes the same record as the question page");
    assert.deepEqual([onPage.via, onPage.answer], [onRow.via, onRow.answer]);
  });

  test(`T1216 J1 at ${width} px: a design question has no choice on its row; its row opens the task, where the decision comes first and one more click approves`, async t => {
    const w = await answering(t), { page } = await newPage(t, width);
    await page.goto(`${w.origin}/app/`);
    await w.pair(page);
    const row = page.locator(w.need("G2"));
    assert.equal(await row.getByRole("button").count(), 0, "no answer on the row of a design question");
    let clicks = 0;
    clicks++; await row.getByRole("link", { name: "Open the design to answer" }).click();
    const decide = page.locator(".lv-decide");
    await decide.getByRole("heading", { name: "Approve design v1 of the receipt mail?" }).waitFor();
    assert.deepEqual(await decide.getByRole("button").allTextContents(), ["Approve (recommended)", "Approve with your words", "New version"]);
    assert.ok(await page.locator(".taskpage h1").boundingBox().then(box => box.y) < (await decide.boundingBox()).y, "the decision comes right under the title and the steps");
    const preview = decide.locator(".viewer");
    await preview.locator("iframe").waitFor();
    assert.equal(await preview.locator("h2").textContent(), "Design · 1 version", "F-T1216-16: the decision shows the task's design");
    assert.equal(await decide.evaluate(block => !!(block.querySelector(".viewer").compareDocumentPosition([...block.querySelectorAll("button")].find(button => button.textContent.startsWith("Approve"))) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "F-T1216-16: the design comes before Approve");
    const [seen, approve] = [await preview.boundingBox(), await decide.getByRole("button", { name: "Approve (recommended)" }).boundingBox()];
    assert.ok(width < 760 ? seen.y + seen.height <= approve.y : seen.x + seen.width <= approve.x, "the design is above the choices on a phone, and on their left on a wide screen");
    await shot(page, `design-ask-${width}`);
    await decide.getByRole("button", { name: "Approve with your words" }).click();
    await decide.getByRole("textbox").waitFor();
    await decide.getByRole("button", { name: "Cancel" }).click();
    clicks++; await decide.getByRole("button", { name: "Approve (recommended)" }).click();
    await decide.getByText("You chose Approve").waitFor();
    assert.equal(clicks, 2, "J1: a design question takes two clicks");
    assert.deepEqual([w.answered("G2").via, w.answered("G2").answer], ["board", "Approve"]);
    assert.equal(await decide.getByRole("button", { name: "Undo" }).count(), 1);
    await decide.locator(".viewer iframe").waitFor();
    assert.equal(await decide.getByRole("link", { name: "Open the design and the full question" }).getAttribute("href"), `#question?key=${encodeURIComponent(w.key("G2"))}`, "F-T1216-29: the answered decision keeps the design and its link");
    await shot(page, `design-${width}`);
  });
}

async function fixture(t, { maxModel, empty = false, damaged = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-levels-fx-")), saved = process.env.SAGE_WORKTREES, logbooks = join(dir, "logbooks");
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  mkdirSync(logbooks, { recursive: true });
  if (!empty) {
    writeTasksLogbook(logbooks, join(dir, "worktrees"), new Date().toISOString(), { agents: true, about: true });
    const quiet = join(logbooks, "quiet-app-def456");
    mkdirSync(quiet);
    for (const [name, columns] of Object.entries(TABLES)) writeFileSync(join(quiet, `${name}.tsv`), `${columns.join("\t")}\n`);
    if (damaged) writeFileSync(join(logbooks, "sample-app-abc123", "runs.tsv"), "not a header\n");
  }
  const server = quietBoard({ sources: [{ id: "shared", path: logbooks, label: "Shared" }], port: 0, app: APP, ...(maxModel && { maxModel }) });
  const { port } = await server.start();
  await server.ready();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}
const KEY = id => encodeURIComponent(`shared/sample-app-abc123/${id}`);
const LEVELS = { l0: "", l1: "#project?key=sample-app-abc123", l2: `#milestone?key=${KEY("M1")}`, l3: `#task?key=${KEY("T3")}`, l4: `#run?key=${KEY("T3")}&run=R30` };

test("T1216: each level shows its loading state while the board reads", async t => {
  const origin = await fixture(t), { page, context } = await newPage(t, 1440);
  await context.route(`${origin}/app/events`, () => {});
  await context.route(`${origin}/app/task/**`, () => {});
  for (const [level, hash] of Object.entries(LEVELS)) {
    await page.goto(`${origin}/app/${hash}`);
    const text = { l3: "Reading the task", l4: "Reading the run" }[level] ?? "The board is reading the logbooks";
    await page.locator("main h1", { hasText: text }).waitFor();
    await shot(page, `${level}-loading-1440`);
  }
});

test("T1216: each level shows its empty state in one line, not empty cards", async t => {
  const none = await fixture(t, { empty: true }), { page } = await newPage(t, 1440);
  await page.goto(`${none}/app/`);
  await page.getByRole("heading", { name: "Start your first task" }).waitFor();
  await shot(page, "l0-empty-1440");
  const origin = await fixture(t);
  await page.goto(`${origin}/app/#project?key=quiet-app-def456`);
  await page.locator("main h1", { hasText: "quiet-app" }).waitFor();
  assert.equal(await page.locator("[data-part=needs]").textContent(), "Nothing needs you here.");
  assert.equal(await page.locator("[data-part=fold]").textContent(), "Here: no agent at work · no milestone · nothing waits · nothing done in the last 7 days.");
  assert.equal(await page.locator("section.lv-part").count(), 0, "no part with nothing in it");
  await shot(page, "l1-empty-1440");
  await page.goto(`${origin}/app/#milestone?key=${KEY("M3")}`);
  await page.locator("main h1", { hasText: "Sign-in rework" }).waitFor();
  assert.equal(await page.locator("[data-part=fold], [data-part=needs]").count(), 0, "a milestone page lists its tasks, so it has no empty line");
  assert.equal(await page.locator("[data-part=lines] .lv-row").count(), 2, "both merged tasks stay on the milestone page");
  await shot(page, "l2-empty-1440");
  await page.goto(`${origin}/app/#task?key=${KEY("T4")}`);
  await page.getByText("No agent works on this task now.").waitFor();
  await shot(page, "l3-empty-1440");
  await page.goto(`${origin}/app/${LEVELS.l4}`);
  await page.getByText("The log shows here when the agent writes its first note.").waitFor();
  await shot(page, "l4-empty-1440");
});

test("T1216: each level shows its failure and keeps the rest of the page", async t => {
  const origin = await fixture(t, { damaged: true }), { page, context } = await newPage(t, 1440);
  for (const level of ["l0", "l1", "l2"]) {
    await page.goto(`${origin}/app/${LEVELS[level]}`);
    await page.locator("[data-part=failure]").filter({ hasText: "the board cannot read the runs table of its Shared logbook" }).waitFor();
    assert.ok(await page.locator("[data-part=needs], [data-part=work], [data-part=progress], [data-part=lines]").count() > 0, `${level} keeps its parts`);
    await shot(page, `${level}-failure-1440`);
  }
  await context.route(`${origin}/app/task/**`, route => route.fulfill({ status: 503, contentType: "text/plain", body: "The board is reading again. Try again in a moment.\n" }));
  await page.goto(`${origin}/app/${LEVELS.l3}`);
  await page.locator("main h1", { hasText: "The board cannot read this task now" }).waitFor();
  await shot(page, "l3-failure-1440");
  const healthy = await fixture(t);
  await context.route(`${healthy}/api/actions/**`, route => route.fulfill({ status: 503, contentType: "text/plain", body: "The board cannot read this run's actions now. Try again.\n" }));
  await page.goto(`${healthy}/app/${LEVELS.l4}`);
  await page.locator("[data-part=failure]", { hasText: "The board cannot read this run's log now." }).waitFor();
  assert.equal(await page.locator("[data-part=facts]").count(), 1, "the run still says what happened");
  await shot(page, "l4-failure-1440");
});

test("T1216: when the model is too big to send, each level shows the red note and no endless loading", async t => {
  const origin = await fixture(t, { maxModel: 2000 }), { page } = await newPage(t, 1440);
  for (const [level, hash] of Object.entries(LEVELS)) {
    await page.goto(`${origin}/app/${hash}`);
    await page.locator("[data-part=too-big]", { hasText: /^The board could not send its newest read/ }).waitFor();
    assert.equal(await page.getByText("The board is reading the logbooks").count(), 0, `${level}: no loading state under the note`);
    assert.match(await page.locator("[data-part=too-big]").textContent(), /No read fit since this page opened, so the page has nothing to show yet\./, "F-T1216-34: no earlier read, so the note does not promise one");
    assert.equal(await page.locator("header .live").textContent(), "No read to show", "F-T1216-34: the top bar does not say that it reads for ever");
    await shot(page, `${level}-big-1440`);
  }
});

test("F-T1216-24, F-T1216-33: the back link of a task page that a link opened goes up one level: its milestone, else its project", async t => {
  const origin = await fixture(t), { page } = await newPage(t, 1440);
  await page.goto(`${origin}/app/${LEVELS.l3}`);
  const back = page.locator(".taskpage a.back");
  await back.filter({ hasText: "Board redesign" }).waitFor();
  assert.deepEqual([await back.textContent(), await back.getAttribute("href")], ["‹ Board redesign", `#milestone?key=${KEY("M1")}`]);
  await back.click();
  await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
  assert.equal(await page.goto(`${origin}/app/#task?key=${KEY("T3")}`).then(() => back.filter({ hasText: "Milestone" }).textContent()), "‹ Milestone", "a level page in the history: the back link goes back to it");
  await page.goto("about:blank");
  await page.goto(`${origin}/app/#task?key=${KEY("T30")}`);
  await page.locator(".taskpage h1", { hasText: "T30" }).waitFor();
  assert.deepEqual([await back.textContent(), await back.getAttribute("href")], ["‹ sample-app", "#project?key=sample-app-abc123"], "a task in no milestone goes up to its project");
  await shot(page, "back-1440");
});

test("F-T1216-31, F-T1216-32: a run link says when the board cannot read the runs table, and a link with no run says so", async t => {
  const origin = await fixture(t, { damaged: true }), { page } = await newPage(t, 1440);
  await page.goto(`${origin}/app/${LEVELS.l4}`);
  await page.locator("main h1", { hasText: "The board cannot read this run now" }).waitFor();
  assert.match(await page.locator("[data-part=failure]").last().textContent(), /^The board cannot read the runs table of this logbook, so it cannot show R30\./);
  assert.equal(await page.getByText("This run is not in the logbook").count(), 0, "the run is not called missing");
  await shot(page, "run-unread-1440");
  const healthy = await fixture(t);
  await page.goto(`${healthy}/app/#run?key=${KEY("T3")}`);
  await page.locator("main h1", { hasText: "The link names no run" }).waitFor();
  assert.equal(await page.locator("main").getByRole("link", { name: "Open the task" }).getAttribute("href"), `#task?key=${KEY("T3")}`);
  assert.equal(await page.locator(".lv-crumb [aria-current=page]").textContent(), "Run");
  await shot(page, "run-no-id-1440");
});

async function sample(t, { archivedGate = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-levels-sample-"))), now = new Date().toISOString();
  const sources = writeSampleLogbooks(join(dir, "sample"), { now }).map(({ id, label, path }) => ({ id, label, path }));
  if (archivedGate) {
    const book = join(dir, "sample", "codex", readdirSync(join(dir, "sample", "codex")).find(name => name.startsWith("old-site-")));
    appendFileSync(join(book, "gates.tsv"), `${TABLES.gates.map(column => ({ id: "G1", task: "T3", question: "Sample: keep the old site up?", options: "yes|no", recommendation: "yes", at: new Date(Date.parse(now) - 60_000).toISOString() })[column] ?? "").join("\t")}\n`);
  }
  const server = quietBoard({ sources, port: 0, app: APP });
  const { port } = await server.start();
  await server.ready();
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const view = boardOverview(buildBoardModel(readBoardSources(sources, { now: Date.parse(now) }), { now }));
  const key = (id, project = "claude/sage-") => view.tasks.find(task => task.id === id && task.key.startsWith(project)).key;
  return { origin: `http://127.0.0.1:${port}`, view, key, now };
}

test("F-T1216-21: a stopped or failed run with no report says that it stopped; only a run at work says it is at work", async t => {
  const { origin, key } = await sample(t), { page } = await newPage(t, 1440);
  const report = async (task, run) => {
    await page.goto(`${origin}/app/#run?key=${encodeURIComponent(key(task))}&run=${run}`);
    await page.locator("main h1", { hasText: run }).waitFor();
    return page.locator("[data-part=report] p").first().textContent();
  };
  assert.equal(await report("T301", "R242"), "No report. The run stopped.", "R242 is running in the logbook, but its agent stopped with no report");
  assert.equal(await page.locator("[data-part=facts] .big2").textContent(), "Stopped without a report");
  await shot(page, "run-stopped-1440");
  assert.equal(await report("T210", "R254"), "No report. The run stopped.", "R254 failed");
  await shot(page, "run-failed-1440");
  assert.equal(await report("T301", "R241"), "No report yet: the run is at work.");
});

test("F-T1216-17, F-T1216-22: a failed run shows the flag words of the model; a merge row names its next step and no ask time", async t => {
  const { origin, key } = await sample(t), { page } = await newPage(t, 1440);
  await page.goto(`${origin}/app/`);
  const failed = page.locator(`[data-part=work] a[data-run="R254"][data-task="${key("T210")}"]`);
  await failed.waitFor();
  assert.deepEqual([await failed.locator(".fl").textContent(), await failed.locator(".fl").getAttribute("class")], ["failed", "fl red"]);
  const merge = page.locator(`[data-part=needs] .lv-need`).filter({ has: page.locator(`a[href="#task?key=${encodeURIComponent(key("T12", "claude/order-chaser-"))}"]`) });
  assert.match(await merge.locator(".q").textContent(), /PR 41/);
  assert.equal(await merge.locator(".body .more").last().textContent(), "Next: merge it in the chief's chat. The chief runs the merge check first.");
  assert.equal(await merge.locator(".meta").textContent(), "T12 · order-chaser", "no ask time for a row that is not a question");
  await shot(page, "merge-row-1440");
});

test("F-T1216-18: the since line counts the questions and the flags of the rows below it, so an archived project counts in neither", async t => {
  const { origin, view, now } = await sample(t, { archivedGate: true }), { page } = await newPage(t, 1440);
  const archived = new Set(view.projects.filter(project => project.archived).map(project => project.key)), from = Date.parse(now) - 86_400_000;
  assert.ok(view.needs.some(need => archived.has(need.project) && Date.parse(need.askedAt) > from), "the archived project has a new question, so the test can tell");
  const asked = view.needs.filter(need => !archived.has(need.project) && Date.parse(need.askedAt) > from).length, flags = view.agents.filter(book => !archived.has(book.project)).reduce((n, book) => n + book.look, 0);
  await page.goto(`${origin}/app/`);
  await page.locator("[data-part=since]").waitFor();
  assert.match(await page.locator("[data-part=since]").textContent(), new RegExp(` · ${asked} new questions? · ${flags} with a flag now`));
  await shot(page, "since-1440");
});

async function named(t) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-levels-names-")), saved = process.env.SAGE_WORKTREES, logbooks = join(dir, "logbooks"), book = join(logbooks, "sample-app-abc123");
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(logbooks, join(dir, "worktrees"), new Date().toISOString(), {});
  const row = (table, values) => { const file = join(book, `${table}.tsv`); appendFileSync(file, `${readFileSync(file, "utf8").split("\n")[0].split("\t").map(column => values[column] ?? "").join("\t")}\n`); };
  row("tasks", { id: "T15", title: "Sample lone task of a milestone with a long name", size: "small", route: "build,code-review,qa", state: "building", round: "0", milestone: "M4" });
  row("gates", { id: "G9", task: "T15", question: "Approve milestone M4? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", answer: "approve", at: new Date(Date.now() - 3_600_000).toISOString() });
  row("milestones", { id: "M4", name: "A milestone whose name runs on and on past the width of a phone", goal: "Sample goal.", pilot: "T15", gate: "G9", at: new Date(Date.now() - 3_600_000).toISOString() });
  const server = quietBoard({ sources: [{ id: "shared", path: logbooks, label: "Shared" }], port: 0, app: APP });
  const { port } = await server.start();
  await server.ready();
  t.after(async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${port}`;
}

for (const width of WIDTHS) {
  test(`T1257 at ${width} px: rows read "name: where it stands", a milestone lists its tasks in waits-for lines, and a task outside its milestone carries the milestone tag`, async t => {
    const origin = await named(t), { page } = await newPage(t, width);
    await page.goto(`${origin}/app/${LEVELS.l2}`);
    await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
    const lines = page.locator("[data-part=lines]");
    assert.deepEqual(await lines.locator(".lv-line .ln").allTextContents(), ["First", "Then", "Last"]);
    assert.deepEqual(await lines.locator(".lv-line").evaluateAll(list => list.map(line => [...line.querySelectorAll("[data-task]")].map(row => row.dataset.task.split("/").at(-1)))), [["T1"], ["T2", "T3"], ["T4"]]);
    assert.equal(await lines.locator(".tag").count(), 0, "no milestone tag inside the milestone's own page");
    assert.equal(await lines.locator(`[data-task$="/T4"] .tt`).textContent(), "Sample queue: waits for Sample chief records.");
    assert.equal(await lines.locator(`[data-task$="/T4"] .tn.fb`).evaluate(name => getComputedStyle(name).fontStyle), "italic", "a name from the title shows in italics");
    await page.goto(`${origin}/app/#milestone?key=${KEY("M4")}`);
    await page.locator("main h1", { hasText: "A milestone whose name" }).waitFor();
    assert.equal(await page.locator("[data-part=lines] .ln").count(), 0, "a milestone with one line has no First, Then or Last");
    await page.goto(`${origin}/app/${LEVELS.l1}`);
    const tag = page.locator(`[data-part=waits] [data-task$="/T15"] .tag`);
    await tag.waitFor();
    assert.equal(await tag.getAttribute("title"), "A milestone whose name runs on and on past the width of a phone");
    if (width === 390) assert.ok(await tag.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === "ellipsis"), "a long milestone name is cut with an ellipsis on a phone");
    await page.goto(`${origin}/app/${LEVELS.l3}`);
    await page.locator(".tp-head .kind", { hasText: "Task in" }).waitFor();
    assert.match(await page.locator(".tp-head .kind").textContent(), /^Task in . Board redesign name from the title$/);
    assert.match(await page.locator(".taskpage h1").textContent(), /^Sample shared limits T3$/);
    assert.equal(await page.locator(".tp-head .tp-what").textContent(), "What it is: Sample shared limits");
    await shot(page, `names-task-${width}`);
  });
}

const selected = page => page.evaluate(() => { const row = document.activeElement?.closest(".main [data-nav]"); return row && (row.dataset.need ?? row.dataset.answered ?? row.dataset.decide ?? row.getAttribute("href")); });
const until = async (page, check) => { for (let i = 0; i < 50 && !check(); i++) await page.waitForTimeout(100); return check(); };

test("T1250 keys: j and k move the selection, 1 to 3 answer the selected question, a design question opens its page and never takes a key, and no key acts in a text field or with Ctrl, Cmd or Alt held", async t => {
  const w = await answering(t), { page } = await newPage(t, 1440);
  await page.goto(`${w.origin}/app/`);
  await page.locator("main h1", { hasText: "All projects" }).waitFor();
  const code = page.getByPlaceholder("ABCD-EFGH").first();
  await code.focus();
  await page.keyboard.type("jk1");
  assert.equal(await code.inputValue(), "jk1", "the text field gets the letters");
  assert.equal(await selected(page), null, "no key moves the selection while a text field has the focus");
  await code.fill("");
  await w.pair(page);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("j");
  assert.equal(await selected(page), w.key("G1"), "j selects the first row: the oldest question");
  for (const key of ["j", "j", "j"]) await page.keyboard.press(key);
  assert.equal(await selected(page), w.key("G3"), "j stops at the last row");
  await page.keyboard.press("k"); await page.keyboard.press("k");
  assert.equal(await selected(page), w.key("G1"), "k moves up");
  for (const key of ["Control+2", "Meta+2", "Alt+2", "Control+j", "Meta+j", "Alt+j"]) await page.keyboard.press(key);
  assert.equal(await selected(page), w.key("G1"), "no key acts with Ctrl, Cmd or Alt held");
  await page.waitForTimeout(300);
  assert.equal(w.answered("G1"), null, "Ctrl, Cmd or Alt with a number answers nothing");
  await page.keyboard.press("2");
  assert.equal((await until(page, () => w.answered("G1")))?.answer, "no", "2 answers the selected question with its second choice");
  await page.locator(`${w.need("G1")}, [data-answered="${w.key("G1")}"]`).getByText("You chose no").waitFor();

  await page.locator(w.need("G2")).focus();
  await page.keyboard.press("1");
  await page.locator(".lv-decide h2", { hasText: "Approve design v1 of the receipt mail?" }).waitFor();
  assert.match(new URL(page.url()).hash, /^#task\?key=.*T2$/, "1 on a design question opens its task page");
  await page.keyboard.press("j");
  assert.equal(await selected(page), w.key("G2"), "j selects the decision on the task page");
  for (const key of ["1", "2", "3"]) await page.keyboard.press(key);
  await page.waitForTimeout(300);
  assert.equal(w.answered("G2"), null, "no key answers a design question, also on its own page");
  assert.equal(await page.locator(".lv-decide textarea").count(), 0, "and no key opens its words box");

  await page.goto(`${w.origin}/app/#task?key=${encodeURIComponent(w.key("T3"))}`);
  await page.locator(".lv-decide h2", { hasText: "Send crash reports on their own?" }).waitFor();
  await page.keyboard.press("j");
  await page.keyboard.press("1");
  assert.equal((await until(page, () => w.answered("G3")))?.answer, "yes", "1 answers the selected decision on a task page");
  await shot(page, "keys-answered-1440");
});

test("T1250 keys: ? lists the keys and Esc closes the list; Enter and o open the row; u goes up and marks the row; g then i selects what needs you; g then p opens the projects", async t => {
  const origin = await fixture(t), { page } = await newPage(t, 1440);
  await page.goto(`${origin}/app/${LEVELS.l1}`);
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  await page.keyboard.press("?");
  const list = page.getByRole("dialog", { name: "Keys" });
  await list.waitFor();
  assert.deepEqual(await list.locator("dt").allTextContents(), ["jk", "Entero", "u", "123", "g then i", "g then p", "?", "Esc"]);
  await shot(page, "keys-list-1440");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "? Keys" }).click();
  await list.waitFor();
  await list.getByRole("button", { name: "Close" }).click();
  await list.waitFor({ state: "hidden" });

  await page.keyboard.press("j");
  const first = await page.evaluate(() => { const row = document.activeElement.closest("[data-nav]"); return (row.matches("a") ? row : row.querySelector("[data-open]")).getAttribute("href"); });
  await page.keyboard.press("o");
  await page.waitForURL(url => new URL(url).hash === first);
  await page.goBack();
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();

  const m1 = page.locator(`[data-part=progress] a[data-milestone="${decodeURIComponent(KEY("M1"))}"]`);
  await m1.focus();
  await page.keyboard.press("Enter");
  await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
  await page.keyboard.press("u");
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  assert.equal(await selected(page), `#milestone?key=${KEY("M1")}`, "u returns to the project and selects the milestone you came from");
  assert.equal(await m1.evaluate(row => row.classList.contains("came")), true, "and marks it");

  await page.keyboard.press("g"); await page.keyboard.press("i");
  await page.locator("main h1", { hasText: "All projects" }).waitFor();
  assert.equal(await page.evaluate(() => !!document.activeElement.closest("[data-part=needs] [data-need]")), true, "g then i selects the first row of Needs you");
  assert.equal(await page.evaluate(() => document.activeElement.closest("[data-need]") === document.querySelector("[data-part=needs] [data-need]")), true);

  await page.keyboard.press("g"); await page.keyboard.press("p");
  const menu = page.getByRole("menu", { name: "Projects" });
  await menu.waitFor();
  assert.ok((await menu.getByRole("menuitem").allTextContents()).some(item => item.startsWith("sample-app")), "g then p opens the list of projects");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Projects", "Esc gives the focus back to the menu button");
});

test("T1250 keep place: Back and u return to the same scroll place and mark the row you came from", async t => {
  const origin = await fixture(t), { page } = await newPage(t, 1440);
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.goto(`${origin}/app/${LEVELS.l1}`);
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  const done = page.locator("[data-part=done] a[data-task]").first();
  await done.evaluate(row => row.scrollIntoView({ block: "center" }));
  const y = await page.evaluate(() => scrollY), href = await done.getAttribute("href");
  assert.ok(y > 200, `the project page scrolls: ${y}`);
  await done.click();
  await page.locator(".taskpage h1").waitFor();
  await page.goBack();
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  await page.waitForFunction(at => scrollY === at, y);
  assert.equal(await selected(page), href, "Back selects the row you opened");
  assert.equal(await done.evaluate(row => row.classList.contains("came")), true, "and marks it");
  await shot(page, "keep-back-1440");

  const m1 = page.locator(`[data-part=progress] a[data-milestone="${decodeURIComponent(KEY("M1"))}"]`);
  await m1.evaluate(row => row.scrollIntoView({ block: "center" }));
  const at = await page.evaluate(() => scrollY);
  assert.ok(at > 0, `the milestone row is under the first screen: ${at}`);
  await m1.click();
  await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
  await page.evaluate(() => scrollTo(0, 120));
  await page.keyboard.press("u");
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  await page.waitForFunction(place => scrollY === place, at);
  assert.equal(await selected(page), `#milestone?key=${KEY("M1")}`, "u selects the milestone you came from");
  assert.equal(await m1.evaluate(row => row.classList.contains("came")), true, "and marks it");
  await shot(page, "keep-up-1440");
});

for (const width of WIDTHS) {
  test(`T1250 crumb menus at ${width} px: each part of the breadcrumb opens a menu of its siblings with their counts, by mouse and by keyboard`, async t => {
    const origin = await fixture(t), { page } = await newPage(t, width);
    await page.goto(`${origin}/app/${LEVELS.l3}`);
    await page.locator(".tp-head .kind", { hasText: "Task in" }).waitFor();
    const crumb = page.locator("header .lv-crumb");
    assert.deepEqual(await crumb.getByRole("button").evaluateAll(list => list.map(button => [button.getAttribute("aria-label"), button.getAttribute("aria-haspopup"), button.getAttribute("aria-expanded")])),
      [["Projects", "menu", "false"], ["Other projects", "menu", "false"], ["Other milestones", "menu", "false"]], "All projects, the project and the milestone each have a menu button");
    const milestones = crumb.getByRole("button", { name: "Other milestones" });
    await milestones.click();
    const menu = page.getByRole("menu", { name: "Other milestones" });
    await menu.waitFor();
    assert.equal(await milestones.getAttribute("aria-expanded"), "true");
    assert.equal(await milestones.getAttribute("aria-controls"), await menu.getAttribute("id"));
    const items = await menu.getByRole("menuitem").evaluateAll(list => list.map(item => [item.querySelector("b").textContent, item.querySelector("span").textContent, item.getAttribute("aria-current")]));
    const named = Object.fromEntries(items.map(([name, n, current]) => [name, [n, current]]));
    assert.deepEqual(Object.keys(named).sort(), ["Board redesign", "No milestone", "Offline sync", "Sign-in rework"]);
    assert.deepEqual([named["Offline sync"], named["Sign-in rework"]], [["0 of 2", null], ["2 of 2", null]], "a milestone counts its merged tasks of all");
    assert.match(named["Board redesign"][0], /^\d+ of \d+$/);
    assert.equal(named["Board redesign"][1], "true", "the milestone of the task is marked");
    assert.match(named["No milestone"][0], /^\d+ open$/, "No milestone counts its open tasks");
    assert.equal(items.at(-1)[0], "No milestone", "No milestone comes last");
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `the menu fits the screen: ${JSON.stringify(box)}`);
    await shot(page, `crumb-milestones-${width}`);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("role")), "menuitem", "the menu takes the focus");
    assert.equal(await page.evaluate(() => document.activeElement.querySelector("b").textContent), "Board redesign", "the focus starts on the milestone of the task");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.querySelector("b").textContent), items[items.findIndex(([name]) => name === "Board redesign") + 1][0], "the arrow keys move in the menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Other milestones", "Esc closes the menu and gives the focus back");

    const projects = crumb.getByRole("button", { name: "Projects", exact: true });
    await projects.focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("menu", { name: "Projects" });
    await list.waitFor();
    const rows = await list.getByRole("menuitem").evaluateAll(all => all.map(item => [item.querySelector("b").textContent, item.querySelector("span").textContent]));
    assert.deepEqual(rows.map(([name]) => name), ["sample-app", "quiet-app"]);
    assert.match(rows[0][1], /^\d+ needs? you$/, "a project with questions shows how many need you");
    assert.equal(rows[1][1], "quiet", "a quiet project says so");
    await list.getByRole("menuitem", { name: /quiet-app/ }).click();
    await page.locator("main h1", { hasText: "quiet-app" }).waitFor();
    assert.equal(await list.count(), 0, "a choice closes the menu");
  });
}

test("T1250 phone bar at 390 px: Up, N need you and Find sit at the bottom of the first screen; the tree leaves, so switching projects is no longer 2400 px down", async t => {
  const origin = await fixture(t), { page } = await newPage(t, 390);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/app/`);
  await page.locator("main h1", { hasText: "All projects" }).waitFor();
  const bar = page.getByRole("navigation", { name: "Phone bar" });
  const needs = await page.locator("[data-part=needs] [data-need]").count();
  assert.ok(needs > 1, "the sample has questions");
  assert.deepEqual(await bar.locator(":scope > a, :scope > button, .lv-mbtn").evaluateAll(list => list.map(item => [item.textContent, item.getAttribute("aria-label"), item.disabled ?? null])),
    [["↑ Up", "Up one level", true], [`${needs} need you`, null, false], ["Find", "Find a project", false]]);
  assert.equal(await page.locator(".side .tree").boundingBox(), null, "the tree leaves at 390 px");
  const find = await bar.getByRole("button", { name: "Find a project" }).boundingBox();
  assert.ok(find.y + find.height <= 844 && find.y > 700, `Find, the project switch, is at the bottom of the first screen, not 2400 px down: ${JSON.stringify(find)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await shot(page, "phone-bar-390");
  await bar.getByRole("button", { name: "Find a project" }).click();
  const menu = page.getByRole("menu", { name: "Find a project" });
  await menu.waitFor();
  const box = await menu.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= find.y && box.x >= 0 && box.x + box.width <= 390, `the menu opens above the bar, on the screen: ${JSON.stringify(box)}`);
  await shot(page, "phone-find-390");
  await menu.getByRole("menuitem", { name: /sample-app/ }).click();
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await bar.getByRole("button", { name: `${needs} need you` }).click();
  await page.locator("main h1", { hasText: "All projects" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.closest("[data-need]") === document.querySelector("[data-part=needs] [data-need]")), true, "N need you opens All projects on its first question");
  await page.goto(`${origin}/app/${LEVELS.l2}`);
  await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
  await bar.getByRole("link", { name: "Up one level" }).click();
  await page.locator("main h1", { hasText: "sample-app" }).waitFor();
  assert.equal(await selected(page), `#milestone?key=${KEY("M1")}`, "Up keeps your place like u");
});
