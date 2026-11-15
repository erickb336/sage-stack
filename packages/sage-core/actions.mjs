import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { shellCommands } from "./command-reader.mjs";

export const ACTIONS_KEPT = 20, ACTIONS_DAYS = 7;
const TAIL = 8 * 1024, FILE_MAX = 8 * 1024, DAY = 86_400_000;
const KEYS = "at call kind mark run target tool v";
const KINDS = new Set("file search command web agent message mcp other end".split(" ")), MARKS = new Set(["ok", "refused", "failed", "end"]);
const RUN = /^R[1-9]\d*$/, TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

const fine = (record, run) => !!record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).sort().join(" ") === KEYS
  && record.v === 1 && typeof record.at === "string" && TIME.test(record.at) && !Number.isNaN(Date.parse(record.at))
  && RUN.test(record.run) && record.run === run && typeof record.tool === "string" && /^[A-Za-z0-9][\w.:-]{0,63}$/.test(record.tool) && KINDS.has(record.kind)
  && (record.target === null || typeof record.target === "string" && record.target.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(record.target))
  && typeof record.call === "string" && /^[0-9a-f]{8}$/.test(record.call) && MARKS.has(record.mark);

const WORDS = { outside: noun => `a ${noun} outside the project`, secret: noun => `a secrets ${noun}`, odd: noun => `a ${noun} with an unusual name`, command: "a command", agent: "an agent" };
const SECRET_FILE = /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|keystore|jks)|id_.*|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials.*|.*secret.*|.*token.*)$/i, SECRET_FOLDERS = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube"]);
const SKIPPED = new Set(["cd", "pushd", "popd"]);
const SEGMENT = /^[A-Za-z0-9._@+-]+$/, PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,31}$/, ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBCOMMANDS = {
  git: new Set("add apply bisect blame branch checkout cherry-pick clone commit diff fetch grep init log merge merge-base merge-tree mv pull push rebase reflog remote reset restore revert rev-list rev-parse rm show stash status switch tag worktree".split(" ")),
  npm: new Set("ci exec install ls pack run test version view".split(" ")),
  gh: new Set("api auth issue pr release repo run workflow".split(" ")),
};
const inside = (base, path) => { const rel = relative(base, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel) ? rel : null; };
const cut = text => text.length > 80 ? `…${text.slice(-79)}` : text;

const entry = path => { try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return undefined; } };
const real = path => { try { return realpathSync.native(path); } catch { return path; } };
const small = path => entry(path)?.isFile() ? readFileSync(path, "utf8").slice(0, 4096).trim() : "";
function worktreeHolding(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dot = join(dir, ".git"), stat = entry(dot);
    if (stat?.isDirectory()) return { root: dir, common: real(dot) };
    const link = stat?.isFile() && /^gitdir: (.+)$/m.exec(small(dot))?.[1];
    if (link) { const git = resolve(dir, link), common = small(join(git, "commondir")); return { root: dir, common: real(common ? resolve(git, common) : git) }; }
    if (dir === dirname(dir)) return undefined;
  }
}

