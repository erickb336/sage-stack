import { readFileSync, watch } from "node:fs";
import { createServer } from "node:http";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { sharedRoot, BOARD_PORT, WORDS_MAX } from "../core/index.mjs";
import { COOKIE, boardAccess } from "./access.mjs";
import { pagesRequest, servePages } from "./pages.mjs";
import { GATE, LOGBOOK, serve } from "./thread.mjs";
import { ARCHIVE_JOBS, writeInWorker, writesEnded } from "./writes.mjs";

const MARKDOWN = await import("./markdown.mjs").then(module => module.renderMarkdown, () => null);
const NO_READER = "The reader's Markdown renderer is not in this copy of the board. Run the board from the sage plugin, or run npm ci and npm run build.";

const MAX_MODEL = 8 * 1024 * 1024;
const megabytes = bytes => `${Math.round(bytes / 104857.6) / 10} MB`;
const TOO_BIG = (size, limit) => `The board could not send its newest read: its data is ${megabytes(size)}, and the limit is ${megabytes(limit)}. The page shows the last read that fit. Ask the chief to look, or archive a project that has many old tasks.`;
const MAX_CLIENTS = 16;
const own = (object, name) => Object.hasOwn(object, name);
const SETTLE_READS = [250, 1000, 3000, 7000, 15000];
const LIGHT_EVERY = 2000;
const BOOK = /^[a-z0-9-]+-[0-9a-f]{6}$/;
const READING = "Reading the logbooks. The board answers when its first read ends.";
const READING_AGAIN = "The board is reading again. Try again in a moment.";
const RESTARTS = 3, RESTART_WINDOW = 5 * 60_000, RESTART_WAIT = 30_000;
const RESTARTING = "The board's reading threads stopped 3 times in 5 minutes, so the board waits 30 seconds before it starts a stopped thread again. The lists show the last finished read. Until the next read ends, a task or question page can say that the board is reading again.";

function oneHeader(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : values.length ? null : undefined;
}

function taskKey(encoded) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    const key = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.toString("base64url") === encoded && !/[\x00-\x1f\x7f]/.test(key) ? key : null;
  } catch { return null; }
}

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

const ANSWER_TO_THE_BOARD_PROBE_OF_ANY_PLUGIN = [200, { "Content-Type": "text/html; charset=utf-8" }], SEND_THE_BROWSER_TO_THE_APP = [302, { Location: "/app/" }];
const APP_DIR = fileURLToPath(new URL("./app/", import.meta.url));
const APP_FILE = /^(?:app|vendor|graph)-[A-Z0-9]{8}\.(?:js|css)$/;
const APP_TYPES = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const NO_APP = "The board app is not built in this copy of the board. npm run build writes it only into the plugins, so start the board from the sage plugin's board/cli.mjs.";

export function loadBoardApp(dir = APP_DIR) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { return null; }
  const names = [manifest?.script, manifest?.style, manifest?.vendor, manifest?.graph];
  if (!names.every(name => typeof name === "string" && APP_FILE.test(name)) || !manifest.script.endsWith(".js") || !manifest.style.endsWith(".css") || !manifest.vendor.endsWith(".js") || !manifest.graph.endsWith(".js")) return null;
  let files;
  try { files = new Map(names.map(name => [name, { type: APP_TYPES[name.split(".").pop()], body: readFileSync(join(dir, name)) }])); } catch { return null; }
  const shell = (writes = "off", pair = null) => `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="sage-writes" content="${writes}">${pair ? `<meta name="sage-pair" content="${pair.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)}">` : ""}<title>Sage board</title><link rel="stylesheet" href="/app/${manifest.style}"><link rel="modulepreload" href="/app/${manifest.vendor}"><script type="module" src="/app/${manifest.script}"></script></head><body><div id="root"></div><noscript><p>This board needs scripts. The board in the chat needs none: send a message that starts with "show board".</p></noscript></body></html>`;
  return { files, shell };
}

function appPolicy(origin) {
  return `default-src 'none'; script-src ${origin}/app/; style-src ${origin}/app/; connect-src 'self'; img-src 'self'; frame-src ${origin}/read/ ${origin}/pages/; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`;
}

