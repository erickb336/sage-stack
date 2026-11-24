import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLES } from "../packages/sage-core/logbook-fields.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";
import { NOW as WALK_NOW, STAGES } from "./fixtures/board-walkthrough.mjs";
import { isMain } from "./is-main.mjs";
import { quietBoard } from "./fixtures/quiet-board.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = ["scripts/fixtures/board-app.mjs", "scripts/fixtures/board-walkthrough.mjs"];
const KEY = id => encodeURIComponent(`shared/sample-app-abc123/${id}`);
const b64 = text => Buffer.from(text).toString("base64url");
const PAGES = {
  light: ["/app/", "light"],
  dark: ["/app/", "dark"],
  tasks: ["/app/#tasks", "dark"],
  task: [`/app/#task?key=${KEY("T3")}`, "dark"],
  agents: ["/app/#agents", "dark"],
  prs: ["/app/#pull-requests", "dark"],
  question: [`/app/#question?key=${KEY("G4")}`, "dark"],
  reader: [`/read/${b64("shared/sample-app-abc123/T10")}/question/G4`, "dark"],
  narrow: [`/app/#question?key=${KEY("G4")}`, "dark", { width: 390, height: 844 }],
};
export const SHOTS = {
  ...Object.fromEntries(Object.keys(PAGES).map(name => [name, `docs/assets/board-${name}.png`])),
  ...Object.fromEntries(Object.keys(STAGES).map(stage => [stage, `docs/assets/learn-${stage}.png`])),
};
export const SHOTS_RECORD = "docs/assets/board-shots.json";
export const sampleHash = () => createHash("sha256").update(SOURCES.map(file => readFileSync(join(ROOT, file), "utf8")).join("\0")).digest("hex");

const LABEL = `const b = document.createElement("div"); b.textContent = "SAMPLE DATA";
b.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:8px;font:600 13px system-ui,sans-serif;background:#b3261e;color:#fff";
document.body.append(b);`;
const LAPTOP = { width: 1280, height: 800 };

function writeWalkthrough(root, stage, now) {
  const shift = Date.parse(now) - Date.parse(WALK_NOW), dir = join(root, "ramen-finder-a1b2c3");
  const moved = JSON.parse(JSON.stringify(STAGES[stage]).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z/g, at => new Date(Date.parse(at) + shift).toISOString()));
  mkdirSync(dir, { recursive: true });
  for (const name of ["tasks", "runs", "findings", "ledger", "gates", "decisions", "milestones"]) {
    const rows = moved[name] ?? [], columns = [...TABLES[name], ...new Set(rows.flatMap(row => Object.keys(row)).filter(key => !TABLES[name].includes(key)))];
    writeFileSync(join(dir, `${name}.tsv`), [columns.join("\t"), ...rows.map(row => columns.map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Ramen Finder (sample)" }));
}

async function serve(dir, sources) {
  const { createBoardServer, loadBoardApp } = await import("../packages/sage-board/server.mjs");
  const server = quietBoard({ sources: [{ id: "shared", path: sources, label: "Shared" }], port: 0, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")) });
  const { port } = await server.start();
  await server.ready();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function shoot(browser, base, path, theme, viewport, file) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
  try {
    await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    if (theme === "light") await context.addInitScript(() => localStorage.setItem("board-theme", "light"));
    const page = await context.newPage();
    await page.goto(`${base}${path}`);
    await page.locator("main h1, h1").first().waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(LABEL);
    await page.screenshot({ path: join(ROOT, file) });
  } finally { await context.close(); }
}

async function main() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const dir = mkdtempSync(join(tmpdir(), "sage-board-shots-")), saved = process.env.SAGE_WORKTREES, now = new Date().toISOString();
  process.env.SAGE_WORKTREES = join(dir, "worktrees");
  const browser = await chromium.launch({ headless: true, ...(process.env.BOARD_BROWSER_PATH ? { executablePath: process.env.BOARD_BROWSER_PATH } : {}) });
  try {
    writeTasksLogbook(join(dir, "sample"), join(dir, "worktrees"), now, { agents: true, about: true, prs: true, documents: true });
    const sample = await serve(dir, join(dir, "sample"));
    try {
      for (const [name, [path, theme, viewport = LAPTOP]] of Object.entries(PAGES)) await shoot(browser, sample.base, path, theme, viewport, SHOTS[name]);
    } finally { await sample.close(); }
    for (const stage of Object.keys(STAGES)) {
      writeWalkthrough(join(dir, stage), stage, now);
      const walk = await serve(dir, join(dir, stage));
      try { await shoot(browser, walk.base, `/app/#task?key=${encodeURIComponent("shared/ramen-finder-a1b2c3/T1")}`, "light", LAPTOP, SHOTS[stage]); }
      finally { await walk.close(); }
    }
  } finally {
    await browser.close();
    if (saved === undefined) delete process.env.SAGE_WORKTREES; else process.env.SAGE_WORKTREES = saved;
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(join(ROOT, SHOTS_RECORD), `${JSON.stringify({ sample: sampleHash(), sources: SOURCES }, null, 2)}\n`);
  console.log(`✓ ${Object.values(SHOTS).join(", ")} and ${SHOTS_RECORD}`);
}

if (isMain(import.meta.url)) await main();
