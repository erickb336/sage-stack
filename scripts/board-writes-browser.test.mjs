import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { runBoardCli } from "../plugins/sage/board/cli.mjs";
import { startLink } from "../plugins/sage/board/access.mjs";
import { createBoardServer, loadBoardApp } from "../plugins/sage/board/server.mjs";
import { writeInWorker } from "../plugins/sage/board/writes.mjs";
import { boardCommandPort } from "./fixtures/board-port.mjs";
import { QUESTION } from "./fixtures/question-message.mjs";

const chromium = requireBrowser();
const APP = loadBoardApp(new URL("../plugins/sage/board/app/", import.meta.url).pathname);
const SHOTS = process.env.BOARD_SHOTS ?? null;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const MESSAGE = { kind: "question", title: "Can a viewer copy a shared list into their own lists?", blocks: [
  { t: "field", label: "Where", text: "The sample task sets what each person may do with a shared list." },
  { t: "field", label: "Approve", text: "The rule for viewers." },
  { t: "field", label: "Choice", text: "Does a viewer get a copy action?" },
  { t: "table", head: ["Answer", "Next", "Cost"], rows: [["yes", "The chief adds the copy action.", "About 1 to 2 h of agent time."], ["no", "The chief builds view only.", "No extra cost now."]], pick: 0 },
  { t: "field", label: "Default", text: "The task waits." }, { t: "field", label: "Due", text: "Sample: 20:00 today." }, { t: "field", label: "Next", text: "The chief builds the task." }] };

