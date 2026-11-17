#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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
export const VIEW = { width: 1320, height: 800 };
const FPS = 20, MARGIN = 28, BAR = 36;
const CANVAS = { width: VIEW.width + 2 * MARGIN, height: VIEW.height + BAR + 2 * MARGIN };
const FFMPEG_HELP = "The walkthrough needs ffmpeg 6 or later to write the GIF. Install it (macOS: brew install ffmpeg; Debian or Ubuntu: sudo apt-get install ffmpeg), or give its path in FFMPEG.";
const CAPTIONS = {
  1: ["1", "Overview", "where every task and milestone stands"],
  2: ["2", "Needs you", "the questions that wait for your answer"],
  3: ["3", "A task", "its state, its next step and its agents"],
};
const THEMES = {
  dark: { bg: "#0d1117", bar: "#16161b", line: "#2c2c34", text: "#8e8e98", cursor: "#fff", outline: "#111" },
  light: { bg: "#ffffff", bar: "#f4f4f5", line: "#d4d4d8", text: "#63636d", cursor: "#111", outline: "#fff" },
};

export function ffmpegCommand(env = process.env) {
  const ffmpeg = env.FFMPEG || "ffmpeg", probe = spawnSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) throw new Error(`${FFMPEG_HELP} (${ffmpeg}: ${probe.error?.code ?? `exit ${probe.status}`})`);
  const major = Number(/^ffmpeg version n?(\d+)\./.exec(probe.stdout)?.[1]);
  if (!(major >= 6)) throw new Error(`${FFMPEG_HELP} (${ffmpeg} says: ${probe.stdout.split("\n")[0]})`);
  return { ffmpeg, version: probe.stdout.split("\n")[0] };
}

export function refuseLocalText(text, words) {
  const found = words.find(word => text.includes(word));
  if (found) throw new Error(`a frame shows the local text ${JSON.stringify(found)}: the walkthrough shows only sample data`);
}

export function camera(rect, scale, view = VIEW) {
  const at = (size, centre) => Math.min(0, Math.max(size * (1 - scale), size / 2 - scale * centre));
  return { s: scale, tx: at(view.width, rect.x + rect.w / 2), ty: at(view.height, rect.y + rect.h / 2) };
}

const ease = p => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
const mix = (a, b, p) => a + (b - a) * p;
const onScreen = (cam, point) => ({ x: cam.s * point.x + cam.tx, y: cam.s * point.y + cam.ty });

