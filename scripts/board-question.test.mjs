import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { runFailure } from "../packages/sage-core/board-overview.mjs";
import { headingId } from "../packages/sage-core/state-words.mjs";
import { readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { renderMarkdown } from "../packages/sage-board/markdown.mjs";
import { MAX, gateMaterial } from "../packages/sage-board/material.mjs";
import { failureOf } from "../packages/sage-board/pages.mjs";
import { readerPage, readerUrl } from "../packages/sage-board/reader.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-11-13T12:00:00.000Z";
const BOOK = "shared/sample-app-abc123", KEY = id => `${BOOK}/${id}`;
const ORIGIN = "http://127.0.0.1:5000";
const b64 = text => Buffer.from(text).toString("base64url");

function world(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-question-")), before = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(dir, { recursive: true, force: true }); });
  const logbook = writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), NOW, { documents: true, ...options });
  const sources = [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }];
  const model = () => buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW });
  return { dir, logbook, pages: join(dir, "worktrees", "sample-app-abc123", "pages"), sources, model };
}
function column(w, table, name, values) {
  const file = join(w.logbook, `${table}.tsv`), [head, ...rows] = readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
  writeFileSync(file, [`${head}\t${name}`, ...rows.map(row => `${row}\t${values[row.split("\t")[0]] ?? ""}`)].join("\n") + "\n");
}
function message(w, gate, blocks) {
  const file = join(w.logbook, "gates", `${gate}.json`), kept = JSON.parse(readFileSync(file, "utf8"));
  kept.message.blocks.push(...blocks);
  writeFileSync(file, JSON.stringify(kept));
}
function material(w, gateId = "G4") {
  const model = w.model(), task = model.tasks.find(item => item.gateRows?.some(gate => gate.id === gateId)), gate = task.gateRows.find(row => row.id === gateId);
  const kept = JSON.parse(readFileSync(join(w.logbook, "gates", `${gateId}.json`), "utf8"));
  return gateMaterial({ model, task, gate, message: kept.message });
}
const names = list => list.items.map(item => `${item.group} ${item.kind} ${item.task}/${item.file ?? item.title}`);

