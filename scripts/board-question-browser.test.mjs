import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { HOSTILE_MARKDOWN } from "./fixtures/board-app.mjs";
import { QUESTION, questionFile } from "./fixtures/question-message.mjs";

const chromium = requireBrowser();
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const TITLE = "Can a viewer copy a shared list into their own lists?";
const MESSAGE = { kind: "question", title: TITLE, blocks: [
  { t: "field", label: "Where", text: "The sample task sets what each person may do with a shared list." },
  { t: "field", label: "Approve", text: "The rule for viewers." },
  { t: "field", label: "Choice", text: "Does a viewer get a copy action?" },
  { t: "table", head: ["Answer", "Next", "Cost"], rows: [["A: yes", "The chief adds the copy action.", "About 1 to 2 h of agent time."], ["B: no", "The chief builds view only.", "No extra cost now."]], pick: 0 },
  { t: "field", label: "Default", text: "The task waits." }, { t: "field", label: "Due", text: "Sample: no time." }, { t: "field", label: "Next", text: "The chief builds the task." },
  { t: "page", title: "Design notes", task: "T1", file: "notes.md", part: "The rule", answer: "A" }] };
const HOSTILE_PROTOTYPE = `<!doctype html><title>Sample prototype</title><pre id="out">waiting</pre><script>
const out = [], show = () => { document.getElementById("out").textContent = out.join("\\n"); };
const probe = (name, fn) => { try { out.push(name + ": " + fn()); } catch (error) { out.push(name + ": blocked " + error.name); } };
probe("parent", () => parent.document.title);
probe("storage", () => String(localStorage.getItem("board-token")));
probe("cookie", () => document.cookie || "empty");
probe("top", () => { top.location.href = "/app/#moved"; return "tried"; });
fetch("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logbook: "x", gate: "G1", option: 1, digest: "0000000000000000" }) })
  .then(response => "api: " + response.status, error => "api: blocked " + error.name).then(line => { out.push(line); show(); });
show();
</script>
<a id="top" target="_top" href="/app/#moved">Move the board</a> <a id="pop" target="_blank" href="/app/#popup">Open a new page</a>
`;

