import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { survey } from "./worktrees.mjs";

const ENDED = ["merged", "concluded", "abandoned"];
const LOGBOOK_FOLDERS = { briefs: "kept briefs", reports: "kept reports", kept: "kept stop reports" };
const TOP = 15;
const count = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function size(path) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  let bytes = st.blocks === undefined ? st.size : st.blocks * 512;
  if (st.isDirectory()) {
    let names = [];
    try { names = readdirSync(path); } catch {}
    for (const name of names) bytes += size(join(path, name));
  }
  return bytes;
}
const human = (n) => {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let k = 0;
  while (n >= 1000 && k < units.length - 1) { n /= 1000; k++; }
  return `${k ? n.toFixed(1) : n} ${units[k]}`;
};
const real = (path) => { try { return realpathSync(path); } catch { return undefined; } };
const inside = (child, parent) => { const r = relative(parent, child); return Boolean(r) && !r.startsWith("..") && !isAbsolute(r); };
const entries = (dir) => { try { return readdirSync(dir).sort(); } catch { return []; } };
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

const PAGES = "it is in the pages folder, and pages stay";
const baseOf = (path, folder) => [resolve(folder), real(folder)].find((b) => b && inside(resolve(path), b));

function boundary(path, folder) {
  if (/[\p{Cc}]/u.test(path)) return "its path has a control character";
  const base = baseOf(path, folder), top = real(folder), at = real(path);
  if (!base) return "it is outside the sage worktrees folder";
  for (let p = resolve(path); inside(p, base); p = dirname(p)) if (isLink(p)) return "its path has a link in it";
  if (!at || !inside(at, top)) return "it resolves outside the sage worktrees folder";
  if (at === join(top, "pages") || inside(at, join(top, "pages"))) return PAGES;
  return "";
}

const ids = (w) => w.tasks.map((t) => t.id).join(",");
const states = (w) => w.tasks.map((t) => `${t.id} ${t.state}`).join(", ");

function plan(input) {
  const { folder } = input, { all, check } = survey(input), items = [];
  for (const w of all) {
    if (w.gone || !ENDED.includes(w.reason) || !baseOf(w.path, folder)) continue;
    let why = boundary(w.path, folder), again = [];
    if (why === PAGES) continue;
    if (!why) {
      try { ({ why, again } = check(w)); } catch (e) { why = `git could not check it: ${String(e.stderr || e.message).trim().split("\n").at(-1)}`; }
    }
    items.push({ w, why, again, bytes: why ? 0 : size(w.path), leftovers: again.map((a) => ({ name: a, bytes: size(join(w.path, a)) })) });
  }
  const content = items.map((i) => [i.w.path, i.w.head ?? "", i.w.branch ?? "", i.w.tasks.map((t) => `${t.id}:${t.state}`).join(","), i.why]);
  const token = createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12);
  return { items, check, token, gone: items.filter((i) => !i.why) };
}

const keptLine = (i) => `kept ${i.w.path} · ${states(i.w)} · ${/^(uncommitted|untracked|ignored|\d+ unpushed)/.test(i.why) ? `has unsaved work: ${i.why}` : i.why}`;
const goLine = (i, verb = "remove") => `${verb} ${i.w.path} · ${states(i.w)} · ${human(i.bytes)}${i.leftovers.length ? ` · with the build leftovers ${i.leftovers.map((l) => `${l.name} (${human(l.bytes)})`).join(", ")}` : ""}`;
const NEVER = "Never planned: the logbook, its kept briefs and reports, and the pages folder.";

export function storagePlan(input) {
  const p = plan(input);
  const total = p.gone.reduce((n, i) => n + i.bytes, 0);
  return [`Cleanup plan for ${input.folder}: the worktrees of merged, concluded and abandoned tasks. A worktree of a task in any other state is never planned.`,
    ...p.gone.map((i) => goLine(i)), ...p.items.filter((i) => i.why).map(keptLine), NEVER,
    p.gone.length
      ? `The plan removes ${p.gone.length} worktree${p.gone.length === 1 ? "" : "s"}, ${human(total)} in all, with git worktree remove (no --force), and deletes no branch. After the owner's yes: sage storage clean ${p.token}`
      : "Nothing to remove."].join("\n");
}

