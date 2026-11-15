import { Component, Suspense, lazy, useMemo, useState } from "react";
import { GroupIcon } from "./icons.jsx";
import { ago } from "./overview.jsx";
import { ChiefDot, Panel, chiefName, controlsShown, ofChief, taskLink } from "./panel.jsx";
import { useNow } from "./use-model.js";

const PAGE = "pull-requests", RECENT_DAYS = 7, DAY = 86_400_000, VIEW_KEY = "board-pr-view";
const GROUPS = [
  ["need", "Needs you", "Your answer or your merge moves it on. Answer in the chief's chat."],
  ["review", "In review", "Checks, reviews and QA run on the current head."],
  ["repair", "Repairing", "Agents fix what a check or a review found."],
  ["build", "Building", "Agents build or plan it, or the chief moves it on. The review cycles start when the build ends."],
  ["ready", "Ready to merge", "Every clean cycle passed. A chief with autopilot on merges it."],
  ["wait", "Waiting for another task", "It merges only after the task that it waits for."],
  ["merged", "Merged recently", `Merged in the last ${RECENT_DAYS} days.`],
];
const REVIEW = ["reviewing", "verifying", "verified", "pr-ready"];
const CI = { pass: "CI passes", fail: "CI fails" };
const CHIEF_MOVES = { held: "held", "awaiting-you": "you answered" };
const Graph = lazy(() => import("./graph.jsx").catch(() => ({ default: () => <GraphFailed text="The graph could not load from the board server. Reload the page to try again." /> })));
const GraphFailed = ({ text }) => <p className="empty card" role="alert">{text}</p>;

class Contained extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <GraphFailed text="The board could not draw the graph. The list view shows each pull request." /> : this.props.children; }
}

const unmet = task => task.waitsFor.some(wait => !wait.met);
function groupOf(task, at) {
  if (task.ended) return task.state === "merged" && task.pr && Date.parse(task.doneAt) > Date.parse(at) - RECENT_DAYS * DAY ? "merged" : null;
  if (!task.pr) return unmet(task) ? "wait" : null;
  if (task.word === "needs you") return "need";
  if (task.state === "repairing") return "repair";
  if (unmet(task)) return "wait";
  if (task.word && !REVIEW.includes(task.state)) return "build";
  return ["verified", "pr-ready"].includes(task.state) && !task.why ? "ready" : "review";
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function cyclesText({ cycles }, group) {
  if (!cycles.reviews) return "No review step";
  if (cycles.clean === null) return `Clean cycles not known · ${cycles.required} needed`;
  return group === "merged" ? plural(cycles.clean, "clean cycle") : `${cycles.clean} of ${cycles.required} clean cycles`;
}
const findingsText = ({ findings }) => findings.open ? `${findings.open} open · ${findings.worst}` : `0 open${findings.closed ? ` · ${findings.closed} closed` : ""}`;

function Row({ task, group, now, prs, selected, many }) {
  const later = Date.parse(task.doneAt) - Date.parse(now) > 60_000;
  const age = group === "merged" ? task.doneAt && (later ? "merge time is in the future" : `merged ${ago(task.doneAt, now)}`) : task.lastActivity && ago(task.lastActivity, now);
  return (
    <li className="prow" data-pr-task={task.key} aria-current={selected ? "true" : undefined}>
      <GroupIcon group={group} />
      <span className="num mono">{!task.pr ? <span className="faint">no PR</span> : task.prUrl
        ? <a href={task.prUrl} target="_blank" rel="noopener noreferrer" aria-label={`Pull request ${task.pr} on GitHub`}>#{task.pr}</a>
        : `#${controlsShown(task.pr)}`}</span>
      <div className="what">
        <a className="ttl" href={taskLink(task.key, PAGE)} data-task={task.key}>{controlsShown(task.title)}</a>
        <p className="meta">
          <span className="chief">{task.chief && <ChiefDot stopped={task.chief.stopped} />}{chiefName(task.chief)}{task.chief?.stopped && " (stopped)"}</span>
          <span className="mono">{task.id}</span>
          {many && <span>{controlsShown(task.project)}</span>}
          {task.milestone && <span>{controlsShown(task.milestone.title)}</span>}
          {!task.word && <span className="badge">state not known</span>}
          {CHIEF_MOVES[task.state] && <span className="badge">{CHIEF_MOVES[task.state]}</span>}
          {task.conflicts.map(other => <span className="badge warn" key={other.key}>may conflict · {other.id}{prs.get(other.key) ? ` #${prs.get(other.key)}` : ""}</span>)}
          {task.pr && !task.prUrl && <span>No GitHub link: the logbook names no repository for this PR.</span>}
        </p>
        {task.why && <p className={`why ${group}`}>{controlsShown(task.why)}</p>}
        {task.waits && <p className="waits">{controlsShown(task.waits)}</p>}
      </div>
      <div className="facts">
        <span className="cyc">{task.pr ? cyclesText(task, group) : "–"}</span>
        <span className={`ci ${task.ci ?? "unknown"}`}>{task.pr ? CI[task.ci] ?? "CI not known" : "–"}</span>
        <span className={`find${task.findings.open ? " open" : ""}`}>{task.pr ? findingsText(task) : "–"}</span>
        <span className="age">{age || "–"}</span>
      </div>
    </li>
  );
}

function graphData(groups, all, many) {
  const shown = new Map(groups.flatMap(group => group.tasks.map(task => [task.key, { task, group }])));
  const chief = task => many ? `${chiefName(task.chief)} · ${controlsShown(task.project)}` : chiefName(task.chief);
  const head = task => task.pr ? `#${controlsShown(task.pr)} · ${task.id}` : `${task.id} · no PR yet`;
  const away = new Map([...shown.values()].flatMap(({ task }) => task.waitsFor.filter(wait => !wait.met && !shown.has(wait.key)).map(wait => [wait.key, wait])));
  const waits = [...shown.values()].flatMap(({ task }) => task.waitsFor.filter(wait => shown.has(wait.key) || away.has(wait.key)).map(wait => ({ from: wait.key, to: task.key, met: wait.met })));
  const conflicts = [...shown.values()].flatMap(({ task }) => task.conflicts.filter(other => shown.has(other.key) && task.key < other.key).map(other => ({ from: task.key, to: other.key })));
  const linked = new Set([...waits, ...conflicts].flatMap(link => [link.from, link.to]));
  const nodes = [...shown.values()].filter(({ task }) => linked.has(task.key)).map(({ task, group }) => ({
    key: task.key, group: group.key, state: group.title, nopr: !task.pr, href: taskLink(task.key, PAGE), title: controlsShown(task.title), head: head(task), chief: chief(task),
    sub: task.pr ? `${cyclesText(task, group.key)} · ${CI[task.ci] ?? "CI not known"}` : controlsShown(task.waits ?? ""),
  }));
  for (const [key, wait] of away) {
    const task = all.get(key);
    nodes.push(task ? { key, group: "away", state: "Not on this page", nopr: !task.pr, href: taskLink(key, PAGE), title: controlsShown(task.title), head: head(task), chief: chief(task), sub: task.word ? `State: ${task.word}` : "State not known" }
      : { key, group: "away", state: "Not in the logbook", nopr: true, href: null, title: "The logbook has no task with this id.", head: wait.id, chief: "", sub: "" });
  }
  return { nodes, waits, conflicts, alone: shown.size - nodes.filter(node => shown.has(node.key)).length };
}

function useView() {
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "list"; } catch { return "list"; } });
  return [view, value => { setView(value); try { localStorage.setItem(VIEW_KEY, value); } catch {} }];
}

