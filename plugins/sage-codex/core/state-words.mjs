const BUILT = "built", MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const PHRASE = {
  __proto__: null,
  framed: f => f.agents ? `in ${f.step ?? "the plan"}` : "not started",
  designing: () => "in design",
  "awaiting-you": f => f.asked ? "in design" : "you answered; the chief moves it on",
  briefed: f => f.step ? `${f.step} starts next` : "briefed",
  building: f => `in ${f.step ?? "progress"}`,
  held: () => "held by the chief",
  reviewing: f => f.made === BUILT ? `built, in review${f.clean === null ? "" : `, ${f.clean} of ${f.required} ${f.required === 1 ? "cycle" : "cycles"} clean`}`
    : f.made ? `${f.made}, in the evidence review${f.clean === null || f.required < 2 ? "" : `, ${f.clean} of ${f.required} reviews clean`}` : "in review",
  repairing: f => f.made && f.step ? `${f.made}, in ${f.step}` : "in repair",
  replan: () => "the chief makes a new plan",
  verifying: f => f.step ? `the last checks before ${f.step}` : "the last checks",
  verified: f => f.made === BUILT ? "ready to merge" : f.made ? "ready to conclude" : "ready",
  "pr-ready": f => PHRASE.verified(f),
  merged: f => `merged${f.day}`,
  concluded: f => f.made === BUILT ? `closed with no merge${f.day}` : `concluded${f.day}`,
  abandoned: () => "stopped for good",
};
const ENDS = { __proto__: null, merged: "done", concluded: "done", abandoned: "stopped" };
const OPEN = Object.keys(PHRASE).filter(state => !ENDS[state]);
const cap = text => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const andOf = list => list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "";
const dayOf = at => { const when = typeof at === "number" ? at : Date.parse(at); return Number.isFinite(when) ? ` ${new Date(when).getDate()} ${MONTHS[new Date(when).getMonth()]}` : ""; };
const factsOf = card => ({ asked: !!card?.reasons?.length, step: card?.loop?.name || null, made: card?.loop?.build ? BUILT : card?.loop?.investigate ? "report written" : null,
  clean: card?.loop?.cycles?.clean ?? null, required: card?.loop?.cycles?.required ?? 1, day: dayOf(card?.completedAt), agents: (card?.agents ?? []).length });
const phraseOf = card => PHRASE[card.state](factsOf(card));

export function taskWord(card) {
  const { state, waitLine = null } = card ?? {}, reasons = card?.reasons ?? [], problems = card?.problems ?? [];
  if (ENDS[state]) return { word: ENDS[state], reason: `${cap(phraseOf(card))}.` };
  if (!PHRASE[state]) return { word: null, reason: `The board cannot read the state "${state}".` };
  if (reasons.length) return { word: "needs you", reason: reasons[0].text };
  if (waitLine && ["framed", "briefed"].includes(state)) return { word: "waiting", reason: waitLine.text };
  return { word: state === "framed" ? "not started" : "in progress", reason: problems[0]?.text ?? `${cap(phraseOf(card))}.` };
}

const ASK = {
  gate: r => r.breakdown ? "Needs your approval of the breakdown." : r.design ? "Needs your approval of the design." : r.replace ? "Needs your answer: hand it to another chief?" : "Needs your answer.",
  design: () => "Needs your answer on the design.",
  merge: r => r.mode ? "Needs you to merge it: autopilot is off." : "Needs you to merge it: the board cannot tell if autopilot is on.",
  "merge-check": () => "Needs you: the merge check is not checked.",
  "review-wait": () => "Needs your review of its pull request.",
  "chief-unknown": () => "Needs you: its chief may have stopped.",
};
const needOf = reasons => !reasons.length ? null : reasons.length > 1 ? reasons.every(r => r.kind === "gate") ? `Needs your answers to ${reasons.length} questions.` : `Needs you for ${reasons.length} things.`
  : Object.hasOwn(ASK, reasons[0].kind) ? ASK[reasons[0].kind](reasons[0]) : "Needs you.";
