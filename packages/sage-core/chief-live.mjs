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

function liveFile(dir, chief) {
  const live = join(dir, LIVE_FOLDER);
  try { mkdirSync(live); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return lstatSync(live).isDirectory() ? join(live, `${chief}.json`) : null;
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

const noteFile = (dir, program) => join(dir, LIVE_FOLDER, `clear-${program.pid}-${program.pidStart}.json`);
function programNow(dir, pid, tool) {
  const probe = tool.sessionProbe?.(dir), pidStart = Number.isSafeInteger(pid) && pid > 1 && probe ? probe.started(pid) : NaN;
  return Number.isFinite(pidStart) ? { pid, pidStart: Math.round(pidStart) } : null;
}
export function clearNote({ project, native, pid, now, tool, env }) {
  try {
    const { dir, shared } = tool.locate(project, env), chief = shared && tool.chiefFor(project, native, env, true), program = chief && programNow(dir, pid, tool);
    if (!program || !liveFile(dir, chief)) return false;
    writeLive(noteFile(dir, program), { chief, at: now });
    return true;
  } catch { return false; }
}
export function clearLink({ project, native, pid, now, tool, env }) {
  try {
    const { dir, shared } = tool.locate(project, env), program = shared && programNow(dir, pid, tool);
    if (!program) return undefined;
    const file = noteFile(dir, program), note = readLive(file);
    rmSync(file, { force: true });
    return typeof note.chief === "string" && now - note.at >= 0 && now - note.at < CLEAR_MS ? tool.chiefLink(project, native, note.chief, env) : undefined;
  } catch { return undefined; }
}

export function sessionState(record, { running = 0, gates = 0 } = {}, now, probe) {
  if (!record) return { state: "quiet", reason: null };
  if (record.ended) return { state: "stopped", reason: "ended" };
  if (record.confirmed && record.machine && probe?.machine === record.machine && Number.isFinite(probe.boot)) {
    const gone = Math.abs(probe.boot - record.boot) > BOOT_MS || !probe.alive(record.pid) || Math.abs(probe.started(record.pid) - record.pidStart) > START_MS;
    if (gone) return { state: "stopped", reason: "gone" };
  }
  if (running > 0) return { state: "live", reason: null };
  if (record.at === null) return { state: "quiet", reason: null };
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
  return { checkout, sageMode: flag(data.sageMode), autopilot: flag(data.autopilot), at: Number.isFinite(at) ? at : null,
    pid: Number.isSafeInteger(data.pid) ? data.pid : null, pidStart: number(data.pidStart), machine: typeof data.machine === "string" ? data.machine : null, boot: number(data.boot), confirmed: data.confirmed === true, ended };
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

export function boardChiefs({ rows, live = {}, names = {}, runs = [], waits = [], now }) {
  const chiefs = rows.map((row) => {
    const record = live[row.id] ?? null, beat = record?.at != null && record.at - now > SKEW_MS ? null : record, heartbeat = beat?.at ?? null;
    const agents = runs.filter((run) => run.chief === row.id && run.status === "running" && !run.clock?.stale).length;
    const waiting = waits.filter((chief) => chief === row.id).length;
    const silent = heartbeat === null ? null : now - heartbeat > STOPPED_MS;
    const stopped = agents ? false : silent && waiting ? false : silent;
    return {
      id: row.id, provider: row.provider, name: names[row.id] ?? defaultChiefName(row, beat), named: Object.hasOwn(names, row.id), startedAt: utc(row.at) ? new Date(row.at).toISOString() : null,
      checkout: beat?.checkout ?? null, sageMode: stopped ? null : beat?.sageMode ?? null, autopilot: stopped ? null : beat?.autopilot ?? null,
      heartbeat: heartbeat === null ? null : new Date(heartbeat).toISOString(), agents, waitsForOwner: !!(silent && !agents && waiting), stopped,
    };
  });
  const fold = (name) => name.normalize("NFKC").toLowerCase();
  return chiefs.map((chief) => chiefs.some((other) => other !== chief && fold(other.name) === fold(chief.name)) ? { ...chief, name: `${chief.name} · ${chief.id}` } : chief);
}
