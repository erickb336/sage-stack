import { taskLink } from "./task.jsx";
import { MARKS, OBJECTS, runWord, shown } from "../../sage-core/state-words.mjs";

const MIN = 60_000;
const STATE = Object.fromEntries(["lost", "stuck", "stop", "long", "wait", "work", "unk"].map(key => [key, shown(OBJECTS.agent.states[key]).text]));
const ORDINAL = ["th", "st", "nd", "rd"];
export const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ORDINAL[n % 10] ?? "th"}`;
export const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "a time not recorded";
export function span(ms) {
  if (!Number.isFinite(ms)) return "time not recorded";
  const m = Math.max(0, Math.floor(ms / MIN));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const tokens = n => n === null || n === undefined ? "tokens not recorded" : n < 1000 ? `${n}` : n < 1e6 ? `${Math.round(n / 1000)} k` : `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")} M`;
export const runTokens = run => run.weighted != null ? `${tokens(run.weighted)} weighted` : run.own != null ? `${tokens(run.own)} ${run.provider} own count` : run.peak != null ? `peak context ${tokens(run.peak)}` : null;
export const otherCounts = m => [m.peak == null ? null : `largest peak context ${tokens(m.peak)}`, ...Object.entries(m.providers ?? {}).map(([p, o]) => `${p} own count ${tokens(o.tokens)} in ${o.counted} run${o.counted === 1 ? "" : "s"}, not added in`)].filter(Boolean).join(" · ");
export const age = (run, now) => span((run.ended ? Date.parse(run.ended) : now) - Date.parse(run.started));
const GLYPHS = {
  lead: <><circle cx="7" cy="5.5" r="2" /><circle cx="7" cy="18.5" r="2" /><circle cx="17" cy="7.5" r="2" /><path d="M7 7.5v9M17 9.5c0 4.2-4.6 4.6-8.6 7.4" /></>,
  implementer: <path d="M4.5 7l5 5-5 5M12 17.5h7.5" />,
  designer: <><path d="M12 21l-5.8-8.6L12 3.5l5.8 8.9z" /><circle cx="12" cy="11.6" r="1.6" /><path d="M12 13.2V21" /></>,
  pe: <><path d="M3.5 15.5l12-12 5 5-12 12z" /><path d="M6.6 12.4l1.8 1.8M9.6 9.4l2.6 2.6M12.6 6.4l1.8 1.8" /></>,
  "arena-judge": <><path d="M12 4v15.5M8 19.5h8M5 7.5h14M5 7.5l-2.3 5.5M5 7.5l2.3 5.5M19 7.5l-2.3 5.5M19 7.5l2.3 5.5" /><path d="M2.4 13a2.6 2.6 0 0 0 5.2 0zM16.4 13a2.6 2.6 0 0 0 5.2 0z" /></>,
  "code-reviewer": <><path d="M6 3.5h8.5l3.5 3.5v13.5H6z" /><path d="M12 7.6v5M9.5 10.1h5M9.5 16h5" /></>,
  "security-reviewer": <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.2v2.2" /></>,
  "ux-reviewer": <><path d="M2.5 12c2.6-4.3 5.8-6.5 9.5-6.5s6.9 2.2 9.5 6.5c-2.6 4.3-5.8 6.5-9.5 6.5S5.1 16.3 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  qa: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8.2 12.3l2.6 2.6 5-5.6" /></>,
  investigate: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>,
  "evidence-review": <><circle cx="12" cy="9.5" r="5.5" /><circle cx="12" cy="9.5" r="2.1" /><path d="M8.7 13.9L7.6 21l4.4-2.3 4.4 2.3-1.1-7.1" /></>,
};
const OTHER = <><circle cx="12" cy="12" r="7.5" /><path d="M12 8.5v4M12 15.5v.1" /></>;
export const Glyph = ({ role }) => <svg className="gl" viewBox="0 0 24 24" aria-hidden="true">{GLYPHS[role] ?? OTHER}</svg>;
export const ringOf = run => run.status === "queued" ? "queue" : run.status === "running" ? run.look ? "fail" : run.state === "wait" ? "wait" : "run" : run.status === "done" ? "done" : run.status === "question" ? "need" : "fail";
const MARK = { fail: MARKS.problem, done: MARKS.done, need: MARKS["needs you"] };

export function Ring({ ring, children, label, small = false }) {
  return (
    <span className={`av s-${ring}${small ? " sm" : ""}`} {...label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }}>
      {!small && <svg className="ring" viewBox="0 0 40 40" aria-hidden="true"><rect className="tr" x="1" y="1" width="38" height="38" rx="10" pathLength="100" /><rect className="ar" x="1" y="1" width="38" height="38" rx="10" pathLength="100" /></svg>}
      <span className="tile" aria-hidden="true">{children}</span>
      {!small && MARK[ring] && <span className="bd" aria-hidden="true">{MARK[ring]}</span>}
    </span>
  );
}

export const stateText = run => run.status === "queued" ? `${runWord("queued").text} · ${ordinal(run.place ?? 0)} in the queue` : run.status !== "running" ? runWord(run.status).text : STATE[run.state] ?? STATE.unk;
const badgeOf = run => run.status === "queued" ? "queued" : run.status !== "running" ? run.status === "done" ? "done" : run.status === "question" ? "needs-you" : "failed" : run.look ? "look" : "running";
export const StateBadge = ({ run }) => <span className={`badge ${badgeOf(run)}`} title={run.status === "running" ? run.why ?? undefined : undefined}>{stateText(run)}</span>;

export const AgentRing = ({ run, now, small }) => <Ring ring={ringOf(run)} small={small} label={small ? undefined : `${run.role}, ${stateText(run)}${run.status === "queued" ? "" : `, ${age(run, now)}`}`}><Glyph role={run.role} /></Ring>;
export function AgentTile({ run, now, task = false }) {
  const queued = run.status === "queued", failed = run.status === "failed", note = failed ? `Reason: ${run.why ?? "No reason recorded."}` : !queued && run.why && (run.look || run.state === "long") && run.why;
  return (
    <a className={`ag${queued ? " queued" : run.status === "running" ? "" : " ended"}`} href={taskLink(run.task.key)} data-task={run.task.key} data-run={run.id}>
      <AgentRing run={run} now={now} />
      <span className="ag-b">
        <span className="r1"><b className="rw">{run.role}</b><span className="mono faint rid">{task && `${run.task.id} · `}{run.id}</span></span>
        <span className="r2"><StateBadge run={run} /><span className="num">{queued ? `waits ${age(run, now)}` : `${age(run, now)}${runTokens(run) ? ` · ${runTokens(run)}` : ""}`}</span></span>
        {task && <span className="tline">{run.task.id} · {run.task.title}</span>}
        {queued ? <span className="mdl">queued {clock(run.started)} · {ordinal(run.place ?? 0)} in line</span> : <span className="mdl">{run.model ?? "model not recorded"}</span>}
        {note && <span className={`awhy${run.look || failed ? " look" : ""}`}>{note}</span>}
      </span>
    </a>
  );
}