async function openBoard(t, viewport = { width: 1440, height: 1000 }, { refuse, before, setup } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-question-browser-")));
  const saved = { ...process.env }, fakes = join(base, "fakes");
  mkdirSync(fakes);
  for (const name of ["gh", "ps", "kill"]) { writeFileSync(join(fakes, name), `#!/bin/sh\necho fake-${name} >&2\nexit 1\n`); chmodSync(join(fakes, name), 0o755); }
  const env = { PATH: `${fakes}:/usr/bin:/bin`, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"),
    SAGE_HOOKS_STATE: join(base, "hook-state"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  Object.assign(process.env, env);
  const addProject = name => {
    const project = join(base, name);
    mkdirSync(project);
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
    claude.sage(["link", "--separate", "--project", project], env);
    const dir = claude.storeDir(project, env), now = Date.now(), iso = ms => new Date(ms).toISOString();
    writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${iso(now - 3 * 3600_000)}\nC2\tcodex\tcodex-1\t${iso(now - 2 * 3600_000)}\n`);
    mkdirSync(join(dir, "live"));
    for (const id of ["C1", "C2"]) writeFileSync(join(dir, "live", `${id}.json`), JSON.stringify({ provider: id === "C2" ? "codex" : "claude", checkout: project, sageMode: true, autopilot: false, at: iso(now) }));
    return { dir, project, as: (chief, ...args) => claude.sage([...args, "--project", project, "--chief", chief], env) };
  };
  const { dir, as, project } = addProject("sample-app");
  as("C1", "task", "add", "--title", "Sample shared list permissions", "--size", "small", "--priority", "P1");
  as("C2", "task", "add", "--title", "Sample crash report screen", "--size", "small", "--priority", "P2");
  const pages = join(env.SAGE_WORKTREES, basename(dir), "pages", "T1");
  mkdirSync(join(pages, "designs", "v1"), { recursive: true });
  writeFileSync(join(pages, "notes.md"), `# Design notes\n\nThe notes of the sample design.\n\n${Array.from({ length: 30 }, (_, i) => `Sample line ${i + 1} before the rule.`).join("\n\n")}\n\n## The rule\n\nA viewer may copy a list. The copy is a new private list.\n\n${Array.from({ length: 30 }, (_, i) => `Sample line ${i + 1} after the rule.`).join("\n\n")}\n`);
  writeFileSync(join(pages, "hostile.md"), HOSTILE_MARKDOWN);
  writeFileSync(join(pages, "designs", "v1", "version.json"), JSON.stringify({ title: "v1", about: "The share sheet.", run: "R1" }));
  writeFileSync(join(pages, "designs", "v1", "index.html"), HOSTILE_PROTOTYPE);
  writeFileSync(join(pages, "designs", "v1", "notes.md"), "# Notes of v1\n\nWhy the share sheet looks like this.\n");
  as("C1", "run", "add", "T1", "--role", "pe");
  writeFileSync(join(base, "question.json"), JSON.stringify(MESSAGE));
  as("C1", "gate", "add", "T1", "--question", TITLE, "--options", "A: yes|B: no", "--recommend", "A: yes", "--default", "A: yes", "--message", join(base, "question.json"), "--run", "R1");
  as("C2", "gate", "add", "--message", questionFile("Crash reports: send them on their own, or ask each time?"), "T2", "--question", "Crash reports: send them on their own, or ask each time?", "--options", "ask each time|send them", "--recommend", "ask each time");
  setup?.(as);
  const stateDir = join(base, "home", ".config", "sage-board", "state"), writes = [];
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const { writeInWorker } = await import("../plugins/sage/board/writes.mjs");
  const server = createBoardServer({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port: 0, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair",
    write: job => { writes.push(job.argv); before?.(job); return refuse ? { code: 1, text: refuse } : writeInWorker(job); } });
  const { port } = await server.start();
  const context = await browser.newContext({ viewport, colorScheme: "dark", timezoneId: "America/New_York" });
  t.after(async () => {
    await context.close(); await server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, outside = [];
  await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : (outside.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  await page.goto(`${origin}/app/#pair=${startLink(stateDir)}`);
  await page.getByText(/^This browser is paired\./).waitFor();
  const shot = async name => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
  const config = (...args) => claude.sage(["config", ...args, "--project", project], env);
  return { page, origin, dir, writes, outside, shot, as, config, addProject, base, gate: id => claude.read(dir, "gates").find(row => row.id === id) };
}

test("T1121: one click on Needs you opens the question with its material; a page opens in place at the named part, beside the answers; the answer sends from there, and the view names the question left", async t => {
  const w = await openBoard(t), { page } = w;
  await page.getByRole("link", { name: TITLE }).click();
  await page.getByRole("heading", { name: TITLE, level: 1 }).waitFor();
  assert.equal(await page.locator(".q-main .facts-line").nth(1).textContent(), "If you do not answer: C1 takes A: yes.", "R3: the gate's default under the title, and no time");
  const material = page.locator(".material");
  assert.deepEqual(await material.locator(".mat b").allTextContents(), ["Design notes", "Design · 1 version", "v1 prototype", "hostile.md", "Report of R1", "Brief of R1"]);
  assert.deepEqual(await material.locator("h3").allTextContents(), ["Named", "Task pages", "Asking run"]);
  await w.shot("question-view");

  await page.getByRole("button", { name: "See answer A in Design notes" }).click();
  const frame = page.locator(".viewer iframe");
  assert.equal(await frame.getAttribute("sandbox"), "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
  const notes = page.frameLocator(".viewer iframe");
  await notes.getByRole("heading", { name: "The rule" }).waitFor();
  assert.equal(await notes.locator("header.top").count(), 0, "the reader page shows no top bar in the frame");
  await page.waitForFunction(() => document.querySelector(".viewer iframe").contentDocument?.scrollingElement.scrollTop > 0);
  assert.equal(await page.evaluate(() => { const doc = document.querySelector(".viewer iframe").contentDocument; return Math.round(doc.getElementById("h-the-rule").getBoundingClientRect().top); }), 8, "the page opens at the named part");
  assert.equal(await page.evaluate(() => scrollY), 0, "the board itself stays at its top");
  assert.equal(await page.locator(".viewer .hint").textContent(), "Why it is here: G1 names it in the question. It shows answer A.");
  await w.shot("question-page-open");

  await page.locator(".q-side").getByRole("radio", { name: /^A: yes/ }).check();
  await page.locator(".q-side").getByRole("button", { name: "Send answer" }).click();
  await page.locator(".q-side").getByText(/^You answered G1: A: yes\. Recorded in the logbook\./).waitFor();
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "A: yes");
  const left = page.getByRole("link", { name: "Needs you · 1 left: G2 from C2" });
  await left.waitFor();
  await w.shot("question-sent");
  await left.click();
  await page.getByRole("heading", { name: "Crash reports: send them on their own, or ask each time?", level: 1 }).waitFor();
  assert.equal(await page.locator(".viewer").count(), 0, "the next question opens on its answers, not on the last file");
  assert.deepEqual(w.outside, [], "no outside request");
});

test("T1121: on a 390 px window, an open file keeps an answer bar at the bottom that picks and sends", async t => {
  const w = await openBoard(t, { width: 390, height: 844 }), { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.locator(".mat").filter({ hasText: "Design notes" }).click();
  const bar = page.locator(".qbar");
  await bar.waitFor();
  const box = await bar.boundingBox();
  assert.ok(box && Math.round(box.y + box.height) === 844, `the bar sits at the bottom of the window (${JSON.stringify(box)})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scroll");
  await w.shot("question-phone");
  await bar.getByRole("button", { name: "B: no" }).click();
  await bar.getByRole("button", { name: "Send" }).click();
  await inView(page, bar.getByText(/^You answered G1: B: no\. Recorded in the logbook\./), "F-T1121-13: the bar shows that the answer is sent");
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "B: no");
  assert.equal(await bar.getByRole("button", { name: "Send" }).count(), 0, "a sent answer leaves no Send in the bar");
  await w.shot("question-phone-sent");
});

test("T1121 F-T1121-3: below 900 px, where the answers go under the material, an open file keeps the answer bar at the bottom", async t => {
  const w = await openBoard(t, { width: 820, height: 1000 }), { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.locator(".mat").filter({ hasText: "Design notes" }).click();
  await inView(page, page.locator(".qbar").getByRole("button", { name: "Send" }), "the bar shows at 820 px");
});

async function inView(page, locator, why) {
  await locator.waitFor();
  const box = await locator.boundingBox(), { height } = page.viewportSize();
  assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${why}, in the window without a scroll (${JSON.stringify(box)})`);
}

test("T1121 F-T1121-13: on a 390 px window, a refused answer shows in the answer bar, in view, and the logbook keeps no answer", async t => {
  const refuse = "sage: G1 has an answer already: A: yes, from the chief's chat.";
  const w = await openBoard(t, { width: 390, height: 844 }, { refuse }), { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.locator(".mat").filter({ hasText: "Design notes" }).click();
  const bar = page.locator(".qbar");
  await bar.getByRole("button", { name: "B: no" }).click();
  await bar.getByRole("button", { name: "Send" }).click();
  await inView(page, bar.getByText("Not recorded. G1 has an answer already: A: yes, from the chief's chat."), "the bar names the refusal");
  assert.equal(w.writes.length, 1);
  assert.equal(w.gate("G1").answered ?? "", "", "nothing was recorded");
  await w.shot("question-phone-refused");
});

test("T1121 R5: a hostile prototype or Markdown page in the material cannot read the board, its storage or its cookie, call the API, or move the top page", async t => {
  const w = await openBoard(t), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  await page.goto(url);
  await page.locator(".mat").filter({ hasText: "v1 prototype" }).click();
  assert.equal(await page.locator(".viewer iframe").getAttribute("sandbox"), "allow-scripts");
  assert.match(await page.locator(".viewer .frame-warn").textContent(), /^This page runs its own scripts in a sandbox\./, "G190: one warning line on the frame");
  const out = page.frameLocator(".viewer iframe").locator("#out");
  await out.filter({ hasText: /^api: / }).or(out.filter({ hasText: /\napi: / })).waitFor();
  const lines = (await out.textContent()).split("\n");
  assert.deepEqual(lines.slice(0, 3), ["parent: blocked SecurityError", "storage: blocked SecurityError", "cookie: blocked SecurityError"]);
  assert.match(lines.at(-1), /^api: (?:blocked TypeError|4\d\d)$/, "the API refuses a write from the frame");
  assert.deepEqual(w.writes, [], "no write reached the logbook");
  assert.equal(page.url(), `${url}&open=${encodeURIComponent("T1/designs/v1/index.html")}`, "the top page did not move: it shows the open item in its address");
  await w.shot("question-prototype");

  await page.locator(".mat").filter({ hasText: "hostile.md" }).click();
  const doc = page.frameLocator(".viewer iframe");
  await doc.getByRole("heading", { name: "Hostile sample" }).waitFor();
  assert.match(await doc.locator("article").textContent(), /<script>window\.hacked=1<\/script>/, "the script shows as text");
  assert.equal(await page.evaluate(() => window.hacked), undefined, "no script of the page ran in the board");
  assert.equal(await doc.locator('a[href="https://example.com/docs"]').getAttribute("target"), "_blank", "a link to another site opens a new tab, not in the board");
  assert.equal(page.url(), `${url}&open=${encodeURIComponent("T1/hostile.md")}`);
  assert.deepEqual(w.writes, []);
});

test("T1121 F-T1121-2: in a framed reader page, a click on a link to another site opens a new page and a link to a page of the task opens in the frame; in the prototype frame, neither does", async t => {
  const w = await openBoard(t), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  const context = page.context();
  await page.goto(url);
  await page.locator(".mat").filter({ hasText: "v1 prototype" }).click();
  const prototype = page.frameLocator(".viewer iframe");
  await prototype.locator("#out").filter({ hasText: /api: / }).waitFor();
  await prototype.locator("#pop").click();
  await prototype.locator("#top").click();
  await page.locator(".mat").filter({ hasText: "hostile.md" }).click();
  const doc = page.frameLocator(".viewer iframe");
  await doc.getByRole("heading", { name: "Hostile sample" }).waitFor();
  const hostile = `${url}&open=${encodeURIComponent("T1/hostile.md")}`;
  assert.equal(page.url(), hostile, "a click on a _top link in the prototype does not move the board");
  const [popup] = await Promise.all([context.waitForEvent("page"), doc.getByRole("link", { name: "a safe site" }).click()]);
  assert.deepEqual(w.outside, ["https://example.com/docs"], "the new page asked for the other site (the test blocks every request that leaves the board)");
  assert.equal(context.pages().length, 2, "the board and that one page: the prototype's _blank link opened none");
  await popup.close();
  await doc.getByRole("link", { name: "a safe page" }).click();
  await doc.getByRole("heading", { name: "Design notes", level: 1 }).waitFor();
  assert.equal(page.url(), hostile, "F-T1121-20: a page of the task opens in the frame, and the board stays");
  assert.equal(await page.locator(".viewer h2").textContent(), "Design notes", "F-T1156-26: the frame's header names the page that the link opened");
  assert.equal(await page.locator(".viewer .hint").textContent(), "Why it is here: you opened it from a link in hostile.md.");
  assert.deepEqual(w.writes, []);
});

test("T1156 F-T1156-50: after a link in the frame opens another page and a link there comes back, the header and Why it is here name the first page again", async t => {
  const w = await openBoard(t), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  writeFileSync(join(process.env.SAGE_WORKTREES, basename(w.dir), "pages", "T1", "notes.md"), "# Design notes\n\n[back to the hostile page](hostile.md)\n");
  await page.goto(url);
  await page.locator(".mat").filter({ hasText: "hostile.md" }).click();
  const doc = page.frameLocator(".viewer iframe"), header = page.locator(".viewer h2"), why = page.locator(".viewer .hint");
  await doc.getByRole("heading", { name: "Hostile sample" }).waitFor();
  const first = await why.textContent();
  await doc.getByRole("link", { name: "a safe page" }).click();
  await doc.getByRole("heading", { name: "Design notes", level: 1 }).waitFor();
  await page.waitForFunction(() => document.querySelector(".viewer h2").textContent === "Design notes");
  await doc.getByRole("link", { name: "back to the hostile page" }).click();
  await doc.getByRole("heading", { name: "Hostile sample" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".viewer h2").textContent === "hostile.md");
  assert.equal(await header.textContent(), "hostile.md", "the header names the page that the frame shows");
  assert.equal(await why.textContent(), first, "Why it is here gives the page's own reason again");
});

test("T1121 F-T1121-20, T1156 F-T1156-27: in the Design item, each link keeps the question view and the picked answer: the prototype opens in place, the pages index opens a new tab, the design notes open in the frame", async t => {
  const w = await openBoard(t), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  const context = page.context(), designUrl = `${url}&open=${encodeURIComponent("T1/design")}`;
  await page.goto(url);
  await page.locator(".mat").filter({ hasText: "Design · 1 version" }).click();
  const design = page.frameLocator(".viewer iframe"), picked = page.locator(".q-side").getByRole("radio", { name: /^B: no/ });
  await design.getByRole("link", { name: "Read the design notes" }).waitFor();
  await picked.check();
  const stays = async (why, title = "Design · 1 version", at = designUrl) => {
    assert.equal(page.url(), at, `${why}: the board stays on the question`);
    assert.equal(await page.locator(".viewer h2").textContent(), title, `${why}: the viewer shows ${title}`);
    assert.ok(await picked.isChecked(), `${why}: the picked answer stays`);
    assert.match(await page.locator(".q-side .send").textContent(), /Your answer: B: no/, why);
  };
  const [tab] = await Promise.all([context.waitForEvent("page"), design.getByRole("link", { name: "Open the pages index" }).click()]);
  await tab.waitForLoadState();
  assert.ok(tab.url().startsWith(`${w.origin}/pages/`) && tab.url().endsWith("/T1/"), `the pages index opens ${tab.url()} in a new tab`);
  await tab.close();
  await stays("Open the pages index");
  await design.getByRole("link", { name: "Read the design notes" }).click();
  await design.getByRole("heading", { name: "Notes of v1", level: 1 }).waitFor();
  await stays("Read the design notes", "Notes of v1");
  await page.getByRole("button", { name: "‹ The question" }).click();
  await page.locator(".mat").filter({ hasText: "Design · 1 version" }).click();
  await page.frameLocator(".viewer iframe").getByRole("link", { name: "Open the prototype" }).click();
  await page.locator(".viewer iframe[sandbox='allow-scripts']").waitFor();
  await stays("Open the prototype", "v1 prototype", `${url}&open=${encodeURIComponent("T1/designs/v1/index.html")}`);
  assert.equal(context.pages().length, 1, "no new tab");
  await page.goBack();
  await page.locator(".viewer h2").filter({ hasText: "Design · 1 version" }).waitFor();
  assert.equal(page.url(), designUrl, "F-T1156-30: Back returns to the item that was open before");
  await page.reload();
  await page.locator(".viewer h2").filter({ hasText: "Design · 1 version" }).waitFor();
  assert.ok(await picked.isChecked(), "F-T1156-30: a reload keeps the open item and the picked answer");
  assert.deepEqual(w.writes, [], "the prototype wrote nothing");
});

test("T1121 F-T1121-21: after the last question of this project, the line names the other project that needs you and opens it; a page of a task that the board does not have says so", async t => {
  const w = await openBoard(t), { page } = w;
  const other = w.addProject("other-app");
  other.as("C1", "task", "add", "--title", "Sample export screen", "--size", "small", "--priority", "P1");
  const far = join(w.base, "worktrees", basename(other.dir), "pages", "T9");
  mkdirSync(far, { recursive: true });
  writeFileSync(join(far, "far.md"), "# Far page\n\nA page in a folder of a task that the board does not have.\n");
  writeFileSync(join(w.base, "far.json"), JSON.stringify({ ...MESSAGE, title: "Export as CSV or as a sheet?", blocks: [...MESSAGE.blocks.slice(0, -1), { t: "page", title: "Far page", task: "T9", file: "far.md" }] }));
  other.as("C1", "gate", "add", "T1", "--question", "Export as CSV or as a sheet?", "--options", "A: yes|B: no", "--recommend", "A: yes", "--message", join(w.base, "far.json"));
  w.as("C2", "gate", "answer", "G2", "--option", "1", "--via", "chat");
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.locator(".top").getByRole("button", { name: "1 other project needs you" }).waitFor();
  await page.getByRole("radio", { name: /^A: yes/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText("Nothing else waits in sample-app · 1 other project needs you: other-app").waitFor();
  const line = page.locator(".q-main .send").getByRole("link", { name: "other-app" });
  await w.shot("question-other-project");
  await line.click();
  await page.getByRole("link", { name: "Export as CSV or as a sheet?" }).click();
  await page.locator(".mat").filter({ hasText: "Far page" }).click();
  assert.equal(await page.locator(".viewer .note").textContent(), "The board does not show this page: it has no task T9 in the logbook of this question.", "F-T1121-19: the note says the true reason");
});

function setTaskCells(dir, id, cells) {
  const file = join(dir, "tasks.tsv"), [head, ...rows] = readFileSync(file, "utf8").trimEnd().split("\n"), cols = head.split("\t");
  const row = rows.map(line => line.split("\t")).find(row => row[0] === id);
  for (const [name, value] of Object.entries(cells)) row[cols.indexOf(name)] = value;
  writeFileSync(file, `${[head, ...rows.map(line => line.split("\t")[0] === id ? row.join("\t") : line)].join("\n")}\n`);
}

test("T1156 F-T1156-15, -16: after Send, the line counts every need of the project, also a merge; with none left, it names and links each other project that needs you", async t => {
  const w = await openBoard(t), { page } = w, projects = {};
  for (const name of ["other-app", "third-app"]) {
    const other = projects[name] = w.addProject(name);
    other.as("C1", "task", "add", "--title", `Sample ${name} task`, "--size", "small", "--priority", "P1");
    other.as("C1", "gate", "add", "--message", QUESTION, "T1", "--question", `A question of ${name}?`, "--options", "yes|no", "--recommend", "yes");
  }
  w.as("C2", "gate", "answer", "G2", "--option", "1", "--via", "chat");
  setTaskCells(w.dir, "T2", { state: "verified", pr: "12" });
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.getByRole("radio", { name: /^A: yes/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  const send = page.locator(".q-main .send");
  await send.getByRole("link", { name: "Needs you · 1 left" }).waitFor();
  assert.equal(await send.getByText(/Nothing else waits/).count(), 0, "F-T1156-15: the merge of T2 still waits, so the line does not say that nothing waits");
  setTaskCells(w.dir, "T2", { state: "building", pr: "" });
  await send.getByText(/^Nothing else waits in sample-app · 2 other projects need you: /).waitFor();
  for (const name of ["other-app", "third-app"]) {
    const link = send.getByRole("link", { name, exact: true });
    assert.match(await link.getAttribute("href"), new RegExp(`project=${encodeURIComponent(basename(projects[name].dir))}`), `F-T1156-16: the line links ${name}`);
  }
});

test("T1156 F-T1156-18: a PDF in the material shows a note and a link that opens it in a new tab, and no frame", async t => {
  const w = await openBoard(t), { page } = w;
  writeFileSync(join(process.env.SAGE_WORKTREES, basename(w.dir), "pages", "T1", "spec.pdf"), "%PDF-1.4\n% sample\n");
  writeFileSync(join(w.base, "pdf.json"), JSON.stringify({ ...MESSAGE, title: "Which spec?", blocks: [...MESSAGE.blocks.slice(0, -1), { t: "page", title: "Sample spec", task: "T1", file: "spec.pdf" }] }));
  w.as("C1", "gate", "add", "T1", "--question", "Which spec?", "--options", "A: yes|B: no", "--recommend", "A: yes", "--message", join(w.base, "pdf.json"));
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G3`)}`);
  await page.locator(".mat").filter({ hasText: "Sample spec" }).click();
  const viewer = page.locator(".viewer");
  assert.equal(await viewer.locator(".note").textContent(), "The board does not show a PDF inside the page. Open Sample spec in a new tab.");
  const link = viewer.locator(".note").getByRole("link", { name: "Open Sample spec in a new tab" });
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await link.getAttribute("href"), /\/T1\/spec\.pdf$/);
  assert.equal(await viewer.locator("iframe").count(), 0, "no blank frame");
});

test("T1156 F-T1156-36, -43, -45: the picker counts each need as Needs you does, also in the archived list; the archived banner names the agent that still runs, as the header counts it", async t => {
  const w = await openBoard(t, undefined, { setup: as => as("C1", "gate", "add", "--message", questionFile("A second question?", { task: "T1", file: "notes.md" }), "T1", "--question", "A second question on T1?", "--options", "yes|no", "--recommend", "yes") }), { page } = w;
  await page.goto(`${w.origin}/app/#?project=${encodeURIComponent(basename(w.dir))}`);
  await page.locator(".nav .count.need").filter({ hasText: "3" }).waitFor();
  await page.locator("header .picker").click();
  assert.equal(await page.locator('.pick-menu [data-project] span').first().textContent(), "3 need you", "F-T1156-43: three questions on two tasks are three needs, as in Needs you");
  await page.locator("header .picker").click();
  w.config("archived=yes");
  const banner = page.locator(".banner.archived");
  await banner.waitFor();
  assert.match(await banner.textContent(), /1 agent finishes its current run, and nothing new starts\. The logbook is whole\./, "F-T1156-45: the banner names the running agent");
  assert.match(await page.locator("header.top a.limit").first().textContent(), /^Agents 1 of /, "F-T1156-45: as the header counts it");
  await page.locator("header .picker").click();
  assert.match(await page.locator(".pick-menu details").filter({ hasText: "Archived" }).locator("[data-project] span").textContent(), / · 2 open tasks · 3 wait for you$/, "F-T1156-36: the archived row says that questions wait");
});

test("T1121 S7: a failed run's recorded reason shows on its task page and on the Agents page", async t => {
  const w = await openBoard(t), { page } = w, why = "the token budget ran out before the review ended";
  w.as("C2", "run", "add", "T2", "--role", "pe");
  w.as("C2", "run", "done", "R2", "--status", "failed", "--why", why);
  await page.goto(`${w.origin}/app/#task?key=${encodeURIComponent(`shared/${basename(w.dir)}/T2`)}`);
  const note = page.locator(".failed-run");
  await note.waitFor();
  assert.match(await note.textContent(), new RegExp(`^Failed runpe R2 failed\\. "${why}"From the run's failure line, `));
  assert.equal(await note.getByRole("link", { name: "Open the report of R2" }).count(), 0, "T1126 S16: R2 kept no report, so no link leads to Not kept");
  await w.shot("task-failed");
  await page.goto(`${w.origin}/app/#agents`);
  const tile = page.locator('[data-run="R2"]');
  await tile.waitFor();
  assert.equal(await tile.locator(".awhy").textContent(), `Reason: ${why}`);
  await w.shot("agents-failed");
});

const SIZES = [{ width: 390, height: 844 }, { width: 900, height: 900 }, { width: 1440, height: 900 }];
const covered = (page, target) => page.evaluate(selector => {
  const box = document.querySelector(selector)?.getBoundingClientRect();
  if (!box) return "no target";
  const over = [...document.querySelectorAll("body *")].filter(el => getComputedStyle(el).position === "fixed" && getComputedStyle(el).display !== "none").map(el => el.getBoundingClientRect()).filter(bar => bar.height > 0 && bar.top < box.bottom && bar.bottom > box.top && bar.left < box.right && bar.right > box.left);
  return over.length ? `covered by a fixed bar at ${Math.round(over[0].top)} px` : null;
}, target);

const headerHolds = page => page.locator("header.top").evaluate(top => top.scrollWidth <= top.clientWidth && [...top.children].every(child => child.getBoundingClientRect().bottom <= top.getBoundingClientRect().bottom + 1));

test("T1156: the question view at 390, 900 and 1440 px, normal and archived: the answers show on the first screen, or for an archived project the note that offers Restore; nothing covers them, and an archived project takes no answer", async t => {
  const w = await openBoard(t, SIZES[2]), { page } = w, problems = [], check = (ok, why) => { if (!ok) problems.push(why); }, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  for (const archived of [false, true]) {
    if (archived) w.config("archived=yes");
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto(url);
      await page.getByRole("heading", { name: TITLE, level: 1 }).waitFor();
      if (archived) await page.locator(".send").getByText(/^sample-app was archived on /).waitFor();
      await w.shot(`t1156-${archived ? "archived" : "normal"}-${size.width}`);
      const first = await page.locator(archived ? ".send" : ".answer").first().boundingBox();
      check(first && first.y + 40 <= size.height, `${size.width} px${archived ? ", archived: the archived note with Restore" : ": the first answer"} starts on the first screen (${JSON.stringify(first)})`);
      const cover = await covered(page, ".answer");
      check(cover === null, `${size.width} px${archived ? ", archived" : ""}: no fixed bar covers the first answer (${cover})`);
      check(await page.evaluate(() => document.documentElement.scrollWidth) === size.width, `${size.width} px: no sideways scroll`);
      check(await headerHolds(page), `F-T1156-32: ${size.width} px: the top header holds its content`);
      if (archived) {
        check(await page.locator(".answer input:not(:disabled)").count() === 0, "an archived question takes no answer");
        const said = await page.locator(".send").textContent();
        check(/archived/.test(said) && !/chat/.test(said), `${size.width} px: F-T1156-41: the archived question gives one instruction, Restore, not the chat: ${said}`);
        check(await page.locator(".send").getByRole("button", { name: "Restore" }).count() === 1, `${size.width} px: the answer box offers Restore`);
      } else {
        for (const target of [page.locator(".send .btn.primary"), page.locator(".answer").first()]) {
          const box = await target.boundingBox();
          check(box.height >= 44, `${size.width} px: a touch target is 44 px high at least (${JSON.stringify(box)})`);
        }
      }
    }
  }
  await page.setViewportSize({ width: 820, height: 900 });
  check(await headerHolds(page), "F-T1156-32: 820 px: the top header holds its content");
  assert.deepEqual(problems, []);
});

test("T1156: with a file open, the answers stay in view: beside the file at 1440 px while the material scrolls, and in a bar at 390 and 900 px that covers nothing, also after Send, with Undo and the line of what is left", async t => {
  const w = await openBoard(t, SIZES[2]), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}&open=${encodeURIComponent("T1/notes.md")}`;
  await page.goto(url);
  await page.frameLocator(".viewer iframe").getByRole("heading", { name: "The rule" }).waitFor();
  await page.locator(".q-side .material").evaluate(box => { box.scrollTop = box.scrollHeight; });
  await inView(page, page.locator(".q-side .answer").first(), "F-T1156-25: at 1440 px the first answer beside the file stays when the material scrolls");
  await inView(page, page.locator(".q-side .send .btn.primary"), "F-T1156-12: and so does Send");
  await w.shot("t1156-reading-1440");
  for (const size of [SIZES[1], SIZES[0]]) {
    await page.setViewportSize(size);
    await page.goto(`${w.origin}/app/#`);
    await page.goto(url);
    await page.frameLocator(".viewer iframe").getByRole("heading", { name: "The rule" }).waitFor();
    await inView(page, page.locator(".viewer h2"), `F-T1156-21: at ${size.width} px the open file shows on the first screen`);
    await w.shot(`t1156-reading-${size.width}`);
  }
  const bar = page.locator(".qbar");
  await bar.getByRole("button", { name: "B: no" }).click();
  await bar.getByRole("button", { name: "Send" }).click();
  await inView(page, bar.getByText(/^You answered G1: B: no\. Recorded in the logbook\./), "the bar says that the answer is sent");
  await inView(page, bar.getByRole("button", { name: "Undo" }), "F-T1156-28: the bar offers Undo after Send");
  await inView(page, bar.getByRole("link", { name: "Needs you · 1 left: G2 from C2" }), "F-T1156-29: the bar names what is left");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "said", "F-T1156-42: focus moves to the result, not to the body");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const last = await page.locator(".mat").last().boundingBox(), top = (await bar.boundingBox()).y;
  assert.ok(last.y + last.height <= top, `F-T1156-9: the bar covers no material card at the page end (card ends at ${last.y + last.height}, bar starts at ${top})`);
  await w.shot("t1156-reading-390-sent");
  await bar.getByRole("button", { name: "‹ Question" }).click();
  await page.locator(".viewer").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.item), "T1/notes.md", "F-T1156-22: back to the question puts focus on the item that was open");
  assert.equal(await covered(page, ".q-form h2"), null, "F-T1156-17: after the viewer closes, nothing covers the Answers label");
});

test("T1156 F-T1156-53: at 390 px each standalone link of the question view is at least 44 px tall", async t => {
  const w = await openBoard(t, SIZES[0]), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`;
  const tall = async (locator, name) => { const box = await locator.boundingBox(); assert.ok(box.height >= 44, `${name} is ${box.height} px tall`); };
  await page.goto(url);
  await tall(page.getByRole("link", { name: "T1 · Sample shared list permissions" }), "the task link in Where it fits");
  await tall(page.getByRole("link", { name: "Read the full question" }), "Read the full question");
  await w.shot("t1156-links-390");
  await page.locator(".mat").filter({ hasText: "Design notes" }).click();
  await tall(page.getByRole("link", { name: "Open in a new tab" }), "Open in a new tab");
});

test("T1156 F-T1156-54: from 1100 to 1279 px an open file takes the whole width, and the answers go to the bar beside the side column", async t => {
  const w = await openBoard(t, { width: 1100, height: 900 }), { page } = w, url = `${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}&open=${encodeURIComponent("T1/notes.md")}`;
  for (const width of [1100, 1150, 1200, 1279]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${w.origin}/app/#`);
    await page.goto(url);
    await page.frameLocator(".viewer iframe").getByRole("heading", { name: "The rule" }).waitFor();
    const pane = await page.locator(".viewer iframe").boundingBox(), side = await page.locator(".side").boundingBox(), bar = await page.locator(".qbar").boundingBox();
    assert.ok(pane.width >= width - 232 - 64 - 60, `at ${width} px the file is ${pane.width} px wide: the main column less its padding and the viewer's own`);
    await inView(page, page.locator(".qbar").getByRole("button", { name: "Send" }), `at ${width} px the bar offers the answers`);
    assert.ok(bar.x >= side.x + side.width, `at ${width} px the bar starts at ${bar.x} px, after the side column`);
    await w.shot(`t1156-reading-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${w.origin}/app/#`);
  await page.goto(url);
  await inView(page, page.locator(".q-side .answer").first(), "at 1280 px the answers are beside the file");
});

test("T1156 F-T1156-40, -47: an answer sent while the Archive write lands is refused by the state tool, and the board shows the refusal; an answer sent before the archive says that it waits for Restore and offers no Undo", async t => {
  let w;
  w = await openBoard(t, SIZES[2], { before: job => { if (job.argv[2] === "G1") w.config("archived=yes"); } });
  const { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.getByRole("radio", { name: /^A: yes/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText("Not recorded. This project is archived, so it takes no answer. Restore it, then answer again. Nothing changed.").waitFor();
  assert.equal(w.gate("G1").answered ?? "", "", "the archived project keeps no answer");
  await page.locator(".send").getByRole("button", { name: "Restore" }).waitFor();
  await w.shot("t1156-archived-refused-1440");

  await page.locator(".send").getByRole("button", { name: "Restore" }).click();
  await page.getByText("sample-app is restored.").waitFor();
  await page.waitForFunction(() => document.activeElement?.matches(".answer input:not(:disabled)"));
  assert.equal(await page.getByRole("radio", { name: /^A: yes/ }).isEnabled(), true, "F-T1156-35, -42: after Restore the note says so, the answers take an answer, and focus is on the first one");

  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G2`)}`);
  await page.getByRole("radio", { name: /^send them/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText(/^You answered G2: send them\. Recorded in the logbook\. It waits for Codex · C2 to pick it up/).waitFor();
  w.config("archived=yes");
  await page.getByText(/^You answered G2: send them\. Recorded in the logbook\. The project is archived now, so it waits until you restore it\. Then Codex · C2 picks it up\./).waitFor();
  assert.equal(await page.locator(".send").getByRole("button", { name: "Undo" }).count(), 0, "F-T1156-46: no Undo that the archive would refuse");
  await page.locator(".send").getByRole("button", { name: "Restore" }).waitFor();
  await page.reload();
  await page.getByText(/so it waits until you restore it/).waitFor();
  assert.equal(await page.locator(".send").getByRole("button", { name: "Restore" }).count(), 1, "T1159 F-T1159-52: the line that says to restore offers Restore, also after a reload");
});

test("T1156 F-T1156-23: in a report in the frame, the link to the same question closes the file, and opens no second tab", async t => {
  const w = await openBoard(t, undefined, { setup: as => as("C1", "run", "done", "R1", "--status", "done", "--tokens", "1") }), { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G1`)}`);
  await page.locator(".mat").filter({ hasText: "Report of R1" }).click();
  await page.frameLocator(".viewer iframe").getByRole("link", { name: "Open G1" }).click();
  await page.locator(".viewer").waitFor({ state: "detached" });
  assert.equal(page.context().pages().length, 1);
});

test("T1159 F-T1159-4: when the message holds its answers in a section, the answers show there, in the message's order, and not again as a table", async t => {
  const nested = { kind: "question", title: "Which copy rule?", blocks: [
    { t: "field", label: "Where", text: "The sample task sets the copy rule." },
    { t: "field", label: "Approve", text: "The copy rule." }, { t: "field", label: "Choice", text: "Does a viewer copy?" },
    { t: "section", label: "Question 1: Copy rule", body: [{ t: "p", text: "Sample text before the answers." }, { t: "table", head: ["Answer", "Next", "Cost"], rows: [["A: copy", "The chief adds it.", "1 h"], ["B: no copy", "View only.", "none"]], pick: 0 }] },
    { t: "field", label: "Default", text: "Sample default after the answers." }, { t: "field", label: "Due", text: "Sample: no time." }, { t: "field", label: "Next", text: "The chief builds the task." },
    { t: "page", title: "Sample notes", task: "T1", file: "notes.md" }] };
  const w = await openBoard(t, SIZES[2], { setup: as => {
    writeFileSync(join(tmpdir(), `t1159-nested-${process.pid}.json`), JSON.stringify(nested));
    as("C1", "gate", "add", "T1", "--question", "Which copy rule?", "--options", "A: copy|B: no copy", "--recommend", "A: copy", "--message", join(tmpdir(), `t1159-nested-${process.pid}.json`));
  } });
  rmSync(join(tmpdir(), `t1159-nested-${process.pid}.json`), { force: true });
  const { page } = w;
  await page.goto(`${w.origin}/app/#question?key=${encodeURIComponent(`shared/${basename(w.dir)}/G3`)}`);
  await page.locator("#question-h", { hasText: "Which copy rule?" }).waitFor();
  const order = await page.evaluate(() => {
    const main = document.querySelector(".q-main"), at = node => [...main.querySelectorAll("*")].indexOf(node);
    const text = words => [...main.querySelectorAll("p, h3")].find(node => node.textContent.includes(words));
    return { section: at(text("Question 1: Copy rule")), before: at(text("Sample text before the answers.")), answers: at(main.querySelector(".answers")), after: at(text("Sample default after the answers.")), tables: main.querySelectorAll(".context table").length };
  });
  assert.ok(order.section >= 0 && order.section < order.before && order.before < order.answers && order.answers < order.after, `the answers sit where the message holds them: ${JSON.stringify(order)}`);
  assert.equal(order.tables, 0, "the answers show once, as the answers, not again as a table");
});
