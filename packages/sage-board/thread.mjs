import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { AGENT_QUIET_MS, DESIGNS_FOLDER, readActions, readHookNotes, readBoardSources, buildBoardModel, boardOverview, boardStats, taskPanel, landingRule, optionsOf, pageTaskFolder } from "../sage-core/index.mjs";
import { readJson } from "./access.mjs";
import { gateMaterial } from "./material.mjs";
import { failureOf, taskFiles } from "./pages.mjs";
import { briefAbout, changeText, designSummary, logbookDir, readerPage, recordedPages, runFiles } from "./reader.mjs";

const MARKDOWN = await import("./markdown.mjs").then(module => module.renderMarkdown, () => null);
export const GATE = /^G[1-9]\d*$/, LOGBOOK = /^([A-Za-z0-9_-]{1,80})\/([a-z0-9-]+-[0-9a-f]{6})$/;
const UNAVAILABLE = [{ source: "board", message: "The board snapshot is unavailable." }];
const JSON_TYPE = "application/json; charset=utf-8", PLAIN = "text/plain; charset=utf-8";
const digest = text => createHash("sha256").update(text).digest("base64");
const bytes = text => new TextEncoder().encode(text).buffer;
const jsonCell = text => { try { const value = JSON.parse(text || "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } };
const agentRows = model => {
  const all = [], walk = agent => { all.push(agent); for (const child of agent.children ?? []) walk(child); };
  for (const project of model?.agents?.projects ?? []) for (const agent of project.agents) walk(agent);
  return all;
};
const hookShape = notes => JSON.stringify([notes.present, notes.problem, notes.slots.map(slot => [slot.name, [...slot.marks].sort()]), notes.helpers]);
const json = (status, value) => ({ status, type: JSON_TYPE, body: JSON.stringify(value) });
const text = (status, words) => ({ status, type: PLAIN, body: `${words}\n` });

function watchPlan(configured) {
  const plans = new Map();
  const add = (path, child = null) => {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("watch directory is unavailable");
    const plan = plans.get(path) ?? { path, identity: `${info.dev}:${info.ino}`, children: [], all: false };
    if (child) { if (!plan.children.includes(child)) plan.children.push(child); } else plan.all = true;
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
  return [...plans.values()];
}

export function serve(port, { configured, providerRoots = [], reader = false, duringRead = null, holds = null, walks }) {
  const landing = landingRule(configured), render = reader ? MARKDOWN : null;
  const post = (message, transfer = []) => port.postMessage(message, transfer);
  const stop = slot => !isMainThread && holds && Atomics.exchange(holds, slot, 0) && process.exit(1);
  const hold = slot => {
    if (!holds || slot >= holds.length || !Atomics.load(holds, slot)) return;
    Atomics.add(holds, 1, 1); Atomics.notify(holds, 1);
    Atomics.wait(holds, slot, 1);
  };
  const walkNumber = () => Atomics.add(walks, 0, 1) + 1;
  let read = null, built = null, model = null;
  let rows = null, hooks = {}, activity = new Map();

  function planWatchers() {
    stop(3);
    read = built = model = null;
    let folders = [];
    try { folders = watchPlan(configured); } catch {}
    post({ type: "plan", plan: walkNumber(), folders, read: true });
  }

  function readAndBuild({ now }) {
    let next, failed = false;
    try {
      read = readBoardSources(configured, { duringRead: duringRead ?? (() => hold(0)), providerRoots });
      for (const [index, source] of read.entries()) if (!lstatSync(configured[index].path, { throwIfNoEntry: false })) source.diagnostics = source.diagnostics.filter(message => message !== "ENOENT");
      next = buildBoardModel(read, { now: now ?? new Date().toISOString(), landing });
    } catch { failed = true; next = { ...buildBoardModel([], { now: now ?? new Date().toISOString() }), diagnostics: UNAVAILABLE }; }
    built = next;
    const keys = [null, ...next.projects.map(project => project.key)], numbers = keys.map(key => boardStats(next, key));
    const stats = keys.map((key, i) => [key, bytes(JSON.stringify(numbers[i]))]);
    const shapes = Object.fromEntries((read ?? []).filter(source => source.hooks).map(source => [source.id, hookShape(source.hooks)]));
    post({ type: "built", failed, diagnostics: next.diagnostics, changing: next.changing ?? [], digest: digest(JSON.stringify(numbers.map(item => ({ ...item, at: null })))), stats, hooks: shapes }, stats.map(([, body]) => body));
  }

  function publish({ seq, diagnostics, changing, own, stats }) {
    model = diagnostics.length ? { ...built, stale: true, diagnostics, changing }
      : changing.length && !own ? { ...built, stale: false, changing: changing.map(item => ({ project: item.project, at: built.at })) }
      : { ...built, stale: false };
    const overview = { ...boardOverview(model), stats };
    for (const book of overview.agents) for (const run of book.runs) if (run.status === "failed" || run.role === "arena-judge") {
      const task = model.tasks.find(item => item.key === run.task.key), row = task?.runs.find(item => item.id === run.id), dir = task && logbookDir(configured, task);
      if (row && run.status === "failed") run.why = failureOf({ dir, task, run: row })?.text ?? null;
      if (row && run.role === "arena-judge") run.report = runFiles(dir, pageTaskFolder(task.project.slice(task.project.indexOf("/") + 1), task.id), task, row).report;
    }
    const data = JSON.stringify(overview), event = bytes(data), now = Date.now();
    const boundary = model.tasks.reduce((first, task) => {
      const at = task.completedAt === null ? NaN : task.completedAt + 7 * 86400000 + 1;
      return Number.isFinite(at) && at > now ? Math.min(first, at) : first;
    }, Math.min(model.agents?.next > now ? model.agents.next : Infinity, overview.next > now ? overview.next : Infinity));
    const tasks = {};
    for (const task of model.tasks) tasks[`${task.project.slice(task.project.indexOf("/") + 1)}/${task.id}`] ??= task.key;
    const facts = {
      shared: model.sources.filter(source => source.shared).map(source => source.id),
      projects: model.projects.map(project => ({ key: project.key, name: project.name, archived: !!project.archived, logbooks: project.logbooks ?? [] })),
      books: [...new Set(model.projects.flatMap(project => project.books ?? []).map(key => key.slice(key.indexOf("/") + 1)))],
      tasks,
    };
    const seed = agentRows(model).map(row => ({ source: row.source ?? null, logbook: row.logbook ?? null, runId: row.runId ?? null, slot: row.slot?.name ?? null, activity: row.activity }));
    post({ type: "published", seq, event, sent: digest(data), facts, rows: seed, boundary: Number.isFinite(boundary) ? boundary : null }, [event]);
  }

  function taskAnswer(key) {
    const panel = model && taskPanel(model, key);
    if (!panel) return text(404, "This task is not on the board.");
    const task = model.tasks.find(item => item.key === key), dir = logbookDir(configured, task);
    const folder = pageTaskFolder(panel.logbook, task.id), files = { ...taskFiles({ dir, logbook: panel.logbook, task: task.id, runs: panel.runs }), designs: designSummary(panel.logbook, task.id), recorded: recordedPages(task, folder) };
    const runs = panel.runs.map(run => ({ ...run, ...runFiles(dir, folder, task, run), ...(run.status === "failed" && { failure: failureOf({ dir, task, run: task.runs.find(item => item.id === run.id) }) }) }));
    const change = task.state === "merged" ? changeText(dir, folder, task, panel.runs) : undefined;
    return json(200, { ...panel, runs, files, brief: briefAbout(dir, task, panel.runs), ...(change !== undefined && { change }) });
  }

  function gateAnswer(key) {
    const at = key.lastIndexOf("/"), logbook = key.slice(0, at), id = key.slice(at + 1);
    const task = GATE.test(id) && model?.tasks.find(item => item.project === logbook && item.gateRows?.some(gate => gate.id === id));
    if (!task) return text(404, "This question is not on the board.");
    const gate = task.gateRows.find(row => row.id === id), source = configured.find(item => item.id === task.source);
    let kept = null;
    try { kept = source && LOGBOOK.test(logbook) ? readJson(join(source.path, logbook.slice(logbook.indexOf("/") + 1), "gates"), `${id}.json`, 1 << 20) : null; } catch {}
    const answered = jsonCell(gate.answered), picked = jsonCell(gate.picked), need = model.needsOwner.flatMap(item => item.reasons).find(reason => reason.key === key);
    return json(200, { key, id, logbook, task: { key: task.key, id: task.id, title: task.title }, project: task.projectName, question: String(gate.question ?? ""), options: optionsOf(gate),
      recommendation: gate.recommendation || null, default: gate.default || null, at: gate.at || null, answer: gate.answer || null, answered: answered && { at: String(answered.at ?? ""), via: String(answered.via ?? ""), answer: answered.answer == null ? null : String(answered.answer) },
      picked: picked && { at: String(picked.at ?? ""), chief: String(picked.chief ?? "") }, digest: need?.digest ?? null, owner: (gate.kind === "replace" && gate.chief) || task.owner?.id || gate.chief || null, takeover: gate.kind === "replace", text: need?.text ?? null,
      message: kept?.message?.kind === "question" ? kept.message : null, run: /^R[1-9]\d*$/.test(gate.run ?? "") ? gate.run : null,
      material: gateMaterial({ model, task, gate, message: kept?.message?.kind === "question" ? kept.message : null }) });
  }

  function readerAnswer(url, origin) {
    let page;
    try { page = readerPage({ model, configured, url, origin, render }); } catch { return text(503, "The board cannot read this document now. Reload the page to try again."); }
    return page ? { status: 200, type: "text/html; charset=utf-8", body: page.top + page.rest, policy: page.policy } : text(404, "This document is not on the board.");
  }

  function actionsAnswer(url) {
    const mark = url.indexOf("?"), path = mark === -1 ? url : url.slice(0, mark), query = new URLSearchParams(mark === -1 ? "" : url.slice(mark + 1));
    const run = /^\/api\/actions\/(R[1-9]\d{0,8})$/.exec(path)?.[1], book = [...query.keys()].join(" ") === "logbook" ? LOGBOOK.exec(query.get("logbook")) : null;
    const project = run && book && read?.find(source => source.id === book[1])?.projects.find(item => item.key === book[0] && !item.old);
    if (!project?.tables.runs?.some(item => item.id === run)) return text(404, "This run is not on the board.");
    const dir = join(configured.find(source => source.id === book[1]).path, book[2]);
    try { return json(200, { logbook: book[0], run, ...readActions(dir, run) }); } catch (error) {
      return ["ELOOP", "ENOTDIR"].includes(error.code) ? text(403, "The board does not open links: this run's action file or its folder is a link or not a plain file.") : text(503, "The board cannot read this run's actions now. Try again.");
    }
  }

  function ask({ id, kind, key, url, origin }) {
    stop(2);
    let answer;
    try { answer = kind === "task" ? taskAnswer(key) : kind === "gate" ? gateAnswer(key) : kind === "read" ? readerAnswer(url, origin) : actionsAnswer(url); }
    catch { answer = text(503, "The board snapshot is unavailable."); }
    const body = bytes(answer.body);
    post({ type: "answer", id, status: answer.status, kind: answer.type, body, policy: answer.policy ?? null }, [body]);
  }

  function seed({ rows: next, hooks: shapes }) {
    const known = activity, books = new Set();
    rows = next; hooks = shapes; activity = new Map();
    for (const row of rows) if (row.logbook && row.runId) {
      const key = `${row.logbook}/${row.runId}`;
      activity.set(key, { activity: row.activity, now: known.get(key)?.now ?? null });
      if (!known.has(key)) books.add(row.logbook);
    }
    post({ type: "activity", all: Object.fromEntries(activity), books: [...books] });
  }

  function light({ hooks: ids, books, folders, at }) {
    if (!rows) return;
    const changes = {};
    let refresh = false;
    const update = (key, change) => {
      const entry = activity.get(key), next = { ...entry, ...change };
      if (JSON.stringify(next) !== JSON.stringify(entry)) { activity.set(key, next); changes[key] = next; }
    };
    try {
      if (folders || ids.length) {
        const walked = watchPlan(configured), plan = walkNumber();
        hold(4);
        post({ type: "plan", plan, light: true, folders: walked });
      }
      for (const id of ids) {
        const notes = readHookNotes(configured.find(source => source.id === id).path);
        if (hooks[id] === undefined || hookShape(notes) !== hooks[id]) { refresh = true; continue; }
        for (const slot of notes.slots) for (const row of rows.filter(row => row.source === id && row.slot === slot.name)) {
          const key = row.logbook && row.runId ? `${row.logbook}/${row.runId}` : null, was = key ? activity.get(key)?.activity : row.activity;
          if (was === undefined || was === slot.at) continue;
          if (was === null || at - was >= AGENT_QUIET_MS) refresh = true;
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
    } catch { refresh = true; }
    post({ type: "activity", changes, refresh });
  }

  const handlers = { build: planWatchers, read: readAndBuild, publish, ask, seed, light, drop: () => { read = built = model = null; } };
  port.on("message", message => handlers[message.type](message));
}

if (!isMainThread && workerData?.board) serve(parentPort, workerData.board);
