import { LINE } from "./logbook-fields.mjs";
import { ENDED } from "./milestone-rules.mjs";
import { isMoving } from "./board-overview.mjs";
import { BOARD_PORT } from "./message.mjs";
import { localTime } from "./move-text.mjs";
import { KINDS as KIND, MARKS, STEPS, UNKNOWN, chiefName, runWord, shown, stoppedAt } from "./state-words.mjs";
import { measureLabel } from "./usage.mjs";
import { flagRank, needsLook } from "./agent-flag.mjs";
const md = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "").replace(/[\\`*_{}\[\]()<>#+.!|&~:@]/g, c => String.fromCharCode(92) + c);
const mdLines = (value, join = "\n") => String(value ?? "").split(LINE).map(md).join(join);
const mdBlock = value => String(value ?? "").split(/\r?\n/).map(md).join("\n");
const evidenceArtifacts = task => task.artifacts.filter(record => ["report", "proof"].includes(record.data.type) && record.content?.verified && typeof record.content.text === "string");
const prUrl = task => task.repository && /^[1-9]\d*$/.test(task.pr) ? `${task.repository}/pull/${task.pr}` : null;
const mdUrl = url => url.replace(/[()<>\[\]\\\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const SEVERITIES = ["high", "medium", "low"];
const STEP = Object.fromEntries([...Object.entries(STEPS), ["unknown", []]].map(([key, pair]) => [key, shown(pair)]));
const MARK = Object.fromEntries(Object.entries(STEP).map(([key, step]) => [key, step.mark])), WORD = Object.fromEntries(Object.entries(STEP).map(([key, step]) => [key, step.text]));
const status = value => MARK[value] ? value : "unknown";
const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
function runTime(run) {
  const start = Date.parse(run.started), end = Date.parse(run.ended);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${Math.floor((end - start) / 1000)} s · ${run.started} to ${run.ended}` : run.started ? `${run.started} · duration unknown` : "time unknown";
}
const oldWhat = (task, where) => `${task.old.finished ? "A finished" : "An open"} task ${where} the old ${title(task.old.provider)} logbook`;
const goneNote = task => { const run = !ENDED.includes(task.state) && task.runs.find(item => item.id === task.goneRun); return run ? { run: run.id, name: run.checkoutName } : null; };
function waitNext(task) {
  if (!task.waitLine || task.loop.now.needs && !task.waitLine.never) return null;
  const open = task.waits.filter(wait => !wait.met);
  return task.waitLine.never ? "Nothing until the wait changes. Ask the chief to remove the wait, or to drop this task."
    : `Starts when ${open.map(wait => wait.breakdown ? "you approve the breakdown" : `${wait.id} merges`).join(" and ")}.${task.column === "design" ? " Its design and PE may run before." : ""}`;
}
const goneText = task => { const note = goneNote(task); return note ? `\nThe folder ${md(note.name)} of ${md(note.run)} is not on this Mac now, so sage cannot read the branch there. The next review step of ${md(task.id)} stops until the folder is back.` : ""; };
const providerText = (name, task) => name ? md(name) : `${md(title(task.providerStandIn))} (${task.shared ? "the run names no chief" : "logbook source"})`;
const stepText = task => task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}`).join(" › ");
const nowText = task => {
  const needs = task.loop.now.needs, next = waitNext(task), ask = `Needs you: ${mdLines(task.loop.now.text)}`;
  if (next === null) return `${needs ? ask : `Now: ${mdLines(task.loop.now.text)}`}${task.loop.next ? `\nNext: ${md(task.loop.next)}` : ""}`;
  return `${needs ? `${ask}\n` : ""}${WAIT_MARK[task.waitLine.never ? "never" : "wait"]} ${needs ? "" : "Now: "}${md(task.waitLine.text)}\nNext: ${md(next)}`;
};
const wordText = item => ` · ${md(item.word || UNKNOWN)}`;
const tagText = task => `${task.priority ? ` · ${md(task.priority)}` : ""}${task.kind ? ` · ${md(KIND[task.kind][1])}` : ""}`;
export function renderTaskText(task) {
  const head = task.currentHead ? `${md(task.currentHead)}${task.headBasis === "ledger" ? " (newest verdict)" : ""}` : "not recorded";
  const where = row => row.movedTo ? ` · moved to ${md(row.movedTo)}` : row.movedFrom ? ` · from ${md(row.movedFrom)}` : "";
  const rows = task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}: ${WORD[status(step.status)]}${step.detail ? ` · ${md(step.detail)}` : ""}${step.parts?.length ? `\n  ${step.parts.map(([name, value]) => `${MARK[status(value)]} ${md(name)}: ${WORD[status(value)]}`).join(" · ")}` : ""}`).join("\n");
  const holder = `${task.shared ? `Owning chief: ${md(task.holder)}${task.owner?.unlisted ? `\n${md(`${task.owner.id} is not in chiefs.tsv, so the board does not know its provider.`)}` : ""}\n` : ""}${task.old ? `${md(`${oldWhat(task, "of")}.${task.old.finished ? "" : " The move did not take it to the shared logbook."} It stays there, read-only, and its number belongs to that old logbook.`)}\n` : ""}`;
  return `**${md(task.title)}** ${md(task.id)}${task.was ? ` · ${md(task.was)}` : ""}\n${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}${wordText(task)} · ${md(task.size)}${tagText(task)}${task.risk ? ` · risk: ${md(task.risk)}` : ""}${task.pr ? ` · PR ${prUrl(task) ? `[${md(task.pr)}](${mdUrl(prUrl(task))})` : md(task.pr)}` : ""}\n${holder}\n**Loop**\n${stepText(task)}\n${nowText(task)}\n${rows}\nRecorded state: ${md(task.state)} · repair round ${md(task.round)} · last commit ${head}\n\n**Brief**\nGoal: ${mdBlock(task.briefFields.goal ?? "not recorded")}\nAcceptance: ${mdBlock(task.briefFields.acceptance ?? "not recorded")}\n\nFull brief:\n${mdBlock(task.brief ?? "No verified brief content is available.")}\n\n**Agent runs**\n${task.runs.map(r => `${md(r.id)} ${providerText(r.provider, task)} · ${md(r.role)}${r.checkoutName ? ` · checkout ${md(r.checkoutName)}${r.checkoutGone ? " (gone)" : r.checkoutGone === null ? " (not checked)" : ""}` : ""} · ${md(runWord(r.status, r.flag).text)} · ${md(task.runClocks?.[r.id]?.text ?? runTime(r))} · ${md(measureLabel(r))}`).join("\n") || "No runs recorded."}${goneText(task)}\n\n**Evidence**\n${task.ledger.map(r => `${md(r.kind || `verdict ${UNKNOWN}`)} · cycle ${md(r.cycle || UNKNOWN)} · ${md(r.sha || `commit ${UNKNOWN}`)} · ${md(r.run || `run ${UNKNOWN}`)} · ${md(r.at || `time ${UNKNOWN}`)}`).join("\n") || "No verdicts recorded."}${evidenceArtifacts(task).map(r => `\n\n${md(r.data.label)} · ${md(r.source)} · ${md(r.observedAt)} · ${md(r.data.run ?? "run unknown")} · digest verified\n${mdBlock(r.content.text)}`).join("")}\n\n**Findings**\n${task.findings.map(r => `${md(SEVERITIES.includes(r.severity) ? r.severity : `severity ${UNKNOWN}`)} · ${md(r.summary)} · ${md(r.status)}${where(r)}${r.reason ? ` · ${md(r.reason)}` : ""}`).join("\n") || "No findings recorded."}\n\n**Artifacts**\n${task.artifacts.map(r => `${md(r.data.label)} · ${md(r.data.url ?? (r.content?.verified ? "local artifact; digest verified" : "local artifact; content not verified"))}`).join("\n") || "No artifacts recorded."}\n\n**Latest decisions**\n${task.decisions.map(r => `${md(r.at)} · ${md(r.decision)} · ${md(r.why)}`).join("\n") || "No decisions recorded."}`;
}
const movedText = item => `${item.tasks === 1 ? "1 open task has a new number" : `${item.tasks} open tasks have new numbers`}, and each card shows its old number. Finished tasks stay in Done as Old and read-only${item.finished ? `, except ${item.finished === 1 ? "1 finished task of a milestone, which moved with its milestone and has" : `${item.finished} finished tasks of milestones, which moved with their milestones and have`} a new number too` : ""}. The old-to-new map is move-map.html in the logbook folder ${item.folder}, on this Mac.`;
const WAIT_MARK = { never: MARKS["cannot start"], wait: MARKS.waiting };