const RETIRED_STREAM = `retry: 86400000\nevent: board\ndata: ${JSON.stringify({ stale: true, html: '<div id="board-content" data-at="before the board\'s update"><p><b>The board was updated, and this old page no longer updates.</b> <a href="/app/">Open the new board</a>.</p></div>' })}\n\n`;

const forwarded = name => name === "forwarded" || name.startsWith("x-forwarded-");

const BODY_MAX = 16 * 1024;
const PAIR_AGAIN = "To pair it, type show board in a chief's chat, and click the link that it sends; or use the Terminal code of the pairing card.";
const HEADERS_MAX = 64 * 1024;
const TASK = /^T[1-9]\d*$/, CHIEF = /^C[1-9]\d*$/;
const JOBS = {
  answer: body => GATE.test(body.gate) && Number.isInteger(body.option) && body.option >= 1 && body.option <= 99 && /^[0-9a-f]{16}$/.test(body.digest ?? "") && (body.words === undefined || typeof body.words === "string" && [...body.words].length <= WORDS_MAX)
    && ["gate", "answer", body.gate, "--via", "board", "--option", String(body.option), ...(body.words?.trim() ? ["--other-hex", Buffer.from(body.words, "utf8").toString("hex")] : []), "--seen", body.digest],
  undo: body => GATE.test(body.gate) && ["gate", "undo", body.gate],
  give: body => TASK.test(body.task) && CHIEF.test(body.to) && ["gate", "give", body.task, "--to", body.to],
  name: body => CHIEF.test(body.chief) && typeof body.name === "string" && body.name.length <= 240 && ["chief", "name", body.chief, ...(body.name.trim() ? [body.name.trim()] : [])],
};
const LOCAL_PATH = /(?<![\w.~/-])~?\/(?!\/[^/])[^\s"'`]+(?:(?: [^\s"'`/]+){0,3} [^\s"'`/]+\/[^\s"'`]*)*/g;
export const withoutPaths = text => text.replace(LOCAL_PATH, path => `…/${basename(path)}`);

function json(response, status, body, headers = {}) {
  const text = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": text.length, ...headers });
  response.end(text);
}
const broken = error => `The board could not do this on this Mac (${/^E[A-Z]+$/.test(error?.code ?? "") ? error.code : "an error"}), so nothing changed. Check that the board's state folder, beside its board.json, is an ordinary folder that can be written, and that the disk has space.`;

