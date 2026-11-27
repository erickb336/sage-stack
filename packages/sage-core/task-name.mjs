import { nameProblem } from "./logbook-fields.mjs";
import { ENDED, ID_FORM, releaseKey } from "./milestone-rules.mjs";

export const TASK_NAME_MAX = 32;
const WORDS_MAX = 4;
const SEPARATOR = /[:·,]/u;
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
  if (SEPARATOR.test(name)) return "has a colon, a middle dot (·) or a comma, which the board's sentence uses as a separator: leave it out";
  return null;
}

export const taskNameTwin = (name, tasks, self) => open(tasks).find((t) => t.id !== self && t.name && releaseKey(t.name) === releaseKey(name));

export function taskNames(tasks) {
  const lead = (t) => String(t.title ?? "").split(":")[0].trim();
  const taken = new Map();
  for (const t of open(tasks)) {
    const key = releaseKey(t.name ? t.name : lead(t));
    taken.set(key, (taken.get(key) ?? 0) + 1);
  }
  return new Map(tasks.map((t) => {
    if (t.name) return [t.id, { name: t.name, given: true }];
    const first = lead(t), mine = ENDED.includes(t.state) ? 0 : 1;
    if (!taskNameProblem(first) && (taken.get(releaseKey(first)) ?? 0) === mine) return [t.id, { name: first, given: false }];
    const words = wordsOf(String(t.title ?? "").replaceAll(new RegExp(SEPARATOR, "gu"), " ")).slice(0, WORDS_MAX);
    while (words.length > 1 && [...words.join(" ")].length > TASK_NAME_MAX) words.pop();
    const text = words.join(" "), chars = [...text];
    return [t.id, { name: chars.length > TASK_NAME_MAX ? `${chars.slice(0, TASK_NAME_MAX - 1).join("")}…` : text || t.id, given: false }];
  }));
}
