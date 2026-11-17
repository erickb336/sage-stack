#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLink } from "../packages/sage-board/access.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT = { dark: "docs/assets/board-walkthrough-dark.gif", light: "docs/assets/board-walkthrough-light.gif" };
const NARROWEST_WINDOW_WHERE_MILESTONE_NAMES_DO_NOT_WRAP_BY_LETTER = { width: 1320, height: 800 };
const FFMPEG_HELP = "The walkthrough needs ffmpeg 6 or later to write the GIF. Install it (macOS: brew install ffmpeg; Debian or Ubuntu: sudo apt-get install ffmpeg), or give its path in FFMPEG.";

export function answerInSample({ shared, folder, argv }, at = new Date().toISOString()) {
  const [table, verb, gate] = argv, option = Number(argv[argv.indexOf("--option") + 1]);
  if (table !== "gate" || verb !== "answer") return { code: 1, text: "The walkthrough sample records only answers to questions." };
  const file = join(shared, folder, "gates.tsv"), [head, ...lines] = readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
  const columns = head.split("\t"), rows = lines.map(line => Object.fromEntries(line.split("\t").map((cell, i) => [columns[i], cell])));
  const row = rows.find(item => item.id === gate), answer = row?.options.split("|")[option - 1];
  if (!answer) return { code: 1, text: `${gate} has no answer ${option} in the sample.` };
  row.answered = JSON.stringify({ via: "board", at, answer });
  const all = columns.includes("answered") ? columns : [...columns, "answered"];
  writeFileSync(file, [all.join("\t"), ...rows.map(item => all.map(column => item[column] ?? "").join("\t"))].join("\n") + "\n");
  return { code: 0, text: `${gate} answered: ${answer}` };
}

export function concatList(frames) {
  const entry = ({ file, seconds }) => `file '${file.replace(/'/g, "'\\''")}'\nduration ${seconds}\n`;
  return `ffconcat version 1.0\n${frames.map(entry).join("")}${frames.length ? `file '${frames.at(-1).file.replace(/'/g, "'\\''")}'\n` : ""}`;
}

export function ffmpegCommand(env = process.env) {
  const ffmpeg = env.FFMPEG || "ffmpeg", probe = spawnSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) throw new Error(`${FFMPEG_HELP} (${ffmpeg}: ${probe.error?.code ?? `exit ${probe.status}`})`);
  const major = Number(/^ffmpeg version n?(\d+)\./.exec(probe.stdout)?.[1]);
  if (!(major >= 6)) throw new Error(`${FFMPEG_HELP} (${ffmpeg} says: ${probe.stdout.split("\n")[0]})`);
  return { ffmpeg, version: probe.stdout.split("\n")[0] };
}

const OVERLAY = ({ caption, point }) => {
  for (const id of ["walk-caption", "walk-sample", "walk-pointer"]) document.getElementById(id)?.remove();
  const add = (id, css, html) => { const el = document.createElement("div"); el.id = id; el.style.cssText = `position:fixed;z-index:10000;pointer-events:none;${css}`; el.innerHTML = html; document.body.append(el); };
  const pill = "bottom:14px;padding:7px 12px;border-radius:9px;font:600 15px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);";
  add("walk-caption", `left:50%;transform:translateX(-50%);${pill}background:#1d4ed8;color:#fff`, "");
  document.getElementById("walk-caption").textContent = caption;
  add("walk-sample", `right:14px;${pill}background:#b3261e;color:#fff`, "Sample data");
  if (point) add("walk-pointer", `left:${point.x - 18}px;top:${point.y - 18}px;width:48px;height:48px`,
    '<svg viewBox="0 0 48 48" width="48" height="48"><circle cx="18" cy="18" r="16" fill="rgba(250,204,21,.4)"/><path d="M18 18 L18 38 L23 33 L27 42 L30.5 40.5 L26.5 31.5 L33 31.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>');
};

