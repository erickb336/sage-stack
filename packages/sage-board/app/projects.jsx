import { useEffect, useRef, useState } from "react";
import { ago, plural } from "./overview.jsx";
import { PROJECT } from "./use-model.js";
const LISTS = ["older", "archived"];

export const projectNamed = (projects, name) => !PROJECT.test(name ?? "") ? null
  : projects.find(project => project.key === name) ?? projects.find(project => project.books.some(book => book.endsWith(`/${name}`))) ?? null;
export const projectOfKey = (projects, key) => projects.find(project => project.books.includes(String(key ?? "").slice(0, String(key ?? "").lastIndexOf("/")))) ?? null;

export function projectView(model, key) {
  const own = row => row.project === key, agents = model.agents.filter(own);
  return { ...model, tasks: model.tasks.filter(own), needs: model.needs.filter(need => need.project === key || need.project === null), answered: model.answered.filter(own),
    milestones: model.milestones.filter(own), hiddenDone: model.hiddenDone[key] ?? 0, chiefs: model.chiefs.filter(own), agents, stuck: agents.reduce((n, book) => n + book.look, 0) };
}

function useMenu() {
  const [open, setOpen] = useState(false), box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const key = event => { if (event.key === "Escape") { setOpen(false); box.current?.querySelector("button")?.focus(); } };
    const click = event => { if (!box.current?.contains(event.target)) setOpen(false); }, moved = () => setOpen(false);
    addEventListener("keydown", key); addEventListener("hashchange", moved); document.addEventListener("click", click);
    return () => { removeEventListener("keydown", key); removeEventListener("hashchange", moved); document.removeEventListener("click", click); };
  }, [open]);
  return [open, setOpen, box];
}

function line(project, now) {
  if (project.list === "archived") return `archived · ${plural(project.open, "open task")}`;
  const last = project.lastActivity ? ago(project.lastActivity, now) : "no work recorded";
  if (project.list === "older") return `${last} · ${project.open} open`;
  if (project.needs) return `${project.needs} ${project.needs === 1 ? "needs" : "need"} you`;
  return project.agents ? `${plural(project.agents, "agent")} · ${last}` : last;
}

function Rows({ projects, current, page, now }) {
  return (
    <ul>{projects.map(project => (
      <li key={project.key}>
        <a href={`#${page}?project=${encodeURIComponent(project.key)}`} aria-current={project.key === current?.key ? "true" : undefined} data-project={project.key}>
          <b>{project.name}</b><span className={project.list === "needs" ? "need" : "faint"}>{line(project, now)}</span>
        </a>
      </li>
    ))}</ul>
  );
}

const FOLDS = { older: ["Older", "no work for 30 days"], archived: ["Archived", "put away by you"] };

export function Picker({ projects, current, page, now }) {
  const [open, setOpen, box] = useMenu();
  const top = projects.filter(project => !LISTS.includes(project.list));
  return (
    <span className="projects" ref={box}>
      <button type="button" className="picker" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        {current ? current.name : "No project yet"}{current?.archived && <span className="badge">archived</span>}<span aria-hidden="true">{open ? " ▴" : " ▾"}</span>
      </button>
      {open && (
        <div className="menu pick-menu" role="dialog" aria-label="Projects">
          {!projects.length ? <p className="hint">No project yet. Turn sage mode on in the chat of a repository. The project shows here after its first task.</p> : <>
            <p className="lbl">Projects</p>
            {top.length ? <Rows projects={top} current={current} page={page} now={now} /> : <p className="hint">Every project is archived or older.</p>}
            {LISTS.map(list => {
              const folded = projects.filter(project => project.list === list);
              return folded.length > 0 && (
                <details key={list} open={current?.list === list}>
                  <summary>{FOLDS[list][0]} · {plural(folded.length, "project")} <span className="faint">{FOLDS[list][1]}</span></summary>
                  <Rows projects={folded} current={current} page={page} now={now} />
                </details>
              );
            })}
          </>}
        </div>
      )}
    </span>
  );
}

export function Signal({ projects, current }) {
  const [open, setOpen, box] = useMenu();
  const others = projects.filter(project => project.key !== current?.key && project.list === "needs");
  if (!others.length) return null;
  return (
    <span className="projects" ref={box}>
      <button type="button" className="signal" aria-expanded={open} onClick={() => setOpen(!open)}>{plural(others.length, "other project needs", "other projects need")} you</button>
      {open && (
        <div className="menu pick-menu" role="dialog" aria-label="Other projects that need you">
          <ul>{others.map(project => (
            <li key={project.key}><a href={`#?project=${encodeURIComponent(project.key)}`} data-project={project.key}><b>{project.name}</b><span className="need">{project.needs} {project.needs === 1 ? "needs" : "need"} you</span></a></li>
          ))}</ul>
        </div>
      )}
    </span>
  );
}