function pathOf(value, cwd, home, noun) {
  if (typeof value !== "string" || !value || typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const path = resolve(cwd, value), own = worktreeHolding(path), project = own && worktreeHolding(resolve(cwd));
  const root = project && own.common === project.common ? own.root : resolve(cwd), rel = inside(root, path);
  if (rel === null || inside(root, resolve(home ?? homedir())) !== null) return WORDS.outside(noun);
  if (rel === "") return ".";
  const parts = rel.split(sep);
  if (parts.some(part => SECRET_FOLDERS.has(part.toLowerCase()) || SECRET_FILE.test(part))) return WORDS.secret(noun);
  return parts.every(part => SEGMENT.test(part)) ? cut(rel) : WORDS.odd(noun);
}

function commandOf(value) {
  const text = Array.isArray(value) ? value.join(" ") : value;
  if (typeof text !== "string" || !text.trim()) return null;
  let list;
  try { list = shellCommands(text).filter(command => !command.host && command.words.length); } catch { return WORDS.command; }
  const first = list.findIndex(command => !SKIPPED.has(command.words.find(word => !ASSIGN.test(word))));
  if (first > 0) list = list.slice(first);
  if (!list.length) return WORDS.command;
  const words = list[0].words, at = words.findIndex(word => !ASSIGN.test(word)), base = at < 0 ? "" : words[at].split("/").at(-1);
  let name = PROGRAM.test(base) ? base : WORDS.command, next = at + 1;
  if (name === "git") while (["-C", "-c"].includes(words[next]) || words[next]?.startsWith("-")) next += ["-C", "-c"].includes(words[next]) ? 2 : 1;
  if (SUBCOMMANDS[name]?.has(words[next])) name += ` ${words[next]}`;
  return list.length > 1 ? `${name} +${list.length - 1} more` : name;
}

function hostOf(value) {
  try {
    const host = new URL(String(value)).hostname;
    return /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/.test(host) || /^\[[0-9a-f:.]{2,45}\]$/.test(host) ? host : null;
  } catch { return null; }
}

function agentOf(input) {
  const type = String(input.subagent_type ?? ""), run = /^Run (R[1-9]\d{0,8}) · /.exec(String(input.prompt ?? "").split("\n", 1)[0])?.[1];
  return [/^sage:[a-z][a-z-]{1,30}$/.test(type) ? type : WORDS.agent, run].filter(Boolean).join(" ");
}

const FILES = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]), SEARCHES = { Grep: "path", Glob: "folder" }, SHELLS = new Set(["Bash", "Monitor", "PowerShell"]), AGENTS = new Set(["Agent", "Task"]);
function shapeOf(tool, input, cwd, home) {
  const mcp = /^mcp__([A-Za-z0-9][A-Za-z0-9_-]{0,30})__([A-Za-z0-9_-]{1,31})$/.exec(tool);
  if (mcp?.[1] === "terminal") return { tool: `${mcp[1]}:${mcp[2]}`, kind: "command", target: commandOf(input.command) };
  if (mcp) return { tool: `${mcp[1]}:${mcp[2]}`, kind: "mcp", target: null };
  if (!/^[A-Za-z][\w.-]{0,63}$/.test(tool)) return { tool: "unknown", kind: "other", target: null };
  if (FILES.has(tool)) return { tool, kind: "file", target: pathOf(input.file_path ?? input.notebook_path, cwd, home, "file") };
  if (Object.hasOwn(SEARCHES, tool)) return { tool, kind: "search", target: pathOf(input.path, cwd, home, SEARCHES[tool]) };
  if (SHELLS.has(tool)) return { tool, kind: "command", target: commandOf(input.command) };
  if (tool === "WebFetch") return { tool, kind: "web", target: hostOf(input.url) };
  if (tool === "WebSearch") return { tool, kind: "web", target: null };
  if (AGENTS.has(tool)) return { tool, kind: "agent", target: agentOf(input) };
  if (tool === "SendMessage") return { tool, kind: "message", target: /^(?:main|lead-t[1-9]\d*|R[1-9]\d*)$/i.test(input.to ?? "") ? input.to : null };
  return { tool, kind: "other", target: null };
}

export function actionOf({ run, tool, input, call, cwd, mark = "ok", at = Date.now(), home } = {}) {
  if (!RUN.test(run ?? "") || !MARKS.has(mark)) return null;
  const shape = mark === "end" ? { tool: "end", kind: "end", target: null } : shapeOf(String(tool ?? ""), input && typeof input === "object" ? input : {}, cwd, home);
  const target = typeof shape.target === "string" ? shape.target.replace(/[\p{Cc}\p{Cf}]/gu, "") || null : null;
  const record = { v: 1, at: new Date(at).toISOString(), run, tool: shape.tool, kind: shape.kind, target,
    call: typeof call === "string" && call ? createHash("sha256").update(call).digest("hex").slice(0, 8) : "00000000", mark };
  return fine(record, run) ? record : null;
}

