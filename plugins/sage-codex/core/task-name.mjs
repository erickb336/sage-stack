import { nameProblem } from "./logbook-fields.mjs";
import { ENDED, ID_FORM, releaseKey } from "./milestone-rules.mjs";

export const TASK_NAME_MAX = 32;
const WORDS_MAX = 4;
const SEPARATOR = /[:·,、・∶꞉‧∙⋅]/u;
const separated = (text) => SEPARATOR.test(text.normalize("NFKC"));
const wordsOf = (text) => text.split(/\s+/u).filter(Boolean);
const open = (tasks) => tasks.filter((t) => !ENDED.includes(t.state));

export function taskNameProblem(name) {
  const why = nameProblem(name, TASK_NAME_MAX);
  if (why) return why;
  const words = wordsOf(name).length;
  if (words > WORDS_MAX) return `has ${words} words: give 1 to ${WORDS_MAX}`;
  const key = releaseKey(name);
  if (ID_FORM.test(key)) return "has the form of a sage id (such as T12 or M3), so a line could read it as that id: give it words";
  if (key === "none") return "is none, which sage reads as no name: give it words";
  if (separated(name)) return "has a colon, a middle dot (·) or a comma, or a mark like one, which the board's sentence uses as a separator: leave it out";
  return null;
}

export const taskNameTwin = (name, tasks, self) => !ENDED.includes(tasks.find((t) => t.id === self)?.state)
  && open(tasks).find((t) => t.id !== self && t.name && releaseKey(t.name) === releaseKey(name));

const CLOSES = { __proto__: null, ")": "(", "]": "[", "}": "{" };
const balanced = (text) => {
  const open = [];
  for (const c of text) if ("([{".includes(c)) open.push(c); else if (CLOSES[c] && open.pop() !== CLOSES[c]) return false;
  return !open.length;
};
function shortName(text, whole) {
  const all = wordsOf(text), words = all.slice(0, WORDS_MAX), name = () => `${words.join(" ")}${words.length < all.length ? "…" : ""}`;
  while (words.length > 1 && (!balanced(words.join(" ")) || [...name()].length > TASK_NAME_MAX)) words.pop();
  const chars = [...name()], cut = chars.length > TASK_NAME_MAX ? `${chars.slice(0, TASK_NAME_MAX - 1).join("")}…` : chars.join("");
  return balanced(cut) && !(whole && cut.endsWith("…")) ? cut : null;
}

export function taskNames(tasks) {
  const title = (t) => String(t.title ?? "");
  const picks = [(t) => shortName(title(t).split(":")[0], true), (t) => shortName([...title(t)].map((c) => (separated(c) ? " " : c)).join(""), false)];
  const isOpen = (t) => !ENDED.includes(t.state), scope = (t) => t.milestone ?? "";
  const shown = new Map(tasks.filter((t) => t.name && !taskNameProblem(t.name)).map((t) => [t, { name: t.name, given: true }]));
  for (const closed of [false, true]) for (const pick of picks) {
    const want = new Map(tasks.filter((t) => !isOpen(t) === closed && !shown.has(t)).map((t) => [t, pick(t)]).filter(([, name]) => name && !taskNameProblem(name)));
    const inScope = new Map(), inOpen = new Map(), add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1), at = (t, name) => JSON.stringify([releaseKey(name), scope(t)]);
    for (const [t, name] of [...[...shown].map(([t, { name }]) => [t, name]), ...want]) { add(inScope, at(t, name)); if (isOpen(t)) add(inOpen, releaseKey(name)); }
    for (const [t, name] of want) if (inScope.get(at(t, name)) === 1 && (inOpen.get(releaseKey(name)) ?? 0) === (isOpen(t) ? 1 : 0)) shown.set(t, { name, given: false });
  }
  return new Map(tasks.map((t) => [t.id, shown.get(t) ?? { name: t.id, given: false }]));
}