const neverOf = (wait, nameOf) => wait.odd ? "its waits cell is not a task id" : wait.breakdown ? `the breakdown of its milestone is ${wait.breakdown.state === "dropped" ? "dropped" : "lost"}`
  : wait.loop ? `its waits make a loop through ${nameOf(wait.id)}` : wait.state === null ? `${wait.id} is not in the logbook` : `${nameOf(wait.id)} was abandoned`;
function waitsOf(waits, nameOf) {
  const never = waits.filter(wait => wait.never);
  if (never.length) return `cannot start, because ${andOf(never.map(wait => neverOf(wait, nameOf)))}`;
  return `waits for ${andOf(waits.map(wait => wait.breakdown ? wait.breakdown.state === "changing" ? "the new breakdown" : "your approval of the breakdown" : nameOf(wait.id)))}`;
}
export const ROWS = { needs: ["needs you", "need"], work: ["in progress", "run"], waits: ["waiting", ""], done: ["done", "done"], stopped: ["stopped", ""] };
export const rowMark = row => ({ mark: MARKS[ROWS[row]?.[0]] ?? MARKS.unknown, tone: ROWS[row]?.[1] ?? "" });
export function taskSentence(card, nameOf = id => id, asks = card.state !== "abandoned") {
  const { word } = taskWord(card), reasons = asks ? card.reasons ?? [] : [], problems = card.problems ?? [], agents = ENDS[card.state] ? 0 : (card.agents ?? []).length;
  const waiting = !!word && !ENDS[card.state] && !!card.waitLine && ["framed", "briefed"].includes(card.state), never = waiting && !!card.waitLine.never;
  const says = `${!word ? `the board cannot read the state "${card.state}"` : waiting ? waitsOf(card.waitLine.waits ?? [], nameOf) : phraseOf(card)}${agents ? `, ${agents} ${agents === 1 ? "agent" : "agents"} at work` : ""}`;
  const need = needOf(reasons), flag = problems[0]?.text ?? null;
  const shown = rowMark(need ? "needs" : ENDS[card.state] === "stopped" ? "stopped" : ENDS[card.state] ? "done" : agents ? "work" : "waits");
  const mark = need ? shown.mark : flag ? MARKS.problem : never ? MARKS["cannot start"] : !word ? MARKS.unknown : !agents && card.state === "framed" && !waiting ? MARKS["not started"] : shown.mark;
  return { says, need, flag, mark, tone: !need && (flag || never) ? "fail" : shown.tone };
}

export function milestoneSentence(milestone, needs = []) {
  const { state, merged, total, abandoned = [], moving = 0, waiting = 0, cannotStart = [] } = milestone, asked = MILESTONE[state];
  const done = state === "done";
  const says = asked && asked[0] !== "needs you" ? asked[1].charAt(0).toLowerCase() + asked[1].slice(1, -1) : done ? `done, ${merged === total ? `all ${total}` : `${merged} of ${total}`} ${total === 1 ? "task" : "tasks"} merged${abandoned.length ? `, ${abandoned.length} abandoned` : ""}${dayOf(milestone.doneAt)}`
    : [`${merged} of ${total} ${total === 1 ? "task" : "tasks"} merged`, moving && `${moving} at work`, waiting && `${waiting} waiting`, cannotStart.length && `${cannotStart.length} cannot start`].filter(Boolean).join(", ");
  const need = [asked?.[0] === "needs you" && asked[1], needs.length && `${andOf(needs)} ${needs.length === 1 ? "needs" : "need"} you.`].filter(Boolean).join(" ") || null;
  return { says, need, mark: MARKS.milestone, tone: need ? "need" : done ? "done" : moving ? "run" : "" };
}

const MILESTONE = {
  __proto__: null,
  proposed: ["needs you", "Its breakdown waits for your answer."],
  lost: ["needs you", "The logbook lost its breakdown gate. Ask the chief to repair it."],
  stuck: ["needs you", "Its pilot stopped. Choose a new pilot, or drop the milestone."],
  changing: ["in progress", "You asked for changes. The chief revises the breakdown."],
  dropped: ["stopped", "You dropped it."],
};

export function milestoneWord({ state }, words = []) {
  return MILESTONE[state] ? { word: MILESTONE[state][0], reason: MILESTONE[state][1] } : releaseWord(words);
}