async function openBoard(t, { write, copy = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-writes-browser-")));
  const saved = { ...process.env };
  const fakes = join(base, "fakes");
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
  writeFileSync(join(dir, "chiefs.tsv"), `id\tprovider\tnative\tat\nC1\tclaude\tclaude-1\t${iso(now - 3 * 3600_000)}\nC2\tcodex\tcodex-1\t${iso(now - 2 * 3600_000)}\nC3\tclaude\tclaude-3\t${iso(now - 5 * 3600_000)}\nC4\tcodex\tcodex-4\t${iso(now - 4 * 3600_000)}\n`);
  mkdirSync(join(dir, "live"));
  for (const [id, ago, autopilot] of [["C1", 0, true], ["C2", 0, false], ["C3", 2 * 3600_000, false]]) writeFileSync(join(dir, "live", `${id}.json`), JSON.stringify({ provider: id === "C2" ? "codex" : "claude", checkout: project, sageMode: true, autopilot, at: iso(now - ago) }));
  const as = (chief, ...args) => claude.sage([...args, "--project", project, "--chief", chief], env);
  as("C1", "task", "add", "--title", "Sample shared list permissions", "--size", "small", "--priority", "P1");
  writeFileSync(join(base, "question.json"), JSON.stringify(MESSAGE));
  as("C1", "gate", "add", "T1", "--question", MESSAGE.title, "--options", "yes|no", "--recommend", "yes", "--message", join(base, "question.json"));
  as("C2", "task", "add", "--title", "Sample crash report screen", "--size", "small", "--priority", "P2");
  as("C2", "gate", "add", "--message", QUESTION, "T2", "--question", "Crash reports: send them on their own, or ask each time?", "--options", "ask each time|send them", "--recommend", "ask each time");
  as("C3", "task", "add", "--title", "Sample export a list as CSV", "--size", "small", "--priority", "P2");
  const config = join(base, "home", ".config", "sage-board", "board.json"), stateDir = join(base, "home", ".config", "sage-board", "state");
  const setup = port => runBoardCli(["board", "--setup", "--config", config, "--port", String(port), "--sources", JSON.stringify([{ id: "shared", path: env.SAGE_SHARED_HOME }])], { output: () => {}, env });
  let server, cli = null, port;
  if (copy) {
    port = await boardCommandPort();
    await setup(port);
    cli = join(base, copy, "board", "cli.mjs");
    for (const part of ["board", "core"]) cpSync(new URL(`../plugins/sage/${part}/`, import.meta.url), join(base, copy, part), { recursive: true });
    server = await (await import(pathToFileURL(cli).href)).runBoardCli(["board", "--serve", "--config", config], { output: () => {}, env });
  } else {
    server = createBoardServer({ sources: [{ id: "shared", label: "Shared", path: env.SAGE_SHARED_HOME }], port: 0, app: APP, settleReads: [], stateDir, pairCommand: "node /sample/board/cli.mjs board --pair", ...(write && { write }) });
    ({ port } = await server.start());
    await setup(port);
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", timezoneId: "America/New_York", permissions: ["clipboard-read", "clipboard-write"] });
  t.after(async () => {
    await context.close(); await server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, requests = [], problems = [];
  await context.route("**/*", route => { requests.push(`${route.request().method()} ${route.request().url()}`); return route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(String(error)));
  page.on("console", message => { if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
  await page.goto(`${origin}/app/`);
  await page.locator("main h1").waitFor();
  const pairText = async () => {
    const lines = [];
    await runBoardCli(["board", "--pair", "--config", config], { output: line => lines.push(line), env, input: { isTTY: true } });
    return lines.join("\n");
  };
  const pairCode = async () => /Pairing code: (\S+)/.exec(await pairText())[1];
  const pair = async () => {
    await page.getByPlaceholder("ABCD-EFGH").fill(await pairCode());
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
  };
  const shot = async name => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
  const posts = path => requests.filter(line => line === `POST ${origin}/api/${path}`).length;
  const settled = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  return { page, context, origin, cli, dir, project, env, stateDir, as, pairText, pair, shot, requests, posts, settled, problems, gate: id => claude.read(dir, "gates").find(row => row.id === id) };
}

test("T1059: the owner pairs once, then answers with full context, undoes, renames a chief, filters by chief, gives a task to another chief and sees what changed, each within two clicks of the Overview", async t => {
  const w = await openBoard(t), { page } = w;
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };

  assert.equal(await page.getByRole("button", { name: "Send answer" }).count(), 0);
  await w.shot("t1059-unpaired");
  await w.pair();
  await page.reload();
  await page.getByRole("heading", { name: /^Since you looked|^In the last 24 hours/ }).waitFor();

  clicks = 0;
  await click(page.getByRole("link", { name: MESSAGE.title }));
  await page.getByRole("heading", { name: MESSAGE.title, level: 1 }).waitFor();
  assert.equal(clicks, 1, "J1: one click opens the question with its full context");
  const view = await page.locator(".question").textContent();
  for (const part of ["Where", "The rule for viewers.", "Default", "The chief adds the copy action.", "About 1 to 2 h of agent time.", "C1's pick"]) assert.ok(view.includes(part), `the view shows ${part}`);
  const taskKey = `shared/${basename(w.dir)}/T1`;
  assert.equal(await page.getByRole("link", { name: "Read the full question" }).getAttribute("href"), `/read/${Buffer.from(taskKey).toString("base64url")}/question/G1`, "the link opens the reader's question page of the same gate");
  await w.shot("t1059-question");
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText(/^You answered G1: no\. Recorded in the logbook\./).waitFor();
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no");
  await w.shot("t1059-answered");

  await page.goto(`${w.origin}/app/`);
  const waits = page.locator(`[data-answered$="/G1"]`);
  await waits.waitFor();
  clicks = 0;
  await click(waits.getByRole("button", { name: "Undo" }));
  await waits.waitFor({ state: "detached" });
  assert.equal(clicks, 1, "Undo: one click on the Overview");
  assert.equal(w.gate("G1").answered, "", "the undo cleared the board answer before any pickup");
  await page.getByRole("link", { name: MESSAGE.title }).waitFor();

  clicks = 0;
  await click(page.getByRole("button", { name: "More about C2" }));
  await page.getByLabel("Name").fill("Codex desk");
  await click(page.getByRole("button", { name: "Rename" }));
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  assert.equal(clicks, 2, "rename: the chip's menu, then Rename");
  await page.locator(`.chip[data-chief$="/C2"]`).filter({ hasText: "Codex desk" }).waitFor();
  await w.shot("t1059-chief-menu");

  clicks = 0;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Rename" }).waitFor({ state: "detached" });
  await click(page.locator(`.chip[data-chief$="/C2"]`));
  assert.equal(clicks, 1, "filter: one click on the chief's chip");
  await page.getByRole("link", { name: MESSAGE.title }).waitFor({ state: "detached" });
  assert.deepEqual(await page.locator(".needs > li[data-need] .q").allTextContents(), ["Crash reports: send them on their own, or ask each time?"]);
  await page.getByRole("link", { name: /^Tasks/ }).click();
  await page.locator("a.row").first().waitFor();
  assert.deepEqual(await page.locator("a.row .id").allTextContents(), ["T2"], "the filter holds across pages");
  await page.getByRole("link", { name: /^Overview/ }).click();
  await page.getByRole("button", { name: "All chiefs" }).click();
  await page.getByRole("link", { name: MESSAGE.title }).waitFor();

  clicks = 0;
  const stopped = page.locator(`[data-stopped$="/C3"]`);
  await click(stopped.getByRole("button", { name: "Give to another chief" }));
  assert.equal(await stopped.getByRole("radio", { checked: true }).getAttribute("name"), await stopped.getByRole("radio").first().getAttribute("name"));
  assert.match(await stopped.locator(".pickable").first().textContent(), /^Claude · C1.*Recommended$/, "the live chief of C3's provider comes first");
  await click(stopped.getByRole("button", { name: "Open the takeover question" }));
  await stopped.getByText(/^G3 open · Hand T3 from C3 \(claude\) to C1 \(claude\)\?/).waitFor();
  assert.equal(clicks, 2, "give: Give to another chief, then Open the takeover question");
  await page.locator(".needs > li[data-need] .q").filter({ hasText: /^Hand T3 from/ }).waitFor();
  await w.shot("t1059-give");

  await page.goto("about:blank");
  const later = await w.context.newPage();
  await later.goto(`${w.origin}/app/`);
  await later.getByRole("heading", { name: /^Since you looked/ }).waitFor();
  assert.match(await later.locator("#counts-h").textContent(), /^Since you looked · you left the board at /);
  assert.equal(await later.locator('[data-count="added"] .n').textContent(), "0", "no task was added since the last look");

  assert.deepEqual(w.problems, [], "no page error and no CSP refusal");
  assert.deepEqual(w.requests.filter(line => !line.split(" ")[1].startsWith(`${w.origin}/`)), [], "no outside request");
});

test("T1059: a question answered first in the chief's chat shows who answered first, and a later board answer is refused with the first answer", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: "Crash reports: send them on their own, or ask each time?" }).click();
  await page.getByRole("radio", { name: /^ask each time/ }).check();
  let holdGateReads = true;
  const held = [];
  await page.route("**/app/gate/**", route => holdGateReads ? held.push(route) : route.fallback().catch(() => {}));
  claude.sage(["gate", "answer", "G2", "--option", "2", "--via", "chat", "--project", w.project], w.env);
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText(/^Not recorded\. G2 has the answer "send them" already, from the chat at \d\d:\d\d: the first answer wins/).waitFor();
  holdGateReads = false;
  for (const route of held) await route.fallback().catch(() => {});
  await page.getByText(/^Answered first in C2's chat at \d\d:\d\d: send them\./).waitFor();
  await w.shot("t1059-answered-elsewhere");
  assert.equal(w.gate("G2").answer, "send them");
});

test("T1119: a board started from a copy in a folder whose name has shell characters shows its own pairing command, quoted for an interactive shell, with a copy button, on the Overview and in the question view", async t => {
  const w = await openBoard(t, { copy: "sage plugin's $HOME `x` \"q\" !! copy" }), { page } = w;
  const command = `node '${w.cli.replace("plugin's", "plugin'\\''s")}' board --pair`;
  const card = page.locator("form.pair");
  await card.waitFor();
  assert.equal(await card.locator("code").textContent(), command);
  await card.getByRole("button", { name: "Copy", exact: true }).click();
  await card.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("heading", { name: MESSAGE.title, level: 1 }).waitFor();
  assert.equal(await page.locator("form.pair code").textContent(), command);
  assert.deepEqual(w.problems, []);
});

test("F-T1119-3: the pairing card holds its whole command and the Copy button at 1440 px and 390 px, on the Overview and in the question view, and the page does not scroll sideways", async t => {
  const w = await openBoard(t, { copy: "sage plugin" }), { page } = w;
  await page.locator("form.pair code").waitFor();
  const fits = async where => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await w.settled();
      const box = await page.evaluate(() => {
        const card = document.querySelector("form.pair").getBoundingClientRect(), code = document.querySelector("form.pair code"), button = document.querySelector("form.pair .pair-cmd button").getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, view: innerWidth, card: [card.left, card.right], button: [button.left, button.right], hidden: code.scrollWidth - code.clientWidth };
      });
      const at = `${where} at ${width} px: ${JSON.stringify(box)}`;
      assert.ok(box.page <= box.view, `the page does not scroll sideways, ${at}`);
      assert.ok(box.button[0] >= box.card[0] && box.button[1] <= box.card[1] && box.card[1] <= box.view, `the Copy button is inside the card and the screen, ${at}`);
      assert.ok(box.hidden <= 0, `the card shows the whole command, ${at}`);
      await w.shot(`f-t1119-3-${where}-${width}`);
    }
  };
  await fits("overview");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("heading", { name: MESSAGE.title, level: 1 }).waitFor();
  await fits("question");
  assert.deepEqual(w.problems, []);
});

test("F-T1059-17: board --pair names the card, the field and the button that the page shows, and says how to restart an older board", async t => {
  const w = await openBoard(t), { page } = w;
  const told = await w.pairText(), [, card, field, button] = /In the card "([^"]+)", type the code in the "([^"]+)" field, then choose (\w+)\./.exec(told) ?? [];
  assert.ok(card, `the output names the controls: ${told}`);
  assert.match(told, /If the page shows no pairing card and this browser is not paired yet, the board that runs is older than this one: run node .* board --stop --config .*, ask for the board again, and reload the page\./);
  await page.getByLabel(field).fill(/Pairing code: (\S+)/.exec(told)[1]);
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("heading", { name: card }).waitFor({ state: "detached" });
  assert.deepEqual(w.problems, []);
});

test("F-T1059-19: each chief's chip says its state in words: live, waits for you, stopped or liveness unknown", async t => {
  const w = await openBoard(t), { page } = w;
  const chip = id => page.locator(`.chip[data-chief$="/${id}"] .state`);
  await chip("C4").waitFor();
  assert.deepEqual(await Promise.all(["C1", "C2", "C3", "C4"].map(id => chip(id).textContent())), ["in progress · autopilot on", "in progress · autopilot off", "stopped", "unknown"]);
  const once = (text, id) => assert.equal(text.split(id).length - 1, 1, `${id} once: ${text}`);
  for (const id of ["C1", "C2"]) {
    assert.match(await page.locator(`.chip[data-chief$="/${id}"] b`).textContent(), new RegExp(`^(Claude|Codex) · ${id}$`), "F-T1096-11: the chip names the chief as 'Claude · C1'");
    once(await page.locator(`button.chip[data-chief$="/${id}"]`).textContent(), id);
  }
  const stopped = await page.locator('[data-stopped$="/C3"] .q').textContent();
  assert.match(stopped, /^(Claude|Codex) · C3\b/, "F-T1096-11: a stopped chief reads 'Claude · C3' too");
  once(stopped, "C3");
  await w.shot("t1059-chips");
});

test("F-T1059-21: a chief's default name and its menu's Started row show the same local time", async t => {
  const w = await openBoard(t), { page } = w;
  const name = await page.locator('.chip[data-chief$="/C1"] .faint').first().textContent();
  await page.getByRole("button", { name: "More about C1" }).click();
  const started = await page.locator(".menu .facts dt", { hasText: "Started" }).locator("xpath=following-sibling::dd[1]").textContent();
  assert.ok(!name.includes("UTC") && (name === started || name.endsWith(` · ${started}`)), `"${name}" ends with "${started}"`);
  await w.shot("t1059-chief-started");
});

test("F-T1059-23: a double click on Send answer sends one answer and shows no refusal", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).dblclick();
  await page.getByText(/^You answered G1: no\. Recorded in the logbook\./).waitFor();
  assert.equal(w.posts("answer"), 1, "one answer was sent");
  await w.settled();
  assert.equal(await page.getByText(/^Not recorded/).count(), 0, "no refusal under the recorded answer");
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no");
  await w.shot("t1059-double-send");
});

