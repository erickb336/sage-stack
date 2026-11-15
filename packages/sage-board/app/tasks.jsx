import { useEffect, useMemo, useState } from "react";
import { ago } from "./overview.jsx";
import { ChiefDot, chiefName, controlsShown, ofChief, taskLink } from "./task.jsx";
import { useNow } from "./use-model.js";
import { OBJECTS, STEPS, UNKNOWN, URGENCY as WORDS, prName, shown } from "../../sage-core/state-words.mjs";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const ENDED_WORDS = ["done", "stopped"];
const NONE = "—", SHOWN_CONFLICTS = 1;
const order = (list, value) => (list.indexOf(value) + 1 || list.length + 1);
const number = id => Number(String(id).replace(/^\D+/, "")) || 0;

const GROUPS = {
  milestone: { name: OBJECTS.milestone.label, of: task => task.milestone?.key ?? "", title: task => task.milestone?.title ?? "No milestone" },
  priority: { name: "Priority", of: task => task.priority ?? "", title: task => task.priority ?? "No priority", rank: key => order(PRIORITIES, key) },
  chief: { name: OBJECTS.chief.label, of: task => task.who, title: task => task.who, rank: key => key.startsWith("No chief") ? 1 : 0 },
  state: { name: "State", of: task => task.word ?? "", title: task => task.word ?? `State ${UNKNOWN}`, rank: key => order(WORDS, key) },
};
const FILTERS = [
  ["chief", OBJECTS.chief.label, task => task.who],
  ["provider", "Provider", task => task.chief?.provider ?? NONE],
  ["priority", "Priority", task => task.priority ?? NONE],
  ["kind", "Kind", task => task.kind ?? NONE],
  ["state", "State", task => task.word ?? NONE],
];

function StepMark({ status }) {
  const step = shown(STEPS[status]);
  return step.word === "needs you" || step.flag ? <><span aria-hidden="true">{step.mark} </span><span className="sr">{step.text}: </span></> : null;
}

function Row({ task, at, many }) {
  const age = task.lastActivity ? ago(task.lastActivity, at) : null, shown = task.conflicts.slice(0, SHOWN_CONFLICTS), more = task.conflicts.length - shown.length;
  return (
    <li>
      <a className={`row${task.ended ? " ended" : ""}`} href={taskLink(task.key)} data-task={task.key}>
        <span className={`badge prio ${(task.priority ?? "none").toLowerCase()}`}>{task.priority ?? NONE}</span>
        <span className="title">
          <span className="text">{controlsShown(task.title)}</span>
          {many && <span className="kind">{task.project}</span>}
          {task.kind && <span className="kind">{task.kind}</span>}
          {shown.length > 0 && <span className="badge warn" title={more ? `May conflict with ${task.conflicts.map(other => other.id).join(", ")}` : undefined}>may conflict · {shown.map(other => other.id).join(", ")}{more > 0 && ` +${more}`}</span>}
          {task.waits && !task.ended && <span className="badge" title={task.waits}>waits</span>}
        </span>
        <span className="mono id">{task.id}</span>
        <span className={`badge word ${(task.word ?? UNKNOWN).replace(" ", "-")}`}>{task.word ?? UNKNOWN}</span>
        <span className="chief">{task.chief && !task.chief.old && <ChiefDot stopped={task.chief.stopped} />}{chiefName(task.chief)}{task.chief?.stopped && " (stopped)"}{task.chief?.waits && " (waits for you)"}</span>
        <span className={`step ${task.step?.status ?? ""}`}>{task.step && <StepMark status={task.step.status} />}{task.step?.label ?? (task.ended ? "" : NONE)}</span>
        <span className="mono pr">{task.pr ? prName(task.pr) : NONE}</span>
        <span className="age">{age ?? NONE}</span>
      </a>
    </li>
  );
}

