import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBoardServer } from "../packages/sage-board/server.mjs";
import { readerUrl } from "../packages/sage-board/reader.mjs";
import { ARENA_KEY, writeArenaFixture } from "./fixtures/board-arena.mjs";

test("fictional arena route preserves failed candidates and unknown evidence on desktop and mobile", async t => {
  const root = mkdtempSync(join(tmpdir(), "sage-arena-browser-")), fixture = writeArenaFixture(root);
  const previous = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = fixture.worktrees;
  let board, browser, port;
  const artifacts = process.env.ARENA_SCREENSHOTS;
  if (artifacts) mkdirSync(artifacts, { recursive: true });
  try {
    do {
      const socket = createServer();
      await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
      port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
    } while ([4173, 43123].includes(port));
    board = createBoardServer({ sources: fixture.sources, port });
    await board.start();
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