const TITLE_MAX = 60, SHOWN = 6;
const plain = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "").replace(/\]\(/g, "] (").replace(/</g, "‹").replace(/>/g, "›").replace(/ {2,}/g, " ").trim();
const cut = value => {
  const chars = [...plain(value)];
  if (chars.length <= TITLE_MAX) return chars.join("");
  const head = chars.slice(0, TITLE_MAX).join(""), space = head.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? head.slice(0, space) : head).replace(/[\s,;:.·-]+$/u, "")}…`;
};
const sentence = (first, rest) => `${first}${/[.?!…]$/.test(first) ? "" : "."}${rest ? ` ${rest}` : ""}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function ownText(task, text) {
  const runs = new Set(task.runs.map(run => run.id));
  let out = plain(text);
  if (task.pr) out = out.replaceAll(`${task.id} and PR ${task.pr}`, "this task and its PR").replaceAll(`PR ${task.pr}`, "its PR");
  if (task.currentHead) out = out.replaceAll(task.currentHead.slice(0, 7), "its last commit");
  out = out.replace(/\bR[1-9]\d*(?:(?:, | and )R[1-9]\d*)*\b/g, list => { const ids = list.split(/, | and /); return ids.every(id => runs.has(id)) ? ids.length === 1 ? "its run" : `${ids.length} of its runs` : list; });
  return out.replace(new RegExp(`\\b${task.id}\\b`, "g"), "this task");
}
const lostText = milestone => `${!milestone.gate ? "it names no breakdown question" : !milestone.gateFound ? "the breakdown question that it names is not in the logbook"
  : milestone.named !== undefined ? `its breakdown question names ${milestone.named ? "another milestone" : "no milestone"}` : "the question that it names is not a breakdown question on its pilot task"}. Ask the chief to repair the logbook, or to propose the milestone again.`;