function Group({ group, milestone, why, focus, open, shown, toggle, row }) {
  const ended = group.tasks.filter(task => task.ended), live = group.tasks.filter(task => !task.ended);
  return (
    <section className={`card group${focus ? " focus" : ""}`} data-group={group.key} aria-labelledby={`g-${group.id}`}>
      <div className="card-h">
        <h2 id={`g-${group.id}`}>{group.title}</h2>
        <span className="hint">{live.length} open</span>
        <span className="grow" />
        {milestone && <span className="hint">{milestone.merged} of {milestone.total} merged</span>}
      </div>
      {why}
      {live.length > 0 && <ul className="rows">{live.map(row)}</ul>}
      {ended.length > 0 && (
        <>
          {!shown && (
            <button type="button" className="more-ended" aria-expanded={open} onClick={toggle}>
              {open ? "Hide" : "Show"} {ended.length} ended {ended.length === 1 ? "task" : "tasks"} (merged, concluded or abandoned)
            </button>
          )}
          {(open || shown) && <ul className="rows">{ended.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

const Why = ({ needs }) => needs.length > 0 && <div className="why" role="note">{needs.map(need => <p key={need.key}><b>{need.question}.</b> {need.more.join(" ")}</p>)}</div>;

const hashOf = (params, changes) => {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
  return `#tasks${next.size ? `?${next}` : ""}`;
};

export function Tasks({ model, params, chief = null }) {
  const [opened, setOpened] = useState(() => new Set(history.state?.opened ?? []));
  useEffect(() => { history.replaceState({ ...history.state, opened: [...opened] }, ""); }, [opened]);
  const now = useNow();
  const focus = params.get("milestone");
  const group = focus || !Object.hasOwn(GROUPS, params.get("group")) ? "milestone" : params.get("group");
  const filters = Object.fromEntries(FILTERS.map(([key]) => [key, params.get(key) ?? ""]));
  const go = changes => { location.hash = hashOf(location.hash.split("?")[1] ?? "", changes); };
  useEffect(() => {
    if (focus) requestAnimationFrame(() => document.querySelector(`[data-group="${CSS.escape(focus)}"], .lost`)?.scrollIntoView({ block: "start" }));
  }, [focus]);

  const many = model.projects.length > 1;
  const tasks = useMemo(() => model.tasks.map(task => ({ ...task, who: many ? `${chiefName(task.chief)} · ${task.project}` : chiefName(task.chief) })), [model.tasks, many]);
  const options = useMemo(() => Object.fromEntries(FILTERS.map(([key, , value]) => [key, [...new Set(tasks.map(value))].sort((a, b) => key === "state" ? order(WORDS, a) - order(WORDS, b) : a.localeCompare(b))])), [tasks]);
  const shown = useMemo(() => tasks.filter(task => ofChief(task, chief) && FILTERS.every(([key, , value]) => !filters[key] || value(task) === filters[key])), [tasks, chief, ...Object.values(filters)]);
  const groups = useMemo(() => {
    const how = GROUPS[group], rank = new Map(model.milestones.map((milestone, i) => [milestone.key, i])), map = new Map();
    for (const task of shown) { const key = how.of(task); if (!map.has(key)) map.set(key, { key: key || "none", title: how.title(task), tasks: [] }); map.get(key).tasks.push(task); }
    const sortKey = item => group === "milestone" ? (item.key === "none" ? Infinity : rank.get(item.key) ?? 1e6 + number(item.key.split("/").at(-1))) : how.rank?.(item.key === "none" ? "" : item.key) ?? 0;
    const sorted = [...map.values()].sort((a, b) => (a.tasks.every(task => task.ended) - b.tasks.every(task => task.ended)) || sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
    for (const item of sorted) item.tasks.sort((a, b) => b.needsYou - a.needsYou || order(PRIORITIES, a.priority) - order(PRIORITIES, b.priority) || number(a.id) - number(b.id));
    return sorted.map((item, i) => ({ ...item, id: i }));
  }, [shown, group, model.milestones]);

  const open = shown.filter(task => !task.ended).length;
  const filtered = FILTERS.some(([key]) => filters[key]);
  const clear = () => go(Object.fromEntries(FILTERS.map(([key]) => [key, ""])));
  const toggle = key => setOpened(previous => { const next = new Set(previous); next.has(`${group}:${key}`) ? next.delete(`${group}:${key}`) : next.add(`${group}:${key}`); return next; });
  const milestones = new Map(model.milestones.map(milestone => [milestone.key, milestone]));
  const needsOf = key => model.needs.filter(need => need.milestone === key);
  const lost = focus && !groups.some(item => item.key === focus);
  const row = task => <Row key={task.key} task={task} at={now} many={many} />;
  return (
    <>
      <div className="page-h">
        <h1>Tasks</h1>
        <p>Open a task to read its page: what it is for, where it is in its dev cycle, which chief owns it, and what its agents made.</p>
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Group by">
          <span className="lbl">Group by</span>
          {Object.entries(GROUPS).map(([key, item]) => <button type="button" key={key} aria-pressed={group === key} onClick={() => go({ group: key === "milestone" ? "" : key, milestone: "" })}>{item.name}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Filter">
          <span className="lbl">Filter</span>
          {FILTERS.map(([key, label]) => (
            <label className={`filter${filters[key] ? " on" : ""}`} key={key}>{label}
              <select aria-label={`Filter by ${label.toLowerCase()}`} value={filters[key]} onChange={event => go({ [key]: event.target.value })}>
                <option value="">All</option>
                {options[key].map(value => <option key={value} value={value}>{value === NONE ? "None" : value}</option>)}
              </select>
            </label>
          ))}
          {filtered && <button type="button" className="clear" onClick={clear}>Clear filters</button>}
        </div>
        <span className="grow" />
        <span className="hint" role="status">{chief && `${chief.id}'s work · `}{open} open · {shown.length - open} ended</span>
      </div>
      {lost && (
        <section className="card group focus lost" aria-labelledby="g-lost">
          <div className="card-h"><h2 id="g-lost">{milestones.get(focus)?.title ?? needsOf(focus)[0]?.question ?? "This milestone"}</h2></div>
          <Why needs={needsOf(focus)} />
          <p className="none">{tasks.some(task => task.milestone?.key === focus) ? "The filters hide the tasks of this milestone." : "The logbook links no task to this milestone."}</p>
        </section>
      )}
      {groups.length
        ? groups.map(item => {
          const focused = group === "milestone" && item.key === focus;
          return <Group key={item.key} group={item} milestone={group === "milestone" ? milestones.get(item.key) : null} why={focused && <Why needs={needsOf(focus)} />} focus={focused}
            open={opened.has(`${group}:${item.key}`)} shown={focused || ENDED_WORDS.includes(filters.state)} toggle={() => toggle(item.key)} row={row} />;
        })
        : <p className="empty card">{model.tasks.length ? "No task matches these filters." : "No tasks yet. A task starts when you ask the chief for a change."}</p>}
    </>
  );
}