test("T1125: the last visit lives in each browser, also an unpaired one: a reload keeps the counts, a later visit shows Since you looked, a visit older than 7 days shows the last 7 days, and nothing goes to the server", async t => {
  const w = await openBoard(t), { page } = w;
  const heading = () => page.locator("#counts-h").textContent();
  assert.match(await heading(), /^In the last 24 hours/, "a first visit in this browser");
  await page.reload();
  await page.locator("#counts-h").waitFor();
  assert.match(await heading(), /^In the last 24 hours/, "a reload is the same visit, so it keeps the counts");
  await page.getByRole("link", { name: /^Tasks/ }).click();
  await page.locator("a.row").first().waitFor();
  await page.getByRole("link", { name: /^Overview/ }).click();
  await page.locator("#counts-h").waitFor();
  assert.match(await heading(), /^In the last 24 hours/, "a move inside the app is the same visit");
  await page.goto("about:blank");
  const later = await w.context.newPage();
  await later.goto(`${w.origin}/app/`);
  await later.getByRole("heading", { name: /^Since you looked/ }).waitFor();
  assert.match(await later.locator("#counts-h").textContent(), /^Since you looked · you left the board at /, "the time when you left is kept in this browser");
  if (SHOTS) await later.screenshot({ path: join(SHOTS, "t1125-since-you-looked.png") });
  const other = await w.context.browser().newContext();
  t.after(() => other.close());
  const fresh = await other.newPage();
  await fresh.goto(`${w.origin}/app/`);
  await fresh.locator("#counts-h").waitFor();
  assert.match(await fresh.locator("#counts-h").textContent(), /^In the last 24 hours/, "another browser has its own last visit");
  const back = await other.newPage();
  await back.addInitScript(() => { if (!sessionStorage.getItem("primed")) { sessionStorage.setItem("primed", "1"); localStorage.setItem("board-seen", new Date(Date.now() - 9 * 86_400_000).toISOString()); } });
  await back.goto(`${w.origin}/app/`);
  await back.locator("#counts-h").waitFor();
  assert.match(await back.locator("#counts-h").textContent(), /^In the last 7 days · you last looked more than 7 days ago/, "the board keeps 7 days, so an older visit counts the last 7 days");
  assert.equal(w.posts("seen"), 0, "no visit goes to the server");
  assert.deepEqual(w.problems, []);
});