const joined = lines => lines.reduce((text, line) => text ? `${text}${text.endsWith(":") ? " " : " · "}${line}` : line, "");
function askText(model, task, reason) {
  const gate = reason.kind === "gate" && !reason.replace && task.gates.find(row => row.id === reason.gateId);
  if (!gate) return { text: ownText(task, reason.text), lost: [] };
  const lost = (model.milestones ?? []).filter(milestone => milestone.state === "lost" && milestone.gate === gate.id && milestone.project === task.project);
  const question = reason.breakdown ? joined(String(gate.question ?? "").split(LINE).map(plain).filter(Boolean)) : plain(gate.question);
  return { text: joined([question, ...lost.map(milestone => `${cut(milestone.name || "Its milestone")}: ${lostText(milestone)}`)]), lost };
}
function needLines(model, task, reason, ref) {
  const { text, lost } = askText(model, task, reason);
  ref([task.key, task.id], ...(reason.breakdown ? [[reason.breakdown.key, reason.breakdown.id]] : []), [reason.key, reason.gateId && reason.key], ...(task.pr ? [[`${task.key}/pr`, `PR ${task.pr}`]] : []), ...lost.map(milestone => [milestone.key, milestone.id]));
  return [`- ${sentence(cut(reason.breakdown?.name || task.title), text)}`, ...(reason.options?.length ? [`  Options: ${reason.options.map((option, i) => `${i + 1} ${plain(option)}`).join(" · ")}.`] : []),
    ...(reason.recommendation ? [`  Recommended: ${sentence(ownText(task, reason.recommendation))}`] : [])];
}
function problemLine(model, need, ref) {
  const milestone = (model.milestones ?? []).find(item => item.key === need.key), name = cut(milestone?.name || "A milestone");
  if (milestone) ref([milestone.key, milestone.id], ...(need.kind === "stuck" ? [[`${milestone.key}/pilot`, milestone.pilot]] : []));
  if (need.kind === "missing") {
    const own = model.tasks.filter(task => task.milestone?.key === need.key && !ENDED.includes(task.state));
    ref([need.key, need.key.split("/").at(-1).replace(/^\?$/, "")], ...own.map(task => [task.key, task.id]));
    const one = own.length === 1, which = own.length ? `${plural(own.length, "task")} ${one ? "names" : "name"} it, so ${one ? "it cannot" : "they cannot"} go on` : "Tasks name it";
    return `- ${need.key.endsWith("/?") ? "A milestone cell is not a milestone id" : "A milestone is not in the logbook"}. ${which}. Ask the chief to repair the logbook, or to take ${one ? "the task" : "each task"} out of the milestone.`;
  }
  return `- ${{
    stuck: () => `${name} is stuck. Its pilot task ${milestone.pilotState ? "was abandoned" : "is not in the logbook"}. Choose a new pilot, or drop the milestone.`,
    lost: () => `${name}: ${lostText(milestone)}`,
    unread: () => `${name}: its state cannot be read. ${plain(need.text)}`,
  }[milestone && need.kind]?.() ?? sentence(cut(need.title), plain(need.text))}`;
}
function movingText(task) {
  const live = task.agents.find(agent => !agent.stale), stale = task.agents.find(agent => agent.stale);
  const flagged = task.runs.filter(run => run.status === "running" && needsLook(run.flag)).sort((a, b) => flagRank(a.flag) - flagRank(b.flag))[0];
  const review = task.loop.steps.find(step => step.key.startsWith("review-") && step.status !== "done");
  const problem = task.problems?.length ? ownText(task, task.problems[0].text).split(/(?<=\.)\s/)[0].replace(/\.$/, "") : null;
  const what = problem ? /the chief repairs it/.test(problem) ? problem : `${problem}; the chief repairs it` : task.waitLine ? task.waitLine.never ? "Cannot start" : "Waits for another task" : {
    framed: "Not briefed yet, an agent at work", designing: "In design", "awaiting-you": "In design", briefed: "Briefed", building: "Building", held: "Held by the chief", replan: "Needs a new plan",
    repairing: `In repair, round ${Number(task.round) || 1}`, verifying: "The chief checks the verdicts", verified: "Ready to merge", "pr-ready": "Ready to merge",
    reviewing: review ? review.label.replace(/^Review /, "In review, cycle ").replace(/^Evidence review/, "In evidence review") : "The reviews are clean",
  }[task.state] ?? title(task.word || UNKNOWN);
  const clock = flagged ? `${flagged.flag.text} (run ${flagged.id})` : live ? task.runClocks?.[live.id]?.text : stale ? `no news since ${task.runClocks?.[stale.id]?.since ?? "a day"}` : "";
  return `${what}${clock ? `, ${clock}` : ""}.`;
}
function doneText(task, today) {
  const at = localTime(new Date(task.completedAt).toISOString());
  return `${task.state === "concluded" ? "Concluded" : "Merged"} ${at.date === today ? "" : "yesterday "}at ${at.time}.`;
}
function milestoneText(milestone, tasks) {
  const name = milestone.name ? cut(milestone.name) : "A milestone with no name";
  const next = milestone.next && tasks.get(milestone.next.key);
  return `- ${name}: ${{
    proposed: () => "the breakdown waits for you.",
    changing: () => "the chief revises the breakdown.",
    lost: () => "its breakdown question has a problem. See Needs you.",
    stuck: () => "stuck. See Needs you.",
    dropped: () => `dropped, with ${plural(milestone.open, "task")} still in it. Ask the chief to take ${milestone.open === 1 ? "the task" : "each task"} out of the milestone.`,
  }[milestone.state]?.() ?? `${milestone.progress.merged} of ${milestone.progress.total} merged.${next ? ` Next, ${cut(next.title)}${/[.?!…]$/.test(cut(next.title)) ? "" : "."}` : " No task can move now."}`}`;
}
const part = (label, groups, empty, grouped, extra = "") => {
  const shownGroups = groups.filter(group => group.lines.length);
  if (!shownGroups.length) return `### ${label}\n${empty}`;
  return `### ${extra}${label}\n${shownGroups.map(group => `${grouped ? `${group.name}\n` : ""}${group.lines.join("\n")}`).join("\n\n")}`;
};
const capped = (items, render) => [...items.slice(0, SHOWN).flatMap(render), ...(items.length > SHOWN ? [`- And ${items.length - SHOWN} more on the board.`] : [])];

