import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { requireBrowser } from "./browser-prerequisite.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const chromium = requireBrowser();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = loadBoardApp(join(ROOT, "plugins/sage/board/app"));
const SHOTS = process.env.BOARD_SHOTS_DIR ?? null;
const WIDTHS = [1440, 390];
const KEY = id => `shared/sample-app-abc123/${id}`;
let browser, base, close;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-jobs-")), saved = process.env.SAGE_WORKTREES;
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  writeTasksLogbook(join(dir, "logbooks"), join(dir, "worktrees"), new Date().toISOString(), { agents: true, about: true, prs: true, documents: true });
  const server = quietBoard({ sources: [{ id: "shared", path: join(dir, "logbooks"), label: "Shared" }], port: 0, app: APP });
  const { port } = await server.start();
  await server.ready();
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  close = async () => { await server.close(); if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved; rmSync(dir, { recursive: true, force: true }); };
});
after(async () => { await browser?.close(); await close?.(); });

async function walk(t, job, width, steps, start = "") {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  const page = await context.newPage(), problems = [];
  page.on("pageerror", error => problems.push(String(error)));
  let clicks = 0;
  const click = async locator => { clicks++; await locator.click(); };
  await page.goto(`${base}/${start}`);
  if (!start) assert.equal(new URL(page.url()).pathname, "/app/", "the board's address opens the app");
  await page.locator("main h1", { hasText: start ? /./ : "All projects" }).first().waitFor();
  await steps(page, click);
  assert.ok(clicks <= 2, `${job} at ${width} px took ${clicks} clicks from All projects`);
  assert.deepEqual(problems, []);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${job}-${width}.png`), fullPage: width < 1000 ? false : true }); }
  return clicks;
}
const part = (page, name) => page.locator(`[data-part="${name}"]`);

for (const width of WIDTHS) {
  test(`J1 at ${width} px: Needs you comes first, full width, oldest first, and Open on a row shows the question with its full context`, async t => {
    const clicks = await walk(t, "J1", width, async (page, click) => {
      const first = await page.locator("main [data-part]").first().getAttribute("data-part");
      assert.ok(["since", "needs"].includes(first), `the first part is the since line, then Needs you: ${first}`);
      const needs = part(page, "needs");
      assert.ok((await needs.boundingBox()).width > width * (width < 1000 ? .85 : .6), "Needs you takes the full width");
      await click(needs.locator(`[data-need="${decodeURIComponent(KEY("G4"))}"]`).getByRole("link", { name: "Open", exact: true }));
      await page.locator("main h1", { hasText: "Can a viewer copy a shared list into their own lists?" }).waitFor();
      await page.locator("main h2", { hasText: "Answers" }).waitFor();
    });
    assert.equal(clicks, 1);
  });

  test(`J2 at ${width} px: At work shows one line for each project with no click; the line opens its tasks in place, and a task opens in a second click`, async t => {
    const clicks = await walk(t, "J2", width, async (page, click) => {
      const line = part(page, "work").locator("button[data-work]").first();
      assert.match(await line.textContent(), /^sample-app\d+ tasks · \d+ agents · /);
      await click(line);
      assert.equal(await line.getAttribute("aria-expanded"), "true");
      await click(part(page, "work").locator(`a[data-row][data-task="${decodeURIComponent(KEY("T2"))}"]`));
      await page.locator(".taskpage h1", { hasText: "Sample chief records" }).waitFor();
    });
    assert.equal(clicks, 2);
  });

  test(`J3 at ${width} px: a task opens through its project in two clicks`, async t => {
    const clicks = await walk(t, "J3", width, async (page, click) => {
      await click(page.locator(".tree a[data-project]").first());
      await page.locator("main h1", { hasText: "sample-app" }).waitFor();
      await click(part(page, "waits").locator(`a[data-task="${decodeURIComponent(KEY("T4"))}"]`));
      await page.locator(".taskpage h1", { hasText: "Sample queue" }).waitFor();
    });
    assert.equal(clicks, 2);
  });

  test(`J4 at ${width} px: Progress shows each milestone with no click, and one click opens it`, async t => {
    const clicks = await walk(t, "J4", width, async (page, click) => {
      const rows = await part(page, "progress").locator("a[data-milestone]").allTextContents();
      assert.ok(rows.length >= 2 && rows.every(row => /\d+ of \d+$/.test(row)), rows.join(" | "));
      await click(part(page, "progress").locator(`a[data-milestone="${decodeURIComponent(KEY("M1"))}"]`));
      await page.locator("main h1", { hasText: "Board redesign" }).waitFor();
      assert.match(await part(page, "progress").textContent(), /\d+ of \d+ merged/);
    });
    assert.equal(clicks, 1);
  });

  test(`J6 at ${width} px: the tree switches to a project in one click`, async t => {
    const clicks = await walk(t, "J6", width, async (page, click) => {
      await click(page.locator(".tree a[data-project]").first());
      await page.locator("main h1", { hasText: "sample-app" }).waitFor();
      assert.match(await page.locator("header .lv-crumb").textContent(), /^All projects›sample-app$/);
    });
    assert.equal(clicks, 1);
  });

  test(`J7 at ${width} px: the since line and Done in the last 7 days say what was done, with no click`, async t => {
    const clicks = await walk(t, "J7", width, async page => {
      assert.match(await part(page, "since").textContent(), /^(Since you looked at .+|In the last 24 hours): \d+ merged · \d+ new questions? · \d+ with a flag now/);
      assert.ok(await part(page, "done").locator("a[data-task]").count() > 0);
    });
    assert.equal(clicks, 0);
  });

  test(`J8 at ${width} px: a flagged agent has its own row under its project, and one click opens its run with what happened first`, async t => {
    const clicks = await walk(t, "J8", width, async (page, click) => {
      const flagged = part(page, "work").locator("a[data-run]").first();
      await click(flagged);
      await page.locator("main .kind", { hasText: "Run" }).waitFor();
      assert.equal(await page.locator("main [data-part]").first().getAttribute("data-part"), "facts", "What happened comes first");
      await page.locator("[data-part=facts]").getByText("What next").waitFor();
    });
    assert.equal(clicks, 1);
  });

  test(`More at ${width} px: the Agents and Pull requests pages stay one click away under More`, async t => {
    const clicks = await walk(t, "More", width, async (page, click) => {
      await click(page.locator('nav a[href="#agents"]'));
      await page.locator("main h1", { hasText: "Agents" }).waitFor();
      assert.ok(await page.locator(".chief-box").count() >= 2, "a box for each chief");
      await click(page.locator('nav a[href="#pull-requests"]'));
      await page.locator("main h1", { hasText: "Pull requests" }).waitFor();
    });
    assert.equal(clicks, 2);
  });

  test(`F-T1158-6 and F-T1158-9 at ${width} px: on Stats, the page's own Show list is the only scope: no project picker and no chief chips`, async t => {
    const clicks = await walk(t, "stats", width, async (page, click) => {
      assert.equal(await page.locator("header.top button.picker").count(), 1, "the Overview has the picker");
      assert.ok(await page.locator(".chips").count() > 0, "and the chief chips");
      await click(page.locator(".nav a", { hasText: "Stats" }));
      await page.locator(".chart").first().waitFor();
      assert.deepEqual([await page.locator("header.top button.picker").count(), await page.locator(".chips").count(), await page.locator("header.top .crumb").textContent()], [0, 0, "Stats"]);
      assert.deepEqual(await page.getByLabel("Show").locator("option").allTextContents(), ["All projects", "sample-app"]);
      assert.match(await page.locator("header.top").textContent(), /Live · read/, "the top bar keeps its other parts");
    }, "app/#overview");
    assert.equal(clicks, 1);
  });

  test(`J7 of the Overview at ${width} px: each chief's chip says whether it runs and whether its autopilot is on, with no click`, async t => {
    const clicks = await walk(t, "chiefs", width, async page => {
      if (width < 760) {
        const fold = page.locator(".chips .chip.fold");
        assert.match(await fold.textContent(), /^C1 · autopilot on C2 · autopilot off ▾$/, "T1126 S14: on a phone the folded chip still says each chief's state");
        assert.equal(await fold.locator(".dot.live").count(), 2, "both chiefs run");
        return;
      }
      const chips = await page.locator(".chips button.chip[data-chief]").allTextContents();
      assert.equal(chips.length, 2, chips.join(" | "));
      assert.ok(chips.some(text => /Claude · C1/.test(text) && /autopilot on/.test(text)), chips.join(" | "));
      assert.ok(chips.some(text => /Codex · C2/.test(text) && /autopilot off/.test(text)), chips.join(" | "));
    }, "app/#overview");
    assert.equal(clicks, 0);
  });
}
