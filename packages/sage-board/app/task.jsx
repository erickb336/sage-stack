import { useEffect, useRef, useState } from "react";
import { AgentRing, age, span, stateText, tokens } from "./agent.jsx";
import { MARKS, OBJECTS, UNKNOWN, chiefName as nameOf, prName, shown, taskWord } from "../../sage-core/state-words.mjs";

export const taskLink = (key, tab) => `#task?key=${encodeURIComponent(key)}${tab && tab !== "artifacts" ? `&tab=${tab}` : ""}`;
export const milestoneLink = key => `#tasks?milestone=${encodeURIComponent(key)}`;
export const ofChief = (task, chief) => !chief || task.chief?.id === chief.id && task.key === `${chief.logbook}/${task.id}`;
export const chiefName = chief => chief ? chief.old ?? (chief.id ? nameOf(chief.id, chief.provider) : `Chief ${UNKNOWN}`) : "No chief";
export const chiefState = key => Object.hasOwn(OBJECTS.chief.states, key) ? shown(OBJECTS.chief.states[key]).text : UNKNOWN;
export const chiefSub = chief => { const head = `${nameOf(null, chief.provider)} · `, tail = ` · ${chief.id}`, name = chief.name.startsWith(head) ? chief.name.slice(head.length) : chief.name; return name.endsWith(tail) ? name.slice(0, -tail.length) : name; };
const liveness = stopped => stopped === false ? "live" : stopped ? "stopped" : "unknown";
export function ChiefDot({ stopped }) {
  const state = liveness(stopped);
  return state === "stopped" ? <span className="dot" aria-hidden="true" /> : <span className={`dot ${state}`} role="img" aria-label={`Chief ${chiefState(state)}`} title={`Chief ${chiefState(state)}`} />;
}
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad = n => String(n).padStart(2, "0");
function when(at, now) {
  const date = new Date(at), today = new Date(now);
  if (!at || Number.isNaN(date.getTime())) return "time not recorded";
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? clock : `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}
const hex = c => c.codePointAt(0).toString(16).padStart(4, "0");
const JOINS = /[\p{L}\p{M}]/u, NOT_JOINED = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}]/u, PICTURE = /\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]?$/u;
const joined = (c, before, after) => JOINS.test(before.slice(-1)) && JOINS.test(after[0] ?? "") && !NOT_JOINED.test(before.slice(-1)) && !NOT_JOINED.test(after[0])
  || c === "\u200d" && PICTURE.test(before) && /^\p{Extended_Pictographic}/u.test(after);
const kept = (c, before, after) => /[\u200c\u200d]/.test(c) ? joined(c, before, after)
  : /[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u.test(c) && (/[\p{Extended_Pictographic}\p{Ideographic}]$/u.test(before) || /[#*0-9]$/.test(before) && after[0] === "\u20e3");
export const controlsShown = text => String(text ?? "").replace(/\u{1f3f4}[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{2,6}\u{e007f}|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, (c, at, all) =>
  c.length > 2 || kept(c, all.slice(Math.max(0, at - 40), at), all.slice(at + c.length, at + c.length + 2)) ? c
  : ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? (c.length > 1 ? `\\u{${hex(c)}}` : `\\u${hex(c)}`));
export const encodeKey = key => btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function readLink(key, kind, arg) {
  const query = new URLSearchParams(document.documentElement.dataset.theme === "light" ? { theme: "light" } : {}).toString();
  return `/read/${encodeKey(key)}/${kind}${arg ? `/${arg}` : ""}${query ? `?${query}` : ""}`;
}
const TABS = ["Artifacts", "Log", "Decisions"];

function useTask(key, at) {
  const [state, setState] = useState({ key, data: null, problem: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/app/task/${encodeKey(key)}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(response.status))
      .then(data => setState({ key, data, problem: null }))
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, problem: error === 404 ? "gone" : "read" })); });
    return () => controller.abort();
  }, [key, at]);
  return state.key === key ? state : { data: null, problem: null };
}


const UNKNOWN_WHY = (why) => <p className="unk"><strong>{UNKNOWN}</strong> · {why}</p>;
const pct = (part, whole) => `${Math.round((100 * part) / whole)} %`;
const Long = ({ text }) => <div className="long">{String(text).split(/\r?\n/).map((line, i) => <p key={i}>{controlsShown(line)}</p>)}</div>;
const and = list => list.length > 1 ? [...list.slice(0, -1).flatMap((item, i) => [i > 0 && ", ", item]), " and ", list.at(-1)] : list;
const hours = ms => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}`; };
const TRAIL = status => ["done", "fail"].includes(status) ? "done" : ["wait", "idle"].includes(status) ? "" : "now";
const BLOCKS = { pe: "PE check", qa: "QA", "code-review": "reviews", "security-review": "reviews", "ux-review": "reviews" };
const PHASE = { design: "plan", arena: "plan", "PE check": "plan", build: "build", investigate: "build" };
function trailOf(task) {
  const merged = task.steps.find(step => step.key === "merge")?.status === "done";
  return [...new Set(task.route.map(block => BLOCKS[block] ?? block.replace("-", " ")))].map(label => {
    const phase = PHASE[label] ?? "review", names = label === "reviews" ? ["code review", "security review", "UX review"] : [label];
    const steps = task.steps.filter(step => step.key.startsWith(phase) || phase === "review" && ["repair", "again"].includes(step.key));
    const open = steps.find(step => TRAIL(step.status) !== "done"), parts = (open?.parts ?? []).filter(part => names.includes(part.name)).map(part => TRAIL(part.status));
    const mark = merged || steps.length && !open ? "done" : !open ? "" : !parts.length ? TRAIL(open.status) : parts.every(part => part === "done") ? "done" : parts.every(part => !part) ? "" : "now";
    return { label, mark };
  });
}

