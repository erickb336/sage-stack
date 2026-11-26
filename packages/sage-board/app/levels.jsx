import { useState } from "react";
import { PairBox, PairNote, UndoButton, chiefLabel, markSeen, post, useAccess, useSeen } from "./actions.jsx";
import { Start, ago, plural } from "./overview.jsx";
import { projectNamed } from "./projects.jsx";
import { questionLink, runLink, taskLink } from "./task.jsx";
import { DESIGN_OPTIONS, OBJECTS, WORDS_MAX } from "../../sage-core/state-words.mjs";

const q = encodeURIComponent;
export const projectLink = key => `#project?key=${q(key)}`;
export const milestoneLevelLink = key => `#milestone?key=${q(key)}`;
export const looseLink = project => `#milestone?project=${q(project)}`;
export const LEVELS = ["", "project", "milestone", "task", "run"];
const KIND = { "": "All projects", project: "Project", milestone: "Milestone", task: "Task", run: "Run" };
const DONE_SHOWN = 5, DAY = 86_400_000;
const time = at => Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
export const clock = (at, now) => {
  if (time(at) === null) return "a time not recorded";
  const date = new Date(at), hm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return now && date.toDateString() === new Date(now).toDateString() ? hm : `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
};
const ENDED = { merged: "Merged", concluded: "Concluded", abandoned: "Abandoned" };
const WORD = { needs: "needs you", work: "at work", waits: "waits", done: "done" };

export function placeOf(all, page) {
  const key = page.params.get("key"), named = name => projectNamed(all.projects, name);
  if (page.hash === "" && !page.params.get("project")) return { level: "" };
  if (page.hash === "" || page.hash === "project") return { level: "project", project: named(key ?? page.params.get("project")), asked: key ?? page.params.get("project") };
  if (page.hash === "milestone" && key) {
    const milestone = all.milestones.find(item => item.key === key) ?? null;
    return { level: "milestone", milestone, project: milestone && all.projects.find(item => item.key === milestone.project), asked: key };
  }
  if (page.hash === "milestone") return { level: "milestone", loose: true, project: named(page.params.get("project")), asked: page.params.get("project") };
  const row = all.tasks.find(item => item.key === key) ?? null, project = row && all.projects.find(item => item.key === row.project);
  return { level: page.hash, row, project, milestone: row?.milestone && all.milestones.find(item => item.key === row.milestone.key), loose: !!row && !row.milestone, run: page.params.get("run") };
}

export function Crumb({ all, page }) {
  const place = all ? placeOf(all, page) : { level: page.hash };
  const parts = [["All projects", "#"]];
  if (place.project) parts.push([place.project.name, projectLink(place.project.key)]);
  else if (place.level === "project") parts.push([KIND.project]);
  if (place.milestone) parts.push([place.milestone.title, milestoneLevelLink(place.milestone.key)]);
  else if (place.loose && place.project) parts.push(["No milestone", looseLink(place.project.key)]);
  else if (place.level === "milestone") parts.push([KIND.milestone]);
  if (["task", "run"].includes(place.level)) parts.push([place.row?.title ?? KIND.task, place.row && taskLink(place.row.key)]);
  if (place.level === "run") parts.push([place.run ?? KIND.run]);
  return (
    <nav className="crumb lv-crumb" aria-label="Where you are">
      {parts.map(([label, href], i) => i === parts.length - 1 ? <b key={i} aria-current="page">{label}</b> : <span key={i}><a href={href}>{label}</a><i aria-hidden="true">›</i></span>)}
    </nav>
  );
}

const shownProjects = all => all.projects.filter(project => ["needs", "active"].includes(project.list));
export function Tree({ all, page }) {
  if (!all) return <div className="tree" role="navigation" aria-label="Projects" aria-busy="true"><a href="#">All projects</a></div>;
  const place = placeOf(all, page), open = place.project?.key;
  const quiet = all.projects.filter(project => ["quiet", "older"].includes(project.list)), archived = all.projects.filter(project => project.list === "archived");
  const node = project => {
    const level = all.levels.projects[project.key], work = level?.work.length ?? 0;
    return [
      <a key={project.key} className={`d1${open === project.key && place.level === "project" ? " on" : ""}`} href={projectLink(project.key)} data-project={project.key} aria-current={open === project.key && place.level === "project" ? "page" : undefined}>
        <span className="nm">{project.name}</span>
        <span className={`n${project.needs ? " need" : ""}`}>{project.needs ? <><Mark row="needs" />{project.needs} {project.needs === 1 ? "needs" : "need"} you</> : work ? `${work} at work` : ""}</span>
      </a>,
      ...open === project.key ? [
        ...(level?.milestones ?? []).map(key => all.milestones.find(item => item.key === key)).filter(Boolean).map(milestone => (
          <a key={milestone.key} className={`d2${place.milestone?.key === milestone.key && place.level === "milestone" ? " on" : ""}`} href={milestoneLevelLink(milestone.key)}><span className="nm">{milestone.title}</span><span className="n">{milestone.merged} of {milestone.total}</span></a>)),
        <a key="loose" className={`d2${place.loose && place.level === "milestone" ? " on" : ""}`} href={looseLink(project.key)}><span className="nm">No milestone</span><span className="n">{openCount(all.levels.loose[project.key])} open</span></a>,
      ] : [],
    ];
  };
  const fold = (label, list) => list.length > 0 && <details open={list.some(project => project.key === open)}><summary>{label} · {list.length}</summary>{list.map(node)}</details>;
  return (
    <div className="tree" role="navigation" aria-label="Projects">
      <a href="#" className={place.level === "" ? "on" : ""} aria-current={place.level === "" ? "page" : undefined}>All projects</a>
      {shownProjects(all).map(node)}
      {fold("Quiet", quiet)}
      {fold("Archived", archived)}
    </div>
  );
}

const openCount = level => level ? level.needs.length + level.work.length + level.waits.length : 0;
export const Mark = ({ row, state }) => <span className={`mk m-${row === "done" && state === "abandoned" ? "aband" : row}`} aria-hidden="true" />;
const Dot = () => <span className="new" title="New since you looked"><span className="sr">new: </span></span>;

function TaskRow({ row, meta, project, fresh, to, indent }) {
  return (
    <a className={`lv-row${indent ? " ind" : ""}`} href={to ?? taskLink(row.key)} data-task={row.key} data-row={row.row}>
      <Mark row={row.row} state={row.state} />
      <span className="tt">{fresh && <Dot />}{row.title}<span className="id">{row.id}</span></span>
      <span className="meta">{project && `${project} · `}{meta}<span className="sr"> · {WORD[row.row]}</span></span>
    </a>
  );
}

export const flagOf = run => run.flag ?? (run.look ? { level: run.status === "failed" ? "red" : "amber", text: OBJECTS.agent.states[run.status === "running" ? run.state : run.status]?.at(-1) ?? run.status } : null);
const Flag = ({ flag }) => <span className={`fl ${flag.level}`}>{flag.text}</span>;
function RunRow({ run, project }) {
  const flag = flagOf(run);
  return (
    <a className="lv-row ind" href={runLink(run.task.key, run.id)} data-run={run.id} data-task={run.task.key}>
      <span className={run.status === "running" ? "mk m-work" : "mk"} aria-hidden="true" />
      <span className="tt">{run.task.title}<span className="id">{run.task.id}</span></span>
      <span className="meta">{project && `${project} · `}{run.role} {run.id}{flag && <> · <Flag flag={flag} /></>}{run.why && ` · ${run.why}`}</span>
    </a>
  );
}

function Answer({ need, writes, archived }) {
  const [said, setSaid] = useState(null), [busy, setBusy] = useState(false);
  const can = writes === "paired" && !archived && !busy && !said?.ok;
  const answer = async i => {
    setBusy(true);
    setSaid({ ...await post("answer", { logbook: need.logbook, gate: need.gate, option: i + 1, digest: need.digest }), option: need.options[i] });
    setBusy(false);
  };
  if (said?.ok) return <p className="lv-ans" role="status">You chose <b>{said.option}</b>. Recorded in the logbook. It waits for the chief to pick it up. <UndoButton logbook={need.logbook} gate={need.gate} onDone={done => done.ok && setSaid(null)} /></p>;
  return <>
    <div className="lv-acts">
      {need.options.map((option, i) => <button type="button" key={option} className={`btn${option === need.recommendation ? " primary" : ""}`} disabled={!can} onClick={() => answer(i)}>{option}{option === need.recommendation && " (recommended)"}</button>)}
      <a className="lv-open" href={questionLink(need.key)}>Open</a>
      {archived ? <span className="faint">Restore the project to answer.</span> : writes === "unpaired" ? <span className="faint">Pair this browser to answer here, or answer in the chief's chat.</span> : writes === "off" ? <span className="faint">Answer in the chief's chat.</span> : null}
    </div>
    {said && <p className="refused" role="alert">Not recorded. {said.text}</p>}
  </>;
}

export function Decide({ need, answered, archived = false, now }) {
  const writes = useAccess(), [said, setSaid] = useState(null), [busy, setBusy] = useState(false), [words, setWords] = useState(null);
  const done = answered ? { option: answered.answer, logbook: answered.logbook, gate: answered.gateId } : said?.ok ? { option: said.option, logbook: need.logbook, gate: need.gate } : null;
  const question = answered ? answered.question : need.question;
  if (done) return (
    <section className="lv-decide done" data-decide={answered?.key ?? need.key}>
      <p className="lbl2">Answered</p><h2>{question}</h2>
      <p className="lv-ans" role="status">You chose <b>{done.option}</b>. Recorded in the logbook. It waits for the chief to pick it up; you can undo until then. <UndoButton logbook={done.logbook} gate={done.gate} onDone={result => result.ok && setSaid(null)} /></p>
    </section>
  );
  const can = writes === "paired" && !archived && !busy;
  const send = async (i, text) => {
    setBusy(true);
    setSaid({ ...await post("answer", { logbook: need.logbook, gate: need.gate, option: i + 1, digest: need.digest, ...(text !== undefined && { words: text }) }), option: text === undefined ? need.options[i] : `${need.options[i]}: ${text}` });
    setBusy(false);
  };
  const choices = !need.gate ? null : !need.options?.length ? <div className="lv-acts"><a className="lv-open" href={questionLink(need.key)}>Open the question</a></div>
    : words !== null ? <div className="lv-words">
      <label><b>{DESIGN_OPTIONS[1]}</b>: type your words. They go with your choice, as one answer.<textarea value={words} maxLength={WORDS_MAX} rows={3} onChange={event => setWords(event.target.value)} /></label>
      <div className="lv-acts"><button type="button" className="btn primary" disabled={!can || !words.trim()} onClick={() => send(need.options.indexOf(DESIGN_OPTIONS[1]), words)}>Send</button><button type="button" className="btn" onClick={() => setWords(null)}>Cancel</button></div>
    </div>
    : <div className="lv-acts">
      {need.options.map((option, i) => <button type="button" key={option} className={`btn${option === need.recommendation ? " primary" : ""}`} disabled={!can} onClick={() => need.design && option === DESIGN_OPTIONS[1] ? setWords("") : send(i)}>{option}{option === need.recommendation && " (recommended)"}</button>)}
      {archived && <span className="faint">Restore the project to answer.</span>}
    </div>;
  return (
    <section className="lv-decide" data-decide={need.key}>
      <p className="lbl2">Needs you · {need.askedAt ? `asked ${clock(need.askedAt, now)}` : "time not recorded"}</p>
      <h2>{need.question}</h2>
      {need.more.length > 0 && <p className="more">{need.more.join(" ")}</p>}
      {need.design ? <div className="two">
        <a className="lv-design" href={questionLink(need.key)}>Open the design and the full question</a>
        <div><p className="faint">A design question has three fixed choices, so sage knows when you approve. Your words go with {DESIGN_OPTIONS[1]}.</p>{choices}</div>
      </div> : choices}
      {said && !said.ok && <p className="refused" role="alert">Not recorded. {said.text}</p>}
      {need.gate && writes !== "paired" && <PairBox id={`pair-${need.gate}`} />}
    </section>
  );
}

function NeedRow({ need, all, byProject, fresh, now }) {
  const writes = useAccess(), project = all.projects.find(item => item.key === need.project), archived = !!project?.archived && need.project !== null;
  const link = need.task ? taskLink(need.task.key) : need.milestone ? milestoneLevelLink(need.milestone) : null;
  const where = [byProject && project?.name, need.askedAt ? `asked ${clock(need.askedAt, now)}` : "time not recorded"].filter(Boolean).join(" · ");
  return (
    <div className="lv-need" data-need={need.key}>
      <Mark row="needs" />
      <span className="tt">{fresh && <Dot />}{link ? <a href={link}>{need.task?.title ?? need.question}</a> : need.question}{need.task && <span className="id">{need.task.id}</span>}</span>
      <span className="meta">{where}</span>
      <div className="body">
        {need.task && <p className="q">{need.question}</p>}
        {need.more.length > 0 && <p className="more">{need.more.join(" ")}</p>}
        {need.gate && need.design ? <div className="lv-acts"><a className="btn primary" href={taskLink(need.task.key)}>Open the design to answer</a><span className="faint">A design answer needs its page: 3 fixed choices there.</span></div>
          : need.gate && need.options?.length ? <Answer need={need} writes={writes} archived={archived} />
          : link && <div className="lv-acts"><a className="lv-open" href={link}>Open</a></div>}
      </div>
    </div>
  );
}

function AnsweredRow({ item, all, byProject, now }) {
  const project = all.projects.find(row => row.key === item.project);
  return (
    <div className="lv-need answered" data-answered={item.key}>
      <Mark row="done" />
      <span className="tt"><a href={taskLink(item.task.key)}>{item.task.title}</a><span className="id">{item.task.id}</span></span>
      <span className="meta">{[byProject && project?.name, `answered ${clock(item.at, now)}`].filter(Boolean).join(" · ")}</span>
      <div className="body"><p className="lv-ans">You chose <b>{item.answer}</b>. It waits for {chiefLabel(all.chiefs, item.logbook, item.owner)} to pick it up. <UndoButton logbook={item.logbook} gate={item.gateId} /></p></div>
    </div>
  );
}

function NeedsPart({ all, needs, answered, byProject, since, now }) {
  const writes = useAccess();
  if (!needs.length && !answered.length) return <p className="lv-fold" data-part="needs">Nothing needs you{byProject ? " in any project" : " here"}.</p>;
  const fresh = need => since !== null && time(need.askedAt) > since;
  return (
    <section className="lv-part" aria-labelledby="lv-needs" data-part="needs">
      <h2 id="lv-needs">Needs you <span className="r">{needs.length} · oldest first</span></h2>
      <div className="lv-list">
        {needs.map(need => <NeedRow key={need.key} need={need} all={all} byProject={byProject} fresh={fresh(need)} now={now} />)}
        {answered.map(item => <AnsweredRow key={item.key} item={item} all={all} byProject={byProject} now={now} />)}
      </div>
      {writes === "unpaired" && needs.some(need => need.gate && need.options?.length && !need.design) && <PairBox id="lv-pair" />}
    </section>
  );
}

function WorkPart({ all, keys, rows, names, byProject, books }) {
  const [opened, setOpened] = useState(() => new Set());
  const agentsOf = key => books.reduce((n, book) => n + book.runs.filter(run => run.status === "running" && run.task.key === key).length, 0);
  const workMeta = row => [row.step?.label, plural(agentsOf(row.key), "agent")].filter(Boolean).join(" · ");
  const flagged = books.flatMap(book => book.runs.filter(run => run.look).map(run => ({ run, project: book.project })));
  if (!keys.length && !flagged.length) return null;
  const head = <h2 id="lv-work">At work <span className="r">{plural(keys.reduce((n, key) => n + agentsOf(key), 0), "agent")} on {plural(keys.length, "task")}</span></h2>;
  if (!byProject) return (
    <section className="lv-part" aria-labelledby="lv-work" data-part="work">{head}
      <div className="lv-list">
        {keys.map(key => rows.get(key)).filter(Boolean).map(row => <TaskRow key={row.key} row={row} meta={workMeta(row)} />)}
        {flagged.map(({ run }) => <RunRow key={`${run.task.key}/${run.id}`} run={run} />)}
      </div>
    </section>
  );
  const projects = all.projects.filter(project => !project.archived && (all.levels.projects[project.key]?.work.length || flagged.some(item => item.project === project.key)));
  const toggle = key => setOpened(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
  return (
    <section className="lv-part" aria-labelledby="lv-work" data-part="work">{head}
      <div className="lv-list">{projects.map(project => {
        const own = all.levels.projects[project.key].work, mine = flagged.filter(item => item.project === project.key);
        const calm = books.filter(book => book.project === project.key).flatMap(book => book.runs.filter(run => run.status === "running" && run.flag && !run.look).map(run => run.flag.text));
        const flags = [...new Set([...mine.map(item => flagOf(item.run).text), ...calm])];
        return [
          <button type="button" key={project.key} className="lv-wp" aria-expanded={opened.has(project.key)} onClick={() => toggle(project.key)} data-work={project.key}>
            <Mark row="work" /><span className="tt">{project.name}</span>
            <span className="meta">{plural(own.length, "task")} · {plural(all.levels.projects[project.key].agents, "agent")} · {flags.length ? flags.join(" · ") : <span className="faint">no flag</span>}</span>
            <span className="chev" aria-hidden="true">{opened.has(project.key) ? "▾" : "▸"}</span>
          </button>,
          ...mine.map(({ run }) => <RunRow key={`${run.task.key}/${run.id}`} run={run} />),
          ...opened.has(project.key) ? own.map(key => rows.get(key)).filter(Boolean).map(row => <TaskRow key={row.key} row={row} meta={workMeta(row)} indent />) : [],
        ];
      })}</div>
    </section>
  );
}

const Bar = ({ merged, total }) => <span className="lv-bar" aria-hidden="true"><i style={{ width: `${total ? Math.round(100 * merged / total) : 0}%` }} /></span>;
function ProgressPart({ milestones, names, byProject, loose }) {
  if (!milestones.length && !loose) return null;
  return (
    <section className="lv-part" aria-labelledby="lv-progress" data-part="progress">
      <h2 id="lv-progress">Progress <span className="r">merged of all tasks</span></h2>
      <div className="lv-list">
        {milestones.map(milestone => (
          <a key={milestone.key} className="lv-prog" href={milestoneLevelLink(milestone.key)} data-milestone={milestone.key}>
            <span><span className="tt">{milestone.title}</span> <span className="meta">{byProject ? names.get(milestone.project) : milestone.goal}</span></span>
            <Bar merged={milestone.merged} total={milestone.total} /><span className="n2">{milestone.merged} of {milestone.total}</span>
          </a>
        ))}
        {loose && <a className="lv-prog" href={looseLink(loose.project)} data-milestone="none"><span><span className="tt">No milestone</span> <span className="meta">tasks in no milestone</span></span><span /><span className="n2">{loose.open} open</span></a>}
      </div>
    </section>
  );
}

function ListPart({ id, label, keys, rows, names, byProject, meta, fresh, all: everything }) {
  const [all, setAll] = useState(!!everything);
  if (!keys.length) return null;
  const shown = all ? keys : keys.slice(0, DONE_SHOWN);
  return (
    <section className="lv-part" aria-labelledby={`lv-${id}`} data-part={id}>
      <h2 id={`lv-${id}`}>{label} <span className="r">{keys.length}{shown.length < keys.length ? " · newest first" : ""}</span></h2>
      <div className="lv-list">{shown.map(key => rows.get(key)).filter(Boolean).map(row => <TaskRow key={row.key} row={row} meta={meta(row)} project={byProject && names.get(row.project)} fresh={fresh?.(row)} />)}</div>
      {shown.length < keys.length && <button type="button" className="btn lv-more" onClick={() => setAll(true)}>Show all {keys.length}</button>}
    </section>
  );
}

function Since({ all, since, previous, now }) {
  const from = since ?? time(all.at) - DAY;
  const merged = all.tasks.filter(row => row.state === "merged" && time(row.doneAt) > from).length;
  const asked = all.needs.filter(need => time(need.askedAt) > from).length;
  const flags = all.agents.reduce((n, book) => n + book.look, 0);
  return (
    <div className="lv-since" data-part="since">
      <span>{previous ? <>Since you looked at {clock(previous, now)}</> : "In the last 24 hours"}: <b>{merged} merged</b> · <b>{plural(asked, "new question")}</b> · <b>{flags} with a flag now</b></span>
      {previous && <button type="button" className="btn" onClick={markSeen}>Mark seen</button>}
    </div>
  );
}

const unreadLine = (project, names) => project.unread.map(book => `${names.get(project.key)}: the board cannot read the ${book.tables.join(", ")} ${book.tables.length === 1 ? "table" : "tables"} of its ${book.logbook} logbook.`).join(" ");
function Unread({ projects, names }) {
  const bad = projects.filter(project => project.unread?.length || project.problem);
  if (!bad.length) return null;
  return <div className="lv-note bad" role="alert" data-part="failure">{bad.map(project => <p key={project.key}>{project.unread?.length ? unreadLine(project, names) : `${names.get(project.key)}: ${project.problem}`} Ask the chief to repair the logbook. The rest of the board is current.</p>)}</div>;
}

const metaOf = now => ({
  waits: row => row.waits ?? (row.step ? `${row.step.label}: no agent at work now` : "Not started"),
  done: row => `${ENDED[row.state] ?? "Done"} ${clock(row.doneAt, now)}`,
});

export function Loading({ hash }) {
  return (
    <div className="lv" aria-busy="true">
      <p className="kind">{KIND[hash] ?? KIND[""]}</p>
      <h1>The board is reading the logbooks</h1>
      <p className="sub">This takes a few seconds after the board starts. The page fills in by itself.</p>
      {["Needs you", "At work", "Progress"].map(label => <section className="lv-part" key={label}><h2>{label}</h2><i className="skel w6" /><i className="skel" /><i className="skel w4" /></section>)}
    </div>
  );
}

const Missing = ({ kind, text }) => <div className="lv"><p className="kind">{kind}</p><h1>{text}</h1><p className="sub">It may have moved or been removed. <a href="#">All projects</a></p></div>;

export function LevelPage({ all, page, now }) {
  const previous = useSeen(), place = placeOf(all, page);
  const names = new Map(all.projects.map(project => [project.key, project.name])), rows = new Map(all.tasks.map(row => [row.key, row]));
  const since = previous && time(previous), meta = metaOf(now);
  if (place.level === "project" && !place.project) return <Missing kind="Project" text="This project is not on the board" />;
  if (place.level === "milestone" && !place.project) return <Missing kind="Milestone" text="This milestone is not on the board" />;
  const top = place.level === "", project = place.project;
  const live = key => top ? !all.projects.find(item => item.key === key)?.archived : key === project.key;
  const scope = top ? all.levels.all : place.loose ? all.levels.loose[project.key] : place.milestone ? all.levels.milestones[place.milestone.key] : all.levels.projects[project.key];
  const inScope = new Set([...scope.needs, ...scope.work, ...scope.waits, ...scope.done]);
  const inPlace = (key, task, milestone) => top ? key === null || live(key) : place.level === "project" ? key === project.key : task ? inScope.has(task) : !!place.milestone && milestone === place.milestone.key;
  const needs = all.needs.filter(need => inPlace(need.project, need.task?.key, need.milestone));
  const answered = all.answered.filter(item => inPlace(item.project, item.task.key));
  const books = all.agents.filter(book => top ? live(book.project) : book.project === project.key).map(book => ({ ...book, runs: book.runs.filter(run => top || place.level === "project" || inScope.has(run.task.key)) }));
  const milestones = top ? all.levels.all.milestones : place.level === "project" ? all.levels.projects[project.key].milestones : [];
  const shownMilestones = milestones.map(key => all.milestones.find(item => item.key === key)).filter(Boolean);
  const loose = place.level === "project" ? { project: project.key, open: openCount(all.levels.loose[project.key]) } : null;
  const freshDone = row => since !== null && time(row.doneAt) > since;
  const empty = [
    !scope.work.length && !books.some(book => book.runs.some(run => run.look)) && "no agent at work",
    ["", "project"].includes(place.level) && !shownMilestones.length && !loose?.open && "no milestone",
    !top && !scope.waits.length && "nothing waits",
    !scope.done.length && "nothing done in the last 7 days",
  ].filter(Boolean);
  const quiet = all.projects.filter(item => ["quiet", "older"].includes(item.list)).length, archived = all.projects.filter(item => item.archived).length;
  const head = top ? <><p className="kind">All projects</p><h1>All projects</h1><p className="sub">{plural(shownProjects(all).length, "project")} with work · {quiet} quiet · {archived} archived</p></>
    : place.level === "project" ? <><p className="kind">Project</p><h1>{project.name}</h1><p className="sub">{plural(project.open, "open task")}{project.lastActivity && ` · active ${ago(project.lastActivity, now)}`}{project.archived && " · archived"}</p></>
    : place.loose ? <><p className="kind">Milestone</p><h1>No milestone</h1><p className="sub">The tasks of {project.name} that are in no milestone.</p></>
    : <><p className="kind">Milestone</p><h1>{place.milestone.title}</h1><p className="sub">{place.milestone.goal ?? "The logbook keeps no goal for this milestone."} · {project.name}</p></>;
  if (top && !all.projects.length) return <div className="lv">{head}<PairNote /><Start started={false} /></div>;
  return (
    <div className="lv" data-level={top ? "all" : place.level}>
      {head}
      <PairNote />
      <Unread projects={top ? all.projects.filter(item => !item.archived) : [project]} names={names} />
      {top && <Since all={all} since={since} previous={previous} now={now} />}
      <NeedsPart all={all} needs={needs} answered={answered} byProject={top} since={since} now={now} />
      <div className="lv-two">
        <WorkPart all={all} keys={scope.work} rows={rows} names={names} byProject={top} books={books} />
        {place.milestone ? <section className="lv-part" aria-labelledby="lv-progress" data-part="progress">
          <h2 id="lv-progress">Progress <span className="r">{place.milestone.merged} of {place.milestone.total} merged</span></h2>
          <Bar merged={place.milestone.merged} total={place.milestone.total} />
          <p className="meta">Done when each task that is not abandoned is merged or concluded.{place.milestone.abandoned.length > 0 && ` Abandoned: ${place.milestone.abandoned.join(", ")}.`}</p>
        </section> : <ProgressPart milestones={shownMilestones} names={names} byProject={top} loose={loose?.open ? loose : null} />}
      </div>
      {empty.length > 0 && <p className="lv-fold" data-part="fold">Here: {empty.join(" · ")}.</p>}
      {!top && <ListPart id="waits" label="Waits" keys={scope.waits} rows={rows} names={names} meta={meta.waits} all />}
      <ListPart id="done" label="Done in the last 7 days" keys={scope.done} rows={rows} names={names} byProject={top} meta={meta.done} fresh={freshDone} />
      {place.level === "project" && <p className="lv-fold lv-more-pages">More for this project: <a href={`#overview?project=${q(project.key)}`}>chiefs and archive</a> · <a href={`#tasks?project=${q(project.key)}`}>Tasks</a> · <a href={`#agents?project=${q(project.key)}`}>Agents</a> · <a href={`#pull-requests?project=${q(project.key)}`}>Pull requests</a> · <a href={`#stats?project=${q(project.key)}`}>Stats</a></p>}
    </div>
  );
}
