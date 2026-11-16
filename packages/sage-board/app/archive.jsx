import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PairBox, linkProject, post, useAccess } from "./actions.jsx";
import { AlertIcon } from "./icons.jsx";
import { ago, plural } from "./overview.jsx";
import { questionLink, taskLink } from "./task.jsx";

const UNDO_MS = 10_000, CLOSED_KEY = "board-welcome-closed";
let state = { asking: null, opener: null, busy: null, note: null, undone: null };
const listeners = new Set();
const set = change => { state = { ...state, ...change }; listeners.forEach(fn => fn()); };
const useArchive = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
let undoTimer;

export const askArchive = key => { set({ asking: key, note: null, opener: document.activeElement }); scrollTo(0, 0); };
export const day = at => new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
const cancel = () => {
  const { opener } = state;
  set({ asking: null, note: null, opener: null });
  (opener?.isConnected ? opener : document.querySelector("header .picker"))?.focus();
};

const logbookNames = (labels = []) => labels.length ? `The ${labels.join(" and ")} ${labels.length === 1 ? "logbook" : "logbooks"}` : "A logbook";

async function send(kind, project, { undo = false } = {}) {
  if (state.busy) return;
  clearTimeout(undoTimer);
  set({ busy: project.key, note: null, undone: undo ? project.key : null });
  const result = await post(kind, { project: project.key }), { landed = 0, logbooks = 1, failed, pending } = result.json;
  const word = kind === "archive" ? "Archive" : "Restore";
  const note = result.ok ? (kind === "archive" ? { kind: "archived", project } : null)
    : pending ? { kind: "pending", project, text: result.text }
    : landed ? { kind: "partial", project, again: kind, head: `${kind === "archive" ? "Archived" : "Restored"} in ${landed} of ${logbooks} logbooks.`,
      text: `${logbookNames(failed)} of ${project.name} did not save. ${result.text} The board shows ${project.name} as ${kind === "archive" ? "not archived" : "archived"} until ${logbooks === 2 ? "both agree" : "every logbook agrees"}.` }
    : { kind: "failed", project, again: kind, text: result.text, head: `${word} did not save.` };
  const stays = !result.ok && !landed && kind === "archive" && state.asking === project.key;
  set({ busy: null, asking: stays ? state.asking : null, note, ...(stays || { opener: null }), ...(undo && !result.ok && { undone: null }) });
  if (note?.kind === "archived") undoTimer = setTimeout(() => state.note === note && set({ note: null }), UNDO_MS);
}