test("T1125: one click on the chief's link pairs a fresh browser, takes the key out of the address bar and the history, and a second browser that opens it can unpair every browser", async t => {
  const w = await openBoard(t);
  const key = startLink(w.stateDir), link = `${w.origin}/app/#pair=${key}`;
  const page = await w.context.newPage();
  await page.goto(link);
  await page.getByText("This browser is paired. You can now answer questions and send from the board. The link is used up.").waitFor();
  assert.match(page.url(), new RegExp(`^${w.origin}/app/(#\\?project=[a-z0-9-]+)?$`), "the key left the address bar; T1135: the board may add the project");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "t1125-paired.png") });
  await page.goBack();
  assert.equal(page.url(), "about:blank", "no history entry keeps the key: the entry before the board is the new tab's blank page");
  await page.goForward();
  assert.match(page.url(), new RegExp(`^${w.origin}/app/(#\\?project=[a-z0-9-]+)?$`), "the board's own entry has no key");
  await page.locator("#counts-h").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Pair this browser to act from the board" }).count(), 0, "the pairing card is gone");
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("button", { name: "Send answer" }).waitFor();
  assert.equal(w.posts("pair"), 1, "the link is sent once");

  const other = await w.context.browser().newContext();
  t.after(() => other.close());
  const second = await other.newPage();
  await second.goto(link);
  await second.getByText(/^Another browser on this Mac used this link at \d\d:\d\d\. This browser still reads only\./).waitFor();
  assert.match(second.url(), new RegExp(`^${w.origin}/app/(#\\?project=[a-z0-9-]+)?$`));
  if (SHOTS) await second.screenshot({ path: join(SHOTS, "t1125-used.png") });
  await second.getByRole("button", { name: "Unpair every browser" }).click();
  await second.getByText(/^Every browser is unpaired: each one reads only now\./).waitFor();
  assert.deepEqual(JSON.parse(readFileSync(join(w.stateDir, "paired.json"), "utf8")).browsers, [], "no browser is paired now");
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  assert.ok(!w.gate("G1").answered, "the first browser writes nothing after the unpair");

  const late = await other.newPage();
  await late.goto(`${w.origin}/app/#pair=${startLink(w.stateDir, Date.now() - 11 * 60_000)}`);
  await late.getByText(/^This link expired at \d\d:\d\d: a link works for 10 minutes\./).waitFor();
  const wrong = await other.newPage();
  await wrong.goto(`${w.origin}/app/#pair=${"A".repeat(43)}`);
  await wrong.getByText(/^The board does not know this link: it is not a link of this board, or it is older than the board's last 8 links\./).waitFor();
  assert.deepEqual(w.problems, []);
});

