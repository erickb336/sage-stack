import { folderProblems, isOpen } from "./board-model.mjs";
import { projectNames } from "./board-overview.mjs";
import { WORDS } from "./state-words.mjs";

const STATS_WEEKS = 8;
const DAY = 86400000, WEEK = 7 * DAY;
const time = value => typeof value === "number" ? value : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const title = text => text.charAt(0).toUpperCase() + text.slice(1);
const TOKENS = /^[1-9]\d{0,11}$/;
const mondayOf = at => { const day = new Date(at); day.setUTCHours(0, 0, 0, 0); return day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY; };
const hours = ms => Math.round(ms / 360000) / 10;
const LEFT_OUT_BY_TABLE = { runs: "the agent time and tokens", decisions: "the merges", gates: "the questions" };
const and = list => list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
const leftOut = tables => tables.includes("tasks") ? "every task" : and(Object.keys(LEFT_OUT_BY_TABLE).filter(name => tables.includes(name)).map(name => LEFT_OUT_BY_TABLE[name])) ?? null;
const median = list => { if (!list.length) return null; const sorted = [...list].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

export function boardStats(model, project = null) {
  const at = time(model.at), first = mondayOf(at) - (STATS_WEEKS - 1) * WEEK;
  const shown = (model.projects ?? []).filter(item => project === null || item.key === project);
  if (project !== null && !shown.length) return null;
  const names = projectNames(model), week = ms => ms === null || ms < first || ms > at ? -1 : Math.floor((ms - first) / WEEK);
  const total = { merged: 0, undated: 0, open: 0, needs: 0, ms: 0, tokens: 0, runs: 0, noTokens: 0, noTime: 0 };
  const perWeek = { merged: Array(STATS_WEEKS).fill(0), ms: Array(STATS_WEEKS).fill(0), tokens: Array(STATS_WEEKS).fill(0) };
  const open = Object.fromEntries(WORDS.filter(word => !["done", "stopped"].includes(word)).map(word => [word, 0])), rounds = [0, 0, 0, 0], roundList = [];
  const projects = shown.map(item => {
    const row = { key: item.key, name: names.get(item.key), archived: !!item.archived, merged: 0, open: 0, needs: (item.needsOwner ?? 0) - (item.problems ?? 0), ms: 0, tokens: 0 };
    for (const task of model.tasks.filter(task => task.group === item.key)) {
      if (isOpen(task)) { const word = task.word ?? "unknown"; row.open++; open[word] = (open[word] ?? 0) + 1; }
      if (task.state === "merged") {
        const w = week(task.completedAt);
        if (task.completedAt === null) total.undated++;
        if (w >= 0) { row.merged++; perWeek.merged[w]++; const n = Number(task.round) || 0; rounds[Math.min(n, 3)]++; roundList.push(n); }
      }
      for (const run of task.runs) {
        const start = time(run.started), end = time(run.ended), w = week(end);
        if (w < 0) continue;
        total.runs++;
        if (start !== null && end >= start) { row.ms += end - start; perWeek.ms[w] += end - start; } else total.noTime++;
        if (TOKENS.test(run.tokens ?? "")) { row.tokens += Number(run.tokens); perWeek.tokens[w] += Number(run.tokens); } else total.noTokens++;
      }
    }
    for (const key of ["merged", "open", "needs", "ms", "tokens"]) total[key] += row[key];
    return { ...row, hours: hours(row.ms) };
  });
  const gaps = [...(model.sources ?? []).filter(source => folderProblems(source).length).map(source => ({ what: `every project in the ${title(source.label ?? source.id)} logbook folder` })),
    ...shown.flatMap(item => (item.unread ?? []).filter(book => leftOut(book.tables)).map(book => ({ project: names.get(item.key), what: `${leftOut(book.tables)} of ${names.get(item.key)} (${book.logbook} logbook)` })))];
  return {
    at: model.at, project, weeks: Array.from({ length: STATS_WEEKS }, (_, i) => new Date(first + i * WEEK).toISOString().slice(0, 10)),
    logbooks: shown.reduce((n, item) => n + (item.books?.length ?? 0), 0), gaps,
    empty: !shown.some(item => item.tasks > 0) && !gaps.length,
    total: { merged: total.merged, undated: total.undated, open: total.open, needs: total.needs, hours: hours(total.ms), tokens: total.tokens, runs: total.runs, noTokens: total.noTokens, noTime: total.noTime, rounds: median(roundList) },
    perWeek: { merged: perWeek.merged, hours: perWeek.ms.map(hours), tokens: perWeek.tokens },
    open: Object.entries(open).filter(([word, count]) => count || word !== "unknown").map(([word, count]) => ({ word, count })),
    rounds: ["0", "1", "2", "3 or more"].map((label, i) => ({ label, count: rounds[i] })),
    projects: projects.map(({ ms, ...row }) => row),
  };
}
