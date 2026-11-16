import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActions, readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { readerPage, readerUrl } from "../packages/sage-board/reader.mjs";
import { renderMarkdown } from "../packages/sage-board/markdown.mjs";
import { ARENA_KEY, ARENA_NOW, writeArenaFixture } from "./fixtures/board-arena.mjs";

function arena(t) {
  const root = mkdtempSync(join(tmpdir(), "sage-arena-reader-")), before = process.env.SAGE_WORKTREES;
  const fixture = writeArenaFixture(root);
  process.env.SAGE_WORKTREES = fixture.worktrees;
  t.after(() => { if (before === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = before; rmSync(root, { recursive: true, force: true }); });
  const read = () => {
    const model = buildBoardModel(readBoardSources(fixture.sources, { now: Date.parse(ARENA_NOW) }), { now: ARENA_NOW });
    const result = readerPage({ model, configured: fixture.sources, url: readerUrl(ARENA_KEY, "arena"), origin: "http://127.0.0.1:5000", render: renderMarkdown });
    const html = result.top + result.rest;
    return { html, cards: [...html.matchAll(/<section class="card[^"]*">([\s\S]*?)<\/section>/g)].map(match => match[1]), text: html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  };
  const change = (name, mutate) => { const file = join(fixture.pages, "designs", name, "version.json"), data = JSON.parse(readFileSync(file, "utf8")); mutate(data); writeFileSync(file, JSON.stringify(data)); };
  return { ...fixture, read, change };
}

test("arena keeps failed and blocked candidate runs without saved artifacts", t => {
  const w = arena(t);
  for (const status of ["failed", "blocked"]) {
    const file = join(w.logbook, "runs.tsv");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\t(?:failed|blocked)\t/, `\t${status}\t`));
    const page = w.read();
    assert.equal(page.cards.length, 3);
    assert.match(page.cards[2], /C .*R3/);
    assert.match(page.cards[2], new RegExp(`State: [^<]*${status}`));
    assert.match(page.cards[2], /Not assessed/);
    assert.doesNotMatch(page.cards[2], /class="score"|>Base<|>Grafted<|>Not used</);
    assert.match(page.text, /Base: candidate A/);
    assert.match(page.text, /From B: clear search/);
    assert.match(page.text, /C: no artifact/);
  }
});

test("arena never totals or selects a candidate with incomplete scores", t => {
  const w = arena(t);
  for (const scores of [[4, null, 4], [4, 3], [4, 3, 4, 4], [4, 5, 4]]) {
    w.change("final", data => { data.final.scores.candidates.A = scores; });
    const page = w.read();
    assert.match(page.cards[0], /Not assessed/);
    assert.doesNotMatch(page.cards[0], /class="score"|>Base</);
    assert.doesNotMatch(page.text, /Base: candidate A/);
    assert.match(page.cards[1], /class="score">10</);
  }
});

test("arena attaches versions only to explicit candidate run identities", t => {
  const w = arena(t);
  for (const run of [undefined, "R99", "R2"]) {
    w.change("A", data => { data.run = run; });
    const page = w.read();
    assert.equal(page.cards.length, 3);
    assert.match(page.cards[0], /A .*R1/);
    assert.match(page.cards[0], /Not assessed/);
    assert.doesNotMatch(page.cards[0], /list first|class="score"|>Base<|Open its prototype/);
    assert.doesNotMatch(page.text, /Base: candidate A/);
  }
});

test("arena preserves runs before a judge saves a final and refuses ambiguous evidence", t => {
  const w = arena(t), finalFile = join(w.pages, "designs", "final", "version.json"), final = readFileSync(finalFile);
  rmSync(finalFile);
  assert.equal(w.read().cards.length, 3);
  assert.ok(w.read().cards.every(card => card.includes("Not assessed")));
  writeFileSync(finalFile, final);
  const copy = join(w.pages, "designs", "copy"); mkdirSync(copy);
  writeFileSync(join(copy, "version.json"), readFileSync(join(w.pages, "designs", "A", "version.json")));
  assert.match(w.read().cards[0], /Not assessed/);
  assert.doesNotMatch(w.read().cards[0], /class="score"|>Base</);
  rmSync(copy, { recursive: true });
  const runs = join(w.logbook, "runs.tsv");
  writeFileSync(runs, readFileSync(runs, "utf8").replace("R3\tT1\tdesigner\t0\tC", "R3\tT1\tdesigner\t0\tA"));
  assert.ok(w.read().cards.filter(card => /R[13]</.test(card)).every(card => card.includes("Not assessed")));
});

test("arena leaves artifact-free saved versions and unmatched judge evidence not assessed", t => {
  const w = arena(t);
  w.change("final", data => { data.run = "R99"; });
  assert.ok(w.read().cards.every(card => card.includes("Not assessed") && !card.includes('class="score"')));
  w.change("final", data => { data.run = "R4"; });
  rmSync(join(w.pages, "designs", "A", "index.html"));
  const page = w.read();
  assert.match(page.cards[0], /Not assessed/);
  assert.doesNotMatch(page.cards[0], /class="score"|>Base<|Open its prototype/);
  assert.doesNotMatch(page.text, /Base: candidate A/);
});

test("board reader preserves source-qualified duplicate tasks and never initializes missing tables", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = ["one", "two"].map(id => {
    const path = join(root, id), project = join(path, "sample-abcdef");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT197\t<script>sample</script>\tsmall\t\tbuild\tframed\t\t\t0\t\n");
    return { id, path };
  });
  const before = sources.map(s => readFileSync(join(s.path, "sample-abcdef/tasks.tsv"), "utf8"));
  const result = readBoardSources(sources);
  assert.notEqual(result[0].projects[0].key, result[1].projects[0].key);
  for (const [i, source] of sources.entries()) {
    assert.equal(result[i].projects[0].tables.tasks[0].id, "T197");
    assert.equal(result[i].projects[0].tables.tasks[0].title, "<script>sample</script>");
    assert.equal(result[i].projects[0].diagnostics.length, 5);
    assert.deepEqual(readdirSync(join(source.path, "sample-abcdef")), ["tasks.tsv"]);
    assert.equal(readFileSync(join(source.path, "sample-abcdef/tasks.tsv"), "utf8"), before[i]);
  }
});

test("board reader reports unreadable, duplicate and linked sources rather than a complete empty board", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "link"); symlinkSync(root, link);
  const result = readBoardSources([{ id: "one", path: root }, { id: "two", path: root }, { id: "link", path: link }, { id: "missing", path: join(root, "missing") }]);
  assert.deepEqual(result[0].diagnostics, []);
  assert.deepEqual(result[1].diagnostics, ["duplicate physical source"]);
  assert.deepEqual(result[2].diagnostics, ["source is not a directory"]);
  assert.deepEqual(result[3].diagnostics, ["ENOENT"]);
  assert.throws(() => readBoardSources([{ id: "one", path: root }, { id: "one", path: root }]), TypeError);
});