test("T1121 R6: the material of a question lists the pages that it names, then its task's design, prototype and pages, newest first, then the report and brief of the run that asked; a file shows once", t => {
  const w = world(t);
  column(w, "gates", "run", { G4: "R8" });
  writeFileSync(join(w.pages, "T10", "old-plan.md"), "# Old plan\n");
  writeFileSync(join(w.pages, "T10", "pe-check.md"), "# PE check\n\n## The data\n\nSample.\n");
  utimesSync(join(w.pages, "T10", "old-plan.md"), new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
  utimesSync(join(w.pages, "T10", "pe-check.md"), new Date("2026-11-12T00:00:00Z"), new Date("2026-11-12T00:00:00Z"));
  message(w, "G4", [{ t: "page", title: "The PE check", task: "T10", file: "pe-check.md", part: "The data" }]);
  const list = material(w);
  assert.deepEqual(names(list), [
    "named page T10/designs/v2/notes.md",
    "named page T10/pe-check.md",
    "task design T10/Design · 2 versions",
    "task prototype T10/designs/v2/index.html",
    "task page T10/old-plan.md",
    "run report T10/report/R8",
    "run brief T10/brief/R8",
  ], "named first, in the message's order; pe-check.md is named, so it does not show again under the task's pages");
  assert.equal(list.more, 0);
  const pe = list.items[1];
  assert.equal(pe.title, "The PE check");
  assert.deepEqual([pe.src, pe.at], [readerUrl(KEY("T10"), "page", "pe-check.md", { in: "board" }), "h-the-data"]);
  assert.equal(pe.open, `${readerUrl(KEY("T10"), "page", "pe-check.md")}#h-the-data`);
  const page = readerPage({ model: w.model(), configured: w.sources, url: pe.src, origin: ORIGIN, render: renderMarkdown });
  assert.match(page.rest, /<h3 id="h-the-data">The data<\/h3>/, "a named part opens at the heading that the reader renders");
  assert.deepEqual([list.items[3].frame, list.items[3].src], ["script", "/pages/sample-app-abc123/T10/designs/v2/index.html"], "a prototype opens in a frame that runs its scripts");
  assert.equal(list.items[5].why, "R8 asked G4: its report.");
});

test("T1121 R6, T1156 F-T1156-31: the list keeps 8 places for pages that it can show and counts the rest; the asking run's report and brief keep their places, task pages go first; a named page that is gone or of an unknown task stays in the list, marked, and takes no place", t => {
  const w = world(t);
  for (let i = 1; i <= 9; i++) writeFileSync(join(w.pages, "T10", `page-${i}.md`), `# Page ${i}\n`);
  message(w, "G4", [{ t: "page", title: "A plan that is gone", task: "T10", file: "gone.md" }, { t: "page", title: "Far page", task: "T999", file: "far.md" }]);
  const list = material(w);
  assert.equal(MAX, 8);
  assert.equal(list.items.filter(item => !item.gone && item.frame !== null).length, 8, "8 pages that the board can show");
  assert.equal(list.more, 14 - 8, "named 1, design and prototype 2, pages 9, the run's report and brief 2: 14 that the board can show");
  assert.deepEqual(list.items.slice(0, 3).map(item => [item.file, !!item.gone]), [["designs/v2/notes.md", false], ["gone.md", true], ["far.md", false]]);
  assert.deepEqual(list.items.map(item => item.group), ["named", "named", "named", "task", "task", "task", "task", "task", "run", "run"], "F-T1121-12: the task pages are cut, not the asking run");
  assert.deepEqual(list.items.slice(-2).map(item => item.title), ["Report of R8", "Brief of R8"]);
});

test("T1121 G189: a question lists no page of the tasks that its task waits for; a page of another task that it names gets a link, and a page of an unknown task none", t => {
  const w = world(t, { waits: { T10: "T3" } });
  const plain = material(w);
  assert.ok(plain.items.every(item => item.task === "T10"), "no page of T3, which T10 waits for");
  message(w, "G4", [{ t: "page", title: "Retry design", task: "T3", file: "retry-design.md" }, { t: "page", title: "Far page", task: "T999", file: "far.md" }]);
  const named = material(w).items.filter(item => item.group === "named");
  assert.deepEqual(named.map(item => [item.task, item.src]), [["T10", readerUrl(KEY("T10"), "page", "designs/v2/notes.md", { in: "board" })], ["T3", readerUrl(KEY("T3"), "page", "retry-design.md", { in: "board" })], ["T999", undefined]]);
  assert.equal(named[1].why, "G4 names it in the question; it is a page of T3.");
  assert.equal(named[2].sub, "no task T999 in this logbook on the board", "F-T1121-19: the item says the true reason that it has no frame");
  const question = readerPage({ model: w.model(), configured: w.sources, url: readerUrl(KEY("T10"), "question", "G4"), origin: ORIGIN, render: renderMarkdown });
  assert.match(question.rest, new RegExp(`<a href="${readerUrl(KEY("T3"), "page", "retry-design.md")}">Retry design</a>`), "the reader's question page links the named page of T3 too");
});

test("T1121 R6: a recorded run that the logbook does not have gives no run material; with no recorded run, the newest designer, pe or investigate run stands in, and says so", t => {
  const w = world(t);
  column(w, "gates", "run", { G4: "R99" });
  const missing = material(w);
  assert.ok(missing.items.every(item => item.group !== "run"));
  assert.equal(missing.missing, "R99");
  const w2 = world(t), fallback = material(w2);
  assert.deepEqual(fallback.items.filter(item => item.group === "run").map(item => item.title), ["Report of R8", "Brief of R8"]);
  assert.equal(fallback.items.find(item => item.kind === "report").why, "The logbook does not record which run asked G4, so this is the newest designer run of T10.");
  assert.equal(fallback.missing, undefined);
});

test("T1121 S7: a failed run's reason comes from its failure line, then its kept report's RESULT, then the chief's decision, else none", t => {
  const w = world(t), dir = w.logbook, task = { id: "T3", decisionRows: [{ decision: "R5 failed: the chief's reason" }] };
  assert.deepEqual(failureOf({ dir, task, run: { id: "R5", failure: "its own line" } }), { text: "its own line", from: "failure" });
  assert.deepEqual(failureOf({ dir, task, run: { id: "R5", failure: "" } }), { text: "CLEAN. The limits change is correct.", from: "report" });
  assert.deepEqual(failureOf({ dir, task, run: { id: "R5", failure: "" } }).from, "report", "the kept report wins over the decision");
  assert.deepEqual(failureOf({ dir: null, task, run: { id: "R5", failure: "" } }), { text: "the chief's reason", from: "decision" });
  assert.equal(failureOf({ dir, task: { id: "T3" }, run: { id: "R6", failure: "" } }), null);
});

test("T1156 F-T1156-10: the question of a task with an arena lists the arena and the final's prototype", t => {
  const w = world(t), designs = join(w.pages, "T10", "designs");
  for (const name of ["v1", "v2"]) rmSync(join(designs, name), { recursive: true, force: true });
  const items = material(w).items.filter(item => item.group === "task");
  assert.deepEqual(items.map(item => [item.kind, item.title, item.src]), [
    ["arena", "Arena · 2 candidates and the final", readerUrl(KEY("T10"), "arena", null, { in: "board" })],
    ["prototype", "The judge's final prototype", "/pages/sample-app-abc123/T10/designs/final/index.html"]], "a task with only an arena, no plain design version, shows the arena and the final's prototype");
});

test("T1156 F-T1156-11, -33: a part link opens at the reader's own heading id; the reader's question page of an archived project offers Restore on the board, not an answer", t => {
  const w = world(t), heading = "Ünïcode: the rule (v2) & more";
  const rendered = renderMarkdown(`# T\n\n## ${heading}\n`, { href: () => null, picture: () => null });
  assert.equal(rendered.headings[0].id, headingId(heading), "the material's part id is the id that the Markdown renderer gives the heading");
  writeFileSync(join(w.logbook, "config.json"), JSON.stringify({ archived: true }));
  const question = readerPage({ model: w.model(), configured: w.sources, url: readerUrl(KEY("T10"), "question", "G4"), origin: ORIGIN, render: renderMarkdown }).rest;
  assert.match(question, /<b>sample-app is archived\.<\/b> It takes no answer\. Restore brings the project back where it was, and you answer on the board\. <a class="btn" href="\/app\/#question\?key=shared%2Fsample-app-abc123%2FG4">Open it on the board<\/a>/);
  assert.doesNotMatch(question, /Answer on the board or in the chat/);
});

test("T1156 F-T1156-1, -19: one rule gives a failed run's reason to the chat board and the web board: its failure line first", t => {
  const task = { id: "T3", decisionRows: [{ decision: "R5 failed: the chief's reason" }] }, run = { id: "R5", failure: "its own line" };
  for (const reason of [runFailure, (task, run) => failureOf({ dir: null, task, run })]) {
    assert.deepEqual(reason(task, run), { text: "its own line", from: "failure" });
    assert.deepEqual(reason(task, { id: "R5", failure: "" }), { text: "the chief's reason", from: "decision" });
    assert.equal(reason(task, { id: "R6", failure: "" }), null, "a run with no failure line and no decision has no reason");
  }
});

const get = (base, path, headers = {}) => new Promise((accept, reject) => {
  const req = request(`${base}${path}`, { headers }, response => {
    let body = ""; response.setEncoding("utf8");
    if (path === "/app/events") { response.once("data", part => { body += part; req.destroy(); accept({ status: response.statusCode, headers: response.headers, body }); }); return; }
    response.on("data", part => { body += part; }); response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
  });
  req.on("error", reject); req.end();
});
async function serve(t, w) {
  const server = createBoardServer({ sources: w.sources, port: 0, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [], clock: () => NOW });
  t.after(() => server.close());
  return `http://127.0.0.1:${(await server.start()).port}`;
}

test("T1121 R5: the app may frame only reader pages and the pages folder; a reader page opens in a frame only with ?in=board, without its top bar, and its links leave the frame; a pages file only in a frame of the board", async t => {
  const w = world(t);
  writeFileSync(join(w.logbook, "briefs", "R5.md"), "Run R5 · task T3 (code-reviewer)\nGOAL review\n");
  const base = await serve(t, w), origin = base;
  const app = await get(base, "/app/");
  assert.match(app.headers["content-security-policy"], new RegExp(`; frame-src ${origin}/read/ ${origin}/pages/; .*frame-ancestors 'none'`));
  const alone = await get(base, readerUrl(KEY("T10"), "page", "designs/v2/notes.md"));
  assert.match(alone.headers["content-security-policy"], /frame-ancestors 'none'$/);
  assert.match(alone.body, /<header class="top">/);
  const framed = await get(base, readerUrl(KEY("T3"), "report", "R5", { in: "board" }));
  assert.equal(framed.status, 200);
  assert.match(framed.headers["content-security-policy"], /^sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'none'; .*frame-ancestors 'self'$/, "F-T1121-2: the page's own sandbox lets a click on a link open a new tab");
  assert.doesNotMatch(framed.headers["content-security-policy"], /allow-top-navigation/, "F-T1121-20: nothing in the frame moves the board's window");
  assert.match(alone.headers["content-security-policy"], /^sandbox allow-same-origin; /, "a page outside a frame keeps the plain sandbox");
  assert.doesNotMatch(framed.headers["content-security-policy"], /allow-scripts/);
  assert.doesNotMatch(framed.body, /<header class="top">|class="back"/, "no top bar and no back link in the frame");
  assert.match(framed.body, /<a href="\/read\/[\w-]+\/brief\/R5\?in=board">Brief of R5<\/a>/, "F-T1121-20: a link to another reader page of the task stays in the frame");
  assert.match(framed.body, /<a target="_blank" rel="noopener noreferrer" href="\/app\/#task\?key=[^"]+">Task T3<\/a>/, "F-T1121-20: a link to a board page opens a new tab");
  assert.doesNotMatch(framed.body, /target="_top"/);
  assert.match(framed.body, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/github\.com\/sample-owner\/sample-app\/pull\/12">PR 12<\/a>/, "a link to another site opens a new tab");
  assert.match(framed.body, /<a href="\/read\/[\w-]+\/report\/R5\?open=all&#38;in=board">Open all<\/a>/, "Open all stays in the frame");
  const iframe = await get(base, "/pages/sample-app-abc123/T10/designs/v2/index.html", { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" });
  assert.match(iframe.headers["content-security-policy"], new RegExp(`^sandbox allow-scripts; .*frame-ancestors ${origin}$`));
  const top = await get(base, "/pages/sample-app-abc123/T10/designs/v2/notes.md", { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" });
  assert.match(top.headers["content-security-policy"], /frame-ancestors 'none'$/);
});

test("T1121 F-T1121-5: in a framed reader page, only a link to a board page stays in the frame; a site whose address has in=board opens a new tab", t => {
  const w = world(t);
  writeFileSync(join(w.pages, "T10", "links.md"), "# Links\n\n[a look-alike](https://example.com/?in=board) and [notes](designs/v2/notes.md) and [here](#links)\n");
  const page = readerPage({ model: w.model(), configured: w.sources, url: readerUrl(KEY("T10"), "page", "links.md", { in: "board" }), origin: ORIGIN, render: renderMarkdown }).rest;
  assert.match(page, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com\/\?in=board">a look-alike<\/a>/);
  assert.match(page, /<a href="\/read\/[\w-]+\/page\/designs\/v2\/notes\.md\?in=board">notes<\/a>/, "F-T1121-20: a page of the same task opens in the frame");
  assert.match(page, /<a href="#h-links">here<\/a>/, "a link inside the page stays in the frame");
});

test("T1121 F-T1121-20: in the framed design page, the design notes open in the frame, and the prototype and the pages index open a new tab; no link moves the board's window", t => {
  const w = world(t);
  const page = readerPage({ model: w.model(), configured: w.sources, url: readerUrl(KEY("T10"), "design", null, { in: "board" }), origin: ORIGIN, render: renderMarkdown });
  const html = page.top + page.rest, links = [...html.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map(([a]) => a);
  const find = text => links.find(a => a.endsWith(`>${text}</a>`));
  assert.match(find("Read the design notes"), /^<a href="\/read\/[\w-]+\/page\/designs\/v2\/notes\.md\?in=board">/);
  assert.match(find("Open the prototype"), /^<a class="btn" target="_blank" rel="noopener noreferrer" href="\/pages\/sample-app-abc123\/T10\/designs\/v2\/index\.html">/);
  assert.match(find("Open the pages index"), /^<a class="btn" target="_blank" rel="noopener noreferrer" href="\/pages\/sample-app-abc123\/T10\/">/);
  assert.deepEqual(links.filter(a => !/target="_blank" rel="noopener noreferrer"|href="#|href="\/read\/[^"]*in=board/.test(a)), [], "every link stays in the frame or opens a new tab");
  assert.doesNotMatch(page.policy, /allow-top-navigation/);
});

test("T1121 R6: /app/gate/<key> carries the material and the run that asked; the event stream does not", async t => {
  const w = world(t);
  column(w, "gates", "run", { G4: "R8" });
  const base = await serve(t, w);
  const gate = JSON.parse((await get(base, `/app/gate/${b64(KEY("G4"))}`)).body);
  assert.equal(gate.run, "R8");
  assert.deepEqual(gate.material.items.map(item => item.kind), ["page", "design", "prototype", "report", "brief"]);
  const events = await get(base, "/app/events");
  assert.match(events.body, /^id: \d+\nevent: model\n/);
  assert.doesNotMatch(events.body, /"material"|designs\/v2\/notes\.md/);
});

test("T1121: the asking run's report says which question it became; the reader's question page says to answer on the board or in the chat", t => {
  const w = world(t);
  column(w, "gates", "run", { G4: "R8" });
  const read = (task, kind, arg) => readerPage({ model: w.model(), configured: w.sources, url: readerUrl(KEY(task), kind, arg), origin: ORIGIN, render: renderMarkdown });
  const report = read("T10", "report", "R8").rest;
  assert.match(report, /<b>This became G4\.<\/b> The run asked it in its QUESTIONS field: Can a viewer copy a shared list into their own lists\? <a href="\/app\/#question\?key=shared%2Fsample-app-abc123%2FG4">Open G4<\/a>/);
  assert.doesNotMatch(read("T3", "report", "R5").rest, /This became/, "no mark on a run that asked nothing");
  const question = read("T10", "question", "G4").rest;
  assert.match(question, /<b>Answer on the board or in the chat\.<\/b> The first answer wins\. <a class="btn" href="\/app\/#question\?key=shared%2Fsample-app-abc123%2FG4">Answer on the board<\/a>/);
});

test("T1121 S7: the task panel and the Agents rows show a failed run's reason, and a failed run with none shows no invented one", async t => {
  const w = world(t, { agents: true });
  const model = w.model(), failed = model.tasks.flatMap(task => task.runs.filter(run => run.status === "failed").map(run => [task, run]));
  assert.ok(failed.length > 0, "the fixture has a failed run");
  const [task, run] = failed[0];
  column(w, "runs", "failure", { [run.id]: "the token budget ran out before the review ended" });
  const base = await serve(t, w);
  const panel = JSON.parse((await get(base, `/app/task/${b64(task.key)}`)).body);
  assert.deepEqual(panel.runs.find(item => item.id === run.id).failure, { text: "the token budget ran out before the review ended", from: "failure" });
  const events = JSON.parse(/\ndata: (.*)\n/.exec((await get(base, "/app/events")).body)[1]);
  const row = events.agents.flatMap(book => book.runs).find(item => item.id === run.id);
  assert.ok(row, `the Agents page lists ${run.id}`);
  assert.equal(row.why, "the token budget ran out before the review ended");
  assert.ok(panel.runs.filter(item => item.status !== "failed").every(item => !("failure" in item)));
  const [other, bare] = failed.find(([, item]) => item.id !== run.id);
  assert.equal(JSON.parse((await get(base, `/app/task/${b64(other.key)}`)).body).runs.find(item => item.id === bare.id).failure, null, `${bare.id} has no reason recorded, so the panel gives none`);
});
