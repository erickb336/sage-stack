import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { HOSTILE_MARKDOWN } from "./fixtures/board-app.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
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

async function openBoard(t, viewport = { width: 1440, height: 1000 }, { refuse } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-question-browser-")));
  const saved = { ...process.env }, fakes = join(base, "fakes");
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
  const dir = claude.storeDir(project, env), now = Date.now(), iso = ms => new Date(ms).toISOString();
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${iso(now - 3 * 3600_000)}\nC2\tcodex\tcodex-1\t${iso(now - 2 * 3600_000)}\n`);
  mkdirSync(join(dir, "live"));
  for (const id of ["C1", "C2"]) writeFileSync(join(dir, "live", `${id}.json`), JSON.stringify({ provider: id === "C2" ? "codex" : "claude", checkout: project, sageMode: true, autopilot: false, at: iso(now) }));
  const as = (chief, ...args) => claude.sage([...args, "--project", project, "--chief", chief], env);
  as("C1", "task", "add", "--title", "Sample shared list permissions", "--size", "small", "--priority", "P1");
  as("C2", "task", "add", "--title", "Sample crash report screen", "--size", "small", "--priority", "P2");
  const pages = join(env.SAGE_WORKTREES, basename(dir), "pages", "T1");
  mkdirSync(join(pages, "designs", "v1"), { recursive: true });
  writeFileSync(join(pages, "notes.md"), `# Design notes\n\nThe notes of the sample design.\n\n${Array.from({ length: 30 }, (_, i) => `Sample line ${i + 1} before the rule.`).join("\n\n")}\n\n## The rule\n\nA viewer may copy a list. The copy is a new private list.\n\n${Array.from({ length: 30 }, (_, i) => `Sample line ${i + 1} after the rule.`).join("\n\n")}\n`);
  writeFileSync(join(pages, "hostile.md"), HOSTILE_MARKDOWN);
  writeFileSync(join(pages, "designs", "v1", "version.json"), JSON.stringify({ title: "v1", about: "The share sheet.", run: "R1" }));
  writeFileSync(join(pages, "designs", "v1", "index.html"), HOSTILE_PROTOTYPE);
  as("C1", "run", "add", "T1", "--role", "pe");
  writeFileSync(join(base, "question.json"), JSON.stringify(MESSAGE));
  as("C1", "gate", "add", "T1", "--question", TITLE, "--options", "A: yes|B: no", "--recommend", "A: yes", "--default", "A: yes", "--message", join(base, "question.json"), "--run", "R1");
  as("C2", "gate", "add", "T2", "--question", "Crash reports: send them on their own, or ask each time?", "--options", "ask each time|send them", "--recommend", "ask each time");
  const stateDir = join(base, "home", ".config", "sage-board", "state"), port = await freePort(), writes = [];
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const { writeInWorker } = await import("../plugins/sage/board/writes.mjs");
  const server = createBoardServer({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair",
    write: job => { writes.push(job.argv); return refuse ? { code: 1, text: refuse } : writeInWorker(job); } });
  await server.start();
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
  return { page, origin, dir, writes, outside, shot, as, gate: id => claude.read(dir, "gates").find(row => row.id === id) };
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
  assert.equal(await frame.getAttribute("sandbox"), "allow-same-origin allow-top-navigation-by-user-activation allow-popups allow-popups-to-escape-sandbox");
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
  assert.equal(page.url(), url, "the top page did not move");
  await w.shot("question-prototype");

  await page.locator(".mat").filter({ hasText: "hostile.md" }).click();
  const doc = page.frameLocator(".viewer iframe");
  await doc.getByRole("heading", { name: "Hostile sample" }).waitFor();
  assert.match(await doc.locator("article").textContent(), /<script>window\.hacked=1<\/script>/, "the script shows as text");
  assert.equal(await page.evaluate(() => window.hacked), undefined, "no script of the page ran in the board");
  assert.equal(await doc.locator('a[href="https://example.com/docs"]').getAttribute("target"), "_blank", "a link to another site opens a new tab, not in the board");
  assert.equal(page.url(), url);
  assert.deepEqual(w.writes, []);
});

test("T1121 F-T1121-2: in a framed reader page, a click on a link to another site opens a new page and a link to a board page moves the whole window; in the prototype frame, neither does", async t => {
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
  assert.equal(page.url(), url, "a click on a _top link in the prototype does not move the board");
  const [popup] = await Promise.all([context.waitForEvent("page"), doc.getByRole("link", { name: "a safe site" }).click()]);
  assert.deepEqual(w.outside, ["https://example.com/docs"], "the new page asked for the other site (the test blocks every request that leaves the board)");
  assert.equal(context.pages().length, 2, "the board and that one page: the prototype's _blank link opened none");
  await popup.close();
  await doc.getByRole("link", { name: "a safe page" }).click();
  await page.waitForURL(/\/read\/[\w-]+\/page\/notes\.md/);
  await page.getByRole("heading", { name: "Design notes", level: 1 }).waitFor();
  assert.deepEqual(w.writes, []);
});

test("T1121 S7: a failed run's recorded reason shows on its task page and on the Agents page", async t => {
  const w = await openBoard(t), { page } = w, why = "the token budget ran out before the review ended";
  w.as("C2", "run", "add", "T2", "--role", "pe");
  w.as("C2", "run", "done", "R2", "--status", "failed", "--why", why);
  await page.goto(`${w.origin}/app/#task?key=${encodeURIComponent(`shared/${basename(w.dir)}/T2`)}`);
  const note = page.locator(".failed-run");
  await note.waitFor();
  assert.match(await note.textContent(), new RegExp(`^Failed runpe R2 failed\\. "${why}"From the run's failure line, `));
  assert.equal(await note.getByRole("link", { name: "Open the report of R2" }).count(), 1);
  await w.shot("task-failed");
  await page.goto(`${w.origin}/app/#agents`);
  const tile = page.locator('[data-run="R2"]');
  await tile.waitFor();
  assert.equal(await tile.locator(".awhy").textContent(), `Reason: ${why}`);
  await w.shot("agents-failed");
});