test("F-T1159-11, F-T1159-12: a link pasted into a board tab that is open pairs it at once; a link older than the last 8 says so, not that it is another board's", async t => {
  const w = await openBoard(t);
  const other = await w.context.browser().newContext();
  t.after(() => other.close());
  const page = await other.newPage();
  await page.goto(`${w.origin}/app/`);
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  const key = startLink(w.stateDir);
  await page.evaluate(key => { location.hash = `#pair=${key}`; }, key);
  await page.getByText("This browser is paired. You can now answer questions and send from the board. The link is used up.").waitFor();
  assert.match(page.url(), new RegExp(`^${w.origin}/app/(#\\?project=[a-z0-9-]+)?$`), "the key left the address bar");
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
  for (let n = 0; n < 9; n++) startLink(w.stateDir);
  await page.evaluate(key => { location.hash = `#pair=${key}`; }, key);
  await page.getByText(/^This browser is paired already\./).waitFor();
  const fresh = await (await w.context.browser().newContext()).newPage();
  t.after(() => fresh.context().close());
  await fresh.goto(`${w.origin}/app/#pair=${key}`);
  await fresh.getByText(/^The board does not know this link: it is not a link of this board, or it is older than the board's last 8 links\./).waitFor();
  assert.deepEqual(w.problems, []);
});

test("F-T1129-1: the link's note shows its outcome also when the board's answer comes back right after the note first shows, before its effects run", async t => {
  const w = await openBoard(t);
  const other = await w.context.browser().newContext();
  t.after(() => other.close());
  const page = await other.newPage();
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = async (url, init) => {
      const response = await real(url, init);
      if (!String(url).endsWith("/api/pair")) return response;
      const json = await response.json(), answer = { ok: response.ok, status: response.status, json: async () => json };
      return new Promise(done => {
        let watch = null;
        const shown = () => { if (!document.querySelector(".pair-note")) return false; watch?.disconnect(); done(answer); return true; };
        if (!shown()) { watch = new MutationObserver(shown); watch.observe(document, { childList: true, subtree: true }); }
      });
    };
  });
  await page.goto(`${w.origin}/app/#pair=${startLink(w.stateDir)}`);
  await page.getByText("This browser is paired. You can now answer questions and send from the board. The link is used up.").waitFor();
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
});

