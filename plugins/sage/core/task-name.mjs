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

export function taskNames(tasks) {
  const lead = (t) => String(t.title ?? "").split(":")[0].trim();
  const firstWords = (t) => {
    const words = wordsOf([...String(t.title ?? "")].map((c) => (separated(c) ? " " : c)).join("")).slice(0, WORDS_MAX);
    while (words.length > 1 && [...words.join(" ")].length > TASK_NAME_MAX) words.pop();
    const chars = [...words.join(" ")];
    return chars.length > TASK_NAME_MAX ? `${chars.slice(0, TASK_NAME_MAX - 1).join("")}…` : chars.join("");
  };
  const shown = new Map(tasks.filter((t) => t.name).map((t) => [t, { name: t.name, given: true }]));
  for (const closed of [false, true]) for (const pick of [lead, firstWords]) {
    const want = new Map(tasks.filter((t) => ENDED.includes(t.state) === closed && !shown.has(t)).map((t) => [t, pick(t)])), taken = new Map();
    for (const t of open(tasks)) { const key = releaseKey(shown.get(t)?.name ?? want.get(t)); taken.set(key, (taken.get(key) ?? 0) + 1); }
    for (const [t, name] of want) if (!taskNameProblem(name) && (taken.get(releaseKey(name)) ?? 0) === (closed ? 0 : 1)) shown.set(t, { name, given: false });
  }
  return new Map(tasks.map((t) => [t.id, shown.get(t) ?? { name: t.id, given: false }]));
}
