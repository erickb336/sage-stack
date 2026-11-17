import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBoardServer } from "../packages/sage-board/server.mjs";
import { readerUrl } from "../packages/sage-board/reader.mjs";
import { ARENA_KEY, writeArenaFixture } from "./fixtures/board-arena.mjs";
import { createBoardServer as createBuiltBoardServer } from "../plugins/sage-codex/board/server.mjs";

test("task links reach arena-only, mixed and artifact-free arenas without changing ordinary or empty tasks", async t => {
  const root = mkdtempSync(join(tmpdir(), "sage-arena-entry-")), fixture = writeArenaFixture(root);
  const previous = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = fixture.worktrees;
  let board, browser, port;
  const artifacts = process.env.ARENA_SCREENSHOTS;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  try {
    board = createBuiltBoardServer({ sources: fixture.sources, port: 0 });
    ({ port } = await board.start());
    browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${port}`, task = `${origin}/app/#task?key=${encodeURIComponent(ARENA_KEY)}&tab=artifacts`;
    const isTask = url => url.origin === origin && url.pathname === "/app/" && url.hash.startsWith("#task?")
      && new URLSearchParams(url.hash.slice(6)).get("key") === ARENA_KEY;
    const shot = async name => {
      if (!artifacts) return;
      const path = join(artifacts, `${name}.png`);
      await page.screenshot({ path, fullPage: true });
      t.diagnostic(`${name}: ${path} sha256 ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    };
    for (const state of ["arena-only", "mixed", "runs-only", "versions-only", "ordinary", "empty"]) {
      writeArenaFixture(root);
      const designs = join(fixture.pages, "designs"), runs = join(fixture.logbook, "runs.tsv");
      if (["ordinary", "empty", "runs-only"].includes(state)) rmSync(designs, { recursive: true });
      if (["ordinary", "empty", "versions-only"].includes(state)) writeFileSync(runs, readFileSync(runs, "utf8").split("\n")[0] + "\n");
      if (["ordinary", "mixed"].includes(state)) {
        mkdirSync(join(designs, "ordinary"), { recursive: true });
        writeFileSync(join(designs, "ordinary", "version.json"), JSON.stringify({ title: "SAMPLE: ordinary design", today: true }));
        writeFileSync(join(designs, "ordinary", "index.html"), "<!doctype html><p>Fictional ordinary prototype</p>");
      }
      const hasArena = !["ordinary", "empty"].includes(state), hasDesign = ["ordinary", "mixed"].includes(state);
      for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.goto("about:blank");
        assert.equal((await page.goto(task)).status(), 200);
        await page.getByRole("tab", { name: /^Artifacts/ }).waitFor({ state: "visible" });
        const entry = page.getByRole("link", { name: "Arena · candidates, scores and the judge's final", exact: true });
        const design = page.getByRole("link", { name: "Design · 1 version", exact: true });
        await shot(`${state}-${name}-task`);
        assert.equal(await entry.count(), Number(hasArena), `${state} ${name}: Arena entry`);
        assert.equal(await design.count(), Number(hasDesign), `${state} ${name}: ordinary design entry`);
        assert.equal(await page.getByText("No artifact is recorded for this task yet.", { exact: true }).count(), Number(state === "empty"));
        if (hasArena) {
          const arena = `${origin}${readerUrl(ARENA_KEY, "arena")}`;
          await entry.click();
          await page.waitForURL(arena);
          assert.match(await page.locator("h1").innerText(), /Arena of T1/);
          if (state !== "versions-only") {
            assert.equal(await page.locator("section.card").count(), 3);
            const failed = page.locator("section.card").nth(2);
            assert.match(await failed.innerText(), /C R3[\s\S]*failed[\s\S]*No saved version[\s\S]*Not assessed/);
            assert.equal(await failed.locator("a, img, .score").count(), 0);
          }
          await shot(`${state}-${name}-arena`);
          await page.goBack();
          await shot(`${state}-${name}-back`);
          assert.ok(isTask(new URL(page.url())), `browser Back destination: ${page.url()}`);
          await entry.waitFor({ state: "visible" });
        }
        if (hasDesign) {
          await design.click();
          await page.waitForURL(`${origin}${readerUrl(ARENA_KEY, "design")}`);
          assert.match(await page.locator("body").innerText(), /SAMPLE: ordinary design/);
          await page.goBack();
          await page.waitForURL(isTask);
          await design.waitFor({ state: "visible" });
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        t.diagnostic(`${state} ${name}: links and browser Back passed`);
      }
      rmSync(designs, { recursive: true, force: true });
    }
    t.diagnostic(`actual task route checked: ${task}; labeled fictional shared fixture`);
  } finally {
    try { await browser?.close(); } finally { await board?.close(); }
    assert.ok(!browser || !browser.isConnected(), "browser disconnected after close");
    if (port) await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
    t.diagnostic("cleanup: browser disconnected; board listener closed; no background child remains");
    if (previous === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fictional arena route preserves failed candidates and unknown evidence on desktop and mobile", async t => {
  const root = mkdtempSync(join(tmpdir(), "sage-arena-browser-")), fixture = writeArenaFixture(root);
  const previous = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = fixture.worktrees;
  let board, browser, port;
  const artifacts = process.env.ARENA_SCREENSHOTS;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  try {
    board = createBoardServer({ sources: fixture.sources, port: 0 });
    ({ port } = await board.start());
    browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${port}${readerUrl(ARENA_KEY, "arena")}`;
    for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      assert.equal((await page.goto(url)).status(), 200);
      assert.match(await page.locator("body").innerText(), /SAMPLE DATA: fictional arena/);
      assert.equal(await page.locator("section.card").count(), 3);
      assert.match(await page.locator("section.card").nth(2).innerText(), /C R3[\s\S]*failed[\s\S]*Not assessed/);
      assert.match(await page.locator("body").innerText(), /Base: candidate A/);
      assert.match(await page.locator("body").innerText(), /From B: clear search/);
      assert.match(await page.locator("body").innerText(), /C: no artifact/);
      assert.equal(await page.getByRole("link", { name: "Open its prototype", exact: true }).count(), 2);
      for (const link of await page.getByRole("link", { name: /^Open (its|the final) prototype$/ }).all()) {
        const target = new URL(await link.getAttribute("href"), url);
        assert.equal(target.origin, new URL(url).origin);
        const response = await page.request.get(target.href);
        assert.equal(response.status(), 200);
        assert.match(await response.text(), /Fictional prototype (A|B|final)/);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (artifacts) {
        const path = join(artifacts, `${name}.png`);
        await page.screenshot({ path, fullPage: true });
        t.diagnostic(`${name}: ${path} sha256 ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
    const file = join(fixture.pages, "designs", "final", "version.json"), data = JSON.parse(readFileSync(file, "utf8"));
    data.final.scores.candidates.A = [4, null, 4];
    writeFileSync(file, JSON.stringify(data));
    await page.reload();
    assert.equal(await page.locator("section.card").first().locator(".score").count(), 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /Base: candidate A/);
    assert.match(await page.locator("section.card").first().innerText(), /Not assessed/);
    if (artifacts) {
      const path = join(artifacts, "mobile-unassessed.png");
      await page.screenshot({ path, fullPage: true });
      t.diagnostic(`mobile unassessed: ${path} sha256 ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
    t.diagnostic(`actual reader route checked: ${url}; fictional fixture: ${root}`);
  } finally {
    try { await browser?.close(); } finally { await board?.close(); }
    assert.ok(!browser || !browser.isConnected(), "browser disconnected after close");
    if (port) await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
    t.diagnostic("cleanup: browser disconnected; board listener closed; no background child remains");
    if (previous === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