const linkError = (what, stat) => Object.assign(new Error(`${what} is not a plain folder`), { code: stat?.isSymbolicLink() ? "ELOOP" : "ENOTDIR" });
const plainFolder = (path, what) => { const stat = lstatSync(path, { throwIfNoEntry: false }); if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw linkError(what, stat); return stat; };
function openPlain(file, flags) {
  for (let tries = 0; ; tries++) {
    const fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600), stat = fstatSync(fd);
    if (stat.isFile() && (stat.nlink === 1 || stat.nlink === 0 && (!(flags & (constants.O_WRONLY | constants.O_RDWR)) || tries === 3))) return { fd, stat };
    closeSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw Object.assign(new Error("the action file is not one regular file"), { code: "ELOOP" });
  }
}
function readTail(fd, size, bytes) {
  const start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
  let read = 0, count;
  while (read < buffer.length && (count = readSync(fd, buffer, read, buffer.length - read, start + read)) > 0) read += count;
  const lines = buffer.subarray(0, read).toString("utf8").split("\n");
  if (start > 0) lines.shift();
  lines.pop();
  return lines;
}

export function appendAction(logbook, record, { now = Date.now() } = {}) {
  if (!fine(record, record?.run)) throw new TypeError("appendAction takes one record of actionOf");
  if (!plainFolder(logbook, "the logbook")) throw Object.assign(new Error("the logbook folder does not exist"), { code: "ENOENT" });
  const dir = join(logbook, "actions"), file = join(dir, `${record.run}.jsonl`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  plainFolder(dir, "actions");
  const { fd, stat } = openPlain(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT);
  let size;
  try {
    const end = fstatSync(fd).size, last = Buffer.alloc(1), torn = end > 0 && readSync(fd, last, 0, 1, end - 1) === 1 && last[0] !== 10;
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(record)}\n`); size = fstatSync(fd).size;
  } finally { closeSync(fd); }
  if (size > FILE_MAX) compact(dir, file, record.run);
  if (stat.size === 0) sweepActions(logbook, now);
}

function compact(dir, file, run) {
  const { fd, stat } = openPlain(file, constants.O_RDONLY);
  let lines;
  try { lines = readTail(fd, stat.size, stat.size); } finally { closeSync(fd); }
  const temp = join(dir, `.${run}.${randomUUID()}.tmp`);
  try { writeFileSync(temp, `${lines.slice(-ACTIONS_KEPT).join("\n")}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  catch (error) { rmSync(temp, { force: true }); throw error; }
}

export function sweepActions(logbook, now = Date.now()) {
  const dir = join(logbook, "actions");
  if (!plainFolder(dir, "actions")) return 0;
  let gone = 0;
  for (const name of readdirSync(dir)) {
    if (!/^(?:R[1-9]\d*\.jsonl|\.R[1-9]\d*\.[0-9a-f-]{36}\.tmp)$/.test(name)) continue;
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory() && now - stat.mtimeMs > ACTIONS_DAYS * DAY) { try { unlinkSync(join(dir, name)); gone++; } catch {} }
  }
  return gone;
}

export function readActions(logbook, run, limit = ACTIONS_KEPT) {
  if (!RUN.test(run)) throw new TypeError("an action file belongs to one run, R<n>");
  const dir = join(logbook, "actions"), found = { actions: [], dropped: 0 };
  const identity = () => { const book = plainFolder(logbook, "the logbook"), stat = plainFolder(dir, "actions"); return stat && `${book.dev}:${book.ino}/${stat.dev}:${stat.ino}`; };
  const before = identity();
  if (!before) return found;
  let opened;
  try { opened = openPlain(join(dir, `${run}.jsonl`), constants.O_RDONLY); }
  catch (error) { if (error.code === "ENOENT") return found; throw error; }
  try {
    if (identity() !== before) throw Object.assign(new Error("actions changed during the read"), { code: "ELOOP" });
    for (const line of readTail(opened.fd, opened.stat.size, TAIL)) {
      if (!line) continue;
      let record = null;
      try { record = JSON.parse(line); } catch {}
      if (fine(record, run)) found.actions.push(record); else found.dropped++;
    }
    found.actions = found.actions.slice(-limit);
    return found;
  } finally { closeSync(opened.fd); }
}
