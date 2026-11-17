import { useState } from "react";
import { GiveBox, PairBox, PairNote, UndoButton, chiefLabel, useAccess, useSeen } from "./actions.jsx";
import { useNow, when } from "./use-model.js";
import { StateIcon } from "./icons.jsx";
import { chiefSub, milestoneLink, ofChief, questionLink, taskLink } from "./task.jsx";
import { FLAGGED, OBJECTS, UNKNOWN, chiefName } from "../../sage-core/state-words.mjs";

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function ago(from, to) {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const DAY = 86_400_000, WEEK = 7 * DAY;
const after = (list, since) => list.filter(at => at && Date.parse(at) > since).length;
function Counts({ model, previous, now }) {
  const old = previous && Date.parse(previous) < Date.parse(model.at) - WEEK, since = previous && !old ? Date.parse(previous) : Date.parse(model.at) - (old ? WEEK : DAY);
  const known = model.tasks.some(task => task.addedAt), unknown = model.tasks.some(task => !task.addedAt);
  const links = { merged: `#tasks?group=state&sort=newest&since=${new Date(since).toISOString()}`, stuck: "#agents" };
  const items = [
    ["merged", after(model.tasks.filter(task => task.state === "merged").map(task => task.doneAt), since), "Merged", "tasks merged into main"],
    ["stuck", model.stuck, FLAGGED[0].toUpperCase() + FLAGGED.slice(1), "runs of open tasks that failed in the last 24 hours and did not run again, or agents silent for 30 min or stopped"],
    ["added", known ? after(model.tasks.map(task => task.addedAt), since) : null, "New tasks", !known ? `${UNKNOWN} · no task in the logbook has a time when it was added` : unknown ? "tasks added to the logbook; older tasks have no time" : "tasks added to the logbook"],
  ];
  return (
    <section className="counts" aria-labelledby="counts-h">
      <h2 id="counts-h">{old ? <>In the last 7 days <span className="hint">· you last looked more than 7 days ago, and the board keeps 7 days</span></> : previous ? <>Since you looked <span className="hint">· you left the board at {when(previous)}, {ago(previous, now)}</span></> : "In the last 24 hours"}</h2>
      <div className="kpis">
        {items.map(([kind, count, label, hint]) => (
          <div className={`kpi ${kind}`} key={kind} data-count={kind}>
            <div className="n">{count ?? UNKNOWN}</div>
            <div className="l"><span className="dot" aria-hidden="true" />{links[kind] ? <a href={links[kind]}>{label}</a> : label}</div>
            <div className="h">{hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function NeedRow({ need, now, archived }) {
  const asked = need.askedAt ? ago(need.askedAt, now) : null;
  return (
    <li data-need={need.key}>
      <span className="bullet" aria-hidden="true" />
      <div>
        <p className="q">{need.gate && need.logbook ? <a href={questionLink(need.key)}>{need.question}</a> : need.task || need.milestone ? <a href={need.task ? taskLink(need.task.key) : milestoneLink(need.milestone)}>{need.question}</a> : need.question}</p>
        {need.more.length > 0 && <p className="more">{need.more.join(" ")}</p>}
        {need.recommendation && <p className="pick">Recommended: <b>{need.recommendation}</b></p>}
        <p className="meta">
          {need.chief && <span>chief {need.chief}</span>}
          {need.gate && <span className="mono">{need.gate}</span>}
          {need.task && <a href={taskLink(need.task.key)}>{need.task.id} · {need.task.title}</a>}
          <span>{asked ? `asked ${asked}` : "time not recorded"}</span>
          {archived && <span className="need">Restore to answer</span>}
        </p>
      </div>
    </li>
  );
}

function Waits({ answered, chiefs, now }) {
  if (!answered.length) return null;
  return (
    <div className="sub-list" aria-labelledby="waits-h">
      <h3 id="waits-h" className="lbl">Answered · waits for the chief</h3>
      <ul className="needs">{answered.map(item => (
        <li key={item.key} data-answered={item.key}>
          <span className="bullet done" aria-hidden="true" />
          <div>
            <p className="q"><a href={questionLink(item.key)}>{item.question}</a></p>
            <p className="meta"><span>You answered <b>{item.answer}</b> {ago(item.at, now)}</span><span>waits for {chiefLabel(chiefs, item.logbook, item.owner)} to pick it up</span></p>
          </div>
          <UndoButton logbook={item.logbook} gate={item.gateId} />
        </li>
      ))}</ul>
    </div>
  );
}

function Stopped({ model, shown }) {
  const [giving, setGiving] = useState(null);
  const stopped = model.chiefs.filter(chief => chief.stopped && shown(chief.logbook, chief.id));
  if (!stopped.length) return null;
  return (
    <div className="sub-list" aria-labelledby="stopped-h">
      <h3 id="stopped-h" className="lbl">Stopped chiefs</h3>
      <ul className="needs">{stopped.map(chief => {
        const tasks = model.tasks.filter(task => !task.ended && ofChief(task, chief));
        return (
          <li key={chief.key} data-stopped={chief.key}>
            <span className="bullet stopped" aria-hidden="true" />
            <div>
              <p className="q">{chiefName(chief.id, chief.provider)} · {chiefSub(chief)}</p>
              <p className="meta"><span>stopped: no event since {chief.heartbeat ? new Date(chief.heartbeat).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", hourCycle: "h23" }) : "a time not recorded"} and no running agent</span><span>nothing moves on its own</span></p>
              {tasks.length ? <ul className="owned">{tasks.map(task => {
                const need = model.needs.find(item => item.takeover && item.task?.key === task.key), answered = model.answered.find(item => item.takeover && item.task.key === task.key);
                return (
                  <li key={task.key}>
                    <a href={taskLink(task.key)}>{task.id} · {task.title}</a>
                    {giving === task.key ? <GiveBox task={task} logbook={chief.logbook} from={chief.id} chiefs={model.chiefs} close={() => setGiving(null)} />
                      : need ? <a href={questionLink(need.key)} className="btn">{OBJECTS.question.label} {need.gate} open</a>
                      : answered ? <a href={questionLink(answered.key)} className="btn">{OBJECTS.question.label} {answered.gateId} answered</a>
                      : <button type="button" className="btn" onClick={() => setGiving(task.key)}>Give to another chief</button>}
                  </li>
                );
              })}</ul> : <p className="hint">It owns no open task.</p>}
            </div>
          </li>
        );
      })}</ul>
    </div>
  );
}

function NeedsYou({ model, shown, now }) {
  const writes = useAccess();
  const needs = model.needs.filter(need => shown(need.logbook, need.owner));
  const answered = model.answered.filter(item => shown(item.logbook, item.owner));
  return (
    <section className="card" aria-labelledby="needs-h">
      <div className="card-h">
        <h2 id="needs-h">Needs you</h2>
        {needs.length > 0 && (model.archived ? <span className="badge">{needs.length} {needs.length === 1 ? "waits" : "wait"}</span> : <span className="badge need" aria-label={`${needs.length} open`}>{needs.length}</span>)}
        <span className="grow" />
        <span className="hint">Oldest first · {model.archived ? "the project is archived: answers wait until Restore" : writes === "paired" ? "open a question to answer it here" : "answer in the chief's chat, or pair this browser"}</span>
      </div>
      {needs.length
        ? <ul className="needs">{needs.map(need => <NeedRow key={need.key} need={need} now={now} archived={model.archived && need.project !== null} />)}</ul>
        : <p className="empty">Nothing needs you now.</p>}
      <Waits answered={answered} chiefs={model.chiefs} now={now} />
      <Stopped model={model} shown={shown} />
    </section>
  );
}

function Bar({ merged, moving, total }) {
  const width = part => total ? `${(100 * part) / total}%` : "0%";
  return (
    <svg className="bar" aria-hidden="true" focusable="false">
      <rect className="track" width="100%" height="100%" rx="3" />
      <rect className="moving" width={width(merged + moving)} height="100%" rx="3" />
      <rect className="merged" width={width(merged)} height="100%" rx="3" />
    </svg>
  );
}

function MilestoneRow({ milestone }) {
  const parts = [
    milestone.needsYou > 0 && <span className="need" key="need">{milestone.needsYou} {milestone.needsYou === 1 ? "needs" : "need"} you</span>,
    milestone.moving > 0 && <span key="moving">{milestone.moving} in progress</span>,
    milestone.waiting > 0 && <span key="waiting">{milestone.waiting} waiting</span>,
    milestone.abandoned.length > 0 && <span key="abandoned">{milestone.abandoned.join(", ")} abandoned</span>,
    <span key="pilot">Pilot {milestone.pilot}</span>,
  ].filter(Boolean);
  return (
    <li data-milestone={milestone.key}>
      <StateIcon state={milestone.state} />
      <div>
        <div className="name">
          <a href={milestoneLink(milestone.key)}>{milestone.title}</a>
          {milestone.priority && <span className={`badge prio ${milestone.priority.toLowerCase()}`}>{milestone.priority}</span>}
          <span className="badge">{milestone.word}</span>
        </div>
        {milestone.goal && <p className="goal">{milestone.goal}</p>}
        <p className="sub">{parts}</p>
      </div>
      <Bar merged={milestone.merged} moving={milestone.moving} total={milestone.total} />
      <span className="of">{milestone.merged} of {milestone.total} merged</span>
    </li>
  );
}

const MILESTONES_SHOWN = 6;
function Milestones({ milestones, hiddenDone }) {
  const [all, setAll] = useState(false);
  const shown = all ? milestones : milestones.slice(0, MILESTONES_SHOWN), more = milestones.length - MILESTONES_SHOWN;
  return (
    <section className="card" aria-labelledby="milestones-h">
      <div className="card-h">
        <h2 id="milestones-h">Milestones</h2>
        <span className="grow" />
        <span className="hint">By priority · {plural(milestones.length, "milestone")}</span>
      </div>
      {milestones.length
        ? <ul className="ms">{shown.map(milestone => <MilestoneRow key={milestone.key} milestone={milestone} />)}</ul>
        : <p className="empty">No milestones yet. A milestone starts when you ask for work that needs two or more tasks.</p>}
      {more > 0 && <button type="button" className="more-ended" aria-expanded={all} onClick={() => setAll(!all)}>{all ? `Show the first ${MILESTONES_SHOWN} only` : `Show ${plural(more, "more milestone")}`}</button>}
      {hiddenDone > 0 && <p className="more-done">{plural(hiddenDone, "milestone")} done more than 7 days ago {hiddenDone === 1 ? "is" : "are"} not shown.</p>}
    </section>
  );
}

const MODE = "sage mode";
function Start({ started }) {
  const [copied, setCopied] = useState(null);
  const copy = () => Promise.resolve().then(() => navigator.clipboard.writeText(MODE)).then(() => setCopied(true), () => setCopied(false));
  return (
    <section className="card start" aria-labelledby="start-h">
      <h2 id="start-h">Start your first task</h2>
      <p className="hint">The board shows the work of a chief. {started ? "This project has no task yet." : "No chief has recorded work in this logbook yet."}</p>
      <ol>
        <li><b>Start a chief in the project</b>
          {started ? <p className="hint">Done: a chief works in this project.</p> : <>
            <div className="pair-cmd"><code>{MODE}</code><button type="button" className="btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
            <p className="hint">Type it as the whole message, in a Claude Code or Codex session in the project folder.</p></>}</li>
        <li><b>Ask for a change in your words</b><p className="hint">For example: "Add a share button to a list." The chief frames it as a task and starts its agents.</p></li>
        <li><b>Come back here</b><p className="hint">The task shows on this page within a few seconds. Questions for you show first, under Needs you.</p></li>
      </ol>
      <p className="hint">This board reads the logbook on this Mac. It changes nothing until you pair the browser.</p>
    </section>
  );
}

export function Overview({ model, shown }) {
  const previous = useSeen(), now = useNow();
  if (!model.tasks.length && !model.needs.length && !model.milestones.length) return <><div className="page-h"><h1>Overview</h1></div><Start started={model.chiefs.length > 0} /></>;
  return (
    <>
      <div className="page-h">
        <h1>Overview</h1>
        <p>What changed, what needs you, and where each milestone stands.</p>
      </div>
      <PairNote />
      <PairBox />
      <div className="grid">
        <NeedsYou model={model} shown={shown} now={now} />
        <Milestones milestones={model.milestones} hiddenDone={model.hiddenDone} />
      </div>
      <Counts model={model} previous={previous} now={now} />
    </>
  );
}
