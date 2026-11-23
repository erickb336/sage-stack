import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_QUIET_MS, readActions, readHookNotes, readBoardSources, buildBoardModel, boardOverview, boardStats, taskPanel, landingRule, pageTaskFolder, sharedRoot, BOARD_PORT, DESIGNS_FOLDER, WORDS_MAX } from "../core/index.mjs";
import { COOKIE, boardAccess, readJson } from "./access.mjs";
import { gateMaterial } from "./material.mjs";
import { failureOf, pagesRequest, servePages, taskFiles } from "./pages.mjs";
import { briefAbout, changeText, designSummary, logbookDir, readerPage, recordedPages, runFiles } from "./reader.mjs";
import { ARCHIVE_JOBS, writeInWorker, writesEnded } from "./writes.mjs";

const MARKDOWN = await import("./markdown.mjs").then(module => module.renderMarkdown, () => null);
const NO_READER = "The reader's Markdown renderer is not in this copy of the board. Run the board from the sage plugin, or run npm ci and npm run build.";

const MAX_MODEL = 8 * 1024 * 1024;
const MAX_CLIENTS = 16;
const digest = text => createHash("sha256").update(text).digest();
const unavailable = [{ source: "board", message: "The board snapshot is unavailable." }];
const own = (object, name) => Object.hasOwn(object, name);
const SETTLE_READS = [250, 1000, 3000, 7000, 15000];
const LIGHT_EVERY = 2000;
const BOOK = /^[a-z0-9-]+-[0-9a-f]{6}$/;
const agentRows = model => {
  const all = [], walk = agent => { all.push(agent); for (const child of agent.children ?? []) walk(child); };
  for (const project of model?.agents?.projects ?? []) for (const agent of project.agents) walk(agent);
  return all;
};
const hookShape = notes => JSON.stringify([notes.present, notes.problem, notes.slots.map(slot => [slot.name, [...slot.marks].sort()]), notes.helpers]);

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
const GATE = /^G[1-9]\d*$/, TASK = /^T[1-9]\d*$/, CHIEF = /^C[1-9]\d*$/, LOGBOOK = /^([A-Za-z0-9_-]{1,80})\/([a-z0-9-]+-[0-9a-f]{6})$/;
const JOBS = {
  answer: body => GATE.test(body.gate) && Number.isInteger(body.option) && body.option >= 1 && body.option <= 99 && /^[0-9a-f]{16}$/.test(body.digest ?? "") && (body.words === undefined || typeof body.words === "string" && [...body.words].length <= WORDS_MAX)
    && ["gate", "answer", body.gate, "--via", "board", "--option", String(body.option), ...(body.words?.trim() ? ["--other-hex", Buffer.from(body.words, "utf8").toString("hex")] : []), "--seen", body.digest],
  undo: body => GATE.test(body.gate) && ["gate", "undo", body.gate],
  give: body => TASK.test(body.task) && CHIEF.test(body.to) && ["gate", "give", body.task, "--to", body.to],
  name: body => CHIEF.test(body.chief) && typeof body.name === "string" && body.name.length <= 240 && ["chief", "name", body.chief, ...(body.name.trim() ? [body.name.trim()] : [])],
};
const LOCAL_PATH = /(?<![\w.~/-])~?\/(?!\/[^/])[^\s"'`]+(?:(?: [^\s"'`/]+){0,3} [^\s"'`/]+\/[^\s"'`]*)*/g;
export const withoutPaths = text => text.replace(LOCAL_PATH, path => `…/${basename(path)}`);
const jsonCell = text => { try { const value = JSON.parse(text || "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } };

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

export function createBoardServer({ sources, port = BOARD_PORT, id, clock = () => new Date().toISOString(), settleReads = SETTLE_READS, lightEvery = LIGHT_EVERY, duringRead = null, providerRoots = [], app = loadBoardApp(), markdown = MARKDOWN, stateDir = null, pairCommand = null, write = writeInWorker, onStop = null } = {}) {
  if (!Number.isSafeInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new TypeError("board port must be an integer from 1024 through 65535, or 0 for a free port that the system picks");
  if (typeof clock !== "function") throw new TypeError("the board clock must be a function that gives an ISO time");
  if (!Array.isArray(sources) || !sources.length || sources.length > 32) throw new TypeError("board needs 1 to 32 explicit sources");
  const ids = new Set();
  const configured = Array.from(sources, source => {
    if (!source || !own(source, "id") || !own(source, "path") || typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) throw new TypeError("board sources need unique ids and absolute normalized paths");
    for (const key of ["label", "provider"]) if (own(source, key) && (typeof source[key] !== "string" || source[key].length > 160 || /[\x00-\x1f\x7f]/.test(source[key]))) throw new TypeError("invalid board source label");
    ids.add(source.id);
    return Object.freeze({ id: source.id, path: source.path, ...(own(source, "label") ? { label: source.label } : {}), ...(own(source, "provider") ? { provider: source.provider } : {}) });
  });
  const landing = landingRule(configured);
  if (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{16,64}$/.test(id))) throw new TypeError("the board id must be 16 to 64 lowercase hex characters");
  const local = new Set(), origins = new Map();
  let boardHeader = null;
  if (stateDir && (typeof pairCommand !== "string" || !pairCommand || /[\x00-\x1f\x7f]/.test(pairCommand))) throw new TypeError("a board that takes writes needs the pairing command that the owner runs in Terminal");
  const access = stateDir ? boardAccess(stateDir) : null;
  const watchers = new Map(), watchErrors = new Map(), clients = new Set();
  let model, fresh, overview, lastGood, revision = 0, refreshTimer, boundaryTimer, settleTimer, startTimer, startPromise, closePromise, closed = false;
  let lastRead = null, lightTimer, lightAt = 0, activity = new Map(), archiving = Promise.resolve();
  const dirty = { hooks: new Set(), books: new Set(), folders: false };

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
    const data = JSON.stringify(overview), sent = digest(data).toString("base64");
    if (client.sent === sent) return;
    client.sent = sent;
    if (Buffer.byteLength(data) > MAX_MODEL) { client.response.end(); removeClient(client); return; }
    send(client, `id: ${revision}\nevent: model\ndata: ${data}\n\n`);
  }

  function sendActivity(client, changes) {
    if (!Object.keys(changes).length) return;
    if (client.blocked) { client.activity = new Set([...client.activity ?? [], ...Object.keys(changes)]); return; }
    send(client, `event: activity\ndata: ${JSON.stringify(changes)}\n\n`);
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

  function lightSchedule(light) {
    if (light.hooks) dirty.hooks.add(light.hooks);
    if (light.book) dirty.books.add(light.book);
    if (light.folder) dirty.folders = true;
    if (closed || lightTimer) return;
    lightTimer = setTimeout(lightRead, Math.max(20, lightAt + lightEvery - Date.now()));
    lightTimer.unref();
  }

  function lightRead() {
    lightTimer = undefined; lightAt = Date.now();
    const hooks = [...dirty.hooks], books = [...dirty.books], folders = dirty.folders;
    dirty.hooks.clear(); dirty.books.clear(); dirty.folders = false;
    if (closed || !lastRead) return;
    const changes = {}, rows = agentRows(model), at = Date.parse(clock());
    const update = (key, change) => {
      const entry = activity.get(key), next = { ...entry, ...change };
      if (JSON.stringify(next) !== JSON.stringify(entry)) { activity.set(key, next); changes[key] = next; }
    };
    try {
      if (folders || hooks.length) reconcileWatchers(true);
      for (const id of hooks) {
        const notes = readHookNotes(configured.find(source => source.id === id).path), before = lastRead.find(source => source.id === id)?.hooks;
        if (!before || hookShape(notes) !== hookShape(before)) { schedule(); continue; }
        for (const slot of notes.slots) for (const row of rows.filter(row => row.source === id && row.slot?.name === slot.name)) {
          const key = row.logbook && row.runId ? `${row.logbook}/${row.runId}` : null, was = key ? activity.get(key)?.activity : row.activity;
          if (was === undefined || was === slot.at) continue;
          if (was === null || at - was >= AGENT_QUIET_MS) schedule();
          if (key) update(key, { activity: slot.at });
        }
      }
      for (const book of books) {
        const source = configured.find(item => book.startsWith(`${item.id}/`)), dir = join(source.path, book.slice(source.id.length + 1));
        for (const key of activity.keys()) if (key.startsWith(`${book}/`) && /^R[1-9]\d*$/.test(key.slice(book.length + 1))) {
          let now = null;
          try { now = readActions(dir, key.slice(book.length + 1), 1).actions[0] ?? null; } catch {}
          update(key, { now });
        }
      }
    } catch { schedule(); }
    for (const client of clients) sendActivity(client, changes);
  }

  function schedule() {
    if (closed || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 20);
    refreshTimer.unref();
  }

  function watchPlans() {
    const plans = new Map();
    const add = (path, child = null) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("watch directory is unavailable");
      const plan = plans.get(path) ?? { path, identity: `${info.dev}:${info.ino}`, children: new Set(), all: false };
      if (child) plan.children.add(child); else plan.all = true;
      plans.set(path, plan);
    };
    const tree = path => {
      add(path);
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== DESIGNS_FOLDER) try { tree(join(path, entry.name)); } catch {}
    };
    for (const source of configured) {
      try { tree(source.path); } catch {}
      let ancestor = dirname(source.path);
      for (;;) {
        try { add(ancestor, source.path.slice(ancestor.length + (ancestor.endsWith(sep) ? 0 : 1)).split(sep)[0]); break; }
        catch { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
      }
    }
    return plans;
  }

  function settle(step = 0) {
    clearTimeout(settleTimer);
    if (step === settleReads.length) return;
    settleTimer = setTimeout(() => { schedule(); settle(step + 1); }, settleReads[step] - (settleReads[step - 1] ?? 0));
    settleTimer.unref();
  }

  function reconcileWatchers(light = false) {
    const plans = watchPlans();
    let added = false;
    for (const [key, item] of watchers) if (!plans.has(key) || plans.get(key).identity !== item.plan.identity) { item.watcher.close(); watchers.delete(key); }
    for (const [key] of watchErrors) if (!plans.has(key)) watchErrors.delete(key);
    for (const [key, plan] of plans) {
      if (watchers.has(key)) { watchers.get(key).plan = plan; continue; }
      if (watchErrors.has(key)) continue;
      try {
        const item = { plan, watcher: null };
        item.watcher = watch(plan.path, (event, filename) => {
          if (event !== "rename" && !item.plan.all && filename && !item.plan.children.has(String(filename))) return;
          watchErrors.clear();
          const light = lightOf(item.plan.path, filename);
          if (light) lightSchedule(light); else schedule();
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
    if (added && !light) settle();
  }

  function refresh() {
    if (closed) return;
    clearTimeout(boundaryTimer);
    let next;
    try {
      reconcileWatchers();
      const read = readBoardSources(configured, { duringRead, providerRoots });
      lastRead = read;
      for (const [index, source] of read.entries()) if (!lstatSync(configured[index].path, { throwIfNoEntry: false })) source.diagnostics = source.diagnostics.filter(message => message !== "ENOENT");
      next = buildBoardModel(read, { now: clock(), landing });
      next.diagnostics = [...next.diagnostics, ...watchErrors.values()];
    } catch { next = { ...buildBoardModel([], { now: clock() }), diagnostics: unavailable }; }
    fresh = next;
    const changing = next.changing ?? [];
    if (changing.length && !model?.changing?.length) settle();
    if (!next.diagnostics.length && !changing.length) { lastGood = next; model = { ...next, stale: false }; }
    else if (!next.diagnostics.length) model = lastGood ? { ...lastGood, stale: false, changing: changing.map(item => ({ project: item.project, at: lastGood.at })) } : { ...next, stale: false };
    else model = { ...(lastGood ?? next), stale: true, diagnostics: next.diagnostics, changing };
    const numbers = [null, ...next.projects.map(project => project.key)].map(key => ({ ...boardStats(next, key), at: null }));
    overview = { ...boardOverview(model), stats: digest(JSON.stringify(numbers)).toString("base64") };
    for (const book of overview.agents) for (const run of book.runs) if (run.status === "failed" || run.role === "arena-judge") {
      const task = model.tasks.find(item => item.key === run.task.key), row = task?.runs.find(item => item.id === run.id), dir = task && logbookDir(configured, task);
      if (row && run.status === "failed") run.why = failureOf({ dir, task, run: row })?.text ?? null;
      if (row && run.role === "arena-judge") run.report = runFiles(dir, pageTaskFolder(task.project.slice(task.project.indexOf("/") + 1), task.id), task, row).report;
    }
    const known = activity;
    activity = new Map();
    for (const row of agentRows(model)) if (row.logbook && row.runId) {
      const key = `${row.logbook}/${row.runId}`;
      activity.set(key, { activity: row.activity, now: known.get(key)?.now ?? null });
      if (!known.has(key)) lightSchedule({ book: row.logbook });
    }
    revision++;
    for (const client of clients) publish(client);
    const now = Date.now(), boundary = model.tasks.reduce((first, task) => {
      const at = task.completedAt === null ? NaN : task.completedAt + 7 * 86400000 + 1;
      return Number.isFinite(at) && at > now ? Math.min(first, at) : first;
    }, Math.min(model.agents?.next > now ? model.agents.next : Infinity, overview.next > now ? overview.next : Infinity));
    if (Number.isFinite(boundary)) { boundaryTimer = setTimeout(schedule, Math.min(boundary - now, 2_147_483_647)); boundaryTimer.unref(); }
  }

  const server = createServer({ maxHeaderSize: HEADERS_MAX }, (request, response) => {
    securityHeaders(response);
    if (pagesRequest(request.url)) return servePages(request, response, { onMac, model, reader: !!markdown });
    const fail = (status, text) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : `${text}\n`); };
    if (!browserBoundary(request) || !onMac(request)) return fail(403, "This request is not permitted.");
    if (boardHeader) response.setHeader("X-Sage-Board", boardHeader);
    if (request.url.startsWith("/api/actions/")) return serveActions(request, response, fail);
    if (request.url.startsWith("/api/")) return serveApi(request, response, fail).catch(error => response.headersSent ? response.destroy() : json(response, 500, { problem: broken(error) }));
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    if (request.url === "/app" || request.url.startsWith("/app/")) return serveApp(request, response, fail);
    if (request.url.startsWith("/read/")) return serveReader(request, response, fail);
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
      const turn = archiving.then(() => archiveWrite(body.project, ARCHIVE_JOBS[name]));
      archiving = turn.catch(() => {});
      return reply(...await turn);
    }
    const book = LOGBOOK.exec(body.logbook ?? ""), source = book && configured.find(item => item.id === book[1]);
    const argv = Object.hasOwn(JOBS, name) && JOBS[name](body);
    if (!argv || !source || !model?.sources.some(item => item.id === source.id && item.shared)) return reply(400, { problem: "The board cannot send this write: it names no question, task or chief of a shared logbook." });
    const shelved = model.projects?.find(project => project.archived && project.logbooks.includes(body.logbook));
    if (shelved) return reply(409, { ok: false, text: `${shelved.name} is archived, so the board records no answer or other write for it. Restore it first, then try again. Nothing changed.` });
    const done = await write({ shared: source.path, folder: book[2], argv });
    return reply(done.pending ? 202 : done.code ? 409 : 200, { ok: !done.code, ...(done.pending && { pending: true }), text: withoutPaths(String(done.text).replace(/^sage: /, "")) });
  }

  async function archiveWrite(key, argv) {
    const project = typeof key === "string" && model?.projects?.find(item => item.key === key);
    const shared = configured.find(item => model?.sources.some(source => source.id === item.id && source.shared))?.path ?? sharedRoot();
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

  function serveActions(request, response, fail) {
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return fail(405, "This method is not permitted."); }
    const mark = request.url.indexOf("?"), path = mark === -1 ? request.url : request.url.slice(0, mark), query = new URLSearchParams(mark === -1 ? "" : request.url.slice(mark + 1));
    const run = /^\/api\/actions\/(R[1-9]\d{0,8})$/.exec(path)?.[1], book = [...query.keys()].join(" ") === "logbook" ? LOGBOOK.exec(query.get("logbook")) : null;
    const project = run && book && lastRead?.find(source => source.id === book[1])?.projects.find(item => item.key === book[0] && !item.old);
    if (!project?.tables.runs?.some(item => item.id === run)) return fail(404, "This run is not on the board.");
    const dir = join(configured.find(source => source.id === book[1]).path, book[2]);
    let found;
    try { found = readActions(dir, run); } catch (error) {
      return ["ELOOP", "ENOTDIR"].includes(error.code) ? fail(403, "The board does not open links: this run's action file or its folder is a link or not a plain file.") : fail(503, "The board cannot read this run's actions now. Try again.");
    }
    return json(response, 200, { logbook: book[0], run, ...found });
  }

  function gateDetail(key) {
    const at = key.lastIndexOf("/"), logbook = key.slice(0, at), id = key.slice(at + 1);
    const task = GATE.test(id) && model?.tasks.find(item => item.project === logbook && item.gateRows?.some(gate => gate.id === id));
    if (!task) return null;
    const gate = task.gateRows.find(row => row.id === id), source = configured.find(item => item.id === task.source);
    let kept = null;
    try { kept = source && LOGBOOK.test(logbook) ? readJson(join(source.path, logbook.slice(logbook.indexOf("/") + 1), "gates"), `${id}.json`, 1 << 20) : null; } catch {}
    const answered = jsonCell(gate.answered), picked = jsonCell(gate.picked), need = model.needsOwner.flatMap(item => item.reasons).find(reason => reason.key === key);
    return { key, id, logbook, task: { key: task.key, id: task.id, title: task.title }, project: task.projectName, question: String(gate.question ?? ""), options: String(gate.options ?? "").split("|").map(option => option.trim()).filter(Boolean),
      recommendation: gate.recommendation || null, default: gate.default || null, at: gate.at || null, answer: gate.answer || null, answered: answered && { at: String(answered.at ?? ""), via: String(answered.via ?? ""), answer: answered.answer == null ? null : String(answered.answer) },
      picked: picked && { at: String(picked.at ?? ""), chief: String(picked.chief ?? "") }, digest: need?.digest ?? null, owner: (gate.kind === "replace" && gate.chief) || task.owner?.id || gate.chief || null, takeover: gate.kind === "replace", text: need?.text ?? null,
      message: kept?.message?.kind === "question" ? kept.message : null, run: /^R[1-9]\d*$/.test(gate.run ?? "") ? gate.run : null,
      material: gateMaterial({ model, task, gate, message: kept?.message?.kind === "question" ? kept.message : null }) };
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
      return;
    }
    if (name.startsWith("task/")) {
      try {
        const key = taskKey(name.slice("task/".length)), panel = key && model && taskPanel(model, key);
        if (!panel) return fail(404, "This task is not on the board.");
        const task = model.tasks.find(item => item.key === key), dir = logbookDir(configured, task);
        const folder = pageTaskFolder(panel.logbook, task.id), files = { ...taskFiles({ dir, logbook: panel.logbook, task: task.id, runs: panel.runs }), designs: designSummary(panel.logbook, task.id), recorded: recordedPages(task, folder) };
        const runs = panel.runs.map(run => ({ ...run, ...runFiles(dir, folder, task, run), ...(run.status === "failed" && { failure: failureOf({ dir, task, run: task.runs.find(item => item.id === run.id) }) }) }));
        const change = task.state === "merged" ? changeText(dir, folder, task, panel.runs) : undefined;
        const body = Buffer.from(JSON.stringify({ ...panel, runs, files, brief: briefAbout(dir, task, panel.runs), ...(change !== undefined && { change }) }));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
        return response.end(request.method === "HEAD" ? undefined : body);
      } catch { return fail(503, "The board snapshot is unavailable."); }
    }
    if (name === "stats" || name.startsWith("stats?")) {
      const query = new URLSearchParams(name.slice("stats?".length)), asked = query.get("project");
      if ([...query.keys()].some(key => key !== "project") || query.getAll("project").length > 1) return fail(400, "Stats takes one project key, or none for all projects.");
      if (!fresh || fresh.diagnostics === unavailable) return fail(503, "The board cannot read the logbooks now. It reads again when a logbook changes.");
      const stats = boardStats(fresh, asked);
      if (!stats) return fail(404, "This project is not on the board.");
      const body = Buffer.from(JSON.stringify(stats));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      return response.end(request.method === "HEAD" ? undefined : body);
    }
    if (name.startsWith("gate/")) {
      const key = taskKey(name.slice("gate/".length)), detail = key && model && gateDetail(key);
      if (!detail) return fail(404, "This question is not on the board.");
      const body = Buffer.from(JSON.stringify(detail));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      return response.end(request.method === "HEAD" ? undefined : body);
    }
    const body = name === "" ? Buffer.from(app.shell(access ? "on" : "off", access && pairCommand)) : app.files.get(name)?.body;
    if (!body) return fail(404, "This board page does not exist.");
    if (name === "") response.setHeader("Content-Security-Policy", appPolicy(origins.get(oneHeader(request, "host").toLowerCase())));
    response.writeHead(200, { "Content-Type": name === "" ? "text/html; charset=utf-8" : app.files.get(name).type, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  function serveReader(request, response, fail) {
    if (!markdown) return fail(503, NO_READER);
    let page;
    try { page = readerPage({ model, configured, url: request.url, origin: origins.get(oneHeader(request, "host").toLowerCase()), render: markdown }); } catch { return fail(503, "The board cannot read this document now. Reload the page to try again."); }
    if (!page) return fail(404, "This document is not on the board.");
    response.setHeader("Content-Security-Policy", page.policy);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.method === "HEAD") return response.end();
    response.write(page.top);
    response.end(page.rest);
  }

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const board = Object.freeze({
    start() {
      if (closed) return Promise.reject(new Error("the board server is closed"));
      if (startPromise) return startPromise;
      startPromise = new Promise((accept, reject) => {
        refresh();
        const failed = error => {
          for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
          clearTimeout(refreshTimer); clearTimeout(boundaryTimer); clearTimeout(settleTimer); clearTimeout(lightTimer);
          reject(Object.assign(new Error(error.code === "EADDRINUSE" ? `Board port ${port} is already in use.` : "The board listener could not start."), { code: error.code }));
        };
        server.once("error", failed);
        startTimer = setTimeout(() => {
          if (closed) return failed({});
          refresh();
          server.listen(port, "127.0.0.1", () => {
            server.off("error", failed);
            const bound = server.address().port;
            for (const host of [`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`]) { local.add(host); origins.set(host, `http://${host}`); }
            if (id) boardHeader = `id=${id}; pid=${process.pid}; started=${Date.now()}`;
            accept(server.address());
          });
        }, 250);
      });
      return startPromise;
    },
    address: () => server.address(),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
      clearTimeout(refreshTimer); clearTimeout(boundaryTimer); clearTimeout(settleTimer); clearTimeout(lightTimer);
      for (const client of clients) { client.response.destroy(); removeClient(client); }
      closePromise = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        await writesEnded();
        if (server.listening) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
      })();
      return closePromise;
    },
  });
  return board;
}