test("board reader refuses linked, oversized and damaged tables without following their contents", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"); mkdirSync(project);
  const outside = join(root, "outside"); writeFileSync(outside, "private sentinel");
  symlinkSync(outside, join(project, "tasks.tsv"));
  writeFileSync(join(project, "runs.tsv"), "x".repeat(4 * 1024 * 1024 + 1));
  writeFileSync(join(project, "gates.tsv"), "id\tid\nG1\tG1\n");
  const [source] = readBoardSources([{ id: "sample", path: root }]);
  const book = source.projects[0];
  assert.equal(book.tables.tasks, undefined);
  assert.equal(book.tables.runs, undefined);
  assert.equal(book.tables.gates, undefined);
  assert.ok(book.diagnostics.some(d => d.startsWith("tasks:")));
  assert.ok(book.diagnostics.includes("runs: not a bounded regular file"));
  assert.ok(book.diagnostics.includes("gates: damaged table header"));
  assert.equal(readFileSync(outside, "utf8"), "private sentinel");
});

test("reader accepts versioned evidence and rejects future or damaged sidecars", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"); mkdirSync(project);
  const at = "2026-10-08T20:00:00.000Z";
  const record = { id: "O1", task: "T1", kind: "pr", source: "fixture recorder", basis: "observed", observedAt: at, recordedAt: at, data: { repository: "https://example.test/team/project", number: 12, state: "open", head: "a".repeat(40) } };
  const file = join(project, "observations.json");
  writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  assert.equal(read().observations.records[0].data.head, "a".repeat(40));
  record.observedAt = "2027-10-08T20:00:00.000Z"; record.recordedAt = record.observedAt;
  writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
  assert.equal(read().observations.records.length, 0);
  assert.ok(read().diagnostics.some(d => d.startsWith("observations:")));
  writeFileSync(file, "{broken");
  assert.equal(read().observations.records.length, 0);
  assert.ok(read().diagnostics.some(d => d.startsWith("observations:")));
});