export function storageClean(input, token, { refuse, record }) {
  if (!token) refuse("storage clean needs the token that sage storage plan prints, after the owner's yes to that plan. Nothing removed.");
  const p = plan(input);
  if (!p.gone.length) refuse("the plan has nothing to remove now. Nothing removed.");
  if (token !== p.token) refuse(`the token ${JSON.stringify(token)} is not the token of the plan now: a task state or a worktree changed since that plan, or the token is wrong. Run sage storage plan again, show it to the owner, and ask again. Nothing removed.`);
  const out = [];
  for (const i of p.gone) {
    let why = boundary(i.w.path, input.folder);
    try { if (!why) ({ why } = p.check(i.w)); } catch (e) { why = `git could not check it: ${String(e.stderr || e.message).trim().split("\n").at(-1)}`; }
    if (!why) {
      try { input.git(["-C", input.root, "worktree", "remove", i.w.path]); } catch (e) { why = `git refused: ${String(e.stderr || e.message).trim().split("\n").at(-1)}`; }
    }
    if (why) { out.push(keptLine({ ...i, why })); continue; }
    record({ task: i.w.tasks[0].id, decision: `storage clean removed the worktree ${i.w.path}`, why: `the owner's yes to plan ${token}: ${states(i.w)}, ${human(i.bytes)}` });
    out.push(goLine(i, "removed"));
  }
  out.push(`Removed ${out.filter((l) => l.startsWith("removed")).length} of ${p.gone.length} planned. No branch was deleted.`);
  return out.join("\n");
}

export function storageView(input) {
  const { dir, folder, tasks } = input;
  const out = [];
  const files = entries(dir).filter((n) => !LOGBOOK_FOLDERS[n]);
  const tables = files.filter((n) => /\.(tsv|json|md)$/.test(n) && lstatSync(join(dir, n), { throwIfNoEntry: false })?.isFile());
  const parts = [["logbook tables", tables.reduce((n, f) => n + size(join(dir, f)), 0), count(tables.length, "file")],
    ...Object.entries(LOGBOOK_FOLDERS).map(([name, label]) => [label, size(join(dir, name)), count(entries(join(dir, name)).length, "file")]),
    ["other", files.filter((f) => !tables.includes(f)).reduce((n, f) => n + size(join(dir, f)), 0), count(files.length - tables.length, "entry", "entries")]];
  out.push(`Logbook ${dir}: ${human(parts.reduce((n, p) => n + p[1], 0))}`, ...parts.map(([label, bytes, count]) => `  ${label} · ${human(bytes)} · ${count}`));
  const { all } = survey(input);
  const key = (path) => real(path) ?? resolve(path), trees = new Map(all.filter((w) => !w.gone).map((w) => [key(w.path), w]));
  const byTask = new Map(), add = (id, key, bytes) => { const row = byTask.get(id) ?? { worktrees: 0, pages: 0 }; row[key] += bytes; byTask.set(id, row); };
  let pages = 0, worktrees = 0, listed = 0;
  const other = [];
  for (const name of entries(folder)) {
    const path = join(folder, name), w = trees.get(key(path)), bytes = size(path);
    if (name === "pages") {
      pages = bytes;
      for (const task of entries(path)) add(task, "pages", size(join(path, task)));
    } else if (w && !isLink(path)) {
      worktrees += bytes;
      listed++;
      add(ids(w) || "no task", "worktrees", bytes);
    } else other.push([name, bytes]);
  }
  const others = other.reduce((n, o) => n + o[1], 0);
  out.push(`Sage worktrees folder ${folder}: ${human(pages + worktrees + others)}`,
    `  pages · ${human(pages)} · design versions and research: they stay`,
    `  task worktrees · ${human(worktrees)} · ${count(listed, "worktree")}`,
    `  other folders · ${human(others)} · ${count(other.length, "entry", "entries")}${other.length ? `: ${other.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, b]) => `${n} (${human(b)})`).join(", ")}` : ""}`);
  const state = new Map(tasks.map((t) => [t.id, t.state]));
  const rows = [...byTask].map(([id, r]) => [id, r, r.worktrees + r.pages]).sort((a, b) => b[2] - a[2]);
  if (rows.length) out.push("By task (the largest first):", ...rows.slice(0, TOP).map(([id, r, total]) => `  ${id} · ${id.split(",").map((t) => state.get(t) ?? "not in the logbook").join(",")} · ${human(total)} · worktree ${human(r.worktrees)} · pages ${human(r.pages)}`));
  if (rows.length > TOP) out.push(`  and ${rows.length - TOP} more tasks, ${human(rows.slice(TOP).reduce((n, r) => n + r[2], 0))} in all`);
  out.push("To see what a cleanup would remove: sage storage plan. It removes nothing.");
  return out.join("\n");
}