test("F-T1125-9: after a newer link exists, the owner still finds Unpair every browser on the used, expired and replaced notes, and it unpairs the unknown browser", async t => {
  const w = await openBoard(t);
  const first = startLink(w.stateDir), unknown = await w.context.newPage();
  await unknown.goto(`${w.origin}/app/#pair=${first}`);
  await unknown.getByText(/^This browser is paired\./).waitFor();
  startLink(w.stateDir);
  const owner = await w.context.browser().newContext();
  t.after(() => owner.close());
  const open = async (key, note) => {
    const page = await owner.newPage();
    await page.goto(`${w.origin}/app/#pair=${key}`);
    await page.getByText(note).waitFor();
    await page.getByRole("button", { name: "Unpair every browser" }).waitFor();
    return page;
  };
  await open(first, /^Another browser on this Mac used this link at \d\d:\d\d\./);
  await open(startLink(w.stateDir, Date.now() - 11 * 60_000), /^This link expired at \d\d:\d\d/);
  const older = startLink(w.stateDir);
  startLink(w.stateDir);
  const replaced = await open(older, /^A newer link replaced this one\./);
  if (SHOTS) await replaced.screenshot({ path: join(SHOTS, "t1125-replaced.png") });
  await replaced.getByRole("button", { name: "Unpair every browser" }).click();
  await replaced.getByText(/^Every browser is unpaired: each one reads only now\./).waitFor();
  await unknown.getByRole("link", { name: MESSAGE.title }).click();
  await unknown.getByRole("radio", { name: /^no/ }).check();
  await unknown.getByRole("button", { name: "Send answer" }).click();
  await unknown.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  assert.ok(!w.gate("G1").answered, "the unknown browser writes nothing after the unpair");
  assert.deepEqual(w.problems, []);
});

