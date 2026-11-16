import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pageFile, pageTaskFolder, pageType } from "../core/index.mjs";
import { listPages } from "./pages.mjs";
import { designVersions, headingId, readerUrl } from "./reader.mjs";

export const MAX = 8;
const RUN = /^R[1-9]\d*$/, TASK = /^T[1-9]\d*$/;
const ASKERS = ["designer", "pe", "investigate"];
const PICTURE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const time = at => Date.parse(at) || 0;
const modified = (folder, name) => { try { return lstatSync(join(folder, name)).mtimeMs; } catch { return 0; } };

function fileItem(owner, logbook, file, extra) {
  if (!pageType(file)) return null;
  const folder = pageTaskFolder(logbook, owner.id), gone = !folder || !pageFile(folder, file), at = extra.part ? headingId(extra.part) : null;
  const name = file.split("/").at(-1), pages = `/pages/${logbook}/${owner.id}/${file}`;
  const shape = /\.md$/.test(file) ? { kind: "page", frame: "reader", src: readerUrl(owner.key, "page", file, { in: "board" }), open: `${readerUrl(owner.key, "page", file)}${at ? `#${at}` : ""}`, ...(at && { at }) }
    : /\.html$/.test(file) ? { kind: "prototype", frame: "script", src: pages, open: pages }
    : PICTURE.test(file) ? { kind: "picture", frame: "picture", src: pages, open: pages }
    : { kind: "file", frame: "plain", src: pages, open: pages };
  return { task: owner.id, file, title: name, sub: extra.part ? `${file} · ${extra.part}` : file, ...shape, ...extra, ...(gone && { gone: true }) };
}

export function gateMaterial({ model, task, gate, message }) {
  const logbook = task.project.slice(task.project.indexOf("/") + 1), items = [], seen = new Set();
  const add = item => {
    const id = item && `${item.task}/${item.file ?? item.kind}`;
    if (id && !seen.has(id)) { seen.add(id); items.push(item); }
  };
  const blocks = [], walk = list => (Array.isArray(list) ? list : []).forEach(block => block?.t === "section" ? walk(block.body) : block?.t === "page" && blocks.push(block));
  walk(message?.blocks);
  for (const block of blocks) {
    if (typeof block.file !== "string" || !pageType(block.file)) continue;
    const id = block.task ?? task.id, owner = TASK.test(id) && model.tasks.find(item => item.project === task.project && item.id === id);
    const answer = typeof block.answer === "string" ? block.answer : undefined, part = typeof block.part === "string" && /\.md$/.test(block.file) ? block.part : undefined;
    const why = `${gate.id} names it in the question${owner && owner.id !== task.id ? `; it is a page of ${owner.id}` : ""}.${answer ? ` It shows answer ${answer}.` : ""}`;
    const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : block.file;
    add(owner ? { ...fileItem(owner, logbook, block.file, { group: "named", why, answer, part }), title }
      : { task: id, file: block.file, group: "named", kind: "page", frame: null, title, sub: `no task ${id} in this logbook on the board`, why });
  }
  const folder = pageTaskFolder(logbook, task.id), versions = designVersions(folder).filter(version => !version.candidate && !version.final);
  if (versions.length) {
    const today = versions.filter(version => version.today).at(-1) ?? versions.at(-1);
    add({ task: task.id, group: "task", kind: "design", frame: "reader", title: `Design · ${versions.length} ${versions.length === 1 ? "version" : "versions"}`, sub: `${today.name} is the newest${today.run ? ` · designer ${today.run}` : ""}`,
      src: readerUrl(task.key, "design", null, { in: "board" }), open: readerUrl(task.key, "design", null), why: `The design of ${task.id}.` });
    if (today.prototype) add({ ...fileItem(task, logbook, `designs/${today.name}/${today.prototype}`, { group: "task", why: `The prototype of design ${today.name}, the newest version.` }), title: `${today.title ?? today.name} prototype` });
  }
  const pages = folder ? listPages(folder).pages.filter(page => /\.md$/.test(page.name) && !page.name.startsWith("designs/")) : [];
  for (const page of pages.map(page => ({ ...page, at: modified(folder, page.name) })).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))) {
    add(fileItem(task, logbook, page.name, { group: "task", why: `A page in ${task.id}'s pages folder.` }));
  }
  const recorded = RUN.test(gate.run ?? "") ? task.runs.find(run => run.id === gate.run) ?? null : null;
  const run = gate.run ? recorded : [...task.runs].filter(item => ASKERS.includes(item.role) && RUN.test(item.id)).sort((a, b) => time(b.started) - time(a.started))[0] ?? null;
  if (run) for (const kind of ["report", "brief"]) {
    add({ task: task.id, file: `${kind}/${run.id}`, group: "run", kind, frame: "reader", title: `${kind === "report" ? "Report" : "Brief"} of ${run.id}`, sub: `${run.role} ${run.id}`,
      src: readerUrl(task.key, kind, run.id, { in: "board" }), open: readerUrl(task.key, kind, run.id),
      why: recorded ? `${run.id} asked ${gate.id}: its ${kind}.` : `The logbook does not record which run asked ${gate.id}, so this is the newest ${run.role} run of ${task.id}.` });
  }
  const asking = items.filter(item => item.group === "run"), rest = items.filter(item => item.group !== "run"), kept = rest.slice(0, MAX - asking.length);
  return { items: [...kept, ...asking], more: rest.length - kept.length, ...(gate.run && !recorded && { missing: String(gate.run).slice(0, 20) }) };
}
