import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ARENA_KEY, ARENA_NOW, writeArenaFixture } from "../fixtures/board-arena.mjs";

const installed = process.env.SAGE_INSTALLED_PLUGIN;
assert.ok(installed && isAbsolute(installed), "Set SAGE_INSTALLED_PLUGIN to the absolute installed plugin folder; this probe never skips or falls back to source.");
const load = file => import(pathToFileURL(join(installed, file)).href);
const { readBoardSources } = await load("core/board-reader.mjs");
const { buildBoardModel } = await load("core/board-model.mjs");
const { readerPage, readerUrl, parseReaderUrl } = await load("board/reader.mjs");
const { renderMarkdown } = await load("board/markdown.mjs");

const snapshot = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath, entry.name);
    return [file, readFileSync(file).toString("hex")];
  }));

function arena(t) {
  const root = mkdtempSync(join(tmpdir(), "sample-installed-arena-"));
  const before = process.env.SAGE_WORKTREES;
  t.after(() => {
    if (before === undefined) delete process.env.SAGE_WORKTREES;
    else process.env.SAGE_WORKTREES = before;
    rmSync(root, { recursive: true, force: true });
  });
  const fixture = writeArenaFixture(root);
  process.env.SAGE_WORKTREES = fixture.worktrees;
  const read = (url = readerUrl(ARENA_KEY, "arena")) => {
    const filesBefore = snapshot(root);
    const model = buildBoardModel(readBoardSources(fixture.sources, { now: Date.parse(ARENA_NOW) }), { now: ARENA_NOW });
    const result = readerPage({ model, configured: fixture.sources, url, origin: "http://127.0.0.1:5000", render: renderMarkdown });
    assert.ok(result, "The installed reader resolves the shared fixture task.");
    assert.deepEqual(snapshot(root), filesBefore, "The reader leaves the fictional logbook and artifacts unchanged.");
    const html = result.top + result.rest;
    return { html, cards: [...html.matchAll(/<section class="card[^"]*">([\s\S]*?)<\/section>/g)].map(match => match[1]) };
  };
  const change = (name, mutate) => {
    const file = join(fixture.pages, "designs", name, "version.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    mutate(value);
    writeFileSync(file, JSON.stringify(value));
  };
  return { ...fixture, read, change };
}

function unassessed(card) {
  assert.match(card, /Not assessed/);
  assert.doesNotMatch(card, /class="score"|>Base<|>Grafted<|>Not used</);
}

test("SAMPLE complete candidates link to their own saved prototypes and exact totals", t => {
  const w = arena(t), page = w.read();
  assert.equal(page.cards.length, 3);
  for (const [index, candidate, run, total, choice] of [[0, "A", "R1", 11, "Base"], [1, "B", "R2", 10, "Grafted"]]) {
    const card = page.cards[index];
    assert.match(card, new RegExp(`${candidate} .*${run}`));
    assert.match(card, new RegExp(`class="score">${total}</span> of 12`));
    assert.match(card, new RegExp(`>${choice}<`));
    const href = /href="([^"]+)">Open its prototype/.exec(card)?.[1];
    assert.equal(href, `/pages/sample-arena-abc123/T1/designs/${candidate}/index.html`);
    assert.match(readFileSync(join(w.pages, "designs", candidate, "index.html"), "utf8"), new RegExp(`Fictional prototype ${candidate}`));
  }
  assert.match(page.html, /Base: candidate A/);
  assert.match(page.html, /From B: clear search/);
});

for (const status of ["failed", "blocked"]) test(`SAMPLE ${status} run remains visible without an artifact or score`, t => {
  const w = arena(t), file = join(w.logbook, "runs.tsv");
  writeFileSync(file, readFileSync(file, "utf8").replace("\tfailed\t", `\t${status}\t`));
  const page = w.read();
  assert.equal(page.cards.length, 3);
  assert.match(page.cards[2], /C .*R3/);
  assert.match(page.cards[2], new RegExp(`State: [^<]*${status}`));
  unassessed(page.cards[2]);
  assert.doesNotMatch(page.cards[2], /Open its prototype/);
  assert.match(page.cards[0], /class="score">11/);
});

for (const status of ["failed", "blocked"]) test(`SAMPLE ${status} run retains its saved artifact without a score or selection`, t => {
  const w = arena(t), file = join(w.logbook, "runs.tsv");
  writeFileSync(file, readFileSync(file, "utf8").replace("sample/R1\tdone\t", `sample/R1\t${status}\t`));
  const page = w.read();
  assert.equal(page.cards.length, 3);
  assert.match(page.cards[0], /A .*R1/);
  assert.match(page.cards[0], new RegExp(`State: [^<]*${status}`));
  unassessed(page.cards[0]);
  assert.match(page.cards[0], /href="\/pages\/sample-arena-abc123\/T1\/designs\/A\/index.html">Open its prototype/);
  assert.doesNotMatch(page.html, /Base: candidate A/);
  assert.match(page.cards[1], /class="score">10/);
  assert.doesNotMatch(page.cards[1], />Grafted</);
});

test("SAMPLE artifact-free saved version cannot supply a score or a base", t => {
  const w = arena(t);
  rmSync(join(w.pages, "designs", "A", "index.html"));
  const page = w.read();
  unassessed(page.cards[0]);
  assert.doesNotMatch(page.cards[0], /Open its prototype/);
  assert.doesNotMatch(page.html, /Base: candidate A/);
  assert.match(page.cards[1], /class="score">10/);
});

test("SAMPLE mismatched run cannot borrow a candidate title, prototype, or score", t => {
  const w = arena(t);
  for (const run of [undefined, "R99", "R2"]) {
    w.change("A", value => { value.run = run; });
    const page = w.read();
    assert.equal(page.cards.length, 3);
    assert.match(page.cards[0], /A .*R1/);
    unassessed(page.cards[0]);
    assert.doesNotMatch(page.cards[0], /list first|Open its prototype/);
    assert.doesNotMatch(page.html, /Base: candidate A/);
    assert.match(page.cards[1], /search first/);
    assert.match(page.cards[1], /designs\/B\/index.html/);
    assert.doesNotMatch(page.cards[1], /designs\/A\/index.html/);
  }
});

test("SAMPLE incomplete scores suppress the total and selection while retaining the correct artifact", t => {
  const w = arena(t);
  for (const scores of [[4, null, 4], [4, 3], [4, 3, 4, 4], [4, 5, 4]]) {
    w.change("final", value => { value.final.scores.candidates.A = scores; });
    const page = w.read();
    unassessed(page.cards[0]);
    assert.match(page.cards[0], /designs\/A\/index.html/);
    assert.doesNotMatch(page.html, /Base: candidate A/);
    assert.match(page.cards[1], /class="score">10/);
  }
});

test("SAMPLE report reader keeps its run identity and says when no report was kept", t => {
  const w = arena(t);
  for (const run of ["R1", "R2", "R3"]) {
    const url = readerUrl(ARENA_KEY, "report", run);
    const parsed = parseReaderUrl(url);
    assert.equal(parsed.key, ARENA_KEY);
    assert.equal(parsed.arg, run);
    const page = w.read(url);
    assert.match(page.html, new RegExp(`Report of ${run}`));
    assert.match(page.html, new RegExp(`no report of ${run}`));
    assert.match(page.html, /Not kept/);
  }
});