async function walk(page, base, shoot) {
  const heading = name => page.locator("main h1", { hasText: name }).first().waitFor();
  const at = async locator => { await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; };
  const click = async (locator, caption) => { await shoot(caption, 0.9, await at(locator)); await locator.click(); };
  const nav = hash => page.locator(`nav[aria-label="Pages"] a[href="#${hash}"]`);

  await page.goto(`${base}/app/`);
  await heading("Overview");
  let caption = "1 of 5 · Needs you: what waits for your answer";
  await shoot(caption, 3.5);

  await click(nav("agents"), caption);
  await heading("Agents");
  caption = "2 of 5 · The agents at work now, in each project";
  await shoot(caption, 3.5);

  await click(nav("tasks"), caption);
  await heading("Tasks");
  caption = "3 of 5 · A task and its steps";
  await shoot(caption, 2);
  const row = page.locator("a.row", { hasText: "Sample shared limits" }).first();
  await click(row, caption);
  await heading("Sample shared limits");
  await shoot(caption, 2.5);
  await page.locator("ol.trail").evaluate(trail => trail.scrollIntoView({ block: "center" }));
  await shoot(caption, 3.5);

  await click(nav(""), caption);
  await heading("Overview");
  caption = "4 of 5 · Answer a question from the board";
  await click(page.locator("main").getByRole("link", { name: "Can a viewer copy a shared list into their own lists?" }).first(), caption);
  await page.getByRole("heading", { name: "Can a viewer copy a shared list into their own lists?", level: 1 }).waitFor();
  await shoot(caption, 2);
  await click(page.locator(".answer", { hasText: /^A: yes/ }).first(), caption);
  await click(page.getByRole("button", { name: "Send answer" }), caption);
  await page.getByText(/^You answered G4: A: yes/).waitFor();
  await shoot(caption, 3.5);

  await click(nav("stats"), caption);
  await heading("Stats");
  caption = "5 of 5 · Stats: the numbers for every project";
  await shoot(caption, 4);
}

function refuseLocalText(text, words) {
  const found = words.find(word => text.includes(word));
  if (found) throw new Error(`a frame shows the local text ${JSON.stringify(found)}: the walkthrough shows only sample data`);
}

export async function record({ theme = "dark", browserPath = process.env.BOARD_BROWSER_PATH, framesDir = null, out = OUT[theme] } = {}) {
  if (!OUT[theme]) throw new TypeError(`--theme is dark or light, not ${theme}`);
  const { ffmpeg, version } = ffmpegCommand();
  const { chromium } = createRequire(import.meta.url)("playwright");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-walkthrough-"))), frames = framesDir ? resolve(framesDir) : join(dir, "frames");
  const saved = Object.fromEntries(["SAGE_HOME", "SAGE_SHARED_HOME", "SAGE_WORKTREES"].map(name => [name, process.env[name]]));
  for (const name of Object.keys(saved)) process.env[name] = join(dir, name.toLowerCase());
  mkdirSync(frames, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  let server;
  try {
    writeTasksLogbook(join(dir, "logbooks"), process.env.SAGE_WORKTREES, new Date().toISOString(), { agents: true, about: true, prs: true, documents: true });
    const stateDir = join(dir, "board-state");
    mkdirSync(stateDir, { mode: 0o700 });
    server = createBoardServer({
      sources: [{ id: "shared", label: "Shared", path: join(dir, "logbooks") }],
      port: 0, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [], stateDir,
      pairCommand: "node <sage>/board/cli.mjs board --pair", write: job => answerInSample(job),
    });
    const base = `http://127.0.0.1:${(await server.start()).port}`;
    const context = await browser.newContext({ viewport: NARROWEST_WINDOW_WHERE_MILESTONE_NAMES_DO_NOT_WRAP_BY_LETTER, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await context.addInitScript(value => localStorage.setItem("board-theme", value), theme);
    const page = await context.newPage(), problems = [];
    page.on("pageerror", error => problems.push(String(error)));
    await page.goto(`${base}/app/#pair=${startLink(stateDir)}`);
    await page.getByText(/^This browser is paired\./).waitFor();
    const local = [dir, homedir(), ...[process.env.USER, process.env.LOGNAME].filter(name => name && name.length > 2)];
    const list = [];
    const shoot = async (caption, seconds, point = null) => {
      await page.waitForTimeout(350);
      await page.evaluate(OVERLAY, { caption, point });
      refuseLocalText(await page.evaluate(() => document.body.innerText), local);
      const file = join(frames, `${String(list.length).padStart(2, "0")}.png`);
      await page.screenshot({ path: file });
      list.push({ file, seconds });
    };
    await walk(page, base, shoot);
    if (problems.length) throw new Error(`the board page failed: ${problems.join("; ")}`);
    writeFileSync(join(frames, "frames.txt"), concatList(list));
    const target = join(ROOT, out);
    const encode = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frames, "frames.txt"),
      "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", target], { encoding: "utf8" });
    if (encode.status !== 0) throw new Error(`ffmpeg could not write ${out}: ${encode.stderr || encode.error}`);
    return { out, bytes: statSync(target).size, frames: list.length, seconds: list.reduce((sum, frame) => sum + frame.seconds, 0), ffmpeg: version };
  } finally {
    await browser.close();
    await server?.close();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const themes = option("--theme") ? [option("--theme")] : Object.keys(OUT);
  try {
    for (const theme of themes) {
      const framesDir = option("--frames") && join(option("--frames"), theme);
      const done = await record({ theme, browserPath: option("--browser") ?? process.env.BOARD_BROWSER_PATH, framesDir });
      console.log(`✓ ${done.out}: ${done.frames} frames, ${done.seconds.toFixed(1)} s, ${(done.bytes / 1e6).toFixed(2)} MB (${done.ffmpeg})`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
