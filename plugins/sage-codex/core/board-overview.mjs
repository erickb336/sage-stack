import { LAPSED, LINE, PRIORITIES, boardAnswer } from "./logbook-fields.mjs";
import { milestoneName } from "./milestone-rules.mjs";
import { AGENT_QUIET_MS, ROW_STATES, isOpen, rowState } from "./board-model.mjs";
import { TEAM } from "./role-policy.mjs";
import { runWord, taskWord } from "./state-words.mjs";
import { measureTotals, runMeasure } from "./usage.mjs";

const DAY = 86_400_000, DONE_DAYS = 7;
const ENDED = ["merged", "concluded", "abandoned"];
const MOVING = ["design", "building", "review", "ready"];
export const isMoving = task => { const row = rowState(task); return row === "work" || row === "waits" && MOVING.includes(task.column); };
const time = value => {
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const iso = value => { const at = time(value); return at === null ? null : new Date(at).toISOString(); };
const title = text => text ? `${String(text).charAt(0).toUpperCase()}${String(text).slice(1)}` : text;
const rank = priority => priority ? PRIORITIES.indexOf(priority) : PRIORITIES.length;
const STATE_ORDER = ["stuck", "lost", "active", "changing", "proposed", "done"];
const stateRank = state => STATE_ORDER.includes(state) ? STATE_ORDER.indexOf(state) : STATE_ORDER.length;
const number = id => Number(String(id).replace(/^\D+/, "")) || 0;

const LOOK = ["lost", "stuck", "stop"];
function everyAgent(agents) {
  const all = [], walk = agent => { all.push(agent); for (const child of agent.children ?? []) walk(child); };
  for (const project of agents?.projects ?? []) for (const agent of project.agents) walk(agent);
  return all;
}

function gateNeeds(task) {
  return task.reasons.map((reason, index) => {
    const [question, ...more] = String(reason.text ?? "").split(LINE).map(line => line.trim()).filter(Boolean);
    const gate = reason.gateId ? task.gates.find(row => row.id === reason.gateId) : null;
    return {
      key: reason.key ?? `${task.key}/${reason.kind}/${index}`,
      kind: reason.kind,
      question: question ?? "",
      more,
      recommendation: reason.recommendation ?? null,
      gate: reason.gateId ?? null,
      task: { key: task.key, id: task.id, title: task.title },
      chief: task.holder ?? title(task.sourceLabel) ?? null,
      ...(reason.gateId && { logbook: reason.logbook, options: reason.options, digest: reason.digest, owner: reason.owner, takeover: !!reason.replace, design: !!reason.design }),
      project: task.group,
      askedAt: gate && time(gate.at) !== null ? new Date(time(gate.at)).toISOString() : null,
    };
  });
}

const milestoneNeed = need => ({
  key: `${need.kind}/${need.key ?? ""}/${need.title}`,
  kind: need.kind,
  question: need.title,
  more: need.text ? [need.text] : [],
  recommendation: null,
  gate: null,
  task: null,
  milestone: need.milestone ? need.key : null,
  chief: null,
  project: need.group ?? null,
  askedAt: null,
});

const chiefTag = (task, chiefs, chief = task.owner && chiefs.find(item => item.key === `${task.project}/${task.owner.id}`)) => task.owner ? { id: task.owner.id, provider: title(task.owner.provider) || null, stopped: chief?.stopped ?? null, waits: !!chief?.waitsForOwner }
  : task.old ? { id: null, provider: title(task.old.provider), stopped: null, old: task.old.label } : task.shared ? null : { id: null, provider: title(task.providerStandIn), stopped: null };
const QUIET = ["done", "wait"];
const stepOf = task => task.loop.steps.find(step => !QUIET.includes(step.status)) ?? null;
const CI = { done: "pass", failed: "fail" };

function cyclesOf(task) {
  const reviews = task.cycles.some(cycle => cycle.steps.length > 0);
  const known = !task.cycles.some(cycle => cycle.steps.some(step => step.status === "unknown"));
  return { required: task.requiredCycles, clean: reviews && known ? task.cycles.filter(cycle => cycle.steps.every(step => step.status === "done")).length : null, reviews, ...(task.carriedFrom && { carriedFrom: task.carriedFrom }) };
}

const SEVERITIES = ["high", "medium", "low"];
function findingsOf(task) {
  const open = task.findings.filter(row => row.status === "open");
  return { open: open.length, closed: task.findings.filter(row => row.status === "closed").length, worst: SEVERITIES.find(severity => open.some(row => row.severity === severity)) ?? null };
}

export function projectNames(model) {
  const projects = model.projects ?? [], count = name => projects.filter(project => project.name === name).length;
  return new Map(projects.map(project => [project.key, count(project.name) > 1 ? `${project.name} (${project.key})` : project.name]));
}

function taskRow(task, chiefs) {
  const step = stepOf(task), row = rowState(task);
  return {
    key: task.key, id: task.id, title: task.title, project: task.group, state: task.state, row, word: task.word ?? null, ended: !isOpen(task),
    priority: task.priority || null, kind: task.kind || null, size: task.size || null, pr: task.pr || null,
    milestone: task.milestone ? { key: task.milestone.key, id: task.milestone.id, title: milestoneName({ id: task.milestone.id, name: task.milestone.name ?? "" }) } : null,
    chief: chiefTag(task, chiefs), needsYou: row === "needs", waits: task.waitLine?.text ?? null, cannotStart: !!task.waitLine?.never,
    waitsFor: task.waits.filter(wait => wait.id).map(wait => ({ key: `${task.project}/${wait.id}`, id: wait.id, met: wait.met })),
    why: task.reasons.length || task.problems?.length ? taskWord(task).reason : null,
    conflicts: task.mayConflict.map(other => ({ key: other.key, id: other.id, chief: other.chief })),
    step: step ? { label: step.label, status: step.status } : null, lastActivity: task.lastActivity,
    addedAt: iso(task.addedAt), doneAt: iso(task.completedAt),
    prUrl: /^[1-9]\d*$/.test(task.pr) && task.repository ? `${task.repository}/pull/${task.pr}` : null, cycles: cyclesOf(task),
    ci: CI[task.cycles[0]?.steps.find(item => item.role === "checks")?.status] ?? null, findings: findingsOf(task),
  };
}

const LIVE = ["running", "queued"], HELPERS_MAX = 20;


const retried = (task, run) => task.runs.some(other => other.role === run.role && time(other.started) > time(run.started));
const failedDecision = (task, run) => (task.decisionRows ?? []).findLast(row => String(row.decision ?? "").startsWith(`${run.id} failed: `))?.decision.slice(`${run.id} failed: `.length) ?? null;
export function runFailure(task, run, reportResult = () => null) {
  if (run.failure) return { text: String(run.failure).slice(0, 300), from: "failure" };
  const result = reportResult(), decision = !result && failedDecision(task, run);
  return result ? { text: result, from: "report" } : decision ? { text: decision.slice(0, 300), from: "decision" } : null;
}

function agentsOf(model, recent, agents, chiefs) {
  const states = new Map(agents.filter(agent => agent.task?.key && agent.runId).map(agent => [`${agent.task.key.slice(0, agent.task.key.lastIndexOf("/"))}/${agent.runId}`, agent]));
  const look = [];
  const books = (model.agents?.limits ?? []).map(book => {
    const all = model.tasks.filter(task => task.project === book.key).flatMap(task => task.runs.map(run => {
      const agent = run.status === "running" ? states.get(`${book.key}/${run.id}`) : null, state = run.status !== "running" ? null : agent?.state ?? (run.clock.stale ? "stuck" : "unk");
      return { run, task, agent, state, look: run.status === "failed" ? !task.archived && !ENDED.includes(task.state) && recent(run.ended) && !retried(task, run) : LOOK.includes(state) };
    }));
    look.push(...all.filter(item => item.look));
    const leads = new Map(all.filter(({ run }) => run.role === "lead" && LIVE.includes(run.status)).map(item => [item.task.key, item.run]));
    const leadOf = ({ run, task }) => {
      const lead = TEAM.has(run.role) && leads.get(task.key);
      return lead && time(run.started) !== null && time(lead.started) !== null && time(run.started) > time(lead.started) ? lead : null;
    };
    const known = new Set(chiefs.filter(chief => chief.logbook === book.key).map(chief => chief.id));
    const chiefOf = item => { const lead = leadOf(item), id = (lead?.status === "running" ? lead : item.run).chief; return known.has(id) ? id : null; };
    const endedOf = new Map([...leads.values()].map(lead => [lead.id, all.filter(item => !LIVE.includes(item.run.status) && !item.look && leadOf(item)?.id === lead.id)]));
    const newest = list => [...list].sort((a, b) => time(b.run.started) - time(a.run.started));
    const ended = [...endedOf.values()].flatMap(list => newest(list).slice(0, HELPERS_MAX));
    const failedBy = new Map();
    for (const item of all.filter(item => item.look && item.run.status === "failed")) {
      const lead = leadOf(item), key = lead?.status === "running" ? `lead ${lead.id}` : `chief ${chiefOf(item)}`;
      failedBy.set(key, [...failedBy.get(key) ?? [], item]);
    }
    const failed = [...failedBy.values()].flatMap(list => newest(list).slice(0, HELPERS_MAX));
    const failedMore = [...failedBy].filter(([, list]) => list.length > HELPERS_MAX).map(([key, list]) => {
      const [kind, id] = key.split(" ");
      return { lead: kind === "lead" ? id : null, chief: kind === "chief" && id !== "null" ? id : null, count: list.length - HELPERS_MAX };
    });
    const arenaRun = ({ run }) => !!run.candidate || run.role === "arena-judge";
    const arenas = new Set(all.filter(item => arenaRun(item) && (LIVE.includes(item.run.status) || recent(item.run.ended))).map(item => item.task.key));
    const arena = all.filter(item => arenaRun(item) && arenas.has(item.task.key) && !LIVE.includes(item.run.status) && !item.look);
    const runs = [...new Set([...all.filter(item => LIVE.includes(item.run.status)), ...failed, ...ended, ...arena])].map(item => {
      const { run, task, agent, state, look } = item;
      return {
        id: run.id, role: run.role, status: run.status, chief: chiefOf(item), lead: leadOf(item)?.id ?? null, model: run.model || null, candidate: run.candidate || null,
        task: { key: task.key, id: task.id, title: task.title }, started: iso(run.started), ended: iso(run.ended), ...runMeasure(run), place: run.place ?? null, look, state,
        why: run.status === "failed" ? runFailure(task, run)?.text ?? null : agent?.why || (run.clock.stale ? run.clock.text : null),
        ...(endedOf.has(run.id) && { endedHelpers: endedOf.get(run.id).length }),
      };
    }).sort((a, b) => (time(a.started) ?? 0) - (time(b.started) ?? 0) || number(a.id) - number(b.id));
    const byChief = new Map();
    for (const run of runs) if (run.status === "running") byChief.set(run.chief, (byChief.get(run.chief) ?? 0) + 1);
    return { key: book.key, project: book.group, running: book.running, limit: book.limit, leads: book.leads, leadLimit: book.leadLimit, queued: book.queued.length,
      look: all.filter(item => item.look).length, failedMore, byChief: [...byChief].map(([chief, n]) => ({ chief, count: n })).sort((a, b) => number(a.chief) - number(b.chief)), runs };
  });
  return { books, look };
}

export function boardOverview(model) {
  const at = time(model.at);
  const since = at - DAY;
  const recent = value => { const when = time(value); return when !== null && when > since && when <= at; };
  const tasks = model.tasks, byKey = new Map(tasks.map(task => [task.key, task])), names = projectNames(model);

  const needs = [...tasks.filter(task => task.visible && task.column).flatMap(gateNeeds), ...(model.milestoneNeeds ?? []).map(milestoneNeed)]
    .sort((a, b) => (time(a.askedAt) ?? -Infinity) - (time(b.askedAt) ?? -Infinity));

  const hiddenDone = {};
  const milestones = model.milestones.filter(milestone => milestone.state !== "dropped").flatMap(milestone => {
    const own = milestone.tasks.map(key => byKey.get(key)).filter(Boolean);
    const open = own.filter(task => !ENDED.includes(task.state));
    const lastDone = Math.max(-Infinity, ...own.map(task => time(task.completedAt)).filter(when => when !== null));
    if (milestone.state === "done" && !(lastDone > at - DONE_DAYS * DAY)) { hiddenDone[milestone.group] = (hiddenDone[milestone.group] ?? 0) + 1; return []; }
    return [{
      key: milestone.key,
      id: milestone.id,
      title: milestoneName(milestone),
      goal: milestone.goal || null,
      project: milestone.group,
      state: milestone.state,
      word: milestone.word,
      priority: PRIORITIES.find(priority => open.some(task => task.priority === priority)) ?? null,
      merged: milestone.progress.merged,
      total: milestone.progress.total,
      abandoned: milestone.progress.abandoned,
      moving: open.filter(isMoving).length,
      waiting: milestone.waiting,
      needsYou: open.filter(task => rowState(task) === "needs").length + (milestone.need ? 1 : 0),
      pilot: milestone.pilot,
      doneAt: milestone.state === "done" && Number.isFinite(lastDone) ? new Date(lastDone).toISOString() : null,
    }];
  }).sort((a, b) => rank(a.priority) - rank(b.priority) || stateRank(a.state) - stateRank(b.state) || number(a.id) - number(b.id));

  const merged = tasks.filter(task => task.state === "merged" && recent(task.completedAt));
  const chiefs = (model.projects ?? []).flatMap(project => (project.chiefs ?? []).map(chief => ({ ...chief, project: project.key, logbook: chief.key.slice(0, chief.key.lastIndexOf("/")) })));
  const lastWrite = agent => agent.how === "logbook" ? time(byKey.get(agent.task?.key)?.lastActivity) ?? time(agent.run?.started) : null;
  const agents = everyAgent(model.agents).map(agent => {
    const when = lastWrite(agent);
    return when !== null && at - when >= AGENT_QUIET_MS ? { ...agent, state: "stuck", why: `no logbook write for ${Math.floor((at - when) / 60_000)} min` } : agent;
  });
  const lastWrites = agents.map(lastWrite).filter(when => when !== null);
  const { books, look } = agentsOf(model, recent, agents, chiefs);
  const leaving = [...merged.map(task => time(task.completedAt)), ...look.filter(item => item.run.status === "failed").map(item => time(item.run.ended))].map(when => when + DAY + 1)
    .concat(chiefs.flatMap(chief => [time(chief.quietAt), time(chief.passOnAt)]).filter(when => when !== null))
    .concat(lastWrites.filter(when => at - when < AGENT_QUIET_MS).map(when => when + AGENT_QUIET_MS));

  const rows = tasks.map(task => taskRow(task, chiefs)), designs = designRows(tasks);
  return {
    at: model.at,
    stale: !!model.stale,
    problems: (model.diagnostics ?? []).map(item => item.message),
    projects: (model.projects ?? []).map(project => ({ key: project.key, name: names.get(project.key), sub: project.sub, books: project.books, list: project.list, needs: needs.filter(need => need.project === project.key).length,
      agents: project.agents, open: tasks.filter(task => task.group === project.key && isOpen(task)).length, lastActivity: project.lastActivity, archived: project.archived, mixed: project.mixed ?? null, problem: project.problem ?? null, unread: project.unread ?? [],
      kept: { tasks: project.tasks, ...project.kept }, archives: project.archives ?? 0, archivedAt: project.archivedAt ?? null, welcome: !project.archived && !project.workSinceRestore && project.restoredAt || null })),
    chiefs,
    pickups: (model.projects ?? []).flatMap(project => (project.pickups ?? []).map(item => ({ ...item, project: project.key }))),
    needs,
    answered: tasks.flatMap(task => task.boardAnswers.map(item => ({ ...item, task: { key: task.key, id: task.id, title: task.title }, project: task.group }))).sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0)),
    tasks: rows,
    milestones,
    designs,
    levels: levelsOf({ rows, tasks, needs, milestones, designs, projects: model.projects ?? [], at }),
    search: searchRows(rows, designs, model.projects ?? [], names),
    hiddenDone,
    agents: books,
    next: leaving.length ? Math.min(...leaving) : null,
  };
}

