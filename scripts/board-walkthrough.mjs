#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
export const TOUR = "docs/assets/board-tour.mp4";
export const VIEW = { width: 1320, height: 800 };
const FPS = 20, MARGIN = 28, BAR = 36, BAND = 52;
const CANVAS = { width: VIEW.width + 2 * MARGIN, height: VIEW.height + BAR + BAND + 2 * MARGIN };
const FFMPEG_HELP = "The walkthrough needs ffmpeg 6 or later to write the GIF and the video. Install it (macOS: brew install ffmpeg; Debian or Ubuntu: sudo apt-get install ffmpeg), or give its path in FFMPEG.";
const CAPTIONS = {
  1: ["1", "Overview", "where every task and milestone stands"],
  2: ["2", "Needs you", "the questions that wait for your answer"],
  3: ["3", "A task", "its state, its next step and its agents"],
};
export const TOUR_CAPTIONS = {
  1: ["1", "Overview", "where every task and milestone stands"],
  2: ["2", "Needs you", "the questions that wait for your answer"],
  3: ["3", "Sessions", "each chief's session: live, quiet or ended"],
  4: ["4", "Tasks", "every task, by milestone, priority, chief or state"],
  5: ["5", "A task", "its state, its next step and its agents"],
  6: ["6", "Agents", "each chief, its leads and their helpers, against the limits"],
  7: ["7", "Pull requests", "each open PR, by what happens next"],
  8: ["8", "Stats", "merged PRs, agent time and tokens of the last 8 weeks"],
  9: ["9", "Archive", "the projects that you put away, ready to restore"],
};
const THEMES = {
  dark: { bg: "#0d1117", bar: "#16161b", line: "#2c2c34", text: "#8e8e98", cursor: "#fff", outline: "#111", shadow: "" },
  light: { bg: "#ffffff", bar: "#f4f4f5", line: "#b8b8c0", text: "#63636d", cursor: "#111", outline: "#fff", shadow: "0 3px 14px rgba(0,0,0,.16)," },
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
  const { cam, cursor, ring, fade, colors } = st, dark = st.theme === "dark";
  if (st.scroll !== undefined) scrollTo(0, st.scroll);
  document.body.style.transformOrigin = "0 0";
  document.body.style.transform = cam.s === 1 && !cam.tx && !cam.ty ? "" : `translate(${cam.tx}px,${cam.ty}px) scale(${cam.s})`;
  const pointer = make("walk-cursor", `z-index:10003;left:${cursor.x - 3}px;top:${cursor.y - 2}px;width:28px;height:34px;transform:scale(${cursor.press ? 0.86 : 1});transform-origin:3px 2px`);
  if (!pointer.firstChild) pointer.innerHTML = `<svg viewBox="0 0 28 34" width="28" height="34"><path d="M3 2 L3 26 L9.5 20 L14 30.5 L18.4 28.6 L14 18.6 L22.6 18.6 Z" fill="${colors.cursor}" stroke="${colors.outline}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  make("walk-ring", ring ? `z-index:10002;left:${ring.x - ring.r}px;top:${ring.y - ring.r}px;width:${2 * ring.r}px;height:${2 * ring.r}px;border-radius:50%;border:3px solid rgba(${dark ? "154,162,255" : "79,70,229"},${ring.a});background:rgba(${dark ? "154,162,255" : "79,70,229"},${ring.a * 0.25})` : "display:none");
  const still = make("walk-fade", `left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;z-index:10010;opacity:${fade ? fade.a : 0}`, "img");
  if (fade && !still.src.endsWith(fade.src)) still.src = fade.src;
  return fade ? still.complete : true;
};

const FONT = "ui-sans-serif,-apple-system,system-ui,sans-serif";
const SAMPLE = dark => `padding:5px 10px;border-radius:999px;font:600 12px/1.2 ${FONT};letter-spacing:.02em;background:${dark ? "#3a1f0a" : "#fdf3e1"};color:${dark ? "#fbbf24" : "#8f5106"};border:1px solid ${dark ? "#6b4210" : "#f0d29a"}`;
const WINDOW = ({ c, dark }) => `<body style="margin:0;background:transparent">
  <div style="position:absolute;left:${MARGIN - 1}px;top:${MARGIN - 1}px;width:${VIEW.width}px;height:${VIEW.height + BAR + BAND}px;border:1px solid ${c.line};border-radius:12px;box-shadow:${c.shadow}0 0 0 3000px ${c.bg};overflow:hidden">
    <div style="height:${BAR}px;background:${c.bar};border-bottom:1px solid ${c.line};box-sizing:border-box;display:flex;align-items:center;padding:0 14px;gap:8px;position:relative">
      <i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i>
      <span style="position:absolute;left:0;right:0;text-align:center;font:500 13px/1 ${FONT};color:${c.text}">sage board</span>
      <span style="position:absolute;right:12px;${SAMPLE(dark)}">SAMPLE DATA</span>
    </div>
  </div></body>`;

const BAND_PAGE = ({ c }) => `<body style="margin:0;height:${BAND}px;box-sizing:border-box;background:${c.bar};border-top:1px solid ${c.line};display:flex;align-items:center;justify-content:center;overflow:hidden"><div id="cap"></div></body>`;
const CAPTION = ({ cap, dark }) => {
  const el = document.getElementById("cap"), font = "ui-sans-serif,-apple-system,system-ui,sans-serif";
  el.style.cssText = `display:flex;align-items:center;gap:10px;white-space:nowrap;font:500 16px/1.2 ${font};color:${dark ? "#ededf0" : "#18181b"};opacity:${cap.a};transform:translateY(${(1 - cap.a) * 6}px)`;
  const [n, label, text] = cap.parts, part = (tag, value, css) => Object.assign(document.createElement(tag), { textContent: value, style: css });
  el.replaceChildren(
    part("span", n, `display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-weight:650;font-size:13px;background:${dark ? "#9aa2ff" : "#4f46e5"};color:${dark ? "#0b0b10" : "#fff"}`),
    part("b", label, "font-weight:650"), part("span", text, `color:${dark ? "#a3a3ad" : "#52525b"}`));
};

function writePickupSample(logbooks, now) {
  const file = join(logbooks, "sample-app-abc123", "decisions.tsv"), at = new Date(Date.parse(now) - 3 * 3_600_000).toISOString();
  const [head, ...rows] = readFileSync(file, "utf8").trimEnd().split("\n"), columns = [...head.split("\t"), "handover"];
  const handover = { from: "C3", to: "C1", fromProvider: "claude", toProvider: "claude", reason: "no heartbeat", since: at, tasks: ["T4", "T21"], lost: ["R12"], queued: [], gates: [] };
  const pickup = { at, task: "", decision: "pick-up from C3 (claude) to C1: tasks T4, T21; lost runs R12; its session stopped (no heartbeat)", why: "pick-up", handover: JSON.stringify(handover) };
  writeFileSync(file, [columns.join("\t"), ...rows.map(row => `${row}\t`), columns.map(column => pickup[column] ?? "").join("\t")].join("\n") + "\n");
}

const ARCHIVED = { folder: "sample-notes-d4e5f6", name: "Sample notes" };
function writeArchivedSample(logbooks, now) {
  const dir = join(logbooks, ARCHIVED.folder), from = join(logbooks, "sample-app-abc123"), daysAgo = days => new Date(Date.parse(now) - days * 86_400_000).toISOString();
  const rows = {
    tasks: [{ id: "T1", title: "Sample export notes", size: "small", route: "build,code-review,qa", state: "merged", round: "0", priority: "P2", chief: "C1" }],
    decisions: [{ at: daysAgo(12), task: "T1", decision: "state merged", why: "sample" }, { at: daysAgo(5), task: "", decision: "project archived", why: "sample" }],
  };
  mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: ARCHIVED.name, archived: true }));
  for (const file of readdirSync(from).filter(name => name.endsWith(".tsv"))) {
    const columns = readFileSync(join(from, file), "utf8").split("\n")[0].split("\t");
    writeFileSync(join(dir, file), [columns, ...(rows[file.slice(0, -4)] ?? []).map(row => columns.map(column => row[column] ?? ""))].map(line => line.join("\t")).join("\n") + "\n");
  }
}

function director(page, shot, st) {
  const play = async (seconds, step = () => {}) => {
    const count = Math.max(1, Math.round(seconds * st.fps));
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
  const caption = async parts => {
    await play(0.125, p => { st.cap.a = 1 - p; });
    st.cap.parts = parts;
    await play(0.125, p => { st.cap.a = p; });
  };
  return { play, box, moveCamera, moveCursor, caption };
}

async function film(page, base, shot, st) {
  const files = new Map(), { play, box, moveCamera, moveCursor, caption: show } = director(page, shot, st), caption = key => show(CAPTIONS[key]);
  await page.context().route(`${base}/__walk/*`, route => route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(files.get(new URL(route.request().url()).pathname.split("/").pop())) }));

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
  await play(0.6, p => {
    st.fade.a = ease(p);
    st.cap = p < 0.5 ? { parts: CAPTIONS[3], a: 1 - 2 * p } : { parts: CAPTIONS[1], a: 2 * p - 1 };
  });
}

async function tourFilm(page, base, shot, st) {
  const { play, box, moveCamera, moveCursor, caption } = director(page, shot, st), whole = { s: 1, tx: 0, ty: 0 };
  const centre = r => ({ x: r.x + Math.min(r.w / 2, 60), y: r.y + r.h / 2 + 3 });
  const click = async (locator, then) => {
    await moveCursor(centre(await box(locator)), 0.7);
    await play(0.15);
    st.cursor.press = true; st.ring = { x: st.cursor.x, y: st.cursor.y, r: 8, a: 0.9 };
    await shot();
    st.cursor.press = false;
    await locator.click();
    await then();
    st.scroll = 0;
    await page.waitForTimeout(300);
    const at = { ...st.ring };
    await play(0.35, p => { st.ring = { x: at.x, y: at.y, r: mix(8, 30, p), a: 0.9 * (1 - p) }; });
    st.ring = null;
  };
  const visit = async (locator, heading, key) => {
    await click(locator, () => page.locator("main h1", { hasText: heading }).first().waitFor());
    await caption(TOUR_CAPTIONS[key]);
  };
  const scroll = (to, seconds) => { const from = st.scroll; return play(seconds, p => { st.scroll = mix(from, to, ease(p)); }); };
  const zoomOn = async (locator, key) => {
    await caption(TOUR_CAPTIONS[key]);
    await moveCamera(camera(await box(locator), 1.4), 0.9);
    await play(2.6);
    await moveCamera(whole, 0.7);
  };
  const nav = hash => page.locator(`nav a[href="#${hash}"]`);

  await page.goto(`${base}/app/`);
  await page.locator("main h1", { hasText: "Overview" }).first().waitFor();
  await page.mouse.move(-10, -10);
  await page.waitForTimeout(500);
  st.scroll = 0;
  await play(2.5);
  await zoomOn(page.locator("section.card", { has: page.locator("#needs-h") }), 2);
  await zoomOn(page.locator("section.card.sessions"), 3);

  await visit(nav("tasks"), "Tasks", 4);
  await play(2);
  await scroll(320, 1.6);
  await play(1.5);
  await visit(page.locator("main a", { hasText: "Sample sync design" }).first(), "Sample sync design", 5);
  await play(3.5);

  await visit(nav("agents"), "Agents", 6);
  await play(2);
  await scroll(420, 1.8);
  await play(2);
  await visit(nav("pull-requests"), "Pull requests", 7);
  await play(3.5);
  await visit(nav("stats"), "Stats", 8);
  await play(2);
  await scroll(360, 1.6);
  await play(2);

  await click(nav(""), () => page.locator("main h1", { hasText: "Overview" }).first().waitFor());
  await caption(TOUR_CAPTIONS[9]);
  await click(page.locator("header .picker"), () => page.locator("summary", { hasText: "Archived" }).waitFor());
  await click(page.locator("summary", { hasText: "Archived" }), () => page.getByText(ARCHIVED.name).first().waitFor());
  await play(1.5);
  await click(page.getByText(ARCHIVED.name).first(), () => page.locator("header .picker", { hasText: "archived" }).waitFor());
  await play(3.5);
}

export function encode({ ffmpeg, fps = FPS, tour, frames, window, captions, out }) {
  const frame = `[0]pad=${CANVAS.width}:${CANVAS.height}:${MARGIN}:${MARGIN + BAR}[page];[page][2]overlay=${MARGIN}:${MARGIN + BAR + VIEW.height}[band];[band][1]overlay=shortest=1`;
  const encoding = tour
    ? ["-filter_complex", `${frame},format=yuv420p`, "-c:v", "libx264", "-preset", "veryslow", "-crf", "30", "-tune", "stillimage", "-movflags", "+faststart", "-an", out]
    : ["-filter_complex", `${frame},split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", out];
  const noRestartOnRgbaFrame = folder => ["-reinit_filter", "0", "-framerate", String(fps), "-i", join(folder, "%04d.png")];
  const done = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...noRestartOnRgbaFrame(frames), "-loop", "1", "-framerate", String(fps), "-i", window, ...noRestartOnRgbaFrame(captions), ...encoding], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`ffmpeg could not write ${out}: ${done.stderr || done.error}`);
}

export async function record({ theme = "dark", tour = false, fps = FPS, browserPath = process.env.BOARD_BROWSER_PATH, framesDir = null, out = tour ? TOUR : OUT[theme] } = {}) {
  if (!OUT[theme]) throw new TypeError(`--theme is dark or light, not ${theme}`);
  if (tour && theme !== "dark") throw new TypeError(`the tour is dark only, so it records no ${theme} video: leave out --theme with --tour, or record the ${theme} GIF without --tour`);
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
    await windowPage.setContent(WINDOW({ c: THEMES[theme], dark: theme === "dark" }));
    await windowPage.screenshot({ path: join(dir, "window.png"), omitBackground: true });
    await windowPage.close();
    const band = await browser.newPage({ viewport: { width: VIEW.width, height: BAND }, deviceScaleFactor: 1 }), caps = join(dir, "captions");
    await band.setContent(BAND_PAGE({ c: THEMES[theme] }));
    mkdirSync(caps);

    const now = new Date().toISOString();
    writeTasksLogbook(join(dir, "logbooks"), process.env.SAGE_WORKTREES, now, { agents: true, about: true, prs: true, documents: true });
    if (tour) { writeArchivedSample(join(dir, "logbooks"), now); writePickupSample(join(dir, "logbooks"), now); }
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
    const st = { theme, fps, colors: THEMES[theme], cam: { s: 1, tx: 0, ty: 0 }, cursor: { x: 1180, y: 560, press: false }, ring: null, cap: { parts: CAPTIONS[1], a: 1 }, fade: null };
    let count = 0, lastCap = null;
    const scenes = [];
    const shot = async () => {
      if (!await page.evaluate(DRAW, st)) await page.waitForFunction(() => document.getElementById("walk-fade").complete);
      const seen = await page.evaluate(() => ({ text: document.body.innerText, heading: document.querySelector("main h1")?.textContent ?? "", project: document.querySelector("header .picker")?.textContent ?? "" }));
      refuseLocalText(seen.text, local);
      const scene = { caption: st.cap.parts[1], heading: seen.heading, project: seen.project };
      if (JSON.stringify(scene) !== JSON.stringify(scenes.at(-1))) scenes.push(scene);
      const name = `${String(count++).padStart(4, "0")}.png`, file = join(frames, name), cap = JSON.stringify(st.cap);
      await page.screenshot({ path: file });
      if (cap === lastCap?.cap) copyFileSync(lastCap.file, join(caps, name));
      else { await band.evaluate(CAPTION, { cap: st.cap, dark: theme === "dark" }); await band.screenshot({ path: join(caps, name) }); lastCap = { cap, file: join(caps, name) }; }
      return file;
    };
    await (tour ? tourFilm : film)(page, base, shot, st);
    if (problems.length) throw new Error(`the board page failed: ${problems.join("; ")}`);
    const target = resolve(ROOT, out);
    encode({ ffmpeg, fps, tour, frames, window: join(dir, "window.png"), captions: caps, out: target });
    return { out, bytes: statSync(target).size, frames: count, seconds: count / fps, ffmpeg: version, scenes };
  } finally {
    await browser.close();
    await server?.close();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const tour = args.includes("--tour"), themes = tour ? [option("--theme") ?? "dark"] : option("--theme") ? [option("--theme")] : Object.keys(OUT);
  try {
    for (const theme of themes) {
      const framesDir = option("--frames") && join(option("--frames"), tour ? "tour" : theme);
      const done = await record({ theme, tour, browserPath: option("--browser") ?? process.env.BOARD_BROWSER_PATH, framesDir });
      console.log(`✓ ${done.out}: ${done.frames} frames, ${done.seconds.toFixed(2)} s at ${FPS} fps, ${(done.bytes / 1e6).toFixed(2)} MB (${done.ffmpeg})`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
