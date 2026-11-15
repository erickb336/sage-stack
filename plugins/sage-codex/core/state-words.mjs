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
  const { state, waitLine = null } = card ?? {}, reasons = card?.reasons ?? [];
  if (ENDS[state]) return { word: ENDS[state][0], reason: ENDS[state][1] };
  if (!DOING[state]) return { word: null, reason: `The board cannot read the state "${state}".` };
  const chiefs = reasons.some(reason => reason.kind === "merge-refused") ? ["merge-refused", "checks-fail", "qa-fail"] : [];
  const owner = reasons.filter(reason => !chiefs.includes(reason.kind));
  if (owner.length) return { word: "needs you", reason: owner[0].text };
  if (waitLine && ["framed", "briefed"].includes(state)) return { word: "waiting", reason: waitLine.text };
  return { word: state === "framed" ? "not started" : "in progress", reason: reasons[0]?.text ?? DOING[state] };
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
export const FLAGS = ["failed", "blocked", "may be stuck", "running long", "run still open"];
export const UNKNOWN = "unknown";
export const MARKS = { "not started": "○", waiting: "⧗", "needs you": "?", "in progress": "▶", done: "✓", stopped: "■", problem: "!", unknown: "◌", milestone: "◫", release: "◎" };

const each = (keys, word) => Object.fromEntries(keys.map(key => [key, [word]]));
const ended = Object.fromEntries(Object.entries(ENDS).map(([state, [word]]) => [state, [word]]));
export const OBJECTS = {
  project: { label: "Project", states: {} },
  release: { label: "Release", states: {} },
  milestone: { label: "Milestone", states: Object.fromEntries(Object.entries(MILESTONE).map(([state, [word]]) => [state, [word]])) },
  task: { label: "Task", states: { ...each(Object.keys(DOING), "in progress"), framed: ["not started"], ...ended } },
  agent: { label: "Agent", states: {
    queued: ["waiting"], running: ["in progress"], done: ["done"], question: ["done"], failed: ["stopped", "failed"], blocked: ["stopped", "blocked"],
    work: ["in progress"], wait: ["waiting"], unk: ["in progress"], stuck: ["in progress", "may be stuck"], long: ["in progress", "running long"], stop: ["stopped", "run still open"],
  } },
  question: { label: "Question", states: { open: ["needs you"], answered: ["in progress"], picked: ["done"], dropped: ["stopped"] } },
  "pull request": { label: "Pull request", states: { open: ["in progress"], ready: ["needs you"], merged: ["done"], closed: ["stopped"] } },
  chief: { label: "Chief", states: { idle: ["waiting"], live: ["in progress"], waits: ["needs you"], stopped: ["stopped"] } },
};
export const STEPS = { done: ["done"], run: ["in progress"], need: ["needs you"], wait: ["not started"], idle: ["waiting"], stale: ["in progress", "may be stuck"], fail: ["done", "failed"] };

export const shown = ([word, flag] = []) => ({ word: word ?? UNKNOWN, flag: flag ?? null, mark: flag ? MARKS.problem : MARKS[word] ?? MARKS.unknown, text: !word ? UNKNOWN : flag ? `${word} · ${flag}` : word });
export const prName = number => `PR ${number}`;
export const chiefName = (id, provider) => [provider && `${String(provider).charAt(0).toUpperCase()}${String(provider).slice(1)}`, id].filter(Boolean).join(" · ");