test("F-T1059-47: after a give, the stopped chief's card shows the open takeover question in place of Give, also after a reload", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  let stopped = page.locator(`[data-stopped$="/C3"]`);
  await stopped.getByRole("button", { name: "Give to another chief" }).click();
  await stopped.getByRole("button", { name: "Open the takeover question" }).click();
  await stopped.getByText(/^G3 open · Hand T3 from C3/).waitFor();
  await page.reload();
  stopped = page.locator(`[data-stopped$="/C3"]`);
  const open = stopped.getByRole("link", { name: "G3 open" });
  await open.waitFor();
  assert.equal(await stopped.getByRole("button", { name: "Give to another chief" }).count(), 0, "no second Give while G3 is open");
  await w.shot("t1059-give-open");
  await open.click();
  await page.getByRole("heading", { name: /^Hand T3 from Claude · C3 to Claude · C1\?/, level: 1 }).waitFor();
  assert.deepEqual(w.problems, []);
});

test("F-T1059-26: a tab opened before the pairing picks up a pairing made in another tab, and its write keeps that tab's token", async t => {
  const w = await openBoard(t), { page } = w;
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  const other = await w.context.newPage();
  await other.goto(`${w.origin}/app/`);
  await other.getByPlaceholder("ABCD-EFGH").fill(/Pairing code: (\S+)/.exec(await w.pairText())[1]);
  await other.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor({ state: "detached" });
  const token = await other.evaluate(() => localStorage.getItem("board-token"));
  await page.getByRole("button", { name: "More about C2" }).click();
  await page.getByLabel("Name").fill("Codex desk");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("board-token")), token, "the pairing of the other tab stays");
});