function trap(event) {
  if (event.key === "Escape") { event.preventDefault(); if (!state.busy) cancel(); return; }
  if (event.key !== "Tab") return;
  const all = [...event.currentTarget.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), [tabindex='0']")];
  const [first, last] = [all[0], all.at(-1)];
  if (!first) return;
  if (event.shiftKey && (document.activeElement === first || !all.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function RestoreButton({ project, primary }) {
  const { busy } = useArchive(), writes = useAccess();
  if (writes !== "paired") return null;
  return <button type="button" className={`btn${primary ? " primary" : ""}`} disabled={!!busy} onClick={() => send("restore", project)}>{busy === project.key ? "Restoring…" : "Restore"}</button>;
}

function Kept({ project }) {
  const { tasks = 0, milestones = 0, findings = 0, answers = 0 } = project.kept ?? {};
  return <p className="kept">{[plural(tasks, "task"), plural(milestones, "milestone"), plural(findings, "finding"), plural(answers, "answer")].join(" · ")}<br /><span className="hint">The logbook keeps all of it.</span></p>;
}

function Confirm({ project, tasks }) {
  const { busy, note } = useArchive(), writes = useAccess(), heading = useRef(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [project.key, writes]);
  const prs = tasks.filter(task => task.project === project.key && task.pr && !task.ended).length;
  const warnings = [
    project.agents > 0 && `${plural(project.agents, "agent runs", "agents run")} now. Each finishes its current run. Then the chief starts nothing new.`,
    prs > 0 && `${plural(prs, "pull request stays", "pull requests stay")} open on GitHub. Nothing closes or merges them.`,
    project.needs > 0 && `${plural(project.needs, "question waits", "questions wait")} for you. ${project.needs === 1 ? "It waits" : "They wait"} in the archive.`,
  ].filter(Boolean);
  const failed = note?.project.key === project.key && note.again === "archive" ? note : null;
  return (
    <section className="card confirm" role="dialog" aria-modal="true" aria-labelledby="archive-h" data-confirm={project.key} onKeyDown={trap}>
      <h2 id="archive-h" ref={heading} tabIndex={-1}>Archive {project.name}?</h2>
      {writes !== "paired" ? <>
        <p>This browser cannot write to the logbook yet. Pair it here, then archive. Or ask the chief in the chat to archive {project.name}.</p>
        <PairBox id="archive-pair-h" />
        <p className="row-btns"><button type="button" className="btn" onClick={cancel}>Cancel</button></p>
      </> : <>
        <p>It moves to the Archived list. The chief starts nothing in it. Restore brings it back where it was.</p>
        <Kept project={project} />
        {warnings.map(text => <p key={text} className="warn" role="note"><AlertIcon />{text}</p>)}
        {busy === project.key ? <p role="status">Archiving {project.name}. Writing to its logbook.</p>
          : <p className="row-btns"><button type="button" className="btn primary" disabled={!!busy} onClick={() => send("archive", project)}>{failed ? "Try again" : "Archive"}</button><button type="button" className="btn" onClick={cancel}>Cancel</button></p>}
        {failed && <p className="refused" role="alert">{failed.head && <b>{failed.head} </b>}{failed.text}</p>}
      </>}
    </section>
  );
}

function Note({ note }) {
  const { project } = note, button = useRef(null);
  useEffect(() => { button.current?.focus(); }, [note]);
  if (note.kind === "archived") return (
    <div className="banner" role="status"><div><b>{project.name} is archived.</b> It is in the Archived list. <button type="button" className="btn" ref={button} onClick={() => send("restore", project, { undo: true })}>Undo</button></div></div>
  );
  return (
    <div className={`banner ${note.kind === "pending" ? "" : "fail"}`} role="alert"><AlertIcon />
      <div>{note.head && <b>{note.head} </b>}{note.text}{note.again && <> <button type="button" className="btn" ref={button} onClick={() => send(note.again, project)}>Try again</button></>}</div>
    </div>
  );
}

function Banner({ project, projects, now }) {
  const writes = useAccess(), fromChat = linkProject && projects.find(item => item.key === linkProject || item.books.some(book => book.endsWith(`/${linkProject}`)))?.key === project.key;
  const since = project.archivedAt ? <>Archived on {day(project.archivedAt)}, {ago(project.archivedAt, now)}.</> : "Archived.";
  return (
    <div className="banner archived" role="status" data-archived={project.key}>
      <div>
        {fromChat ? <b>The chat that sent this link works in {project.name}, and {project.name} is archived.</b> : <b>{since}</b>}{" "}
        <span className="hint">{fromChat ? "Restore it here, or ask the chief." : "Nothing runs here. The logbook is whole. Answers and other writes wait until Restore."}</span>
        <p className="row-btns">{writes === "paired" ? <RestoreButton project={project} primary /> : <span className="hint">Pair this browser on the Overview to restore it here, or ask the chief in the chat.</span>}</p>
      </div>
    </div>
  );
}

export function ArchiveLayer({ all, current, now }) {
  const { asking, note, undone } = useArchive(), project = all.projects.find(item => item.key === asking);
  const back = undone && all.projects.find(item => item.key === undone);
  useEffect(() => { if (back?.welcome && !back.archived) { closeWelcome(back); set({ undone: null }); } }, [back?.welcome, back?.archived]);
  return <>
    {project && <Confirm project={project} tasks={all.tasks} />}
    {note && !(note.again === "archive" && asking) && <Note note={note} />}
    {current?.archived && <Banner project={current} projects={all.projects} now={now} />}
  </>;
}

export function ArchiveFoot({ project }) {
  if (!project || project.archived) return null;
  return <p className="archive-foot"><button type="button" className="btn" onClick={() => askArchive(project.key)}>Archive project</button> <span className="hint">Puts {project.name} away. You can restore it.</span></p>;
}

const closedKey = project => `${project.key} ${project.archives}`;
const closedList = () => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"); } catch { return []; } };
const closeWelcome = project => { try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closedList(), closedKey(project)].slice(-20))); } catch {} };

export function WelcomeBack({ project, model, now }) {
  const [, setClosed] = useState(false), { undone } = useArchive();
  if (!project.welcome || undone === project.key || closedList().includes(closedKey(project))) return null;
  const close = () => { closeWelcome(project); setClosed(true); };
  const open = model.tasks.filter(task => !task.ended), prs = open.filter(task => task.pr).length, needs = model.needs.filter(need => need.project === project.key);
  return (
    <section className="card welcome" aria-labelledby="welcome-h">
      <div className="card-h"><h2 id="welcome-h">Welcome back to {project.name}</h2><span className="grow" /><span className="hint">{project.archivedAt ? `archived ${day(project.archivedAt)} · ` : ""}restored {ago(project.welcome, now)}</span></div>
      <div className="welcome-body">
        {!open.length ? <p>Every task was done when you archived. {needs.length ? "" : "Nothing waits for you. "}Ask the chief for new work when you want it.</p> : <>
          <h3 className="lbl">Where it stood</h3>
          <ul className="stood">{open.map(task => (
            <li key={task.key}><a href={taskLink(task.key)}>{task.id} · {task.title}</a> <span className="badge">{task.state}</span>{(task.waits || task.why || task.step?.label) && <span className="hint"> {task.waits || task.why || task.step.label}</span>}</li>
          ))}</ul>
        </>}
        {needs.length > 0 && <>
          <h3 className="lbl">What waits for you</h3>
          <ul className="stood">{needs.map(need => <li key={need.key}>{need.gate && need.logbook ? <a href={questionLink(need.key)}>{need.question}</a> : need.question}</li>)}</ul>
        </>}
        {prs > 0 && <p>{plural(prs, "pull request is", "pull requests are")} open. Main may have moved since you archived, so {prs === 1 ? "it" : "they"} may need a merge of main and fresh checks. The chief checks this first.</p>}
        {open.length > 0 && <><h3 className="lbl">Next step</h3><p>Ask the chief in the chat of {project.name} to go on. {prs ? "It checks the open pull requests first, then" : "It"} starts at the next step of each task.</p></>}
        <p className="row-btns"><button type="button" className="btn" onClick={close}>Close</button></p>
      </div>
    </section>
  );
}