export function renderBoardText(model, { port = BOARD_PORT } = {}) {
  const now = localTime(model.at), [y, m, d] = now.date.split("-").map(Number);
  const yesterday = localTime(new Date(y, m - 1, d - 1).toISOString()).date;
  const tasks = new Map(model.tasks.map(task => [task.key, task]));
  const live = (model.projects ?? []).filter(project => !project.archived);
  const groups = [...live.map(project => ({ key: project.key, name: plain(project.name), project })), { key: null, name: "Every project", project: null }].map(group => {
    const mine = item => (item.group ?? null) === group.key, refs = new Map();
    const ref = (...items) => { for (const [key, id] of items) if (id && !refs.has(key)) refs.set(key, id); };
    const asks = model.needsOwner.filter(mine).flatMap(task => task.reasons.map(reason => ({ task, reason })));
    const order = [...asks.filter(item => item.reason.breakdown), ...asks.filter(item => !item.reason.breakdown)];
    const stopped = (group.project?.chiefs ?? []).filter(chief => chief.stopped && chief.tasks > 0);
    const needs = [
      ...order.filter(item => item.reason.breakdown).flatMap(item => needLines(model, item.task, item.reason, ref)),
      ...(model.milestoneNeeds ?? []).filter(mine).map(need => problemLine(model, need, ref)),
      ...order.filter(item => !item.reason.breakdown).flatMap(item => needLines(model, item.task, item.reason, ref)),
      ...stopped.map(chief => (ref([chief.key, chief.id]), `- ${chief.named ? `The chief ${plain(chief.name)}` : `A ${chiefName(null, chief.provider) || "sage"} chief`} stopped at ${localTime(stoppedAt(chief)).time} with ${plural(chief.tasks, "open task")}. The next chief that works in this project picks ${chief.tasks === 1 ? "it" : "them"} up.`)),
    ];
    const shown = model.columns.flatMap(column => column.tasks).filter(mine);
    const moving = shown.filter(task => isMoving(task) && !task.reasons.length).sort((a, b) => b.agents.some(agent => !agent.stale) - a.agents.some(agent => !agent.stale));
    const done = shown.filter(task => task.column === "done" && task.completedAt && localTime(new Date(task.completedAt).toISOString()).date >= yesterday).sort((a, b) => b.completedAt - a.completedAt);
    const releases = (model.releases ?? []).filter(entry => mine(entry) && !entry.archived).flatMap(entry => entry.releases.filter(release => release.missing || !["done", "stopped"].includes(release.word)));
    const milestones = (model.milestones ?? []).filter(milestone => mine(milestone) && !milestone.archived && milestone.state !== "done" && !(milestone.state === "dropped" && !milestone.open));
    const lines = {
      needs,
      moving: capped(moving, task => (ref([task.key, task.id], ...(task.pr ? [[`${task.key}/pr`, `PR ${task.pr}`]] : [])), [`- ${sentence(cut(task.title), movingText(task))}`])),
      done: capped(done, task => (ref([task.key, task.id], ...(task.pr ? [[`${task.key}/pr`, `PR ${task.pr}`]] : [])), [`- ${sentence(cut(task.title), doneText(task, now.date))}`])),
      milestones: [...releases.map(release => `- Release ${cut(release.name)}: ${release.done} of ${plural(release.total, "task")} done.${release.missing ? " It is not in the logbook. Ask the chief to add it." : ""}`),
        ...milestones.map(milestone => (ref([milestone.key, milestone.id]), milestoneText(milestone, tasks)))],
    };
    return { ...group, lines, refs, any: Object.values(lines).some(list => list.length) };
  });
  const shownGroups = groups.filter(group => group.any), grouped = shownGroups.length > 1;
  const pick = key => shownGroups.map(group => ({ name: group.name, lines: group.lines[key] }));
  const quiet = live.length - shownGroups.filter(group => group.key !== null).length;
  const head = [`sage board · ${now.time} ${now.zone}`,
    ...(model.changing ?? []).map(item => `The logbook of ${plain(item.project)} is changing: the board shows its read at ${localTime(item.at).time}${item.dropped ? `, without what changed during it (${plain(item.dropped.join("; "))})` : ""}. Ask for the board again for a newer read.`),
    ...(model.moved ?? []).map(item => plain(`${item.project} moved to one shared logbook on ${localTime(item.at).day}. ${movedText(item)}`))];
  const needsCount = shownGroups.reduce((n, group) => n + group.lines.needs.length, 0);
  const foot = [
    quiet > 0 ? `Quiet: ${shownGroups.length ? `${plural(quiet, "other project")} ${quiet === 1 ? "has" : "have"}` : `${plural(quiet, "project")} ${quiet === 1 ? "has" : "have"}`} nothing that moves or needs you.` : "",
    model.archived.length ? `Archived: ${model.archived.map(book => `${plain(book.name)} (${plural(book.tasks, "task")}${book.needsOwner ? `, ${book.needsOwner} ${book.needsOwner === 1 ? "needs" : "need"} you` : ""})`).join(", ")}.` : "",
    ...model.diagnostics.map(d => `Incomplete source: ${plain(d.source)}${d.project ? ` · ${plain(d.project)}` : ""} · ${plain(d.message)}`),
    ...model.warnings.map(d => `Setting ignored: ${plain(d.source)} · ${plain(d.project)} · ${plain(d.message)}`),
    ...(model.notes ?? []).map(d => `Logbook note: ${plain(d.source)} · ${plain(d.project)} · ${plain(d.message)}`),
    `More: http://127.0.0.1:${port}`,
    shownGroups.some(group => group.refs.size) ? `Ref: ${shownGroups.filter(group => group.refs.size).map(group => `${grouped ? `${group.name} ` : ""}${[...group.refs.values()].join(" ")}`).join(" · ")}` : "",
  ].filter(Boolean);
  return [...head,
    part("Needs you", pick("needs"), "Nothing waits for you.", grouped, needsCount ? "🔴 " : ""),
    part("Moving now", pick("moving"), "No task moves now.", grouped),
    part("Done since yesterday", pick("done"), "No task was done since yesterday.", grouped),
    part("Milestones", pick("milestones"), "No milestone is open.", grouped),
    ...foot].join("\n\n");
}
export function renderBoardStatus(model) {
  const states = new Map(); for (const task of model.tasks.filter(task => !task.archived)) states.set(task.state, (states.get(task.state) ?? 0) + 1);
  const archivedNeeds = model.archived.reduce((n, book) => n + book.needsOwner, 0);
  return `Tasks: ${[...states].map(([state,n]) => `${state} ${n}`).join(" · ") || "none recorded"}\nAgents: ${model.counts.recordedAgents} recorded running · ${model.counts.inferredWork} inferred PRs\nOwner: ${model.counts.needsOwner} need you\n${model.archived.length ? `Archived: ${model.archived.length} project${model.archived.length === 1 ? "" : "s"} · ${archivedNeeds} need you\n` : ""}Budget this week: unknown; no provider observation available${model.diagnostics.length ? `\nSources: ${model.diagnostics.length} diagnostics; counts may be incomplete` : ""}`;
}