test("reader exposes a recorded brief only after its content digest matches", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), briefs = join(project, "briefs"); mkdirSync(briefs, { recursive: true });
  writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n");
  const body = "Goal: sample brief.\nAcceptance: sample result.\n", file = join(briefs, "T1.md"); writeFileSync(file, body);
  const at = "2026-10-08T20:00:00.000Z";
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records: [{ id: "O1", task: "T1", kind: "artifact", source: "fixture recorder", basis: "observed", observedAt: at, recordedAt: at, data: { type: "brief", label: "Sample brief", path: "briefs/T1.md", sha256: createHash("sha256").update(body).digest("hex") } }] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  assert.equal(read().contents.O1.text, body);
  writeFileSync(file, "changed brief");
  assert.equal(read().contents.O1, undefined);
  assert.ok(read().diagnostics.includes("artifact O1: artifact digest does not match"));
});


test("recorded screenshots embed only digest-verified raster bytes; config errors expose no input", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), artifacts = join(project, "artifacts"); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(project, "tasks.tsv"), "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\nT1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64"), file = join(artifacts, "sample.png"), at = "2026-10-08T20:00:00.000Z";
  writeFileSync(file, bytes);
  writeFileSync(join(root, "config.json"), "SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW");
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records: [{ id: "O1", task: "T1", kind: "artifact", source: "fixture", basis: "observed", observedAt: at, recordedAt: at, data: { type: "artifact", label: "Sample screenshot", path: "artifacts/sample.png", sha256: createHash("sha256").update(bytes).digest("hex") } }] }));
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0];
  const result = read();
  assert.equal(result.projects[0].contents.O1.dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
  assert.deepEqual(result.diagnostics, ["config: invalid JSON"]);
  writeFileSync(file, "<svg onload=sample>changed</svg>");
  assert.equal(read().projects[0].contents.O1, undefined);
});


test("damaged task identities and states are diagnostics, and repeated artifacts share a read budget", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "sample-abcdef"), artifacts = join(project, "artifacts"); mkdirSync(artifacts, { recursive: true });
  const header = "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\n", row = "T1\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\n", tasks = join(project, "tasks.tsv"), at = "2026-10-08T20:00:00.000Z";
  const read = () => readBoardSources([{ id: "sample", path: root }], { now: Date.parse(at) })[0].projects[0];
  for (const damaged of [row.replace("T1", "bad"), row.replace("framed", "lost-state"), row + row]) {
    writeFileSync(tasks, header + damaged);
    assert.ok(read().diagnostics.includes("tasks: damaged task identity or state"));
  }
  writeFileSync(tasks, header + row);
  const body = "sample proof\n".repeat(22000), digest = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(artifacts, "proof.txt"), body);
  const records = Array.from({ length: 80 }, (_, i) => ({ id: `O${i + 1}`, task: "T1", kind: "artifact", source: "fixture", basis: "observed", observedAt: at, recordedAt: at, data: { type: "proof", label: `Sample ${i + 1}`, path: "artifacts/proof.txt", sha256: digest } }));
  writeFileSync(join(project, "observations.json"), JSON.stringify({ version: 1, records }));
  const result = read();
  assert.ok(result.diagnostics.some(message => message.endsWith("board aggregate read limit exceeded")));
  assert.ok(Object.keys(result.contents).length < records.length);
  assert.ok(Object.values(result.contents).reduce((bytes, content) => bytes + Buffer.byteLength(content.text ?? ""), 0) <= 16 * 1024 * 1024);
});

