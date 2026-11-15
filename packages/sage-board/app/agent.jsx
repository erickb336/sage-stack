import { taskLink } from "./panel.jsx";

const MIN = 60_000;
const STATE = { stuck: "may be stuck", stop: "helper stopped", long: "running long", wait: "waits for its helpers", work: "working", unk: "running" };
const ORDINAL = ["th", "st", "nd", "rd"];
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ORDINAL[n % 10] ?? "th"}`;
export const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "a time not recorded";
function span(ms) {
  if (!Number.isFinite(ms)) return "–";
  const m = Math.max(0, Math.floor(ms / MIN));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const tokens = n => n === null ? "–" : n < 1000 ? `${n}` : `${Math.round(n / 1000)} k`;
const age = (run, now) => span((run.ended ? Date.parse(run.ended) : now) - Date.parse(run.started));

function StateBadge({ run }) {
  if (run.status === "queued") return <span className="badge queued">Queued · {ordinal(run.place ?? 0)}</span>;
  if (run.status !== "running") return <span className={`badge ${run.status === "done" ? "done" : "failed"}`}>{run.status.charAt(0).toUpperCase()}{run.status.slice(1)}</span>;
  return <span className={`badge ${run.look ? "look" : "running"}`} title={run.why ?? undefined}>{STATE[run.state] ?? "running"}</span>;
}

export function AgentMark({ run, now, kind, selected = false, look = 0 }) {
  const link = { href: taskLink(run.task.key, "agents"), "data-task": run.task.key, "data-run": run.id, "aria-current": selected ? "true" : undefined };
  const task = <span className="tline">{run.task.id} · {run.task.title}</span>;
  if (kind === "lead") return (
    <a className="acard-h" {...link}>
      <span className="lead-id"><b className="mono">lead · {run.id}</b> <StateBadge run={run} />{look > 0 && <span className="badge look">{look} {look === 1 ? "helper needs" : "helpers need"} a look</span>}</span>
      <span className="big">{age(run, now)}</span>
      {task}
      <span className="faint">{run.model ?? "model not recorded"}</span>
    </a>
  );
  const queued = kind === "queued";
  return (
    <a className={`arow${queued ? " queued" : run.status === "running" ? "" : " ended"}`} {...link}>
      <span className="who"><span className="role">{run.role}</span><span className="mono faint">{run.id}</span></span>
      <span className="atask"><StateBadge run={run} />{kind !== "helper" && task}{!queued && run.why && (run.look || run.state === "long") && <span className={`why${run.look ? " look" : ""}`}>{run.why}</span>}</span>
      {queued ? <>
        <span className="mdl">queued {clock(run.started)}</span>
        <span className="num">waits {age(run, now)}</span>
        <span className="num">{ordinal(run.place ?? 0)} in line</span>
      </> : <>
        <span className="mdl">{run.model ?? "model not recorded"}</span>
        <span className="num">{age(run, now)}</span>
        <span className="num">{tokens(run.tokens)}</span>
      </>}
    </a>
  );
}
