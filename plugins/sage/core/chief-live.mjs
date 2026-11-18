import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CHIEF } from "./chiefs.mjs";
import { nameProblem } from "./logbook-fields.mjs";
import { plainName } from "./shared-root.mjs";

export const BEAT_MS = 60_000;
export const STOPPED_MS = 30 * 60_000;
export const SKEW_MS = 5 * 60_000;
export const NAMES_FILE = "chief-names.json";
export const LIVE_FOLDER = "live";

export const CONFIRM_MS = 60_000;
export const PASS_ON_MS = 8 * 60 * 60_000;
const START_MS = 2000, BOOT_MS = 60_000, CLEAR_MS = 10 * 60_000;
export const END_REASONS = ["prompt_input_exit", "logout", "other", "off"];

function liveDir(dir) {
  const live = join(dir, LIVE_FOLDER);
  try { mkdirSync(live); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return lstatSync(live).isDirectory() ? live : null;
}
function liveFile(dir, chief) {
  const live = liveDir(dir);
  return live && join(live, `${chief}.json`);
}
function readLive(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 64 * 1024) return {};
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function writeLive(file, data) {
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(data)}\n`, { flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function programOf(pid, probe, prior, now) {
  const pidStart = Number.isSafeInteger(pid) && pid > 1 && probe ? probe.started(pid) : NaN;
  if (!Number.isFinite(pidStart)) return {};
  const machine = typeof probe.machine === "string" && probe.machine ? probe.machine : null, boot = Number.isFinite(probe.boot) ? probe.boot : null;
  const same = prior.pid === pid && Math.abs(prior.pidStart - pidStart) <= START_MS && prior.machine === machine && Math.abs(prior.boot - boot) <= BOOT_MS && Number.isFinite(prior.seen);
  const seen = same ? prior.seen : now;
  return { pid, pidStart, machine, boot, seen, confirmed: !!(machine && boot !== null && same && (prior.confirmed === true || now - seen >= CONFIRM_MS)) };
}

export function chiefBeat({ last, mode, now, project, native, provider, tool, env, pid }) {
  const changed = last ? last.sageMode !== mode.sageMode || last.autopilot !== mode.autopilot : mode.sageMode, age = now - last?.at;
  if (!changed && (!last || (age >= 0 && age < BEAT_MS))) return last;
  try {
    const { dir, shared, row } = tool.locate(project, env);
    if (shared) {
      const file = liveFile(dir, tool.chiefFor(project, native, env));
      if (file) {
        const prior = readLive(file), off = last?.sageMode === true && mode.sageMode === false;
        const ended = off ? endOf("off", now) : mode.sageMode ? undefined : prior.ended;
        writeLive(file, { provider, checkout: row.root, ...mode, at: new Date(now).toISOString(), ...programOf(pid, tool.sessionProbe?.(dir), prior, now), ...(ended ? { ended } : {}) });
      }
    }
  } catch {}
  return { ...mode, at: now };
}

const endOf = (reason, now) => ({ at: new Date(now).toISOString(), reason });

export function chiefEnd({ project, native, reason, now, tool, env }) {
  if (!END_REASONS.includes(reason)) return false;
  try {
    const { dir, shared } = tool.locate(project, env), chief = shared && tool.chiefFor(project, native, env, true);
    const file = chief && liveFile(dir, chief);
    if (!file) return false;
    writeLive(file, { ...readLive(file), ended: endOf(reason, now) });
    return true;
  } catch { return false; }
}

export function chiefResume({ project, native, pid, now, tool, env }) {
  try {
    const { dir, shared } = tool.locate(project, env), chief = shared && tool.chiefFor(project, native, env, true), file = chief && liveFile(dir, chief);
    const prior = file ? readLive(file) : {};
    if (prior.sageMode !== true) return false;
    const { ended, pid: _pid, pidStart, machine, boot, seen, confirmed, ...rest } = prior;
    writeLive(file, { ...rest, at: new Date(now).toISOString(), ...programOf(pid, tool.sessionProbe?.(dir), {}, now) });
    return true;
  } catch { return false; }
}

const noteFile = (dir, program) => join(dir, LIVE_FOLDER, `clear-${program.pid}-${program.pidStart}.json`);
function programNow(dir, pid, tool) {
  const probe = tool.sessionProbe?.(dir), pidStart = Number.isSafeInteger(pid) && pid > 1 && probe ? probe.started(pid) : NaN;
  return Number.isFinite(pidStart) ? { pid, pidStart: Math.round(pidStart) } : null;
}
export function clearNote({ project, native, pid, now, tool, env }) {
  try {
    const { dir, shared } = tool.locate(project, env), program = shared && programNow(dir, pid, tool);
    if (!program || !liveDir(dir)) return false;
    const chief = tool.chiefFor(project, native, env, true) ?? null, file = noteFile(dir, program), prior = readLive(file);
    const clash = now - prior.at >= 0 && now - prior.at < CLEAR_MS && prior.native !== native;
    writeLive(file, clash ? { clash: true, at: now } : { chief, native, at: now });
    return true;
  } catch { return false; }
}
export function clearLink({ project, native, pid, now, tool, env }) {
  try {
    const { dir, shared } = tool.locate(project, env), program = shared && programNow(dir, pid, tool);
    if (!program) return undefined;
    const file = noteFile(dir, program), note = readLive(file), fresh = now - note.at >= 0 && now - note.at < CLEAR_MS;
    if (note.clash === true && fresh) return undefined;
    rmSync(file, { force: true });
    return typeof note.chief === "string" && fresh ? tool.chiefLink(project, native, note.chief, note.native, env) : undefined;
  } catch { return undefined; }
}

const ahead = (record, now) => record.at - now > SKEW_MS;
export function sessionState(record, { running = 0, gates = 0 } = {}, now, probe) {
  if (!record) return { state: "quiet", reason: null };
  if (record.ended && (record.ended !== "off" || !running)) return { state: "stopped", reason: "ended" };
  if (record.confirmed && record.machine && probe?.machine === record.machine) {
    const gone = !probe.alive(record.pid) || Math.abs(probe.started(record.pid) - record.pidStart) > START_MS;
    if (gone) return { state: "stopped", reason: "gone" };
  }
  if (running > 0) return { state: "live", reason: null };
  if (record.at === null || ahead(record, now)) return { state: "quiet", reason: null };
  const age = now - record.at;
  if (age >= PASS_ON_MS) return gates > 0 ? { state: "quiet", reason: null } : { state: "stopped", reason: "quiet-8h" };
  return { state: age > STOPPED_MS ? "quiet" : "live", reason: null };
}

const flag = (value) => (typeof value === "boolean" ? value : null);
export function liveRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const at = typeof data.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(data.at) ? Date.parse(data.at) : NaN;
  const checkout = typeof data.checkout === "string" && data.checkout.length <= 4096 && isAbsolute(data.checkout) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(data.checkout) ? data.checkout : null;
  const number = (value) => (Number.isFinite(value) ? value : null), ended = data.ended && typeof data.ended === "object" && END_REASONS.includes(data.ended.reason) ? data.ended.reason : null;
  const endedAt = ended && typeof data.ended.at === "string" && Number.isFinite(Date.parse(data.ended.at)) ? Date.parse(data.ended.at) : null;
  return { checkout, sageMode: flag(data.sageMode), autopilot: flag(data.autopilot), at: Number.isFinite(at) ? at : null,
    pid: Number.isSafeInteger(data.pid) ? data.pid : null, pidStart: number(data.pidStart), machine: typeof data.machine === "string" ? data.machine : null, boot: number(data.boot), confirmed: data.confirmed === true, ended, endedAt };
}
export function readLiveRecord(dir, chief) {
  return CHIEF.test(chief ?? "") ? liveRecord(readLive(join(dir, LIVE_FOLDER, `${chief}.json`))) : null;
}

export function chiefNames(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  const names = {}, bad = [];
  for (const [id, name] of Object.entries(data)) {
    if (CHIEF.test(id) && !nameProblem(name)) names[id] = name;
    else bad.push(`the name of ${CHIEF.test(id) ? id : "a key that is no chief id"} is not valid`);
  }
  return { names, bad };
}

const title = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const utc = (at) => (Number.isFinite(Date.parse(at)) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : null);
const FOLDER_MAX = 30;
const folderPart = (checkout) => {
  const name = plainName(basename(checkout)).replace(/\s+/gu, " ").trim();
  return [...name].length > FOLDER_MAX ? `${[...name].slice(0, FOLDER_MAX - 1).join("").trimEnd()}…` : name;
};
export function defaultChiefName(row, live) {
  return [title(plainName(row.provider)), live?.checkout && folderPart(live.checkout), utc(row.at)].filter(Boolean).join(" · ");
}

const iso = (ms) => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
export function boardChiefs({ rows, live = {}, names = {}, runs = [], waits = [], owners = [], now }) {
  const chiefs = rows.map((row) => {
    const record = live[row.id] ?? null, beat = record && ahead(record, now) ? null : record, heartbeat = beat?.at ?? null;
    const running = runs.filter((run) => run.chief === row.id && run.status === "running"), working = running.filter((run) => !run.clock?.stale).length, gates = waits.filter((chief) => chief === row.id).length;
    const found = sessionState(record ?? { at: null }, { running: working, gates }, now, null);
    const state = !beat && found.state === "quiet" ? null : found.state, reason = found.reason, stopped = state && state === "stopped";
    return {
      id: row.id, provider: row.provider, name: names[row.id] ?? defaultChiefName(row, beat), named: Object.hasOwn(names, row.id), startedAt: utc(row.at) ? new Date(row.at).toISOString() : null,
      checkout: beat?.checkout ?? null, sageMode: stopped ? null : beat?.sageMode ?? null, autopilot: stopped ? null : beat?.autopilot ?? null,
      heartbeat: iso(heartbeat), agents: working, tasks: owners.filter((chief) => chief === row.id).length,
      session: state, reason, endedAt: iso(record?.endedAt ?? null), confirmed: !!record?.confirmed, lost: stopped ? running.length : 0,
      passOnAt: state === "quiet" && !gates && heartbeat !== null ? iso(heartbeat + PASS_ON_MS) : null, quietAt: state === "live" && !working && heartbeat !== null ? iso(heartbeat + STOPPED_MS + 1) : null,
      waitsForOwner: state === "quiet" && gates > 0, stopped,
    };
  });
  const fold = (name) => name.normalize("NFKC").toLowerCase();
  return chiefs.map((chief) => chiefs.some((other) => other !== chief && fold(other.name) === fold(chief.name)) ? { ...chief, name: `${chief.name} · ${chief.id}` } : chief);
}

const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const holds = (chief) => `${counted(chief.tasks, "task")}, ${counted(chief.agents, "agent")}`;
export function sessionsLine(here) {
  if (!here) return "";
  const { others, running, limit } = here, share = Number.isFinite(limit) ? ` You share ${limit} agents; ${Math.max(0, limit - running)} are free.` : "";
  if (!others.length) return "sage: no other sage session works on this project now.";
  const who = (chief) => `${title(chief.provider)} session ${chief.id}`;
  if (others.length === 1) return `sage: a ${who(others[0])} also works on this project: ${holds(others[0])}. Each session keeps its own tasks.${share} Tell the user this in one line.`;
  const list = others.map((chief) => `${who(chief)} (${holds(chief)})`);
  return `sage: ${others.length} other sessions also work on this project: ${list.slice(0, -1).join(", ")} and ${list.at(-1)}. Each session keeps its own tasks.${share} Tell the user this in one line.`;
}