test("T233 C3: the milestones table: missing is no rows while no task names a milestone, else a diagnostic; a damaged header, two rows of one id, or a bad pilot or gate cell make it unreadable; a bad milestone cell shows as ?", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const HEAD = "id\ttitle\tsize\trisk\troute\tstate\tbranch\tpr\tround\tkeys\twaits\tmilestone\n";
  const task = (id, milestone = "", waits = "") => `${id}\tSample\tsmall\t\tbuild\tframed\t\t\t0\t\t${waits}\t${milestone}\n`;
  const EMPTY = { runs: "id\ttask\trole\tround\tcandidate\tbranch\tstatus\ttokens\treport\tstarted\tended\n", findings: "task\tkey\tround\tsource\tseverity\tsummary\ttriage\treason\tstatus\n", ledger: "task\tpr\tsha\tkind\tcycle\trun\tat\n", gates: "id\ttask\tquestion\toptions\trecommendation\tdefault\tanswer\tat\n", decisions: "at\ttask\tdecision\twhy\n" };
  const read = (tasks, milestones) => {
    const path = mkdtempSync(join(root, "source-")), project = join(path, "sample-abcdef");
    mkdirSync(project);
    writeFileSync(join(project, "tasks.tsv"), HEAD + tasks.join(""));
    for (const [table, text] of Object.entries(EMPTY)) writeFileSync(join(project, `${table}.tsv`), text);
    if (milestones !== undefined) writeFileSync(join(project, "milestones.tsv"), milestones);
    return readBoardSources([{ id: "one", path }])[0].projects[0];
  };
  const MILESTONES = "id\tname\tgoal\tpilot\tgate\tat\n";
  const old = read([task("T1")]);
  assert.deepEqual(old.diagnostics, []);
  assert.deepEqual(old.tables.milestones, []);
  const lost = read([task("T1", "M1")]);
  assert.deepEqual(lost.diagnostics, ["milestones: ENOENT"]);
  assert.equal(lost.tables.milestones, undefined);
  const good = read([task("T1", "M1"), task("T2", "M1", "T1")], `${MILESTONES}M1\t<b>Codex</b> *support*\tSample goal\tT1\tG1\t2026-10-20T10:00:00Z\n`);
  assert.deepEqual(good.diagnostics, []);
  assert.deepEqual(good.tables.milestones, [{ id: "M1", name: "<b>Codex</b> *support*", goal: "Sample goal", pilot: "T1", gate: "G1", at: "2026-10-20T10:00:00Z" }]);
  assert.equal(good.tables.tasks[1].waits, "T1");
  for (const [why, text, message] of [
    ["header", "id\tname\tgoal\tpilot\n", "damaged table header"],
    ["twice", `${MILESTONES}M1\tA\tg\tT1\tG1\t\n\nM1\tB\tg\tT2\tG2\t\n`, "line 4 has the milestone M1 again (first on line 2)"],
    ["one gate", `${MILESTONES}M1\tA\tg\tT1\tG1\t\nM2\tB\tg\tT1\tG1\t\n`, "line 3: M2 names the gate G1 of M1"],
    ["id", `${MILESTONES}P1 <b>\tA\tg\tT1\tG1\t\n`, "line 2 has a milestone id that is not M and a number"],
    ["pilot", `${MILESTONES}M1\tA\tg\tX1\tG1\t\n`, "line 2: the pilot of M1 is not a task id"],
    ["gate", `${MILESTONES}M1\tA\tg\tT1\tgate 1\t\n`, "line 2: the gate of M1 is not a gate id"],
    ["row", `${MILESTONES}\nM1\tA\tg\n`, "line 3 has 3 cells, and its header has 6"],
  ]) {
    const bad = read([task("T1", "M1")], text);
    assert.equal(bad.tables.milestones, undefined, why);
    assert.deepEqual(bad.diagnostics, [`milestones: ${message}`], why);
    assert.equal(bad.tables.tasks.length, 1, why);
  }
  const cell = read([task("T1", "<img src=x>"), task("T2", "M1")], `${MILESTONES}M1\tA\tg\tT2\tG1\t\n`);
  assert.deepEqual(cell.tables.tasks.map(row => row.milestone), ["?", "M1"]);
});

test("T1100 F-T1100-3: readActions never reads through a logbook folder that is a link, also when the folder becomes a link during the read", t => {
  const root = mkdtempSync(join(tmpdir(), "sage-board-actions-")), logbook = join(root, "project-abcdef"), outside = join(root, "outside");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const action = target => `${JSON.stringify({ v: 1, at: "2026-11-14T12:00:00.000Z", run: "R1", tool: "Read", kind: "file", target, call: "00000001", mark: "ok" })}\n`;
  for (const [dir, target] of [[logbook, "src/sample-inside.mjs"], [outside, "src/sample-outside.mjs"]]) { mkdirSync(join(dir, "actions"), { recursive: true }); writeFileSync(join(dir, "actions", "R1.jsonl"), action(target)); }
  assert.equal(readActions(logbook, "R1").actions[0].target, "src/sample-inside.mjs");
  const original = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = (path, ...rest) => {
    if (!swapped && path === join(logbook, "actions")) { swapped = true; renameSync(logbook, `${logbook}-moved`); symlinkSync(outside, logbook); }
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => readActions(logbook, "R1"), { code: "ELOOP" }, "a swap between the check of the logbook and the open is refused"); }
  finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  assert.ok(swapped);
  assert.throws(() => readActions(logbook, "R1"), { code: "ELOOP" }, "a logbook folder that is a link is refused");
});
