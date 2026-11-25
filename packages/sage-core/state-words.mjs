const DOING = {
  __proto__: null,
  framed: "No agent works on it yet.",
  designing: "Agents design it.",
  "awaiting-you": "You answered. The chief moves it on.",
  briefed: "The build starts next.",
  building: "Agents build it.",
  held: "Held. The chief moves it on.",
  reviewing: "Reviewers and QA check it.",
  repairing: "Agents fix the findings.",
  replan: "The chief makes a new plan.",
  verifying: "The last clean cycles run.",
  verified: "Every check is clean.",
  "pr-ready": "The pull request is ready to merge.",
};
const ENDS = { __proto__: null, merged: ["done", "Merged."], concluded: ["done", "The study ended."], abandoned: ["stopped", "Stopped for good."] };

export function taskWord(card) {
  const { state, waitLine = null } = card ?? {}, reasons = card?.reasons ?? [], problems = card?.problems ?? [];
  if (ENDS[state]) return { word: ENDS[state][0], reason: ENDS[state][1] };
  if (!DOING[state]) return { word: null, reason: `The board cannot read the state "${state}".` };
  if (reasons.length) return { word: "needs you", reason: reasons[0].text };
  if (waitLine && ["framed", "briefed"].includes(state)) return { word: "waiting", reason: waitLine.text };
  return { word: state === "framed" ? "not started" : "in progress", reason: problems[0]?.text ?? DOING[state] };
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
const ended = Object.fromEntries(Object.entries(ENDS).map(([state, [word]]) => [state, [word]]));
export const headingId = text => `h-${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "part"}`;
export const SCRIPT_PAGE_NOTE = "This page runs its own scripts in a sandbox. They cannot read the board, your files or other pages, but they can send the text of this page to another site.";
export const OBJECTS = {
  project: { label: "Project", states: {} },
  release: { label: "Release", states: {} },
  milestone: { label: "Milestone", states: Object.fromEntries(Object.entries(MILESTONE).map(([state, [word]]) => [state, [word]])) },
  task: { label: "Task", states: { ...each(Object.keys(DOING), "in progress"), framed: ["not started"], ...ended } },
  agent: { label: "Agent", states: {
    queued: ["waiting"], running: ["in progress"], done: ["done"], question: ["needs you"], failed: ["stopped", "failed"], blocked: ["stopped", "blocked"],
    work: ["in progress"], wait: ["waiting"],
  } },
  question: { label: "Question", states: {} },
  "pull request": { label: "Pull request", states: {} },
  chief: { label: "Chief", states: { live: ["in progress"], quiet: ["waiting"], waits: ["needs you"], stopped: ["stopped"] } },
};
export const STEPS = { done: ["done"], run: ["in progress"], need: ["needs you"], wait: ["not started"], idle: ["waiting"], stale: ["in progress", LOOK_AT_IT], fail: ["done", "failed"], blocked: ["in progress", "blocked"] };

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
