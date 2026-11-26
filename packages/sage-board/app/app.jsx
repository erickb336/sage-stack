import { useEffect, useRef, useState } from "react";
import { TaskPage, taskLink } from "./task.jsx";
import { ChiefChips, QuestionView, StopBoard, Stopped, useStopped } from "./actions.jsx";
import { Agents, LimitCounts } from "./agents.jsx";
import { AgentsIcon, AlertIcon, LeafIcon, MoonIcon, OverviewIcon, PullsIcon, StatsIcon, SunIcon, TasksIcon } from "./icons.jsx";
import { Overview, ago } from "./overview.jsx";
import { Pulls } from "./pulls.jsx";
import { Stats } from "./stats.jsx";
import { Tasks } from "./tasks.jsx";
import { Picker, Signal, projectNamed, projectOfKey, projectView } from "./projects.jsx";
import { ArchiveFoot, ArchiveLayer, WelcomeBack } from "./archive.jsx";
import { useModel, useNow, when } from "./use-model.js";
import { Crumb, Decide, LEVELS, LevelPage, Loading, Tree, placeOf } from "./levels.jsx";
import { RunPage } from "./run.jsx";
import { OBJECTS, runWord } from "../../sage-core/state-words.mjs";

const THEME_KEY = "board-theme";
const PAGES = [
  { hash: "overview", name: "Overview", Icon: OverviewIcon },
  { hash: "tasks", name: "Tasks", Icon: TasksIcon },
  { hash: "agents", name: "Agents", Icon: AgentsIcon },
  { hash: "pull-requests", name: "Pull requests", Icon: PullsIcon },
  { hash: "stats", name: "Stats", Icon: StatsIcon, own: true },
];
const QUESTION = { hash: "question", name: OBJECTS.question.label, hidden: true };
const TASK = { hash: "task", name: OBJECTS.task.label, hidden: true };
const LEVEL_PAGES = [{ hash: "", name: "All projects" }, { hash: "project", name: "Project" }, { hash: "milestone", name: "Milestone" }, { hash: "run", name: "Run" }];
const FILTER_KEY = "board-chief", PROJECT_KEY = "board-project";
const LISTED = PAGES.map(page => page.hash);

