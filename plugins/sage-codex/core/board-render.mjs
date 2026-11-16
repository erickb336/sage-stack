import { LINE } from "./logbook-fields.mjs";
import { ENDED, lostClause, milestoneName } from "./milestone-rules.mjs";
import { KINDS as KIND, MARKS, STEPS, UNKNOWN, URGENCY, releaseWord, runWord, shown } from "./state-words.mjs";
import { box, columns } from "./picture.mjs";
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
const COLUMN_NAME = { done: "Done, last 7 days" };
const hhmm = iso => String(iso ?? "").slice(11, 16);
const day = iso => iso ? `${String(iso).slice(0, 10)} ${hhmm(iso)}` : "";
const title = value => String(value ?? "").charAt(0).toUpperCase() + String(value ?? "").slice(1);
function runTime(run) {
  const start = Date.parse(run.started), end = Date.parse(run.ended);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${Math.floor((end - start) / 1000)} s · ${run.started} to ${run.ended}` : run.started ? `${run.started} · duration unknown` : "time unknown";
}
const oldWhat = (task, where) => `${task.old.finished ? "A finished" : "An open"} task ${where} the old ${title(task.old.provider)} logbook`;
const context = model => ({ tasks: new Map(model.tasks.map(task => [task.key, task])), milestones: new Map((model.milestones ?? []).map(milestone => [milestone.key, milestone])) });
const archivedCounts = book => `${book.tasks} task${book.tasks === 1 ? "" : "s"}${book.needsOwner ? ` · ${book.needsOwner} need${book.needsOwner === 1 ? "s" : ""} you` : ""}`;
const goneNote = task => { const run = !ENDED.includes(task.state) && task.runs.find(item => item.id === task.goneRun); return run ? { run: run.id, name: run.checkoutName } : null; };
function waitNext(task) {
  if (!task.waitLine || task.loop.now.needs && !task.waitLine.never) return null;
  const open = task.waits.filter(wait => !wait.met);
  return task.waitLine.never ? "Nothing until the wait changes. Ask the chief to remove the wait, or to drop this task."
    : `Starts when ${open.map(wait => wait.breakdown ? "you approve the breakdown" : `${wait.id} merges`).join(" and ")}.${task.column === "design" ? " Its design and PE may run before." : ""}`;
}
const movedText = item => `${item.tasks === 1 ? "1 open task has a new number" : `${item.tasks} open tasks have new numbers`}, and each card shows its old number. Finished tasks stay in Done as Old and read-only${item.finished ? `, except ${item.finished === 1 ? "1 finished task of a milestone, which moved with its milestone and has" : `${item.finished} finished tasks of milestones, which moved with their milestones and have`} a new number too` : ""}. The old-to-new map is move-map.html in the logbook folder ${item.folder}, on this Mac.`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const droppedNext = milestone => milestone.open ? `${plural(milestone.open, "task")} still in it: ask the chief to take each task out of the milestone.` : "No task is in it.";
const ENDS = ["done", "stopped"], WORDS = URGENCY, LISTED = 4;
const byWord = (a, b) => WORDS.indexOf(a.word) - WORDS.indexOf(b.word);
const open = item => !!item && !!item.word && (!ENDS.includes(item.word) || item.open > 0);
const doneText = (done, total, stopped) => `${done} of ${plural(total, "task")} done${stopped ? ` · ${stopped} stopped` : ""}`;
const countsText = tasks => WORDS.map(word => [word, tasks.filter(task => task.word === word).length]).filter(([, n]) => n).map(([word, n]) => `${n} ${word}`).join(" · ");
const shownReleases = model => (model.releases ?? []).filter(entry => !entry.archived);
const frameReleases = entry => { const live = entry.releases.filter(release => !ENDS.includes(release.word)); return live.length ? live : entry.releases.slice(-1); };
function waitingFor(ctx, items) {
  const why = item => item.waitLine?.never ? "never" : item.waits.find(wait => wait.breakdown && !wait.met)?.breakdown.state ?? item.waits.filter(wait => wait.id && !wait.met).map(wait => wait.id).sort().join(" ");
  const [first, ...rest] = items.map(why);
  if (!first || rest.some(key => key !== first)) return "";
  if (first === "never") return `Waiting · ${items.length === 1 ? "it cannot" : "they cannot"} start`;
  if (first === "proposed") return "Waiting for your approval";
  if (first === "changing") return "Waiting for the new breakdown";
  const names = first.split(" ").map(id => fit(ctx.tasks.get(`${items[0].project}/${id}`)?.title || id, 24));
  return `Waiting for ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
}
function frameOf(ctx, entry) {
  const task = key => ctx.tasks.get(key), milestone = key => ctx.milestones.get(key);
  const taskNode = (item, pilot) => ({ level: "task", id: item.id, name: item.title, word: item.word, here: ["needs you", "in progress"].includes(item.word), note: item.word === "in progress" ? "you are here" : pilot ? "the pilot" : "" });
  const milestoneNode = m => {
    const tasks = m.tasks.map(task).filter(open), shown = tasks.filter(item => ["needs you", "in progress"].includes(item.word)).sort(byWord).slice(0, 3), rest = tasks.filter(item => !shown.includes(item));
    const groups = WORDS.map(word => [word, rest.filter(item => item.word === word)]).filter(([, items]) => items.length).map(([word, items]) => ({ level: "group", name: plural(items.length, "task"), word, note: word === "waiting" ? waitingFor(ctx, items) : "" }));
    return { level: "milestone", name: milestoneName(m), word: m.word, here: m.word === "needs you", done: doneText(m.progress.merged, m.progress.total, m.progress.abandoned.length),
      note: m.word === "needs you" ? m.reason : m.state === "dropped" && m.open ? droppedNext(m) : "", kids: [...shown.map(item => taskNode(item, item.id === m.pilot)), ...groups] };
  };
  const list = (name, tasks, extra = {}) => ({ level: "list", name, word: releaseWord(tasks.map(item => item.word)).word, list: [...tasks].sort(byWord).map(item => ({ id: item.id, title: item.title, word: item.word })), ...extra });
  const nodes = frameReleases(entry).map(release => {
    const milestones = release.milestones.map(milestone).filter(Boolean), singles = release.singles.map(task).filter(item => item?.word);
    const ended = state => milestones.filter(m => !open(m) && m.word === state).length;
    return { level: "release", name: `Release ${release.name}`, word: release.word, done: doneText(release.done, release.total, release.stopped),
      note: release.missing ? "It is not in the logbook. Ask the chief to add it." : "",
      kids: [...milestones.filter(open).map(milestoneNode), ...(singles.length ? [list(plural(singles.length, "single task"), singles)] : [])],
      tail: ENDS.map(state => ended(state) ? `${title(state)}: ${plural(ended(state), "milestone")}` : "").filter(Boolean).join(" · ") };
  });
  const milestones = entry.loose.milestones.map(milestone).filter(open), singles = entry.loose.singles.map(task).filter(open);
  if (milestones.length || singles.length) nodes.push(list(`Not in a release: ${[milestones.length && plural(milestones.length, "milestone"), singles.length && plural(singles.length, "task")].filter(Boolean).join(" and ")}`, singles,
    { level: "loose", word: releaseWord([...milestones, ...singles].map(item => item.word)).word, kids: milestones.map(milestoneNode) }));
  return nodes;
}
const plain = value => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/\p{Cf}/gu, "");
const fit = (text, n) => { let chars = [...plain(text)]; if (columns(chars.join("")) <= n) return chars.join(""); while (chars.length && columns(chars.join("")) > n - 1) chars.pop(); return `${chars.join("").trimEnd()}…`; };
const FRAME_WIDTH = 46;
function frameText(node, w = FRAME_WIDTH) {
  const name = node.level === "task" ? `Task: ${node.name}` : node.name;
  const short = ["task", "group"].includes(node.level);
  const first = node.list ? countsText(node.list) || title(node.word) : node.level === "group" && node.note ? node.note : [title(node.word), node.done, short ? node.note : ""].filter(Boolean).join(" · ");
  const text = line => line ? [line] : [];
  return box({ w, title: fit(name, w - 6), style: node.here ? "double" : "round", lines: [...text(first), ...text(short ? "" : node.note), ...(node.kids ?? []).map(kid => frameText(kid, w - 4)), ...text(node.tail)] });
}
const whereText = model => { const ctx = context(model); return shownReleases(model).map(entry => `### ${MARKS.release} Where we are · ${md(entry.projectName)}\n${"```"}\n${frameOf(ctx, entry).flatMap(node => frameText(node)).join("\n")}\n${"```"}`); };
const goneText = task => { const note = goneNote(task); return note ? `\nThe folder ${md(note.name)} of ${md(note.run)} is not on this Mac now, so sage cannot read the branch there. The next review step of ${md(task.id)} stops until the folder is back.` : ""; };
const columnMark = key => ({ backlog: "📋", design: "🎨", building: "🔨", review: "🔁", ready: "✅", done: "🏁" }[key]);
const providerText = (name, task) => name ? md(name) : `${md(title(task.providerStandIn))} (${task.shared ? "the run names no chief" : "logbook source"})`;
const stepText = task => task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}`).join(" › ");
const nowText = task => {
  const needs = task.loop.now.needs, next = waitNext(task), ask = `Needs you: ${mdLines(task.loop.now.text)}`;
  if (next === null) return `${needs ? ask : `Now: ${mdLines(task.loop.now.text)}`}${task.loop.next ? `\nNext: ${md(task.loop.next)}` : ""}`;
  return `${needs ? `${ask}\n` : ""}${WAIT_MARK[task.waitLine.never ? "never" : "wait"]} ${needs ? "" : "Now: "}${md(task.waitLine.text)}\nNext: ${md(next)}`;
};
const CHAT_SHOWN = 5, TITLE_MAX = 80;
const wordText = item => ` · ${md(item.word || UNKNOWN)}`;
const tagText = task => `${task.priority ? ` · ${md(task.priority)}` : ""}${task.kind ? ` · ${md(KIND[task.kind][1])}` : ""}`;
const clamp = value => { const chars = [...String(value ?? "")]; return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : chars.join(""); };
export function renderTaskText(task) {
  const head = task.currentHead ? `${md(task.currentHead)}${task.headBasis === "ledger" ? " (newest verdict)" : ""}` : "not recorded";
  const where = row => row.movedTo ? ` · moved to ${md(row.movedTo)}` : row.movedFrom ? ` · from ${md(row.movedFrom)}` : "";
  const rows = task.loop.steps.map(step => `${MARK[status(step.status)]} ${md(step.label)}: ${WORD[status(step.status)]}${step.detail ? ` · ${md(step.detail)}` : ""}${step.parts?.length ? `\n  ${step.parts.map(([name, value]) => `${MARK[status(value)]} ${md(name)}: ${WORD[status(value)]}`).join(" · ")}` : ""}`).join("\n");
  const holder = `${task.shared ? `Owning chief: ${md(task.holder)}${task.owner?.unlisted ? `\n${md(`${task.owner.id} is not in chiefs.tsv, so the board does not know its provider.`)}` : ""}${task.offer ? `\n${MARKS.offer} ${md(task.offer)}` : ""}\n` : ""}${task.old ? `${md(`${oldWhat(task, "of")}.${task.old.finished ? "" : " The move did not take it to the shared logbook."} It stays there, read-only, and its number belongs to that old logbook.`)}\n` : ""}`;
  return `**${md(task.title)}** ${md(task.id)}${task.was ? ` · ${md(task.was)}` : ""}\n${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}${wordText(task)} · ${md(task.size)}${tagText(task)}${task.risk ? ` · risk: ${md(task.risk)}` : ""}${task.pr ? ` · PR ${prUrl(task) ? `[${md(task.pr)}](${mdUrl(prUrl(task))})` : md(task.pr)}` : ""}\n${holder}\n**Loop**\n${stepText(task)}\n${nowText(task)}\n${rows}\nRecorded state: ${md(task.state)} · repair round ${md(task.round)} · last commit ${head}\n\n**Brief**\nGoal: ${mdBlock(task.briefFields.goal ?? "not recorded")}\nAcceptance: ${mdBlock(task.briefFields.acceptance ?? "not recorded")}\n\nFull brief:\n${mdBlock(task.brief ?? "No verified brief content is available.")}\n\n**Agent runs**\n${task.runs.map(r => `${md(r.id)} ${providerText(r.provider, task)} · ${md(r.role)}${r.checkoutName ? ` · checkout ${md(r.checkoutName)}${r.checkoutGone ? " (gone)" : r.checkoutGone === null ? " (not checked)" : ""}` : ""} · ${md(runWord(r.status, task.runClocks?.[r.id]?.stale).text)} · ${md(task.runClocks?.[r.id]?.text ?? runTime(r))} · tokens ${md(r.tokens || "unknown")}`).join("\n") || "No runs recorded."}${goneText(task)}\n\n**Evidence**\n${task.ledger.map(r => `${md(r.kind || `verdict ${UNKNOWN}`)} · cycle ${md(r.cycle || UNKNOWN)} · ${md(r.sha || `commit ${UNKNOWN}`)} · ${md(r.run || `run ${UNKNOWN}`)} · ${md(r.at || `time ${UNKNOWN}`)}`).join("\n") || "No verdicts recorded."}${evidenceArtifacts(task).map(r => `\n\n${md(r.data.label)} · ${md(r.source)} · ${md(r.observedAt)} · ${md(r.data.run ?? "run unknown")} · digest verified\n${mdBlock(r.content.text)}`).join("")}\n\n**Findings**\n${task.findings.map(r => `${md(SEVERITIES.includes(r.severity) ? r.severity : `severity ${UNKNOWN}`)} · ${md(r.summary)} · ${md(r.status)}${where(r)}${r.reason ? ` · ${md(r.reason)}` : ""}`).join("\n") || "No findings recorded."}\n\n**Artifacts**\n${task.artifacts.map(r => `${md(r.data.label)} · ${md(r.data.url ?? (r.content?.verified ? "local artifact; digest verified" : "local artifact; content not verified"))}`).join("\n") || "No artifacts recorded."}\n\n**Latest decisions**\n${task.decisions.map(r => `${md(r.at)} · ${md(r.decision)} · ${md(r.why)}`).join("\n") || "No decisions recorded."}`;
}
const BREAK = "\\\n";
const block = (lines, quoted = []) => [lines.filter(Boolean).join(BREAK), quoted.length ? quoted.map(line => `> ${line}`).join(BREAK) : ""].filter(Boolean).join("\n");
const reasonLines = reason => {
  const [first, ...rest] = String(reason.text ?? "").split(LINE).map(line => md(line).replace(/^(\s*)([-=])/, "$1\\$2"));
  return [`${reason.gateId ? `${md(reason.key)} · ` : ""}${first}`, ...rest, ...(reason.options?.length ? [`Options: ${reason.options.map((option, i) => `${i + 1}: ${md(option)}`).join(" · ")}`] : []), ...(reason.recommendation ? [`Recommended: ${md(reason.recommendation)}`] : [])];
};
const WAIT_MARK = { never: MARKS["cannot start"], wait: MARKS.waiting };
const milestoneLine = milestone => {
  const head = `${md(milestoneName({ id: milestone.id, name: milestone.name && clamp(milestone.name) }))}${wordText(milestone)}${milestone.where ? ` · ${milestone.where}` : ""}`;
  const tasks = n => `${n} ${n === 1 ? "task" : "tasks"}`;
  const pilot = `the pilot ${md(milestone.pilot)} ${milestone.pilotState ? "was abandoned" : "is not in the logbook"}`;
  const cannot = milestone.cannotStart.length ? ` · ${milestone.cannotStart.map(md).join(", ")} cannot start` : "";
  const next = milestone.next ? `${md(milestone.next.id)} \\(${milestone.next.pilot ? "pilot, " : ""}${md(milestone.next.word)}\\)` : "no task can move now";
  return `${head} · ${{
    proposed: () => `the breakdown waits for you \\(gate ${md(milestone.gate)}\\) · pilot ${md(milestone.pilot)}${cannot}`,
    changing: () => `the chief revises the breakdown \\(gate ${md(milestone.gate)}\\)${cannot}`,
    lost: () => `${md(lostClause(milestone))} \\(see Needs you\\)`,
    dropped: () => `dropped · ${tasks(milestone.open)} still in it: ask the chief to take each task out of the milestone`,
    stuck: () => `stuck: ${pilot} \\(see Needs you\\)`,
  }[milestone.state]?.() ?? `${md(milestone.progressText)} · next: ${next}${milestone.waiting ? ` · ${milestone.waiting} ${milestone.waiting === 1 ? "waits" : "wait"}` : ""}${cannot}`}`;
};
export function renderBoardText(model) {
  const shown = model.columns.flatMap(column => column.tasks.slice(0, CHAT_SHOWN));
  const standIns = shown.some(task => task.agents.some(agent => !agent.provider));
  const milestoneTag = task => task.milestone ? ` · ${MARKS.milestone} ${md(milestoneName({ id: task.milestone.id, name: task.milestone.name && clamp(task.milestone.name) }))}${task.milestone.pilot ? " \\(pilot\\)" : ""}`
    : task.release ? ` · ${MARKS.release} Release ${md(clamp(task.release))}` : task.release === null ? " · no release" : "";
  const line = task => block([`**${md(clamp(task.title))}** ${md(task.id)}${task.was ? ` · ${md(task.was)}` : ""}${wordText(task)} · ${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}${task.pr ? ` · PR ${md(task.pr)}` : ""}${tagText(task)}${milestoneTag(task)}`,
    ...task.agents.map(agent => `${agent.provider ? md(agent.provider) : md(`${title(task.providerStandIn)}*`)} · ${md(agent.role)} at work`),
    task.inferredWork ? "Inferred from the open PR." : "",
    task.column === "done" ? "" : stepText(task),
    task.waitLine ? `${WAIT_MARK[task.waitLine.never ? "never" : "wait"]} ${md(task.waitLine.text)}` : "",
    task.column === "done" || task.loop.now.needs || task.waitLine ? "" : `Now: ${md(task.loop.now.text)}`,
    task.column === "done" || !task.offer ? "" : `${MARKS.offer} ${md(task.offer)}`]);
  const section = column => {
    const name = COLUMN_NAME[column.key] ?? column.name, rest = column.tasks.length - CHAT_SHOWN;
    return `### ${columnMark(column.key)} ${md(name)} (${column.tasks.length})\n${column.tasks.slice(0, CHAT_SHOWN).map(line).join("\n\n") || "No tasks."}${rest > 0 ? `\n\n${rest} more in ${md(name)}: open the board's Tasks page for all.` : ""}`;
  };
  const counts = model.counts;
  const approvals = model.needsOwner.flatMap(task => task.reasons.filter(reason => reason.breakdown).map(gate => [task, gate]));
  const others = model.needsOwner.map(task => ({ ...task, reasons: task.reasons.filter(reason => !reason.breakdown) })).filter(task => task.reasons.length);
  const milestoneNeeds = model.milestoneNeeds ?? [];
  let n = 0;
  const approval = ([task, gate]) => block([`**${++n} · ${md(milestoneName({ id: gate.breakdown.id, name: gate.breakdown.name && clamp(gate.breakdown.name) }))}**${wordText(model.milestones?.find(milestone => milestone.key === gate.breakdown.key) ?? {})} · ${md(task.sourceLabel)} · ${md(task.projectName)} · pilot ${md(task.id)} · gate ${md(gate.gateId)}`], reasonLines(gate));
  const milestoneNeed = need => block([`**${++n} · ${md(clamp(need.title))}** · ${md(need.sourceLabel)} · ${md(need.projectName)}`], [md(need.text)]);
  const other = task => block([`**${++n} · ${md(clamp(task.title))}** ${md(task.id)}${wordText(task)} · ${md(task.holder ?? task.sourceLabel)} · ${md(task.projectName)}`], task.reasons.flatMap(reason => reasonLines(reason)));
  const needs = approvals.length
    ? [`#### ${MARKS.milestone} Milestone approval\n${approvals.map(approval).join("\n\n")}`, ...(others.length || milestoneNeeds.length ? [`#### Other\n${[...milestoneNeeds.map(milestoneNeed), ...others.map(other)].join("\n\n")}`] : [])].join("\n\n")
    : [...milestoneNeeds.map(milestoneNeed), ...others.map(other)].join("\n\n") || "No recorded task needs you.";
  const counted = milestone => milestone.state === "done" || milestone.state === "dropped" && !milestone.open;
  const framed = new Set(shownReleases(model).map(entry => entry.key));
  const inFrame = new Set(shownReleases(model).flatMap(entry => [...frameReleases(entry).flatMap(release => release.milestones), ...entry.loose.milestones]));
  const milestones = (model.milestones ?? []).filter(milestone => !milestone.archived && (!framed.has(milestone.project) || !inFrame.has(milestone.key) && !counted(milestone)));
  const groups = new Set(milestones.map(milestone => milestone.group));
  const books = group => new Set(milestones.filter(milestone => milestone.group === group).map(milestone => milestone.project)).size;
  const where = milestone => [groups.size > 1 ? md(milestone.projectName) : "", books(milestone.group) > 1 ? md(milestone.sourceLabel) : ""].filter(Boolean).join(" · ");
  const ended = ["done", "dropped"].map(state => [state, milestones.filter(milestone => counted(milestone) && milestone.state === state).length]).filter(([, count]) => count);
  const milestoneText = milestones.length ? `### ${MARKS.milestone} Milestones\n${[...milestones.filter(milestone => !counted(milestone)).map(milestone => `- ${milestoneLine({ ...milestone, where: where(milestone) })}`), ...(ended.length ? [`- ${ended.map(([state, count]) => `${count} ${state}`).join(" · ")}: see the board's Tasks page, grouped by milestone`] : [])].join("\n")}` : "";
  const changing = (model.changing ?? []).map(item => `The logbook is changing: ${md(item.project)} · read at ${md(hhmm(item.at))} UTC${item.dropped ? `, without what changed during it (${md(item.dropped.join("; "))})` : ""}. The board shows that read; ask for the board again for a read with no change.`);
  const moved = (model.moved ?? []).map(item => `⇢ ${md(`${item.project} moved to one shared logbook on ${day(item.at)} UTC. ${movedText(item)}`)}`);
  const top = block([`**sage board** · built ${md(day(model.at))} UTC`, ...changing, ...moved,`🔴 ${n} needs you · ${counts.recordedAgents} agents at work${counts.inferredWork ? ` · ${counts.inferredWork} inferred PRs` : ""} · 🔁 ${counts.inReview} in review · ${counts.tasks} tasks`, standIns ? `${md("*")} A stand-in: the run does not record its provider, so the board names the logbook's source.` : ""]);
  const end = block([model.archived.length ? `Archived: ${model.archived.map(book => `${md(book.name)} (${archivedCounts(book)})`).join(", ")}` : "",
    ...model.diagnostics.map(d => `Incomplete source: ${md(d.source)}${d.project ? ` · ${md(d.project)}` : ""} · ${md(d.message)}`), ...model.warnings.map(d => `Setting ignored: ${md(d.source)} · ${md(d.project)} · ${md(d.message)}`), ...(model.notes ?? []).map(d => `Logbook note: ${md(d.source)} · ${md(d.project)} · ${md(d.message)}`)]);
  return [top, `### 🔴 Needs you\n${needs}`, ...whereText(model), milestoneText, ...model.columns.map(section), end].filter(Boolean).join("\n\n");
}
export function renderBoardStatus(model) {
  const states = new Map(); for (const task of model.tasks.filter(task => !task.archived)) states.set(task.state, (states.get(task.state) ?? 0) + 1);
  const archivedNeeds = model.archived.reduce((n, book) => n + book.needsOwner, 0);
  return `Tasks: ${[...states].map(([state,n]) => `${state} ${n}`).join(" · ") || "none recorded"}\nAgents: ${model.counts.recordedAgents} recorded running · ${model.counts.inferredWork} inferred PRs\nOwner: ${model.counts.needsOwner} need you\n${model.archived.length ? `Archived: ${model.archived.length} project${model.archived.length === 1 ? "" : "s"} · ${archivedNeeds} need you\n` : ""}Budget this week: unknown; no provider observation available${model.diagnostics.length ? `\nSources: ${model.diagnostics.length} diagnostics; counts may be incomplete` : ""}`;
}