export function releaseWord(words = []) {
  const done = words.filter(word => word === "done").length, stopped = words.filter(word => word === "stopped").length;
  const count = `${done} of ${words.length} done.`;
  if (!words.length) return { word: "not started", reason: "Nothing is in it yet." };
  if (stopped === words.length) return { word: "stopped", reason: "Each item is stopped." };
  if (done + stopped === words.length) return { word: "done", reason: count };
  if (words.every(word => word === "not started" || word === "waiting")) return { word: "not started", reason: "Nothing in it has started." };
  return { word: "in progress", reason: count };
}

export const WORDS = ["not started", "waiting", "needs you", "in progress", "done", "stopped"];
export const URGENCY = ["needs you", "in progress", "waiting", "not started", "done", "stopped"];
export const LOOK_AT_IT = "Look at it", STOPPED_NO_REPORT = "Stopped without a report", ACTIVITY_UNKNOWN = "activity unknown";
export const FLAGS = ["failed", "blocked", LOOK_AT_IT, STOPPED_NO_REPORT];
export const UNKNOWN = "unknown";
export const MARKS = { "not started": "○", waiting: "⧗", "needs you": "?", "in progress": "▶", done: "✓", stopped: "■", problem: "!", unknown: "◌", milestone: "◫", release: "◎", "cannot start": "⊘" };
export const FLAGGED = "with a problem flag";
export const KINDS = { design: ["◇", "Design"], ui: ["▢", "UI"], orchestration: ["⋈", "Orchestration"], optimization: ["↗", "Optimization"], "bug-fix": ["✱", "Bug fix"], logbook: ["≡", "Logbook"], docs: ["¶", "Docs"], security: ["▲", "Security"], providers: ["⊞", "Providers"], checks: ["⊨", "Checks"] };

const each = (keys, word) => Object.fromEntries(keys.map(key => [key, [word]]));
const ended = Object.fromEntries(Object.entries(ENDS).map(([state, word]) => [state, [word]]));
export const headingId = text => `h-${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "part"}`;
export const SCRIPT_PAGE_NOTE = "This page runs its own scripts in a sandbox. They cannot read the board, your files or other pages, but they can send the text of this page to another site.";
export const OBJECTS = {
  project: { label: "Project", states: {} },
  release: { label: "Release", states: {} },
  milestone: { label: "Milestone", states: Object.fromEntries(Object.entries(MILESTONE).map(([state, [word]]) => [state, [word]])) },
  task: { label: "Task", states: { ...each(OPEN, "in progress"), framed: ["not started"], ...ended } },
  agent: { label: "Agent", states: {
    queued: ["waiting"], running: ["in progress"], done: ["done"], question: ["needs you"], failed: ["stopped", "failed"], blocked: ["stopped", "blocked"],
    work: ["in progress"], wait: ["waiting"],
  } },
  question: { label: "Question", states: {} },
  "pull request": { label: "Pull request", states: {} },
  chief: { label: "Chief", states: { live: ["in progress"], quiet: ["waiting"], waits: ["needs you"], stopped: ["stopped"] } },
};
export const STEPS = { done: ["done"], run: ["in progress"], need: ["needs you"], wait: ["not started"], idle: ["waiting"], stale: ["in progress", LOOK_AT_IT], lost: ["in progress", STOPPED_NO_REPORT], fail: ["done", "failed"], blocked: ["in progress", "blocked"] };

export const shown = ([word, flag] = []) => ({ word: word ?? UNKNOWN, flag: flag ?? null, mark: flag ? MARKS.problem : MARKS[word] ?? MARKS.unknown, text: !word ? UNKNOWN : flag ? `${word} · ${flag}` : word });
export const runWord = (status, flag = null) => {
  const word = shown(Object.hasOwn(OBJECTS.agent.states, status) ? OBJECTS.agent.states[status] : undefined);
  return flag && word.word !== UNKNOWN ? { ...word, flag: flag.text, mark: flag.level === "calm" ? word.mark : MARKS.problem, text: `${word.text} · ${flag.text}` } : word;
};
export const prName = number => `PR ${number}`;
export const chiefName = (id, provider) => [provider && `${String(provider).charAt(0).toUpperCase()}${String(provider).slice(1)}`, id].filter(Boolean).join(" · ");