const clock = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function pageOf(hash) {
  let [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  if (path.includes("=")) [path, query] = ["", path];
  return { ...([...LEVEL_PAGES, ...PAGES, QUESTION, TASK].find(page => page.hash === path) ?? LEVEL_PAGES[0]), params: new URLSearchParams(query) };
}
function pageWithOldTaskLinkMoved() {
  const page = pageOf(location.hash), old = page.hash === "tasks" && page.params.get("task");
  if (!old) return page;
  history.replaceState(history.state, "", taskLink(old));
  return pageOf(location.hash);
}
const same = href => [...document.querySelectorAll("a[href]")].filter(link => link.getAttribute("href") === href);
const plainClick = event => !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function useHashPage(ready) {
  const [page, setPage] = useState(pageWithOldTaskLinkMoved);
  useEffect(() => {
    history.scrollRestoration = "manual";
    let last = location.hash;
    const changed = () => {
      const next = pageWithOldTaskLinkMoved();
      if (next.hash === TASK.hash && typeof history.state?.from !== "string") history.replaceState({ ...history.state, from: last.replace(/^#\/?/, "") }, "");
      if (next.hash !== pageOf(last).hash && typeof history.state?.focus !== "string") scrollTo(0, 0);
      last = location.hash; setPage(next);
    };
    const keep = event => {
      const link = event.target.closest?.('a[href^="#"], a[href^="/read/"]');
      if (link && plainClick(event) && link.target !== "_blank") history.replaceState({ ...history.state, scroll: scrollY, focus: link.getAttribute("href"), nth: same(link.getAttribute("href")).indexOf(link) }, "");
    };
    addEventListener("hashchange", changed); document.addEventListener("click", keep, true);
    return () => { removeEventListener("hashchange", changed); document.removeEventListener("click", keep, true); };
  }, []);
  useEffect(() => {
    const kept = history.state;
    if (page.hash === TASK.hash || !ready || typeof kept?.focus !== "string") return;
    scrollTo(0, kept.scroll); same(kept.focus)[kept.nth]?.focus({ preventScroll: true });
  }, [page, ready]);
  return page;
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
  };
  return [theme, flip];
}

const dataAt = (model, link, lostAt) => link === "lost" && !model.stale ? lostAt : model.at;
const age = (at, now) => `${when(at)}, ${ago(at, now)}`;

function Status({ model, link, lostAt, now }) {
  if (link === "connecting" && !model) return <span className="live" role="status"><span className="dot" />Reading the logbooks</span>;
  if (!model) return <span className="live bad" role="status"><span className="dot" />Cannot reach the board</span>;
  if (link === "lost") return <span className="live bad" role="status"><span className="dot" />Not updated since {age(dataAt(model, link, lostAt), now)} · trying again</span>;
  if (model.stale) return <span className="live bad" role="status"><span className="dot" />Not updated since {age(model.at, now)}</span>;
  return <span className="live ok" role="status"><span className="dot" /><span>Live<span className="at"> · read {clock(model.at)}</span></span></span>;
}

function Banner({ model, link, lostAt, now, own }) {
  if (link === "lost" && model) return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board lost its link to the server on this Mac.</b> The data below is from {age(dataAt(model, link, lostAt), now)}. It tries again on its own.</div>
    </div>
  );
  if (model?.stale && !own) return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board cannot read the logbook.</b> The data below is from {age(model.at, now)}. It reads again when the logbook changes.
        {model.problems.length > 0 && <ul>{model.problems.slice(0, 3).map(problem => <li key={problem}>{problem}</li>)}</ul>}
      </div>
    </div>
  );
  return null;
}

function NoData({ link }) {
  if (link === "connecting") return <div className="loading" role="status"><p><b>Reading the logbooks</b></p><p>The board shows your tasks when its first read ends.</p></div>;
  return (
    <div className="banner fail" role="alert"><AlertIcon />
      <div><b>The board cannot reach its server on this Mac.</b> It tries again every few seconds. If this lasts, check that the board service runs.</div>
    </div>
  );
}

function useChiefFilter() {
  const [filter, setFilter] = useState(() => { try { return sessionStorage.getItem(FILTER_KEY); } catch { return null; } });
  const set = value => { setFilter(value); try { value ? sessionStorage.setItem(FILTER_KEY, value) : sessionStorage.removeItem(FILTER_KEY); } catch {} };
  return [filter, set];
}

function useProject(all, page) {
  const last = useRef(null);
  if (last.current === null) try { last.current = localStorage.getItem(PROJECT_KEY) ?? ""; } catch { last.current = ""; }
  const projects = all?.projects ?? [], keyed = ["task", "question"].includes(page.hash) && projectOfKey(projects, page.params.get("key"));
  const kept = projectNamed(projects, last.current), current = all ? keyed || projectNamed(projects, page.params.get("project")) || (!kept?.archived && kept) || projects[0] || null : null;
  useEffect(() => {
    if (!current) return;
    last.current = current.key;
    try { localStorage.setItem(PROJECT_KEY, current.key); } catch {}
    const params = pageOf(location.hash).params;
    if (!LISTED.includes(page.hash) || params.get("project") === current.key) return;
    params.set("project", current.key);
    history.replaceState(history.state, "", `#${page.hash}?${params}`);
  }, [current?.key, page]);
  const asked = page.params.get("project");
  return [current, current && asked && !projectNamed(projects, asked) ? asked.slice(0, 80) : null];
}

export function App() {
  const { model: all, link, lostAt, notice } = useModel("/app/events"), now = useNow();
  const page = useHashPage(!!all);
  const [current, unknown] = useProject(all, page);
  const model = all && projectView(all, current?.key ?? null);
  const [theme, flip] = useTheme();
  const [chosen, setFilter] = useChiefFilter(), stopped = useStopped();
  const filter = model?.chiefs.some(chief => chief.key === chosen) ? chosen : null;
  const picked = model?.chiefs.find(chief => chief.key === filter);
  const shown = (logbook, id) => !filter || `${logbook}/${id}` === filter;
  const next = theme === "dark" ? "light" : "dark";
  const level = LEVELS.includes(page.hash), old = !level && page.hash !== "question";
  const open = model ? model.tasks.filter(task => !task.ended).length : 0;
  const prs = model ? model.tasks.filter(task => task.pr && !task.ended).length : 0;
  const running = model ? model.agents.reduce((n, book) => n + book.running, 0) : 0;
  const key = page.params.get("key") ?? "", place = all && level ? placeOf(all, page) : null;
  const welcome = page.hash === "overview" ? current : place?.level === "project" ? place.project : null;
  const body = page.hash === "overview" ? <Overview model={model} shown={shown} chief={picked} /> : page.hash === "tasks" ? <Tasks model={model} params={page.params} chief={picked} />
    : page.hash === "pull-requests" ? <Pulls model={model} chief={picked} />
    : page.hash === "agents" ? <Agents model={model} chief={picked} />
    : page.hash === "stats" ? <Stats all={all} params={page.params} />
    : page.hash === "question" ? <QuestionView key={key} needKey={key} openId={page.params.get("open")} model={model} theme={theme} project={current} />
    : page.hash === TASK.hash ? <TaskPage key={key} taskKey={key} tab={page.params.get("tab")} at={all?.at} from={history.state?.from}>
      {all?.needs.filter(need => need.task?.key === key).map(need => <Decide key={need.key} need={need} archived={!!place?.project?.archived} now={all.at} />)}
      {all?.answered.filter(item => item.task.key === key).map(item => <Decide key={item.key} answered={item} now={all.at} />)}
    </TaskPage>
    : page.hash === "run" ? <RunPage key={`${key} ${page.params.get("run")}`} taskKey={key} runId={page.params.get("run") ?? ""} all={all} />
    : <LevelPage all={all} page={page} now={now} />;
  if (stopped) return <Stopped at={stopped} />;
  return (
    <div className={level ? "app levels" : "app"}>
      <aside className="side">
        <div className="brand"><span className="mark"><LeafIcon /></span>sage board</div>
        <Tree all={all} page={page} />
        <nav aria-label="More pages">
          <p className="lbl more-h">More</p>
          <ul className="nav">
            {PAGES.map(item => (
              <li key={item.hash}>
                <a href={`#${item.hash}`} aria-current={item.hash === page.hash ? "page" : undefined}>
                  <item.Icon />{item.name}
                  {item.hash === "overview" && model && model.needs.length > 0 && <span className={model.archived ? "count" : "count need"} aria-label={`${model.needs.length} need you`}>{model.needs.length}</span>}
                  {item.hash === "tasks" && model && <span className="count" aria-label={`${open} open`}>{open}</span>}
                  {item.hash === "pull-requests" && model && <span className="count" aria-label={`${prs} open`}>{prs}</span>}
                  {item.hash === "agents" && model && <span className="count" aria-label={`${running} ${runWord("running").text}`}>{running}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="foot"><p className="src">The logbook on this Mac is the source of each line. Your answers and names write to it.</p><p className="lbl">Board</p><StopBoard /></div>
      </aside>
      <div className="col">
        <header className="top">
          {level || page.hash === "question" ? <Crumb all={all} page={page} />
            : <span className="crumb">{all && !page.own && <><Picker projects={all.projects} current={current} page={LISTED.includes(page.hash) ? page.hash : ""} now={now} /><span aria-hidden="true">/</span></>}<b>{page.name}</b></span>}
          {model && !level && !page.own && <Signal others={model.others} />}
          <span className="grow" />
          {model && !level && !page.own && <LimitCounts agents={model.agents} all={all.agents} />}
          <Status model={model} link={link} lostAt={lostAt} now={now} />
          <button type="button" className="theme" onClick={flip} aria-label={`Switch to the ${next} theme`} title={`Switch to the ${next} theme`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </header>
        {model && old && !page.own && <ChiefChips chiefs={model.chiefs} filter={filter} setFilter={setFilter} />}
        <main className="main">
          {notice && <div className="banner fail" role="alert" data-part="too-big"><AlertIcon /><div>{notice}</div></div>}
          {model && <Banner model={model} link={link} lostAt={lostAt} now={now} own={page.own} />}
          {model && unknown && old && !page.own && <p className="banner" role="status">This board shows no project {unknown}, so it opened {current.name}.</p>}
          {model && <ArchiveLayer all={all} current={page.own || page.hash === "question" ? null : level ? place?.project ?? null : current} now={now} />}
          {model && welcome && <WelcomeBack key={`${welcome.key} ${welcome.welcome}`} project={welcome} model={projectView(all, welcome.key)} now={now} />}
          {model || ["task", "run"].includes(page.hash) ? body : notice ? null : level && link === "connecting" ? <Loading hash={page.hash} /> : <NoData link={link} />}
          {model && page.hash === "overview" && <ArchiveFoot project={current} />}
        </main>
      </div>
    </div>
  );
}