function Linked({ items, word }) {
  return and(items.map(item => <span key={item.id}>{item.key ? <a href={taskLink(item.key)} data-task={item.key}>{controlsShown(item.title || item.id)}</a> : item.id}{word && <span className="faint"> ({item.word === "done" ? "done" : item.word ?? UNKNOWN})</span>}</span>));
}

function Section({ label, extra, children }) {
  return <section className="about-s"><h3>{label}{extra && <span className="extra">{extra}</span>}</h3>{children}</section>;
}

function Milestone({ task }) {
  if (!task.milestone) return <Section label="Milestone"><p>Not in a milestone. {task.release ? <>It is in release <strong>{controlsShown(task.release)}</strong>.</> : "It is in no release."}</p></Section>;
  const p = task.progress;
  return (
    <Section label="Milestone">
      <p><a className="strong" href={milestoneLink(task.milestone.key)}>{controlsShown(task.milestone.title)}</a></p>
      {p?.goal ? <p>{controlsShown(p.goal)}</p> : UNKNOWN_WHY("The milestone has no goal in the logbook.")}
      {p && <p className="meter"><svg viewBox="0 0 140 8" aria-hidden="true"><rect className="tr" x=".5" y=".5" width="139" height="7" rx="3.5" /><rect className="mg" x=".5" y=".5" width={Math.max(0, (139 * p.merged) / Math.max(1, p.total))} height="7" rx="3.5" /></svg><span><strong>{p.merged} of {p.total}</strong> tasks merged</span></p>}
      {p?.abandoned > 0 && <p className="faint">{p.abandoned === 1 ? "1 task is abandoned" : `${p.abandoned} tasks are abandoned`}, so the milestone is done at {p.total - p.abandoned}.</p>}
    </Section>
  );
}

function Criteria({ brief }) {
  if (brief.state !== "kept") return <Section label="Criteria">{UNKNOWN_WHY(brief.why)}</Section>;
  if (!brief.criteria.length) return <Section label="Criteria">{UNKNOWN_WHY(`The brief of ${brief.run} has no ACCEPTANCE field.`)}</Section>;
  const met = brief.criteria.filter(line => line.by);
  return (
    <Section label="Criteria" extra={`${met.length} of ${brief.criteria.length} met`}>
      <ul className="crit">{brief.criteria.map((line, i) => <li key={i} className={line.by ? "met" : ""}><span className="dm" aria-hidden="true" /><span>{controlsShown(line.text)}<span className="faint"> · {line.by ? "met" : "not checked yet"}</span></span></li>)}</ul>
      <details className="who"><summary>Who checked each line</summary>
        {met.length ? <ul>{met.map((line, i) => <li key={i}>{controlsShown(line.text)} · <span className="mono">{line.by}</span></li>)}</ul> : <p className="faint">No review or QA report names a line yet. A line is met when a passing review or QA report names it.</p>}
      </details>
    </Section>
  );
}