function designRows(tasks) {
  return tasks.filter(task => task.design && task.state !== "abandoned").map(task => ({ key: task.design.key, task: task.key, id: task.id, title: task.title, project: task.group, milestone: task.milestone?.key ?? null,
    archived: !!task.archived, gate: task.design.gate, design: task.design.design, answer: task.design.answer, at: iso(task.design.at), files: task.design.files }))
    .sort((a, b) => time(b.at) - time(a.at) || a.key.localeCompare(b.key));
}

function levelsOf({ rows, tasks, needs, milestones, designs, projects, at }) {
  const agents = new Map(tasks.map(task => [task.key, task.agents.length])), asked = new Map();
  for (const [i, need] of needs.entries()) if (need.task && !asked.has(need.task.key)) asked.set(need.task.key, i);
  const shown = row => row.row !== "done" || time(row.doneAt) > at - DONE_DAYS * DAY;
  const plan = (a, b) => rank(a.priority) - rank(b.priority) || number(a.id) - number(b.id);
  const ORDER = { needs: (a, b) => (asked.get(a.key) ?? needs.length) - (asked.get(b.key) ?? needs.length) || plan(a, b), work: plan, waits: plan, done: (a, b) => time(b.doneAt) - time(a.doneAt) || plan(a, b) };
  const keys = list => list.map(item => item.key);
  const level = (own, mine) => {
    const lists = Object.fromEntries(ROW_STATES.map(state => [state, keys(own.filter(row => row.row === state && shown(row)).sort(ORDER[state]))]));
    return { ...lists, agents: lists.work.reduce((n, key) => n + agents.get(key), 0), designs: keys(designs.filter(mine)) };
  };
  const archived = new Set(projects.filter(project => project.archived).map(project => project.key)), live = item => !archived.has(item.project);
  return {
    all: { ...level(rows.filter(live), live), projects: keys(projects), milestones: keys(milestones.filter(live)) },
    projects: Object.fromEntries(projects.map(({ key }) => [key, { ...level(rows.filter(row => row.project === key), item => item.project === key), milestones: keys(milestones.filter(milestone => milestone.project === key)) }])),
    milestones: Object.fromEntries(milestones.map(({ key }) => [key, level(rows.filter(row => row.milestone?.key === key), item => item.milestone === key)])),
    loose: Object.fromEntries(projects.map(({ key }) => [key, level(rows.filter(row => row.project === key && !row.milestone), item => item.project === key && !item.milestone)])),
  };
}

