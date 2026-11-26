import { ACTIVITY_UNKNOWN, LOOK_AT_IT, STOPPED_NO_REPORT } from "./state-words.mjs";

export const AGENT_QUIET_MS = 15 * 60_000;
const USUAL_BASIS = 5;
const DAY = 86_400_000;
const NO_NOTES = ["codex"];
const LEVELS = ["red", "amber"];

const title = text => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const span = ms => { const m = Math.max(0, Math.floor(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const article = word => /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;

export function usualTop(durations) {
  const sorted = durations.filter(ms => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  return sorted.length < USUAL_BASIS ? null : sorted[Math.ceil(sorted.length * 0.9) - 1];
}

export function agentFlag({ at, provider = "", role = "agent", chiefStopped = null, ended = false, endedAt = null, noSlot = false, stale = false, since = null, noteAt = null, startedAt = null, usual = null, waits = false }) {
  const flag = (level, text, why) => ({ level, text, why });
  if (chiefStopped) return flag("red", STOPPED_NO_REPORT, `its chief ${chiefStopped} stopped, so no agent works on it; the logbook still says running`);
  if (ended) return flag("red", STOPPED_NO_REPORT, `its process ended${endedAt ? ` at ${new Date(endedAt).toISOString().slice(11, 16)} UTC` : ""} with no report; the logbook still says running`);
  const name = String(provider ?? "").toLowerCase();
  if (NO_NOTES.includes(name)) return flag("calm", `${title(name)}: ${ACTIVITY_UNKNOWN}`, `${title(name)} sends no activity notes yet${stale ? `; no news since ${since}` : ""}`);
  if (noSlot) return flag("amber", LOOK_AT_IT, "no agent slot holds this run: the hook frees a slot after 60 min with no activity. Ask the chief to check the run.");
  const quiet = noteAt === null ? null : Math.max(0, at - noteAt);
  if (stale && !(quiet !== null && quiet < DAY)) return flag("amber", LOOK_AT_IT, `no news since ${since}, so ask the chief to check it`);
  if (!waits && quiet !== null && quiet >= AGENT_QUIET_MS && usual !== null && startedAt !== null && at - startedAt > usual) {
    return flag("amber", LOOK_AT_IT, `no note for ${span(quiet)}, and past ${span(usual)}, the usual top length of ${article(role)} run here`);
  }
  return null;
}

export function agentFlagAt({ noteAt = null, startedAt = null, usual = null, waits = false }) {
  return waits || noteAt === null || startedAt === null || usual === null ? null : Math.max(noteAt + AGENT_QUIET_MS, startedAt + usual + 1);
}

export const needsLook = flag => LEVELS.includes(flag?.level);
export const flagRank = flag => LEVELS.includes(flag?.level) ? LEVELS.indexOf(flag.level) : LEVELS.length;