function Status({ task }) {
  const { clean, required, reviews } = task.cycles, word = task.word ?? UNKNOWN, trail = trailOf(task);
  const where = `${word.charAt(0).toUpperCase()}${word.slice(1)}:`;
  const said = task.ended ? taskWord(task).reason.replace(/\.$/, "") : !task.route.length ? `the logbook records no route for this task` : !reviews ? "this route has no review cycle" : clean === null ? `${required} review ${required === 1 ? "cycle" : "cycles"} to pass; the count of passed cycles is ${UNKNOWN}` : `${clean} of ${required} review ${required === 1 ? "cycle" : "cycles"} passed`;
  return (
    <Section label="Status">
      {task.needsYou && task.now.length ? <>
        <p className="now"><strong>{where}</strong> {controlsShown(task.now[0])}</p>
        {task.now.slice(1).map((line, i) => <p className="now" key={i}>{controlsShown(line)}</p>)}
        {task.next && <p className="now">Next: {controlsShown(task.next)}</p>}
      </> : <p className="now"><strong>{where}</strong> {controlsShown(said)}.{task.next && !task.ended && <> Next: {controlsShown(task.next)}</>}</p>}
      {trail.length > 0 && <ol className="trail" aria-label="Steps">{trail.map(step => <li key={step.label} className={step.mark}>{step.label}{step.mark === "done" && <span className="ok" aria-hidden="true"> {MARKS.done}</span>}<span className="sr"> ({step.mark || "not started"})</span></li>)}</ol>}
    </Section>
  );
}

function Cost({ task, brief }) {
  const { cost } = task, budget = brief.state === "kept" ? brief.budget : null;
  const of = (value, limit, show, what) => limit ? <> of {show(limit)} <span className="faint">({pct(value, limit)})</span></> : <span className="faint"> of an unknown budget: {brief.state !== "kept" ? "the brief is not read" : !budget ? `the brief of ${brief.run} has no BUDGET field` : `its BUDGET names no ${what}`}</span>;
  return (
    <Section label="Cost" extra={cost.runs === 1 ? "1 run" : `${cost.runs} runs`}>
      <p>Agent time: {cost.timed ? <><strong>{hours(cost.ms)}</strong>{of(cost.ms, budget?.ms, hours, "time")}</> : <><strong>{UNKNOWN}</strong> <span className="faint">· no run of this task has a start time</span></>}</p>
      <p>Tokens: {cost.counted ? <><strong>{tokens(cost.tokens)}</strong>{of(cost.tokens, budget?.tokens, tokens, "tokens")}</> : <><strong>{UNKNOWN}</strong> <span className="faint">· no run of this task recorded its tokens</span></>}</p>
    </Section>
  );
}

