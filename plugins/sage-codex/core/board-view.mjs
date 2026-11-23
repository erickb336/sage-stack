import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readBoardSources } from "./board-reader.mjs";
import { buildBoardModel, projectName } from "./board-model.mjs";
import { renderBoardText, renderTaskText, renderBoardStatus } from "./board-render.mjs";
import { createStateTool } from "./state.mjs";

export function landingRule(sources, logbookKey = null) {
  const { mergeCheck, boardLandingCheck } = createStateTool({ defaultRoot: () => { throw new Error("the board names each root"); } });
  const roots = new Map(sources.map(source => [source.id, source.path]));
  return (id, sha, pr, book) => {
    const checkout = isAbsolute(book?.checkout ?? "") && { logbook: book.key.slice(id.length + 1), root: book.checkout };
    const root = roots.get(id), result = logbookKey === null
      ? mergeCheck(sha, { SAGE_HOME: root }, { pr, readOnly: true, checkout })
      : boardLandingCheck(sha, { SAGE_HOME: root }, logbookKey.slice(id.length + 1), pr, checkout);
    return { ok: result.ok, scope: logbookKey === null ? "all" : "project", reason: result.reason.split(`${root}${sep}`).join("") };
  };
}

export const sessionSources = (root, shared, provider) => [{ id: "current", label: "Current provider", path: root, hookProvider: provider }, { id: "shared", label: "Shared", path: shared }];
export const sessionRoots = (root, legacy, provider) => [...new Set([root, ...legacy].map(path => resolve(path)))].map((path, i, roots) => ({ path, provider: i === 0 && roots.length > 1 ? provider : null }));

const fold = value => String(value).normalize("NFC").toLowerCase();
const bare = name => name.replace(/-[0-9a-f]{6}$/, "");
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
function checkoutOf(folder) {
  const start = real(folder);
  try {
    for (let dir = start; ; dir = dirname(dir)) {
      const dotGit = join(dir, ".git"), kind = lstatSync(dotGit, { throwIfNoEntry: false });
      if (kind?.isDirectory()) return dir;
      if (kind?.isFile()) {
        const gitDir = real(resolve(dir, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))[1].trim()));
        const common = real(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
        return dirname(gitDir) === join(common, "worktrees") ? dirname(common) : dir;
      }
      if (dir === dirname(dir)) return start;
    }
  } catch { return start; }
}
function groupsOfThis(snapshots, project, here, now) {
  const projects = snapshots.flatMap(source => source.projects), root = checkoutOf(project);
  let mine = projects.filter(book => book.key === here);
  if (!mine.length) mine = projects.filter(book => book.checkout && real(book.checkout) === root);
  if (!mine.length) mine = projects.filter(book => book.shared && (book.checkouts ?? []).some(item => real(item.root) === root));
  if (!mine.length) mine = projects.filter(book => !book.shared && !book.old && fold(bare(book.name)) === fold(basename(root)));
  return buildBoardModel(snapshots, { now }).projects.filter(group => group.books.some(key => mine.some(book => book.key === key)));
}
function groupsNamed(snapshots, name, now) {
  const projects = snapshots.flatMap(source => source.projects);
  return buildBoardModel(snapshots, { now }).projects.filter(group => [...group.books, group.key, group.name, ...group.terms, ...group.terms.map(bare), ...projects.filter(book => group.books.includes(book.key)).map(projectName)].some(term => fold(term) === fold(name)));
}

export function boardProjectKey({ sources, project = null, name = null, providerRoots = [], now = new Date().toISOString() }) {
  const snapshots = readBoardSources(sources, { now: Date.parse(now), providerRoots });
  const groups = name === null ? groupsOfThis(snapshots, project, null, now) : groupsNamed(snapshots, name, now);
  return groups.length === 1 ? groups[0].key : null;
}

export function boardView({ sources, scope = "all", project = null, logbookKey = null, here = null, providerRoots = [], taskId = null, format = "chat", port, now = new Date().toISOString() }) {
  if (!["chat", "task", "status"].includes(format)) throw new TypeError("unknown board format");
  if (taskId !== null && !/^T[1-9]\d*$/.test(taskId)) throw new TypeError("task id must be T followed by a positive number");
  const snapshots = readBoardSources(sources, { now: Date.parse(now), logbookKey, providerRoots });
  const projects = snapshots.flatMap(source => source.projects);
  let keys = new Set(projects.map(book => book.key));
  if (logbookKey !== null) {
    if (!projects.some(book => book.key === logbookKey)) throw new RangeError("No recorded logbook matches this project.");
    keys = new Set([logbookKey, ...projects.filter(book => book.old?.of === logbookKey).map(book => book.key)]);
  }
  else if (projects.some(book => book.key === scope)) keys = new Set([scope]);
  else if (scope !== "all") {
    let selected;
    if (scope === "this") {
      if (!project) throw new RangeError("this board needs the current project");
      selected = groupsOfThis(snapshots, project, here, now);
    } else selected = groupsNamed(snapshots, scope, now);
    if (!selected.length || scope !== "this" && selected.length !== 1) throw new RangeError(selected.length ? `The project is ambiguous. Choose: ${selected.flatMap(group => group.books).join(", ")}` : "No recorded project matches this board scope.");
    keys = new Set(selected.flatMap(group => group.books));
  }
  const model = buildBoardModel(snapshots.map(source => ({ ...source, projects: source.projects.filter(book => keys.has(book.key)) })), { now, landing: landingRule(sources, logbookKey) });
  if (taskId) {
    const found = model.tasks.filter(task => task.id === taskId), own = found.filter(task => !task.old);
    const tasks = found.length > 1 && own.length === 1 ? own : found;
    if (tasks.length !== 1) {
      if (tasks.length) throw new RangeError(`The task is ambiguous. Choose its project: ${tasks.map(task => task.project).join(", ")}`);
      const nearby = [...new Set(model.tasks.map(task => task.id))].sort((a,b) => Math.abs(Number(a.slice(1)) - Number(taskId.slice(1))) - Math.abs(Number(b.slice(1)) - Number(taskId.slice(1)))).slice(0, 3);
      throw new RangeError(`Unknown task ${taskId}. Nearest recorded ids: ${nearby.join(", ") || "none"}. No task was opened.`);
    }
    return renderTaskText(tasks[0]);
  }
  if (format === "task") throw new TypeError("task view needs a task id");
  return format === "status" ? renderBoardStatus(model) : renderBoardText(model, { port });
}