export function Pulls({ model, params, chief = null }) {
  const [view, setView] = useView(), now = useNow();
  const selected = params.get("task"), many = model.projects.length > 1;
  const all = useMemo(() => new Map(model.tasks.map(task => [task.key, task])), [model.tasks]);
  const prs = useMemo(() => new Map(model.tasks.filter(task => task.pr).map(task => [task.key, task.pr])), [model.tasks]);
  const groups = useMemo(() => {
    const map = new Map(GROUPS.map(([key]) => [key, []]));
    for (const task of model.tasks) if (ofChief(task, chief)) map.get(groupOf(task, model.at))?.push(task);
    const newest = (a, b) => (Date.parse(b.doneAt ?? b.lastActivity) || 0) - (Date.parse(a.doneAt ?? a.lastActivity) || 0);
    return GROUPS.map(([key, title, hint]) => ({ key, title, hint, tasks: map.get(key).sort(newest) })).filter(group => group.tasks.length);
  }, [model.tasks, model.at, chief]);
  const graph = useMemo(() => graphData(groups, all, many), [groups, all, many]);
  const open = groups.filter(group => group.key !== "merged").reduce((n, group) => n + group.tasks.filter(task => task.pr).length, 0);
  return (
    <>
      <div className="page-h">
        <h1>Pull requests</h1>
        <p>Grouped by what happens next. A title opens its task; a number opens the PR on GitHub. CI shows what the logbook records.</p>
      </div>
      {groups.length > 0 && (
        <div className="toolbar">
          <div className="seg" role="group" aria-label="View">
            {[["list", "List"], ["graph", "Graph"]].map(([key, name]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{name}</button>)}
          </div>
          <span className="grow" />
          <span className="hint" role="status">{open} open {open === 1 ? "PR" : "PRs"}</span>
        </div>
      )}
      {!groups.length
        ? <p className="empty card">No pull request yet. A task opens one when its build starts.</p>
        : view === "graph"
          ? <Contained><Suspense fallback={<p className="loading" role="status">Loading the graph.</p>}><Graph data={graph} /></Suspense></Contained>
          : groups.map(group => (
            <section className="card group" key={group.key} data-group={group.key} aria-labelledby={`pg-${group.key}`}>
              <div className="card-h">
                <GroupIcon group={group.key} />
                <h2 id={`pg-${group.key}`}>{group.title}</h2>
                <span className="hint">{group.tasks.length}</span>
                <span className="grow" />
                <span className="hint">{group.hint}</span>
              </div>
              <ul className="rows">{group.tasks.map(task => <Row key={task.key} task={task} group={group.key} now={now} prs={prs} selected={task.key === selected} many={many} />)}</ul>
            </section>
          ))}
      {view === "list" && groups.length > 0 && <p className="none">Older merged PRs and abandoned tasks are on the <a href="#tasks">Tasks page</a>.</p>}
      {selected && <Panel taskKey={selected} at={model.at} back={PAGE} />}
    </>
  );
}