function searchRows(rows, designs, projects, names) {
  const archived = new Set(projects.filter(project => project.archived).map(project => project.key));
  const hit = (kind, key, id, label, project, rank, at, extra) => ({ kind, key, id, label, project, rank: archived.has(project) ? 2 : rank, at: at ?? null, ...extra });
  return [
    ...rows.map(row => hit("task", row.key, row.id, row.title, row.project, row.row === "done" ? 1 : 0, row.lastActivity, { row: row.row })),
    ...designs.map(design => hit("design", design.key, design.id, design.title, design.project, 1, design.at)),
    ...projects.map(project => hit("project", project.key, null, names.get(project.key), project.key, 0, project.lastActivity)),
  ].sort((a, b) => a.rank - b.rank || (time(b.at) ?? 0) - (time(a.at) ?? 0) || a.key.localeCompare(b.key));
}

const LOG_MAX = 200;
const lines = text => String(text ?? "").split(LINE).map(line => line.trim()).filter(Boolean);
const firstLine = text => lines(text)[0] ?? "";

function logOf(task) {
  const events = [
    ...(task.decisionRows ?? []).map(row => ({ at: row.at, who: "chief", text: `${row.decision}${row.why ? ` · ${row.why}` : ""}` })),
    ...task.runs.flatMap(run => run.status === "queued" ? [{ at: run.started, who: run.id, text: `${run.role} queued for an agent slot${run.place ? `, place ${run.place}` : ""}` }] : [
      { at: run.started, who: run.id, text: failedDecision(task, run) === LAPSED ? `${run.role} admitted from the queue, but its agent did not start` : `${run.role} started${run.admitted ? " after its place in the queue" : ""}` },
      ...(run.status === "running" ? [] : [{ at: run.ended, who: run.id, text: `${run.role} ended: ${runWord(run.status).text}` }]),
    ]),
    ...task.ledger.map(row => ({ at: row.at, who: row.run || "CI", text: `${row.kind}${row.cycle ? ` · cycle ${row.cycle}` : ""}${row.sha ? ` on ${String(row.sha).slice(0, 7)}` : ""}` })),
  ].map(event => ({ ...event, at: iso(event.at) }));
  return events.sort((a, b) => (time(b.at) ?? -Infinity) - (time(a.at) ?? -Infinity));
}