function About({ task }) {
  const { brief } = task, reports = task.files.kept.length + task.files.reports.length;
  return (
    <section className="card about-card" aria-labelledby="about-h">
      <h2 id="about-h">About this task</h2>
      {brief.state === "unread" && <p className="stale" role="alert">The board cannot read the brief now. {controlsShown(brief.why)}</p>}
      <Milestone task={task} />
      <Section label="Before and after">
        {!task.before.length && !task.after.length ? <p>No other task comes before or after it.</p> : <>
          <p>Comes after: {task.before.length ? <Linked items={task.before} word /> : "no other task"}.</p>
          <p>Needed by: {task.after.length ? <Linked items={task.after} /> : "no other task"}.</p>
        </>}
      </Section>
      <Section label="Goal">{brief.state === "kept" ? brief.goal ? <Long text={brief.goal} /> : UNKNOWN_WHY(`The brief of ${brief.run} has no GOAL field.`) : UNKNOWN_WHY(brief.why)}</Section>
      <Section label="Why">{task.request ? <Long text={task.request} /> : UNKNOWN_WHY("The logbook keeps no request for this task: the chief records your words with task set request= when it frames a task.")}</Section>
      <Criteria brief={brief} />
      <Status task={task} />
      <Cost task={task} brief={brief} />
      <p className="links">
        {brief.run && brief.state !== "none" ? <a className="btn" href={readLink(task.key, "brief", brief.run)}>Brief <span className="mono faint">{brief.run}</span></a> : <span className="btn off">Brief · none</span>}
        <a className="btn" href={taskLink(task.key, "artifacts")} onClick={event => { event.preventDefault(); document.getElementById("tab-Artifacts")?.click(); document.getElementById("tab-Artifacts")?.focus(); }}>Reports · {reports}</a>
        {task.pr ? task.prUrl ? <a className="btn" href={task.prUrl} target="_blank" rel="noopener noreferrer">Pull request <span className="mono faint">{prName(task.pr)}</span></a> : <span className="btn off">{prName(task.pr)}</span> : <span className="btn off">Pull request · none yet</span>}
        {task.milestone && <a className="btn" href={milestoneLink(task.milestone.key)}>Milestone</a>}
      </p>
    </section>
  );
}

function AtWork({ task }) {
  const now = Date.parse(task.at) || Date.now(), live = task.runs.filter(run => ["running", "queued"].includes(run.status)), ended = task.runs.length - live.length;
  return (
    <div className="atwork">
      <span className="lbl">At work now</span>
      {live.length ? live.map(run => <span className="chipa" key={run.id}><AgentRing run={{ ...run, task }} now={now} small /><strong>{run.role}</strong><span className="faint">{stateText(run)}{run.status === "running" && ` · ${age(run, now)}`}</span></span>) : <span className="faint">No agent works on this task now.</span>}
      {ended > 0 && <span className="faint">+{ended} ended</span>}
    </div>
  );
}