test("F-T1059-46: a shadow cookie on /api does not refuse the paired browser, and a 401 does not erase the stored token", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  const token = await page.evaluate(() => localStorage.getItem("board-token"));
  await w.context.addCookies([{ name: "sage_board", value: "B".repeat(43), domain: "127.0.0.1", path: "/api" }]);
  const rename = async name => {
    await page.getByRole("button", { name: "More about C2" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Rename" }).click();
  };
  await rename("Codex desk");
  await page.getByText("C2 is named \"Codex desk\" now.").waitFor();
  await page.keyboard.press("Escape");
  writeFileSync(join(w.stateDir, "paired.json"), JSON.stringify({ browsers: [] }));
  await rename("Codex desk two");
  await page.getByRole("heading", { name: "Pair this browser to act from the board" }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("board-token")), token, "a 401 asks to pair again, and keeps the stored token");
});

test("F-T1059-36: the Read the full question link follows a theme switch on an open question", async t => {
  const w = await openBoard(t), { page } = w;
  await page.getByRole("link", { name: MESSAGE.title }).click();
  const link = page.getByRole("link", { name: "Read the full question" });
  await link.waitFor();
  assert.doesNotMatch(await link.getAttribute("href"), /theme=/);
  await page.getByRole("button", { name: "Switch to the light theme" }).click();
  assert.match(await link.getAttribute("href"), /\?theme=light$/);
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  assert.doesNotMatch(await link.getAttribute("href"), /theme=/);
});

test("F-T1059-44: the rename field of a chief whose name is shown with its id starts with the stored name, so a plain Rename keeps it", async t => {
  const w = await openBoard(t), { page } = w;
  for (const id of ["C1", "C2"]) claude.sage(["chief", "name", id, "Desk", "--project", w.project], w.env);
  await w.pair();
  await page.locator(`.chip[data-chief$="/C2"]`).filter({ hasText: "Desk" }).waitFor();
  await page.getByRole("button", { name: "More about C2" }).click();
  assert.equal(await page.getByLabel("Name").inputValue(), "Desk");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByText("C2 is named \"Desk\" now.").waitFor();
  assert.equal(JSON.parse(readFileSync(join(w.dir, "chief-names.json"), "utf8")).C2, "Desk");
});

test("F-T1059-43: a write that the board stops waiting for says one thing: not confirmed yet, and it may still finish", async t => {
  const w = await openBoard(t, { write: job => writeInWorker(job, { timeout: 0 }) }), { page } = w;
  await w.pair();
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  const said = page.getByRole("alert").filter({ hasText: /^Not confirmed yet: the logbook was busy\. The write may still finish: reload the board to see it before you try again\.$/ });
  await said.waitFor();
  assert.equal(await page.getByText(/Not recorded/).count(), 0, "no \"Not recorded\" before a write that may still finish");
  await w.shot("t1059-write-timeout");
});

test("F-T1076-13: a write whose connection drops after the server got it says that it may have landed, not that nothing was written", async t => {
  const w = await openBoard(t), { page } = w;
  await w.pair();
  await w.context.route(`${w.origin}/api/answer`, async route => {
    await route.fetch({ headers: { ...await route.request().allHeaders(), "sec-fetch-site": "same-origin" } });
    await route.abort("connectionreset");
  });
  await page.getByRole("link", { name: MESSAGE.title }).click();
  await page.getByRole("radio", { name: /^no/ }).check();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByRole("alert").filter({ hasText: /^The board lost its connection to its server on this Mac, so it cannot say whether the write landed\. Reload the board to see it before you try again\.$/ }).waitFor();
  assert.equal(await page.getByText(/Not recorded|Nothing was written/).count(), 0, "no claim that the write did not land");
  assert.equal(JSON.parse(w.gate("G1").answered).answer, "no", "the write landed");
});