export function taskPanel(model, key) {
  const task = model.tasks.find(item => item.key === key);
  if (!task) return null;
  const chiefs = (model.projects ?? []).flatMap(project => project.chiefs ?? []);
  const log = logOf(task), waiting = new Set(task.reasons.map(reason => reason.gateId));
  const steps = task.loop.steps.map(step => ({ key: step.key, label: step.label, status: step.status, detail: step.detail, parts: (step.parts ?? []).map(([name, status]) => ({ name, status })) }));
  return {
    ...taskRow(task, chiefs),
    at: model.at,
    route: task.route ? task.route.split(",") : [], risk: task.risk || null, branch: task.branch || null,
    logbook: task.project.slice(task.project.indexOf("/") + 1),
    conflicts: task.mayConflict.map(other => ({ key: other.key, id: other.id, chief: other.chief, paths: other.paths })),
    steps,
    question: task.reasons[0]?.gateId ? task.reasons[0].key : null,
    now: (task.loop.now.needs ? task.reasons.flatMap(reason => [...lines(reason.text), ...(reason.recommendation ? [`I recommend: ${reason.recommendation}`] : [])]) : lines(task.loop.now.text))
      .filter(line => !steps.some(step => step.detail === line)),
    next: task.loop.next,
    lastEvent: log[0] ?? null,
    log: log.slice(0, LOG_MAX), logMore: Math.max(0, log.length - LOG_MAX),
    decisions: [...(task.gateRows ?? [])].reverse().map(gate => ({ id: gate.id, question: firstLine(gate.question), answer: gate.answer || null, pending: boardAnswer(gate)?.answer ?? null, recommendation: gate.recommendation || null, waits: waiting.has(gate.id), at: iso(gate.at) })),
    artifacts: task.artifacts.map(record => ({ id: record.id, type: record.data.type, label: record.data.label, run: record.data.run ?? null, at: iso(record.observedAt),
      url: /^https:\/\//.test(record.data.url ?? "") ? record.data.url : null, path: record.data.path ?? null, verified: !!record.content?.verified })),
    runs: task.runs.map(run => ({ id: run.id, role: run.role, status: run.status, started: iso(run.started), ended: iso(run.ended), ...runMeasure(run), place: run.place ?? null })),
    ...aboutOf(model, task),
  };
}

const linked = other => ({ key: other.key, id: other.id, title: other.title, word: other.word ?? null });
function aboutOf(model, task) {
  const at = time(model.at), byKey = new Map(model.tasks.map(item => [item.key, item]));
  const milestone = task.milestone && model.milestones.find(item => item.key === task.milestone.key);
  const spent = task.runs.filter(run => time(run.started) !== null).map(run => Math.max(0, (time(run.ended) ?? at) - time(run.started)));
  return {
    request: task.request || null,
    release: task.release ?? null,
    progress: milestone ? { goal: milestone.goal || null, merged: milestone.progress.merged, total: milestone.progress.total, abandoned: milestone.progress.abandoned.length } : null,
    before: task.waits.filter(wait => wait.id).map(wait => byKey.get(`${task.project}/${wait.id}`) ?? { key: null, id: wait.id, title: null, word: null }).map(linked),
    after: model.tasks.filter(other => other.project === task.project && other.waits.some(wait => wait.id === task.id)).map(linked),
    cost: { runs: task.runs.length, ms: spent.reduce((a, b) => a + b, 0), timed: spent.length, ...measureTotals(task.runs) },
  };
}