const BACK_NAMES = { "": "Overview", tasks: "Tasks", agents: "Agents", "pull-requests": "Pull requests", question: OBJECTS.question.label };
const backName = from => {
  const key = /^task\?key=([^&]*)/.exec(from)?.[1], path = from.split("?")[0];
  return key ? `${OBJECTS.task.label} ${decodeURIComponent(key).split("/").pop()}` : Object.hasOwn(BACK_NAMES, path) ? BACK_NAMES[path] : null;
};
export function TaskPage({ taskKey, tab: asked, at, from }) {
  const { data: task, problem } = useTask(taskKey, at);
  const [tab, setTab] = useState(TABS.find(name => name.toLowerCase() === asked) ?? TABS[0]);
  const heading = useRef(null), tabs = useRef([]);
  useEffect(() => { scrollTo(0, 0); heading.current?.focus({ preventScroll: true }); }, [taskKey]);
  const pick = next => { setTab(next); history.replaceState(history.state, "", taskLink(taskKey, next.toLowerCase())); };
  const move = event => {
    const to = { ArrowRight: TABS.indexOf(tab) + 1, ArrowLeft: TABS.indexOf(tab) - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length];
    pick(next); tabs.current[TABS.indexOf(next)]?.focus();
  };
  const back = typeof from === "string" ? backName(from) : null;
  const counts = task && { Artifacts: task.runs.length + (task.files.designs.versions ? 1 : 0) + task.files.recorded.length + task.artifacts.length + (task.files.pages?.length ?? 0) + task.files.kept.length, Log: task.log.length + task.logMore, Decisions: task.decisions.length };
  return (
    <article className="taskpage">
      <a className="back" href={back ? `#${from}` : "#tasks"} onClick={event => { if (back && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); history.back(); } }}><span aria-hidden="true">‹ </span>{back ?? BACK_NAMES.tasks}</a>
      <h1 ref={heading} tabIndex={-1}>{task ? controlsShown(task.title) : problem === "gone" ? "This task is not on the board" : problem ? "The board cannot read this task now" : "Reading the task"}{task && <span className="mono faint tid">{task.id}</span>}</h1>
      {problem && !task && <p className="none" role="alert">{problem === "gone" ? "The logbook has no task with this name. Go back and pick a task from a list." : "It tries again when the logbook changes."}</p>}
      {problem && task && <p className="stale" role="status">{problem === "gone" ? "This task is no longer on the board. The page shows what it read last." : "The page could not refresh. It shows what it read last, and tries again when the logbook changes."}</p>}
      {!task && !problem && <div className="about-skel" role="status" aria-label="Reading the task">{["Milestone", "Before and after", "Goal", "Why", "Criteria", "Status", "Cost"].map(label => <section className="about-s" key={label}><h3>{label}</h3><i /></section>)}</div>}
      {task && <>
        <p className="facts-line">
          <span className={`badge word ${(task.word ?? UNKNOWN).replace(" ", "-")}`}>{task.word ?? UNKNOWN}</span>
          {[task.priority ?? "no priority", task.size ?? `size ${UNKNOWN}`, task.risk && `risk flag ${task.risk}`, task.kind, task.step?.label, `Run by ${chiefName(task.chief)}${task.chief && !task.chief.old && !task.ended ? ` (chief ${chiefState(liveness(task.chief.stopped))})` : ""}`].filter(Boolean).join(" · ")}
          {task.branch && <> · <code>{controlsShown(task.branch)}</code></>}
        </p>
        <AtWork task={task} />
        {task.conflicts.map(other => (
          <div className="callout" key={other.key}>
            <p><strong>May conflict with {other.id}</strong> ({controlsShown(other.chief)}). Both open branches change:</p>
            <ul>{other.paths.slice(0, 20).map(path => <li key={path}><code>{controlsShown(path)}</code></li>)}</ul>
            {other.paths.length > 20 && <p className="faint">and {other.paths.length - 20} more files.</p>}
            <p className="faint">A warning only: nothing waits. The pull request that merges second may need a rebase.</p>
          </div>
        ))}
        <About task={task} />
        <section className="card records">
          <div className="tabs" role="tablist" aria-label="Task records" onKeyDown={move}>
            {TABS.map((name, i) => <button type="button" role="tab" key={name} id={`tab-${name}`} ref={el => { tabs.current[i] = el; }} aria-selected={tab === name} aria-controls="tab-panel" tabIndex={tab === name ? 0 : -1} onClick={() => pick(name)}>{name} <span className="faint">{counts[name]}</span></button>)}
          </div>
          <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "Artifacts" ? <Artifacts task={task} /> : tab === "Log" ? <Log task={task} /> : <Decisions task={task} />}
          </div>
        </section>
      </>}
    </article>
  );
}