const counted = (count, one) => `${count} ${count === 1 ? one : `${one}s`}`;
const SESSION_NOT_CONFIRMED = "Program not confirmed: this session passes on only when it exits, or after 8 h with no action.";
const idleText = ms => { const m = Math.max(0, Math.floor(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`; };
const lostText = (count) => count ? `${counted(count, "run")} lost` : null;
const MOVED = [["tasks", "task"], ["gates", "question"], ["queued", "queued run"]];
const movedKinds = (counts) => MOVED.filter(([kind]) => counts[kind]).map(([kind, word]) => counted(counts[kind], word));
const moved = (counts) => andList(movedKinds(counts)) || "no task";
const pickupNotes = (chief, stamp) => [chief.pickedUp && [`picked up ${moved(chief.pickedUp)} at ${stamp(chief.pickedUp.at)}`, lostText(chief.pickedUp.lost)].filter(Boolean).join(", "),
  chief.passedOn && `passed on to ${chief.passedOn.to} at ${stamp(chief.passedOn.at)}`].filter(Boolean);
const andList = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
export function pickupLine(pickup, clock) {
  const tasksOnly = !pickup.gates && !pickup.queued;
  const from = pickup.sources.map((source) => `${source.tasks && tasksOnly ? source.tasks : andList(movedKinds(source)) || "nothing open"} ${source.from ? `from ${chiefName(source.from, source.fromProvider)}` : "with no owning chief"}`);
  const lost = pickup.lost.length ? `${lostText(pickup.lost.length)}: ${pickup.lost.join(", ")}` : "no run lost";
  return `${clock(pickup.at)} · ${chiefName(pickup.to, pickup.toProvider)} picked up ${moved(pickup)}: ${andList(from)} · ${lost}`;
}

const DATED_AFTER_MS = 12 * 3_600_000;
export function sessionRow(chief, now, clock, dated = clock) {
  const stamp = (at) => (Date.parse(now) - Date.parse(at) < DATED_AFTER_MS ? clock(at) : dated(at));
  const row = sessionWords(chief, now, clock), notes = pickupNotes(chief, stamp);
  return notes.length ? { ...row, sub: [row.sub, ...notes].join(" · ") } : row;
}
export const stoppedAt = (chief) => chief.reason === "ended" ? chief.endedAt : chief.reason === "quiet-8h" ? new Date(Date.parse(chief.heartbeat) + 8 * 3_600_000).toISOString() : chief.heartbeat;
function sessionWords(chief, now, clock) {
  const head = `${chiefName(null, chief.provider) || "Chief"} · ${chief.id}`, holds = counted(chief.tasks, "task");
  if (chief.session === "stopped") {
    const ended = chief.reason === "ended";
    return { dot: "stopped", word: ended ? "ended" : "stopped", head: `${head} · ${ended ? "ended" : "stopped"} ${clock(stoppedAt(chief))}`,
      sub: [holds, lostText(chief.lost), chief.reason === "quiet-8h" ? "8 h with no action" : null].filter(Boolean).join(" · ") };
  }
  if (chief.session === "quiet") return { dot: "quiet", word: "quiet", head: `${head} · no action for ${idleText(Date.parse(now) - Date.parse(chief.heartbeat))}`,
    sub: [holds, "no agent", chief.passOnAt ? `passes on at ${clock(chief.passOnAt)}` : "waits for your answer, so it keeps its tasks"].join(" · ") };
  if (chief.session === "live") return { dot: "live", word: "live", head: `${head} · since ${clock(chief.startedAt)}`,
    sub: [holds, counted(chief.agents, "agent"), chief.confirmed ? null : "program not confirmed"].filter(Boolean).join(" · "), note: chief.confirmed ? null : SESSION_NOT_CONFIRMED };
  return { dot: "unknown", word: UNKNOWN, head: `${head} · no record`, sub: `${holds} · the session sends no sign of life` };
}

export const DESIGN_OPTIONS = ["Approve", "Approve with your words", "New version"];
export const WORDS_MAX = 1000;
export const withWords = (words) => `${DESIGN_OPTIONS[1]}: ${words}`;
export const answerOption = (options, answer) => options.findIndex((option) => option === answer || (option === DESIGN_OPTIONS[1] && String(answer ?? "").startsWith(withWords(""))));
