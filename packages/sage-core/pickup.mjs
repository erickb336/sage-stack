import { offerOf, replaceOf } from "./chiefs.mjs";
import { ENDED } from "./milestone-rules.mjs";
import { runningRuns, sessionState } from "./chief-live.mjs";

export const PICKUP_TABLES = ["tasks", "runs", "gates", "decisions"];
export const FRESH_MS = 2 * 60_000;
const open = (task) => !ENDED.includes(task.state);
const FREE = ["unclaimed", "free"];
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) + "Z" : "");

export function stoppedState({ id, rows, record, nowMs, probe }) {
  if (record && !record.ended && nowMs - record.at < FRESH_MS) return undefined;
  const running = runningRuns(rows.runs, id).length, gates = rows.gates.filter((g) => g.chief === id && !g.answer).length;
  const state = sessionState(record, { running, gates }, nowMs, probe());
  return state.state === "stopped" ? state : undefined;
}

export function pickupPlan({ to, chiefs, rows, records, probe, now, released, moved }) {
  const me = chiefs.find((c) => c.id === to);
  if (!me) return undefined;
  const nowMs = Date.parse(now), groups = [];
  const ofTask = (filter) => rows.tasks.filter((t) => open(t) && filter(t)).map((t) => t.id);
  for (const chief of chiefs) {
    if (chief.id === to) continue;
    const held = {
      tasks: ofTask((t) => t.chief === chief.id),
      lost: runningRuns(rows.runs, chief.id).map((r) => r.id),
      queued: rows.runs.filter((r) => r.chief === chief.id && r.status === "queued").map((r) => r.id),
      gates: rows.gates.filter((g) => g.chief === chief.id && !g.answer).map((g) => g.id),
    };
    if (!Object.values(held).some((ids) => ids.length)) continue;
    const record = records(chief.id), state = stoppedState({ id: chief.id, rows, record, nowMs, probe });
    if (!state) continue;
    groups.push({ from: chief.id, fromProvider: chief.provider, reason: state.reason, since: iso(record?.at), ...held });
  }
  const free = new Map();
  for (const task of rows.tasks.filter((t) => !t.chief && open(t))) {
    const from = released(task) ?? "";
    if (from === to) continue;
    const fromProvider = from ? chiefs.find((c) => c.id === from)?.provider ?? "" : moved(task) ?? "";
    if (!from && fromProvider && fromProvider !== me.provider) continue;
    const key = `${from}\t${fromProvider}`;
    if (!free.has(key)) free.set(key, { from, fromProvider, reason: FREE[from ? 0 : 1], since: "", tasks: [], lost: [], queued: [], gates: [] });
    free.get(key).tasks.push(task.id);
  }
  const offers = rows.tasks.filter((t) => offerOf(t)).map((t) => ({ task: t.id, id: offerOf(t).id, to: offerOf(t).to }));
  const all = [...groups, ...free.values()].map((g) => ({ ...g, toProvider: me.provider }));
  return all.length || offers.length ? { to, at: now, groups: all, offers } : undefined;
}

export const handoverOf = (decision) => {
  try {
    const h = decision.handover ? JSON.parse(decision.handover) : / → (?:approve|replace)$/.test(decision.decision ?? "") ? replaceOf({ question: decision.decision }) : null;
    return h && typeof h.to === "string" && typeof h.from === "string" ? { fromProvider: "", toProvider: "", ...h, tasks: Array.isArray(h.tasks) ? h.tasks : [] } : undefined;
  } catch { return undefined; }
};
const list = (ids) => ids.join(", ");
export function pickupText(g, to) {
  const parts = [g.tasks.length && `tasks ${list(g.tasks)}`, g.lost.length && `lost runs ${list(g.lost)}`, g.queued.length && `queued runs ${list(g.queued)}`, g.gates.length && `open gates ${list(g.gates)}`].filter(Boolean);
  const source = g.from ? `${g.from}${g.fromProvider ? ` (${g.fromProvider})` : ""}` : `no chief${g.fromProvider ? ` (moved from the ${g.fromProvider} logbook)` : ""}`;
  const why = g.reason === FREE[0] ? "it unclaimed them" : g.reason === FREE[1] ? "they had no owning chief" : `its session stopped (${g.reason})${g.since ? ` at ${g.since}` : ""}`;
  return `pick-up from ${source} to ${to}: ${parts.join("; ")}; ${why}`;
}

export function pickupDelta({ reference: { to, at, groups, offers } }, rows) {
  const decisions = [];
  for (const g of groups) {
    const holder = FREE.includes(g.reason) ? "" : g.from;
    for (const id of g.tasks) {
      const task = rows.tasks.find((t) => t.id === id);
      if (!task || (task.chief ?? "") !== holder || !open(task)) return false;
      task.chief = to;
    }
    for (const id of [...g.lost, ...g.queued]) {
      const run = rows.runs.find((r) => r.id === id), lost = g.lost.includes(id);
      if (!run || run.chief !== g.from || run.status !== (lost ? "running" : "queued")) return false;
      Object.assign(run, lost ? { status: "failed", ended: at, failure: `lost: its session stopped at ${g.since || at}` } : { chief: to });
    }
    for (const id of g.gates) {
      const gate = rows.gates.find((x) => x.id === id);
      if (!gate || gate.chief !== g.from || gate.answer) return false;
      gate.chief = to;
    }
    const handover = { from: g.from, to, fromProvider: g.fromProvider, toProvider: g.toProvider, reason: g.reason, since: g.since, tasks: g.tasks, lost: g.lost, queued: g.queued, gates: g.gates };
    decisions.push({ at, task: "", decision: pickupText(g, to), why: "pick-up", handover: JSON.stringify(handover) });
  }
  for (const o of offers) {
    const task = rows.tasks.find((t) => t.id === o.task);
    if (!task || offerOf(task)?.id !== o.id) return false;
    task.offer = "";
    decisions.push({ at, task: o.task, decision: `${o.task} offer ${o.id} to ${o.to} ended: offers are gone, and pick-up passes work on`, why: "pick-up" });
  }
  rows.decisions.push(...decisions);
  return true;
}

export function pickupsOf(decisions) {
  const events = new Map(), seen = new Set();
  for (const row of decisions) {
    const h = row.why === "pick-up" && row.handover ? handoverOf(row) : undefined;
    const key = `${row.at}\t${h?.to}`, once = `${key}\t${h?.from}\t${h?.fromProvider}`;
    if (!h || seen.has(once)) continue;
    seen.add(once);
    if (!events.has(key)) events.set(key, { at: row.at, to: h.to, toProvider: h.toProvider, tasks: 0, gates: 0, queued: 0, sources: [], lost: [] });
    const event = events.get(key), count = (ids) => (Array.isArray(ids) ? ids.length : 0);
    const source = { from: h.from, fromProvider: h.fromProvider, tasks: h.tasks.length, gates: count(h.gates), queued: count(h.queued), passedOn: !FREE.includes(h.reason) && h.from !== h.to };
    for (const kind of ["tasks", "gates", "queued"]) event[kind] += source[kind];
    event.sources.push(source);
    event.lost.push(...(Array.isArray(h.lost) ? h.lost : []));
  }
  return [...events.values()];
}