function Artifacts({ task }) {
  const { files } = task, base = `/pages/${task.logbook}/${task.id}/`, read = (kind, arg) => readLink(task.key, kind, arg);
  const empty = !task.runs.length && !task.artifacts.length && !files.pages?.length && !files.kept.length && !files.briefs.length && !files.reports.length && !files.designs.versions && !files.recorded.length;
  const fileLink = name => /\.md$/.test(name) ? <a href={read("page", name)}>{name}</a> : <a href={`${base}${name}`} target="_blank" rel="noopener noreferrer">{name}</a>;
  return (
    <div>
      {empty && <p className="none">No artifact is recorded for this task yet.</p>}
      {files.designs.versions > 0 && <>
        <h4>Design</h4>
        <ul className="files">
          <li><a href={read("design")}>Design · {files.designs.versions} {files.designs.versions === 1 ? "version" : "versions"}</a><span className="faint">today, or two side by side</span></li>
          {files.designs.arena && <li><a href={read("arena")}>Arena · candidates, scores and the judge's final</a></li>}
        </ul>
      </>}
      {task.runs.length > 0 && <>
        <h4>Briefs and reports</h4>
        <ul className="files">{task.runs.map(run => <li key={run.id}><span>{run.id} · {run.role}</span><span><a href={read("brief", run.id)}>Brief</a> · <a href={read("report", run.id)}>Report</a></span></li>)}</ul>
      </>}
      {files.pages?.length > 0 && <>
        <h4>Pages folder</h4>
        <ul className="files">{files.pages.map(page => <li key={page.name}>{fileLink(page.name)}<span className="faint">{Math.max(1, Math.round(page.size / 1024))} KB</span></li>)}</ul>
        {files.more && <p className="none">The list stops here: the folder holds more files.</p>}
        <p><a href={base} target="_blank" rel="noopener noreferrer">Open the pages index</a></p>
      </>}
      {files.recorded.length > 0 && <>
        <h4>Recorded pages</h4>
        <ul className="files">{files.recorded.map((page, i) => <li key={i}>{page.state !== "gone" ? fileLink(page.file) : /\.md$/.test(page.file) ? <a href={read("page", page.file)}>{page.file}</a> : <span>{page.file}</span>}<span className={page.state === "same" ? "faint" : "need"}>{{ same: "the same as recorded", changed: "changed since it was recorded", gone: "gone from the pages folder" }[page.state]} · {when(page.at, task.at)}</span></li>)}</ul>
      </>}
      {task.artifacts.length > 0 && <>
        <h4>Recorded artifacts</h4>
        <ul className="files">{task.artifacts.map(item => (
          <li key={item.id}>
            {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{controlsShown(item.label)}</a> : <span>{controlsShown(item.label)}</span>}
            <span className="faint">{[item.type, item.run, when(item.at, task.at), item.path && (item.verified ? "in the logbook · digest checked" : "in the logbook · not checked")].filter(Boolean).join(" · ")}</span>
            {item.path && <code>{controlsShown(item.path)}</code>}
          </li>
        ))}</ul>
      </>}
      {files.kept.length > 0 && <>
        <h4>Kept reports</h4>
        <ul className="files">{files.kept.map(item => (
          <li key={item.run}>
            <a href={read("report", item.run)}>{item.run} · {item.role}{item.status && ` · ${controlsShown(item.status)}`}</a>
            {item.result && <span className="detail">{controlsShown(item.result)}</span>}
            <span className="faint">{[when(item.at, task.at), item.sha && `on ${item.sha.slice(0, 7)}`].filter(Boolean).join(" · ")}</span>
          </li>
        ))}</ul>
      </>}
      {[["Brief files", files.briefs, files.unlisted.briefs], ["Report files", files.reports, files.unlisted.reports]].map(([name, list, more]) => list.length > 0 && (
        <div key={name}>
          <h4>{name}</h4>
          <ul className="files">{list.map(item => <li key={item.name}><code>{controlsShown(item.name)}</code>{item.run && <span className="faint">{item.run}</span>}</li>)}</ul>
          {more > 0 && <p className="none">The list stops here: the logbook holds {more} more {more === 1 ? "file" : "files"} for this task.</p>}
        </div>
      ))}
    </div>
  );
}

function Log({ task }) {
  if (!task.log.length) return <p className="none">No event recorded.</p>;
  return (
    <>
      <ol className="log">{task.log.map((event, i) => <li key={i}><span className="t">{when(event.at, task.at)}</span><span className="who">{event.who}</span><span>{controlsShown(event.text)}</span></li>)}</ol>
      {task.logMore > 0 && <p className="none">{task.logMore} older events are not shown.</p>}
    </>
  );
}

function Decisions({ task }) {
  if (!task.decisions.length) return <p className="none">No question was asked about this task.</p>;
  return (
    <ul className="decs">{task.decisions.map(gate => (
      <li key={gate.id}>
        <p>{controlsShown(gate.question)}</p>
        <p className={gate.answer || gate.pending || !gate.waits ? "by" : "by need"}>{gate.answer ? `You answered: ${controlsShown(gate.answer)}` : gate.pending ? `You answered on the board: ${controlsShown(gate.pending)}. It waits for the chief to pick it up.` : gate.waits ? "Open: it waits for your answer." : "Not answered. No chief waits for this answer now."}{gate.recommendation && gate.waits && !gate.pending && ` Recommended: ${controlsShown(gate.recommendation)}.`}</p>
        <p className="faint">{gate.id} · {when(gate.at, task.at)}</p>
      </li>
    ))}</ul>
  );
}