function jsonBody(request) {
  return new Promise((accept, reject) => {
    const parts = []; let size = 0;
    request.on("data", part => { size += part.length; if (size > BODY_MAX) { reject(new Error("too large")); request.destroy(); } else parts.push(part); });
    request.on("end", () => { try { const value = JSON.parse(Buffer.concat(parts).toString("utf8")); value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string" || typeof item === "number") ? accept(value) : reject(new Error("not an object")); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

export function createBoardServer({ sources, port = BOARD_PORT, id, clock = null, settleReads = SETTLE_READS, lightEvery = LIGHT_EVERY, duringRead = null, holds = null, providerRoots = [], app = loadBoardApp(), reader = MARKDOWN !== null, stateDir = null, pairCommand = null, write = writeInWorker, onStop = null, onWatch = null, maxModel = MAX_MODEL } = {}) {
  if (!Number.isSafeInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new TypeError("board port must be an integer from 1024 through 65535, or 0 for a free port that the system picks");
  if (clock !== null && typeof clock !== "function") throw new TypeError("the board clock must be a function that gives an ISO time");
  if (!Number.isSafeInteger(maxModel) || maxModel < 1) throw new TypeError("the board's model limit must be a positive number of bytes");
  if (holds !== null && !(holds instanceof Int32Array && holds.buffer instanceof SharedArrayBuffer && holds.length >= 4)) throw new TypeError("the board's holds must be an Int32Array of 4 or more on a SharedArrayBuffer");
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("board needs 1 to 32 explicit sources");
  const ids = new Set();
  const configured = Array.from(sources, source => {
    if (!source || !own(source, "id") || !own(source, "path") || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) throw new TypeError("board sources need unique ids and absolute normalized paths");
    for (const key of ["label", "provider"]) if (own(source, key) && (typeof source[key] !== "string" || source[key].length > 160 || /[\x00-\x1f\x7f]/.test(source[key]))) throw new TypeError("invalid board source label");
    ids.add(source.id);
    return Object.freeze({ id: source.id, path: source.path, ...(own(source, "label") ? { label: source.label } : {}), ...(own(source, "provider") ? { provider: source.provider } : {}) });
  });
  if (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{16,64}$/.test(id))) throw new TypeError("the board id must be 16 to 64 lowercase hex characters");
  const local = new Set(), origins = new Map();
  let boardHeader = null;
  if (stateDir && (typeof pairCommand !== "string" || !pairCommand || /[\x00-\x1f\x7f]/.test(pairCommand))) throw new TypeError("a board that takes writes needs the pairing command that the owner runs in Terminal");
  const access = stateDir ? boardAccess(stateDir) : null;
  const watchers = new Map(), watchErrors = new Map(), clients = new Set(), pending = new Map();
  let refreshTimer, boundaryTimer, settleTimer, startPromise, closePromise, closed = false;
  let lightTimer, lightAt = 0, activity = new Map(), archiving = Promise.resolve();
  const dirty = { hooks: new Set(), books: new Set(), folders: false };
  let modelEvent = null, modelSize = 0, modelSent = null, stats = null, facts = null, revision = 0, shownSeq = 0, notice = null, noticeTimer;
  const boards = [null, null], threadOptions = { configured, providerRoots, reader, holds, walks: new Int32Array(new SharedArrayBuffer(4)) };
  let light = null, answering = null, answeringGood = false, building = null, again = false, changingShown = false;
  let planShown = 0, publishes = 0, asks = 0, hooks = {}, lastSeed = null, stops = [];
  let readyAccept, readyReject;
  const idlers = [];
  const readyPromise = new Promise((accept, reject) => { readyAccept = accept; readyReject = reject; });
  readyPromise.catch(() => {});

  function onMac(request) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) || !local.has(oneHeader(request, "host").toLowerCase())) return false;
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (forwarded(request.rawHeaders[i].toLowerCase())) return false;
    return true;
  }

  function browserBoundary(request) {
    const host = oneHeader(request, "host"), origin = oneHeader(request, "origin"), site = oneHeader(request, "sec-fetch-site");
    return typeof host === "string" && local.has(host.toLowerCase()) &&
      (origin === undefined || typeof origin === "string" && origin === origins.get(host.toLowerCase())) &&
      (site === undefined || ["none", "same-origin"].includes(site));
  }

  function removeClient(client) {
    clients.delete(client);
    clearTimeout(client.deadline);
    client.pending = null; client.activity = null;
  }

  function send(client, message) {
    if (client.response.destroyed || !clients.has(client)) return;
    if (client.blocked) { client.pending = message; return; }
    if (!client.response.write(message)) {
      client.blocked = true;
      client.deadline = setTimeout(() => client.response.destroy(), 30_000);
      client.deadline.unref();
      client.response.once("drain", () => {
        clearTimeout(client.deadline); client.blocked = false;
        const next = client.pending, keys = client.activity; client.pending = null; client.activity = null;
        if (next) send(client, next);
        if (keys) sendActivity(client, Object.fromEntries([...keys].filter(key => activity.has(key)).map(key => [key, activity.get(key)])));
      });
    }
  }

  function publish(client) {
    if (!modelEvent || client.sent === modelSent) return;
    client.sent = modelSent;
    if (modelSize <= maxModel) send(client, modelEvent);
  }

  function sendActivity(client, changes) {
    if (!Object.keys(changes).length) return;
    if (client.blocked) { client.activity = new Set([...client.activity ?? [], ...Object.keys(changes)]); return; }
    send(client, `event: activity\ndata: ${JSON.stringify(changes)}\n\n`);
  }

  const shownNotice = () => modelEvent && modelSize > maxModel ? TOO_BIG(modelSize, maxModel) : notice;
  function sendNotice(client) {
    send(client, `event: notice\ndata: ${JSON.stringify({ text: shownNotice() })}\n\n`);
  }

  function lightOf(path, filename) {
    const name = filename == null ? null : String(filename);
    for (const source of configured) {
      if (path !== source.path && !path.startsWith(source.path + sep)) continue;
      const parts = path === source.path ? [] : path.slice(source.path.length + 1).split(sep);
      if (parts[0] === ".hooks" || !parts.length && name === ".hooks") return { hooks: source.id };
      if (BOOK.test(parts[0] ?? "") && (parts[1] === "actions" || parts.length === 1 && name === "actions")) return { book: `${source.id}/${parts[0]}`, folder: parts.length === 1 };
    }
    return null;
  }

  function lightSchedule(change) {
    if (change.hooks) dirty.hooks.add(change.hooks);
    if (change.book) dirty.books.add(change.book);
    if (change.folder) dirty.folders = true;
    if (closed || lightTimer) return;
    lightTimer = setTimeout(lightRead, Math.max(20, lightAt + lightEvery - Date.now()));
    lightTimer.unref();
  }

  function lightRead() {
    lightTimer = undefined; lightAt = Date.now();
    if (closed || !light) return;
    light.post({ type: "light", hooks: [...dirty.hooks], books: [...dirty.books], folders: dirty.folders, at: clock ? Date.parse(clock()) : Date.now() });
    dirty.hooks.clear(); dirty.books.clear(); dirty.folders = false;
  }

  function schedule() {
    if (closed || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 20);
    refreshTimer.unref();
  }

  function settle(step = 0) {
    clearTimeout(settleTimer);
    if (step === settleReads.length) return;
    settleTimer = setTimeout(() => { schedule(); settle(step + 1); }, settleReads[step] - (settleReads[step - 1] ?? 0));
    settleTimer.unref();
  }

  function reconcileWatchers({ plan: number, folders, light: lightPlan = false }) {
    if (closed || number < planShown) return;
    planShown = number;
    const plans = new Map(folders.map(plan => [plan.path, plan]));
    let added = false;
    for (const [key, item] of watchers) if (!plans.has(key) || plans.get(key).identity !== item.plan.identity) { item.watcher.close(); watchers.delete(key); }
    for (const [key] of watchErrors) if (!plans.has(key)) watchErrors.delete(key);
    for (const [key, plan] of plans) {
      if (watchers.has(key)) { watchers.get(key).plan = plan; continue; }
      if (watchErrors.has(key)) continue;
      try {
        const item = { plan, watcher: null };
        item.watcher = watch(plan.path, (event, filename) => {
          if (event !== "rename" && !item.plan.all && filename && !item.plan.children.includes(String(filename))) return;
          watchErrors.clear();
          onWatch?.(item.plan.path, filename == null ? null : String(filename));
          const change = lightOf(item.plan.path, filename);
          if (change) lightSchedule(change); else schedule();
        });
        item.watcher.on("error", () => {
          item.watcher.close(); watchers.delete(key);
          watchErrors.set(key, { source: "board", message: "File watching is unavailable; the displayed board may be stale." });
          schedule();
        });
        watchers.set(key, item); added = true;
      } catch (error) {
        if (error.code !== "ENOENT") watchErrors.set(key, { source: "board", message: "File watching is unavailable; the displayed board may be stale." });
      }
    }
    if (added && !lightPlan) settle();
  }

  function refresh() {
    if (closed) return;
    clearTimeout(boundaryTimer);
    const thread = boards[answering === null ? boards.findIndex(Boolean) : 1 - answering];
    if (building || !thread) { again = true; return; }
    again = false; building = thread;
    thread.post({ type: "build" });
  }

  function watchThenRead(thread, message) {
    reconcileWatchers(message);
    if (!closed && building === thread) thread.post({ type: "read", now: clock ? clock() : null });
  }

  function built(thread, message) {
    building = null;
    const diagnostics = message.failed ? message.diagnostics : [...message.diagnostics, ...watchErrors.values()];
    stats = message.failed ? null : new Map(message.stats.map(([key, body]) => [key, Buffer.from(body)]));
    hooks = message.hooks;
    if (message.changing.length && !changingShown) settle();
    changingShown = message.changing.length > 0;
    const good = !diagnostics.length && !message.changing.length;
    if (good || !answeringGood || answering === null) {
      if (answering !== null && boards[answering] !== thread) boards[answering].post({ type: "drop" });
      answering = boards.indexOf(thread); answeringGood = good;
    }
    boards[answering].post({ type: "publish", seq: ++publishes, diagnostics, changing: message.changing, own: boards[answering] === thread, stats: message.digest });
    if (again) refresh();
  }

  function published(message) {
    if (message.seq < shownSeq) return;
    shownSeq = message.seq;
    facts = { ...message.facts, books: new Set(message.facts.books), tasks: new Map(Object.entries(message.facts.tasks)) };
    const shown = shownNotice();
    modelEvent = Buffer.concat([Buffer.from(`id: ${++revision}\nevent: model\ndata: `), Buffer.from(message.event), Buffer.from("\n\n")]);
    modelSize = message.event.byteLength; modelSent = message.sent;
    for (const client of clients) publish(client);
    if (shownNotice() !== shown) for (const client of clients) sendNotice(client);
    if (message.boundary !== null) { clearTimeout(boundaryTimer); boundaryTimer = setTimeout(schedule, Math.max(0, Math.min(message.boundary - Date.now(), 2_147_483_647))); boundaryTimer.unref(); }
    lastSeed = { type: "seed", rows: message.rows, hooks };
    light?.post(lastSeed);
    readyAccept();
    wakeIdlers();
  }

  function wakeIdlers() {
    if (facts && !refreshTimer && !building && !again && shownSeq === publishes) for (const accept of idlers.splice(0)) accept();
  }

  function lit(message) {
    if (message.all) activity = new Map(Object.entries(message.all));
    for (const book of message.books ?? []) lightSchedule({ book });
    if (message.changes && Object.keys(message.changes).length) {
      for (const [key, entry] of Object.entries(message.changes)) activity.set(key, entry);
      for (const client of clients) sendActivity(client, message.changes);
    }
    if (message.refresh) schedule();
  }

  function receive(thread, message) {
    if (closed) return;
    if (message.type === "plan") return message.read ? watchThenRead(thread, message) : reconcileWatchers(message);
    if (message.type === "built") return built(thread, message);
    if (message.type === "published") return published(message);
    if (message.type === "activity") return lit(message);
    const asked = pending.get(message.id);
    pending.delete(message.id);
    asked?.done(message);
  }

  function spawn() {
    const thread = { post: null, stop: null };
    if (duringRead) {
      const { port1, port2 } = new MessageChannel();
      serve(port2, { ...threadOptions, duringRead });
      port1.on("message", message => receive(thread, message));
      thread.post = (message, transfer) => port1.postMessage(message, transfer);
      thread.stop = async () => { port1.close(); port2.close(); };
    } else {
      const worker = new Worker(new URL("./thread.mjs", import.meta.url), { workerData: { board: threadOptions } });
      worker.on("message", message => receive(thread, message));
      worker.on("error", error => console.error(error));
      worker.once("exit", () => stopped(thread));
      thread.post = (message, transfer) => worker.postMessage(message, transfer);
      thread.stop = () => worker.terminate();
    }
    return thread;
  }

  function setNotice(text) {
    if (notice === text) return;
    const shown = shownNotice();
    notice = text;
    if (shownNotice() !== shown) for (const client of clients) sendNotice(client);
  }

  function stopped(thread) {
    if (closed) return;
    const now = Date.now();
    stops = [...stops.filter(at => now - at < RESTART_WINDOW), now];
    const slow = stops.length >= RESTARTS;
    if (slow) {
      setNotice(RESTARTING);
      clearTimeout(noticeTimer); noticeTimer = setTimeout(() => setNotice(null), RESTART_WINDOW); noticeTimer.unref();
    }
    for (const [key, asked] of pending) if (asked.thread === thread) { pending.delete(key); asked.done(null); }
    const index = boards.indexOf(thread);
    if (thread === light) light = null;
    else {
      boards[index] = null;
      if (building === thread) { building = null; again = true; }
      if (answering === index) { answering = null; answeringGood = false; again = true; }
    }
    const restart = setTimeout(() => {
      if (closed) return;
      if (index === -1) {
        light = spawn();
        if (lastSeed) light.post(lastSeed);
        if (dirty.hooks.size || dirty.books.size || dirty.folders) lightSchedule({});
      }
      else boards[index] = spawn();
      if (again) refresh();
    }, slow ? RESTART_WAIT : 0);
    restart.unref();
    if (again) refresh();
  }

  function ask(question) {
    const thread = answering === null ? null : boards[answering];
    if (!thread) return Promise.resolve(null);
    return new Promise(done => {
      const key = ++asks;
      pending.set(key, { thread, done });
      thread.post({ type: "ask", id: key, ...question });
    });
  }

  async function answer(request, response, fail, question) {
    if (!facts) return fail(503, READING);
    const found = await ask(question);
    if (!found) return fail(503, READING_AGAIN);
    if (response.destroyed) return;
    if (found.policy) response.setHeader("Content-Security-Policy", found.policy);
    const body = Buffer.from(found.body);
    response.writeHead(found.status, { "Content-Type": found.kind, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  const server = createServer({ maxHeaderSize: HEADERS_MAX }, (request, response) => {
    securityHeaders(response);
    if (pagesRequest(request.url)) return servePages(request, response, { onMac, facts, reader });
    const fail = (status, text) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : `${text}\n`); };
    if (!browserBoundary(request) || !onMac(request)) return fail(403, "This request is not permitted.");
    if (boardHeader) response.setHeader("X-Sage-Board", boardHeader);
    if (request.url.startsWith("/api/actions/")) {
      if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
      return answer(request, response, fail, { kind: "actions", url: request.url });
    }
    if (request.url.startsWith("/api/")) return serveApi(request, response, fail).catch(error => response.headersSent ? response.destroy() : json(response, 500, { problem: broken(error) }));
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    if (request.url === "/app" || request.url.startsWith("/app/")) return serveApp(request, response, fail);
    if (request.url.startsWith("/read/")) return reader ? answer(request, response, fail, { kind: "read", url: request.url, origin: origins.get(oneHeader(request, "host").toLowerCase()) }) : fail(503, NO_READER);
    if (/[?&]events=1(?:&|$)/.test(request.url)) { response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" }); return response.end(request.method === "HEAD" ? undefined : RETIRED_STREAM); }
    if (request.url === "/" || request.url.startsWith("/?")) { response.writeHead(...request.method === "HEAD" ? ANSWER_TO_THE_BOARD_PROBE_OF_ANY_PLUGIN : SEND_THE_BROWSER_TO_THE_APP); return response.end(); }
    fail(404, "This board page does not exist.");
  });
  async function serveApi(request, response, fail) {
    const reply = (status, body, headers) => json(response, status, body, headers);
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return fail(405, "This method is not permitted."); }
    const host = oneHeader(request, "host").toLowerCase();
    if (oneHeader(request, "origin") !== origins.get(host) || oneHeader(request, "sec-fetch-site") !== "same-origin") return fail(403, "This write is not permitted: only the board's own page, in a browser on this Mac, writes.");
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(oneHeader(request, "content-type") ?? "")) return fail(415, "A write sends JSON.");
    if (!access) return fail(503, "This board writes nothing: it started without its config folder.");
    let body;
    try { body = await jsonBody(request); } catch { return response.destroyed ? undefined : fail(400, "A write is one JSON object of strings and numbers, of at most 16 KiB."); }
    const name = request.url.slice("/api/".length);
    const browser = access.browserOf(oneHeader(request, "cookie")), fits = browser && access.tokenFits(browser, oneHeader(request, "x-sage-token"));
    const cookie = paired => ({ "Set-Cookie": `${COOKIE}=${paired.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    if (name === "pair" && body.link !== undefined) {
      const { outcome, at, cookie: value, token } = access.pairLink(body.link, Boolean(fits));
      return reply(outcome === "refused" ? 403 : 200, { outcome, ...(typeof at === "string" && { at }), ...(token && { token }) }, value && cookie({ cookie: value }));
    }
    if (name === "pair") {
      const paired = access.pair(body.code);
      return paired.problem ? reply(403, { problem: paired.problem }) : reply(200, { token: paired.token }, cookie(paired));
    }
    if (name === "unpair") {
      access.unpairAll();
      return reply(200, { text: "Every browser is unpaired: each one reads only now. To pair this browser again, type show board in a chief's chat, and click the link that it sends." }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (!browser) return reply(401, { problem: `This browser is not paired with the board. ${PAIR_AGAIN}` });
    if (!fits) return reply(403, { problem: `This page does not have this browser's pairing token. ${PAIR_AGAIN}` });
    if (name === "stop") {
      response.once("finish", () => Promise.resolve().then(onStop ?? board.close).catch(() => {}));
      return reply(200, { ok: true, text: "The board stopped. To start it again, type show board in a chief's chat." });
    }
    if (name === "name" && /^\s*-/.test(body.name ?? "")) return reply(400, { problem: "A chief's name cannot start with \"-\", because the state tool would read it as an option. Start it with a letter or a digit. Nothing changed." });
    if (Object.hasOwn(ARCHIVE_JOBS, name)) {
      if (!facts) return reply(503, { problem: READING });
      const turn = archiving.then(() => archiveWrite(body.project, ARCHIVE_JOBS[name]));
      archiving = turn.catch(() => {});
      return reply(...await turn);
    }
    const book = LOGBOOK.exec(body.logbook ?? ""), source = book && configured.find(item => item.id === book[1]);
    const argv = Object.hasOwn(JOBS, name) && JOBS[name](body);
    const refused = { problem: "The board cannot send this write: it names no question, task or chief of a shared logbook." };
    if (!argv || !source) return reply(400, refused);
    if (!facts) return reply(503, { problem: READING });
    if (!facts.shared.includes(source.id)) return reply(400, refused);
    const shelved = facts.projects.find(project => project.archived && project.logbooks.includes(body.logbook));
    if (shelved) return reply(409, { ok: false, text: `${shelved.name} is archived, so the board records no answer or other write for it. Restore it first, then try again. Nothing changed.` });
    const done = await write({ shared: source.path, folder: book[2], argv });
    return reply(done.pending ? 202 : done.code ? 409 : 200, { ok: !done.code, ...(done.pending && { pending: true }), text: withoutPaths(String(done.text).replace(/^sage: /, "")) });
  }

  async function archiveWrite(key, argv) {
    const project = typeof key === "string" && facts.projects.find(item => item.key === key);
    const shared = configured.find(item => facts.shared.includes(item.id))?.path ?? sharedRoot();
    const jobs = (project?.logbooks ?? []).map(logbook => {
      const book = LOGBOOK.exec(logbook), source = book && configured.find(item => item.id === book[1]);
      return source && { shared, folder: book[2], argv, ...(source.path !== shared && { root: source.path }), label: source.provider ? source.label ?? source.provider : "shared" };
    });
    if (!jobs.length || !jobs.every(Boolean)) return [400, { problem: "The board cannot send this write: it names no project of this board. Nothing changed." }];
    const done = [];
    for (const { label, ...job } of jobs) done.push({ label, ...await write(job) });
    const landed = done.filter(item => !item.code).length, failed = done.find(item => item.code), text = item => withoutPaths(String(item.text).replace(/^sage: /, ""));
    if (!failed) return [200, { ok: true, logbooks: jobs.length, text: text(done.at(-1)).split("\n").at(-1) }];
    return [failed.pending ? 202 : 409, { ok: false, logbooks: jobs.length, landed, failed: done.filter(item => item.code).map(item => item.label), ...(failed.pending && { pending: true }), text: text(failed) }];
  }

  function serveApp(request, response, fail) {
    if (request.url === "/app") { response.writeHead(301, { Location: "/app/" }); return response.end(); }
    if (!app) return fail(503, NO_APP);
    const name = /^\?/.test(request.url.slice("/app/".length)) ? "" : request.url.slice("/app/".length);
    if (name === "events") {
      if (clients.size >= MAX_CLIENTS && request.method !== "HEAD") return fail(503, "There are too many open board streams.");
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
      if (request.method === "HEAD") return response.end();
      response.flushHeaders();
      const client = { response, blocked: false, pending: null, activity: null, deadline: null, sent: null };
      clients.add(client); response.once("close", () => removeClient(client)); publish(client);
      sendActivity(client, Object.fromEntries(activity));
      if (shownNotice()) sendNotice(client);
      return;
    }
    if (name.startsWith("task/")) {
      const key = taskKey(name.slice("task/".length));
      return key ? answer(request, response, fail, { kind: "task", key }) : fail(404, "This task is not on the board.");
    }
    if (name === "stats" || name.startsWith("stats?")) {
      const query = new URLSearchParams(name.slice("stats?".length)), asked = query.get("project");
      if ([...query.keys()].some(key => key !== "project") || query.getAll("project").length > 1) return fail(400, "Stats takes one project key, or none for all projects.");
      if (!facts) return fail(503, READING);
      if (!stats) return fail(503, "The board cannot read the logbooks now. It reads again when a logbook changes.");
      const body = stats.get(asked);
      if (!body) return fail(404, "This project is not on the board.");
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      return response.end(request.method === "HEAD" ? undefined : body);
    }
    if (name.startsWith("gate/")) {
      const key = taskKey(name.slice("gate/".length));
      return key ? answer(request, response, fail, { kind: "gate", key }) : fail(404, "This question is not on the board.");
    }
    const body = name === "" ? Buffer.from(app.shell(access ? "on" : "off", access && pairCommand)) : app.files.get(name)?.body;
    if (!body) return fail(404, "This board page does not exist.");
    if (name === "") response.setHeader("Content-Security-Policy", appPolicy(origins.get(oneHeader(request, "host").toLowerCase())));
    response.writeHead(200, { "Content-Type": name === "" ? "text/html; charset=utf-8" : app.files.get(name).type, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const board = Object.freeze({
    start() {
      if (closed) return Promise.reject(new Error("the board server is closed"));
      if (startPromise) return startPromise;
      startPromise = new Promise((accept, reject) => {
        const failed = error => {
          const problem = Object.assign(new Error(error.code === "EADDRINUSE" ? `Board port ${port} is already in use.` : "The board listener could not start."), { code: error.code });
          readyReject(problem); reject(problem);
        };
        server.once("error", failed);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", failed);
          if (closed) return failed({});
          const bound = server.address().port;
          for (const host of [`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`]) { local.add(host); origins.set(host, `http://${host}`); }
          if (id) boardHeader = `id=${id}; pid=${process.pid}; started=${Date.now()}`;
          boards[0] = spawn(); boards[1] = spawn(); light = spawn();
          refresh();
          accept(server.address());
        });
      });
      return startPromise;
    },
    ready: () => readyPromise,
    idle: () => new Promise(accept => { idlers.push(accept); wakeIdlers(); }),
    address: () => server.address(),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      readyReject(new Error("the board server is closed"));
      for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
      clearTimeout(refreshTimer); clearTimeout(boundaryTimer); clearTimeout(settleTimer); clearTimeout(lightTimer); clearTimeout(noticeTimer);
      for (const client of clients) { client.response.destroy(); removeClient(client); }
      for (const asked of pending.values()) asked.done(null);
      pending.clear();
      const threads = [...boards, light].filter(Boolean).map(thread => thread.stop());
      closePromise = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        await Promise.all(threads);
        await writesEnded();
        if (server.listening) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
      })();
      return closePromise;
    },
  });
  return board;
}