const DRAW = st => {
  const make = (id, css, tag = "div") => {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement(tag); el.id = id; document.documentElement.append(el); }
    el.style.cssText = `position:fixed;pointer-events:none;${css}`;
    return el;
  };
  const { cam, cursor, ring, cap, fade, colors } = st, dark = st.theme === "dark";
  document.body.style.transformOrigin = "0 0";
  document.body.style.transform = cam.s === 1 && !cam.tx && !cam.ty ? "" : `translate(${cam.tx}px,${cam.ty}px) scale(${cam.s})`;
  const pointer = make("walk-cursor", `z-index:10003;left:${cursor.x - 3}px;top:${cursor.y - 2}px;width:28px;height:34px;transform:scale(${cursor.press ? 0.86 : 1});transform-origin:3px 2px`);
  if (!pointer.firstChild) pointer.innerHTML = `<svg viewBox="0 0 28 34" width="28" height="34"><path d="M3 2 L3 26 L9.5 20 L14 30.5 L18.4 28.6 L14 18.6 L22.6 18.6 Z" fill="${colors.cursor}" stroke="${colors.outline}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  make("walk-ring", ring ? `z-index:10002;left:${ring.x - ring.r}px;top:${ring.y - ring.r}px;width:${2 * ring.r}px;height:${2 * ring.r}px;border-radius:50%;border:3px solid rgba(${dark ? "154,162,255" : "79,70,229"},${ring.a});background:rgba(${dark ? "154,162,255" : "79,70,229"},${ring.a * 0.25})` : "display:none");
  const font = "ui-sans-serif,-apple-system,system-ui,sans-serif";
  const caption = make("walk-caption", `z-index:10001;left:50%;bottom:22px;transform:translateX(-50%) translateY(${(1 - cap.a) * 6}px);opacity:${cap.a};display:flex;align-items:center;gap:10px;padding:9px 16px 9px 10px;border-radius:999px;white-space:nowrap;font:500 16px/1.2 ${font};background:${dark ? "rgba(24,24,30,.94)" : "rgba(255,255,255,.96)"};color:${dark ? "#ededf0" : "#18181b"};border:1px solid ${dark ? "#34343e" : "#d4d4d8"};box-shadow:0 6px 24px rgba(0,0,0,${dark ? 0.45 : 0.12})`);
  if (caption.dataset.key !== cap.parts[0]) {
    caption.dataset.key = cap.parts[0];
    const [n, label, text] = cap.parts, part = (tag, value, css) => Object.assign(document.createElement(tag), { textContent: value, style: css });
    caption.replaceChildren(
      part("span", n, `display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-weight:650;font-size:13px;background:${dark ? "#9aa2ff" : "#4f46e5"};color:${dark ? "#0b0b10" : "#fff"}`),
      part("b", label, "font-weight:650"), part("span", text, `color:${dark ? "#a3a3ad" : "#52525b"}`));
  }
  make("walk-sample", `z-index:10001;right:16px;bottom:24px;padding:5px 10px;border-radius:999px;font:600 12px/1.2 ${font};letter-spacing:.02em;background:${dark ? "#3a1f0a" : "#fdf3e1"};color:${dark ? "#fbbf24" : "#8f5106"};border:1px solid ${dark ? "#6b4210" : "#f0d29a"}`).textContent = "SAMPLE DATA";
  const still = make("walk-fade", `left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;z-index:10010;opacity:${fade ? fade.a : 0}`, "img");
  if (fade && !still.src.endsWith(fade.src)) still.src = fade.src;
  return fade ? still.complete : true;
};

const WINDOW = ({ c, view, margin, bar }) => `<body style="margin:0;background:transparent">
  <div style="position:absolute;left:${margin - 1}px;top:${margin - 1}px;width:${view.width}px;height:${view.height + bar}px;border:1px solid ${c.line};border-radius:12px;box-shadow:0 0 0 3000px ${c.bg};overflow:hidden">
    <div style="height:${bar}px;background:${c.bar};border-bottom:1px solid ${c.line};box-sizing:border-box;display:flex;align-items:center;padding:0 14px;gap:8px;position:relative">
      <i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i>
      <span style="position:absolute;left:0;right:0;text-align:center;font:500 13px/1 -apple-system,system-ui,sans-serif;color:${c.text}">sage board · sample data</span>
    </div>
  </div></body>`;

async function film(page, base, shot, st) {
  const files = new Map();
  await page.context().route(`${base}/__walk/*`, route => route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(files.get(new URL(route.request().url()).pathname.split("/").pop())) }));
  const play = async (seconds, step = () => {}) => {
    const count = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= count; i++) { step(i / count); await shot(); }
  };
  const box = async locator => { const r = await locator.boundingBox(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const moveCamera = (to, seconds, also = () => {}) => {
    const from = { ...st.cam };
    return play(seconds, p => { const e = ease(p); st.cam = { s: mix(from.s, to.s, e), tx: mix(from.tx, to.tx, e), ty: mix(from.ty, to.ty, e) }; also(e); });
  };
  const moveCursor = (to, seconds) => {
    const from = { ...st.cursor };
    return play(seconds, p => { const e = ease(p); st.cursor.x = mix(from.x, to.x, e); st.cursor.y = mix(from.y, to.y, e) - Math.sin(Math.PI * e) * 18; });
  };
  const caption = async key => {
    await play(0.125, p => { st.cap.a = 1 - p; });
    st.cap.parts = CAPTIONS[key];
    await play(0.125, p => { st.cap.a = p; });
  };

  await page.goto(`${base}/app/`);
  await page.locator("main h1", { hasText: "Overview" }).first().waitFor();
  await page.mouse.move(-10, -10);
  await page.waitForTimeout(500);
  const needs = await box(page.locator("section, div", { has: page.locator("h2", { hasText: "Needs you" }) }).filter({ hasText: "Can a viewer copy" }).last());
  const question = await box(page.locator("main a", { hasText: "Can a viewer copy a shared list" }).first());
  const taskLink = page.locator("main a", { hasText: "T10 · Sample sync design" }).first(), link = await box(taskLink);
  files.set("first.png", await shot());

  await play(1.0);
  const onNeeds = camera(needs, 1.45);
  await caption(2);
  const q = onScreen(onNeeds, { x: question.x + 40, y: question.y + question.h / 2 + 4 }), start = { ...st.cursor };
  await moveCamera(onNeeds, 0.9, e => { st.cursor.x = mix(start.x, q.x, e * 0.35); st.cursor.y = mix(start.y, q.y, e * 0.35); });
  await moveCursor(q, 0.45);
  await play(1.1);
  await moveCursor(onScreen(onNeeds, { x: link.x + link.w * 0.45, y: link.y + link.h / 2 + 3 }), 0.6);
  await play(0.2);
  st.cursor.press = true; st.ring = { x: st.cursor.x, y: st.cursor.y, r: 8, a: 0.9 };
  await shot();
  st.cursor.press = false;
  files.set("before.png", await shot());

  await taskLink.click();
  const heading = page.locator("main h1", { hasText: "Sample sync design" });
  await heading.waitFor();
  await page.waitForTimeout(300);
  const clicked = { ...st.cursor }, from = { x: link.x + link.w * 0.45, y: 150 };
  st.cam = { s: 1, tx: 0, ty: 0 };
  Object.assign(st.cursor, from);
  st.fade = { src: `${base}/__walk/before.png`, a: 1 };
  st.cap.parts = CAPTIONS[3];
  await play(0.35, p => { st.fade.a = 1 - ease(p); st.ring = { x: clicked.x, y: clicked.y, r: mix(8, 30, p), a: 0.9 * (1 - p) }; });
  st.fade = null; st.ring = null;
  const head = await box(heading), meta = await box(page.getByText(/^At work now/i).first());
  const pill = await box(page.locator("main").getByText("needs you", { exact: true }).first());
  await play(0.5);
  const onTask = camera({ x: head.x - 10, y: head.y - 30, w: 860, h: meta.y + meta.h - head.y + 40 }, 1.4);
  const to = onScreen(onTask, { x: pill.x + pill.w * 0.5, y: pill.y + pill.h + 8 });
  await moveCamera(onTask, 0.9, e => { st.cursor.x = mix(from.x, to.x, e); st.cursor.y = mix(from.y, to.y, e); });
  await play(1.6);

  st.fade = { src: `${base}/__walk/first.png`, a: 0 };
  await play(0.6, p => { st.fade.a = ease(p); });
}

export async function record({ theme = "dark", browserPath = process.env.BOARD_BROWSER_PATH, framesDir = null, out = OUT[theme] } = {}) {
  if (!OUT[theme]) throw new TypeError(`--theme is dark or light, not ${theme}`);
  const { ffmpeg, version } = ffmpegCommand();
  const { chromium } = createRequire(import.meta.url)("playwright");
  if (framesDir) {
    mkdirSync(framesDir, { recursive: true });
    if (readdirSync(framesDir).length) throw new Error(`--frames needs a new or empty folder, so that the GIF takes only this run's frames: ${framesDir} is not empty`);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-walkthrough-"))), frames = framesDir ? resolve(framesDir) : join(dir, "frames");
  const saved = Object.fromEntries(["SAGE_HOME", "SAGE_SHARED_HOME", "SAGE_WORKTREES"].map(name => [name, process.env[name]]));
  for (const name of Object.keys(saved)) process.env[name] = join(dir, name.toLowerCase());
  mkdirSync(frames, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  let server;
  try {
    const windowPage = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1 });
    await windowPage.setContent(WINDOW({ c: THEMES[theme], view: VIEW, margin: MARGIN, bar: BAR }));
    await windowPage.screenshot({ path: join(dir, "window.png"), omitBackground: true });
    await windowPage.close();

    writeTasksLogbook(join(dir, "logbooks"), process.env.SAGE_WORKTREES, new Date().toISOString(), { agents: true, about: true, prs: true, documents: true });
    const stateDir = join(dir, "board-state");
    mkdirSync(stateDir, { mode: 0o700 });
    server = createBoardServer({
      sources: [{ id: "shared", label: "Shared", path: join(dir, "logbooks") }],
      port: 0, app: loadBoardApp(join(ROOT, "plugins/sage/board/app")), settleReads: [], stateDir,
      pairCommand: "node <sage>/board/cli.mjs board --pair", write: () => ({ code: 1, text: "The walkthrough sample records no writes." }),
    });
    const base = `http://127.0.0.1:${(await server.start()).port}`;
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.route("**/*", route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await context.addInitScript(value => localStorage.setItem("board-theme", value), theme);
    const page = await context.newPage(), problems = [];
    page.on("pageerror", error => problems.push(String(error)));
    await page.goto(`${base}/app/#pair=${startLink(stateDir)}`);
    await page.getByText(/^This browser is paired\./).waitFor();
    const local = [dir, homedir(), ...[process.env.USER, process.env.LOGNAME].filter(name => name && name.length > 2)];
    const st = { theme, colors: THEMES[theme], cam: { s: 1, tx: 0, ty: 0 }, cursor: { x: 1180, y: 560, press: false }, ring: null, cap: { parts: CAPTIONS[1], a: 1 }, fade: null };
    let count = 0;
    const shot = async () => {
      if (!await page.evaluate(DRAW, st)) await page.waitForFunction(() => document.getElementById("walk-fade").complete);
      refuseLocalText(await page.evaluate(() => document.body.innerText), local);
      const file = join(frames, `${String(count++).padStart(4, "0")}.png`);
      await page.screenshot({ path: file });
      return file;
    };
    await film(page, base, shot, st);
    if (problems.length) throw new Error(`the board page failed: ${problems.join("; ")}`);
    const target = join(ROOT, out);
    const encode = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frames, "%04d.png"), "-i", join(dir, "window.png"),
      "-filter_complex", `[0]pad=${CANVAS.width}:${CANVAS.height}:${MARGIN}:${MARGIN + BAR}[page];[page][1]overlay,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      "-loop", "0", target], { encoding: "utf8" });
    if (encode.status !== 0) throw new Error(`ffmpeg could not write ${out}: ${encode.stderr || encode.error}`);
    return { out, bytes: statSync(target).size, frames: count, seconds: count / FPS, ffmpeg: version };
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
      console.log(`✓ ${done.out}: ${done.frames} frames, ${done.seconds.toFixed(2)} s at ${FPS} fps, ${(done.bytes / 1e6).toFixed(2)} MB (${done.ffmpeg})`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
