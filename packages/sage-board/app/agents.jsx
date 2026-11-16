import { useEffect, useState } from "react";
import { AgentRing, AgentTile, Glyph, Ring, StateBadge, age, clock, span, tokens } from "./agent.jsx";
import { chiefState, chiefSub, ofChief, readLink, taskLink } from "./task.jsx";
import { FLAGGED, MARKS, OBJECTS, chiefName, runWord, shown } from "../../sage-core/state-words.mjs";

const MIN = 60_000, SEATS_MAX = 30;
const LEGEND = [["running", "running"], ["done", "done"], ["question", "question"], ["failed", "failed"], ["look", "stuck"], ["queued", "queued"]].map(([bar, state]) => [bar, shown(OBJECTS.agent.states[state]).text + (bar === "look" ? `, or ${shown(OBJECTS.agent.states.stop).text}` : "")]);
const RUN = runWord("running").text, WAIT = runWord("queued").text;
const limitNote = (n, limit) => n > limit ? " · over the limit" : n >= limit ? " · at the limit" : "";
const chiefKey = id => id ?? "none";
const chiefTitle = chief => chief.id ? chiefName(chief.id, chief.provider) : chief.name;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const arenaRun = run => !!run.candidate || run.role === "arena-judge";
const spent = (runs, now) => runs.reduce((sum, run) => sum + Math.max(0, (run.ended ? Date.parse(run.ended) : now) - Date.parse(run.started) || 0), 0);
const tokensOf = runs => runs.some(run => run.tokens !== null) ? runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) : null;
const tok = n => n === null ? tokens(n) : `${tokens(n)} tok`;

function useNow(at) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [at]);
  return Math.max(now, Date.parse(at) || 0);
}

const runningIn = books => books.reduce((n, book) => n + book.running, 0);
export function LimitCounts({ agents, all }) {
  const everywhere = runningIn(all), others = all.length > agents.length && <span className="limit" title="Running agents of every project on this Mac">{everywhere} {RUN} in all projects</span>;
  if (agents.length !== 1) return <>{agents.length > 1 && <a className="limit" href="#agents">Agents <b>{runningIn(agents)} {RUN}</b>{agents.some(book => book.queued) && ` · ${agents.reduce((n, book) => n + book.queued, 0)} ${WAIT}`}</a>}{others}</>;
  const [book] = agents, full = book.running >= book.limit, leads = book.leads >= book.leadLimit;
  return (
    <>
      <a className={`limit${full ? " full" : ""}`} href="#agents" title="Running agents of every chief, against the project's one limit">
        Agents <b>{book.running} of {book.limit}</b>{book.byChief.map(item => <span key={chiefKey(item.chief)}> · {item.chief ?? "no chief"} {item.count}</span>)}{book.queued > 0 && <b> · {book.queued} {WAIT}</b>}
      </a>
      <a className={`limit${leads ? " full" : ""}`} href="#agents" title="Lead runs that run or wait in the queue, against the project's lead limit">Leads <b>{book.leads} of {book.leadLimit}</b></a>
      {others}
    </>
  );
}

const About = ({ task }) => <a className="about" href={taskLink(task.key)} data-task={task.key} aria-label={`About ${task.title}`}>About <span aria-hidden="true">›</span></a>;
const Title = ({ task, run }) => <a className="ttl" href={taskLink(task.key)} data-task={task.key} data-run={run?.id}>{task.title || task.id}</a>;
const More = ({ count }) => count > 0 && <p className="more-done">and {count.toLocaleString("en-US")} more failed</p>;

function Fold({ runs, total, now }) {
  const [open, setOpen] = useState(false);
  if (!runs.length) return null;
  const count = total > runs.length ? `the last ${runs.length} of ${total.toLocaleString("en-US")}` : `${runs.length}`;
  return (
    <>
      <button type="button" className="more-ended" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dstack" aria-hidden="true">{runs.slice(0, 3).map(run => <span className="tile" key={run.id}><Glyph role={run.role} /></span>)}</span>
        <span>{open ? "Hide" : "Show"} {count} ended {total === 1 ? "helper" : "helpers"}</span>
      </button>
      {open && <div className="squad">{runs.map(run => <AgentTile key={run.id} run={run} now={now} />)}</div>}
    </>
  );
}

function LeadCard({ lead, helpers, queued, more, now, step }) {
  const shown = helpers.filter(run => run.status === "running" || run.look), ended = helpers.filter(run => !shown.includes(run));
  const look = shown.filter(run => run.look).length + more, mine = [lead, ...helpers];
  return (
    <section className="acard" aria-label={`${lead.role} ${lead.id} on ${lead.task.id}`}>
      <header className="acard-h">
        <AgentRing run={lead} now={now} />
        <div className="lt">
          <Title task={lead.task} run={lead} />
          <span className="sub"><span className="mono">lead · {lead.id}</span> <StateBadge run={lead} />{step && <span> · {step}</span>}{look > 0 && <span className="badge look">{MARKS.problem} {plural(look, "helper")} {FLAGGED}</span>}</span>
        </div>
        <div className="tot"><b>{age(lead, now)}</b><span>{tok(tokensOf(mine))} · with helpers</span></div>
        <About task={lead.task} />
      </header>
      {shown.length > 0 && <div className="squad">{shown.map(run => <AgentTile key={run.id} run={run} now={now} />)}</div>}
      <More count={more} />
      <Fold runs={ended} total={lead.endedHelpers ?? ended.length} now={now} />
      <footer className="acard-f">
        <span>Lead's own work: {age(lead, now)}{lead.tokens === null ? "" : ` · ${tokens(lead.tokens)}`} · {lead.model ?? "model not recorded"}</span>
        <span>{shown.filter(run => run.status === "running").length} {RUN}{queued > 0 && ` · ${queued} ${WAIT}`} · {plural(helpers.length + queued, "helper")}</span>
      </footer>
    </section>
  );
}

function Arena({ runs, now }) {
  const task = runs[0].task, candidates = runs.filter(run => run.candidate).sort((a, b) => String(a.candidate).localeCompare(String(b.candidate), "en", { numeric: true }));
  const judge = runs.filter(run => run.role === "arena-judge").at(-1), done = candidates.filter(run => run.status !== "running" && run.status !== "queued").length;
  const ended = judge && judge.status !== "running" && judge.status !== "queued";
  return (
    <section className="acard arena" aria-label={`Arena of ${task.id}`}>
      <header className="acard-h">
        <Ring ring={ended ? "done" : "run"}><Glyph role="arena-judge" /></Ring>
        <div className="lt"><Title task={task} /><span className="sub">Arena · {plural(candidates.length, "candidate")}, one brief, then a judge · <span className="mono">{task.id}</span></span></div>
        <div className="tot"><b>{ended ? "ended" : `${done} of ${candidates.length} ended`}</b><span>{span(spent(runs, now))} · {tok(tokensOf(runs))}</span></div>
        <About task={task} />
      </header>
      <div className="squad ar-sq">
        {candidates.map(run => <AgentTile key={run.id} run={run} now={now} />)}
        <span className="ar-arrow" aria-hidden="true">→</span>
        {judge ? <AgentTile run={judge} now={now} /> : <p className="ag ended wait"><Ring ring="wait"><Glyph role="arena-judge" /></Ring><span className="ag-b"><b className="rw">arena-judge</b><span className="mdl">Starts when all {candidates.length} candidates end · {candidates.length - done} still {candidates.length - done === 1 ? "runs" : "run"}</span></span></p>}
      </div>
      <p className="ar-res">{ended
        ? <>The judge ended: <a href={readLink(task.key, "arena")}>the scores, the base and the grafts</a> · <a href={readLink(task.key, "report", judge.id)}>the judge's report {judge.id}</a></>
        : "The scores, the base and the grafts show when the judge ends. Each candidate saves its design in the task's pages folder."}</p>
    </section>
  );
}

function OwnRuns({ label, note, runs, more = 0, now, failed = false }) {
  if (!runs.length) return null;
  const tasks = [...new Map(runs.map(run => [run.task.key, run.task])).values()];
  return (
    <section className={`acard own${failed ? " failed" : ""}`} aria-label={label}>
      <header className="acard-h plain"><b>{label}</b><span className="faint">{note}</span></header>
      {tasks.map(task => (
        <div className="own-t" key={task.key}>
          <p className="own-h"><Title task={task} /> <span className="mono faint">{task.id}</span><About task={task} /></p>
          <div className="squad">{runs.filter(run => run.task.key === task.key).map(run => <AgentTile key={run.id} run={run} now={now} />)}</div>
        </div>
      ))}
      <More count={more} />
    </section>
  );
}

function Queued({ runs, now }) {
  if (!runs.length) return null;
  return (
    <section className="queue" aria-label={WAIT}>
      <p className="queue-h"><b>{WAIT[0].toUpperCase() + WAIT.slice(1)}</b> <span className="faint">Each run waits for an agent slot. The oldest starts first, when an agent of any chief ends.</span></p>
      <div className="squad">{runs.map(run => <AgentTile key={run.id} run={run} now={now} task />)}</div>
    </section>
  );
}

function ChiefBox({ chief, runs, failedMore, tasks, now }) {
  const more = lead => failedMore.find(item => item.lead === lead && (lead || item.chief === chief.id))?.count ?? 0;
  const arenas = [...new Set(runs.filter(arenaRun).map(run => run.task.key))].map(key => runs.filter(run => arenaRun(run) && run.task.key === key && run.status !== "queued"));
  const rest = runs.filter(run => !arenaRun(run));
  const leads = rest.filter(run => run.role === "lead" && run.status === "running");
  const loose = rest.filter(run => !leads.some(lead => lead.id === run.lead));
  const own = loose.filter(run => run.role !== "lead" && run.status === "running");
  const failed = loose.filter(run => run.look && run.status !== "running");
  const queued = runs.filter(run => run.status === "queued").sort((a, b) => a.place - b.place);
  const running = runs.filter(run => run.status === "running").length;
  const stopped = chief.stopped === true, ring = stopped ? "stop" : chief.waits ? "need" : chief.stopped === false ? "live" : "wait";
  const owned = stopped ? tasks.filter(task => !task.ended && ofChief(task, chief)) : [];
  const stepOf = key => tasks.find(task => task.key === key)?.step?.label ?? null;
  return (
    <section className={`card chief-box${stopped ? " stopped" : ""}`} data-chief={chief.key} aria-labelledby={`chief-${chief.key}`}>
      <div className="card-h chief-h">
        <Ring ring={ring} label={`Chief ${chief.id ?? ""}, ${chiefState(stopped ? "stopped" : chief.waits ? "waits" : chief.stopped === false ? "live" : "unknown")}`}><span className="cm">{chief.id ?? MARKS.unknown}</span></Ring>
        {chief.waits && <span className="need-mark" aria-hidden="true">{MARKS["needs you"]}</span>}
        <h2 id={`chief-${chief.key}`}>{chiefTitle(chief)}</h2>
        {chief.id && <span className="faint">{chiefSub(chief)}</span>}
        <span className={`badge${stopped ? "" : chief.stopped === false ? " done" : ""}`}>{chiefState(stopped ? "stopped" : chief.stopped === false ? "live" : "unknown")}</span>
        {chief.autopilot !== null && chief.autopilot !== undefined && !stopped && <span className={`badge${chief.autopilot ? " pick" : ""}`}>Autopilot {chief.autopilot ? "on" : "off"}</span>}
        {chief.waits && <span className="badge need">{MARKS["needs you"]} a question for you</span>}
        <span className="grow" />
        <span className="hint">{plural(leads.length, "lead")} · {running} {RUN}{queued.length > 0 && ` · ${queued.length} ${WAIT}`}</span>
      </div>
      {stopped && (
        <div className="stopped-note">
          <p>{running || queued.length ? "No run of this chief shows activity, although the logbook lists the runs below." : "No agent is running."} Last event {clock(chief.heartbeat)}: the heartbeat stopped. Nothing moves on its own.</p>
          {owned.length > 0 && <p>It owns {owned.map((task, i) => <span key={task.key}>{i > 0 && ", "}<a href={taskLink(task.key)} data-task={task.key}>{task.id} · {task.title}</a></span>)}. To give a task to another chief, use the Overview.</p>}
        </div>
      )}
      {!stopped && !running && !queued.length && <p className="empty">No agent is running now.</p>}
      {(leads.length > 0 || arenas.length > 0 || own.length > 0 || failed.length > 0) && (
        <div className="acards">
          {leads.map(lead => <LeadCard key={lead.id} lead={lead} step={stepOf(lead.task.key)} helpers={rest.filter(run => run.lead === lead.id && run.status !== "queued")} queued={rest.filter(run => run.lead === lead.id && run.status === "queued").length} more={more(lead.id)} now={now} />)}
          {arenas.filter(list => list.length).map(list => <Arena key={list[0].task.key} runs={list} now={now} />)}
          <OwnRuns label={`${chief.id ?? "Chief"} own runs`} note="Steps that the chief runs with no lead, such as design and PE. One row for each task." runs={own} now={now} />
          <OwnRuns label="Failed in the last 24 hours" note="Runs with no running lead." runs={failed} more={more(null)} now={now} failed />
        </div>
      )}
      <Queued runs={queued} now={now} />
    </section>
  );
}

function Seats({ book }) {
  const free = Math.max(0, book.limit - book.running), over = book.running + book.queued > SEATS_MAX || book.limit > SEATS_MAX;
  const groups = [...book.byChief.map(item => ({ key: chiefKey(item.chief), label: item.chief ?? "no chief", count: item.count, kind: "used" })), { key: "free", label: "free", count: free, kind: "free" }];
  return (
    <div className="seats" aria-label="Seats against the limit">
      <p className="seats-h"><b>Seats</b> <span className="faint">One limit for the whole project, shared by every chief in Claude and Codex. Each running agent takes a seat; a chief does not. A lead counts while it runs or waits in the queue.</span></p>
      {over ? <p className="seat-bar" role="img" aria-label={`${book.running} of ${book.limit} seats used, ${book.queued} ${WAIT}`}><span style={{ width: `${Math.min(100, (100 * book.running) / Math.max(1, book.limit))}%` }} /><b>{book.running} of {book.limit}</b>{book.queued > 0 && ` · ${book.queued} queued`}</p> : (
        <div className="seat-row" role="img" aria-label={`${groups.map(group => `${group.label} ${group.count}`).join(", ")}, limit ${book.limit}${book.queued ? `, ${book.queued} ${WAIT}` : ""}`}>
          {groups.filter(group => group.count).map(group => <span className={`sg ${group.kind}`} key={group.key}><span className="sq">{Array.from({ length: group.count }, (_, i) => <i key={i} />)}</span><span className="sl">{group.label} <b>{group.count}</b></span></span>)}
          <span className="sg limitmark"><span className="sq"><i /></span><span className="sl">limit <b>{book.limit}</b></span></span>
          {book.queued > 0 && <span className="sg queued"><span className="sq">{Array.from({ length: book.queued }, (_, i) => <i key={i} />)}</span><span className="sl">queued <b>{book.queued}</b></span></span>}
        </div>
      )}
    </div>
  );
}

const STEPS = [15, 30, 60, 120, 240].map(m => m * MIN);
function Timeline({ groups, now }) {
  const shown = groups.flatMap(group => group.lanes.map(lane => lane.run));
  if (!shown.length) return null;
  const first = Math.min(...shown.map(run => Date.parse(run.started)).filter(Number.isFinite));
  const step = STEPS.find(ms => (now - Math.min(first, now - 30 * MIN)) / ms <= 6) ?? STEPS.at(-1);
  const start = Math.max(Math.floor(Math.min(first, now - 30 * MIN) / step) * step, now - 6 * step), width = now - start;
  const x = at => `${Math.max(0, Math.min(100, (100 * (at - start)) / width))}%`;
  const ticks = []; for (let at = Math.ceil(start / step) * step; at <= now; at += step) ticks.push(at);
  return (
    <section className="card timeline" aria-labelledby="timeline-h">
      <div className="card-h"><h2 id="timeline-h">Timeline</h2><span className="grow" /><span className="hint">{clock(new Date(start).toISOString())} to now · one lane for each agent, by chief</span></div>
      <div className="lanes">
        <div className="lane ticks" aria-hidden="true"><span /><div className="track">{ticks.map(at => <span key={at} className="tick" style={{ left: x(at) }}>{clock(new Date(at).toISOString())}</span>)}</div></div>
        {groups.map(group => (
          <div key={group.key} className="lane-group">
            <p className="lane-h">{group.title}</p>
            {group.lanes.map(({ run, indent }) => {
              const from = Date.parse(run.started), to = run.ended ? Date.parse(run.ended) : now;
              const bar = run.status === "queued" ? "queued" : run.status === "running" ? run.look ? "look" : "running" : ["done", "question"].includes(run.status) ? run.status : "failed";
              return (
                <div className="lane" key={run.id}>
                  <span className={`lane-l${indent ? " in" : ""}`}><AgentRing run={run} now={now} small /><span>{run.role} <span className="mono faint">{run.id}</span></span></span>
                  <div className="track">
                    {ticks.map(at => <i key={at} className="gline" style={{ left: x(at) }} />)}
                    {to >= start && <span className={`lbar ${bar}`} style={{ left: x(from), width: `max(3px, calc(${x(to)} - ${x(from)}))` }} title={`${run.role} ${run.id} · ${runWord(run.status).text} · ${clock(run.started)}${run.ended ? ` to ${clock(run.ended)}` : ""}`} />}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="legend" aria-label="Bar colours">
        {LEGEND.map(([bar, text]) => <li key={bar}><span className={`lbar ${bar}`} />{text}</li>)}
      </ul>
    </section>
  );
}

function lanesOf(chief, runs) {
  const lanes = [];
  for (const lead of runs.filter(run => run.role === "lead" && run.status === "running")) lanes.push({ run: lead }, ...runs.filter(run => run.lead === lead.id).map(run => ({ run, indent: true })));
  lanes.push(...runs.filter(run => !lanes.some(lane => lane.run === run) && (run.status === "running" || run.status === "queued")).map(run => ({ run })));
  return { key: chief.key, title: chiefTitle(chief), lanes };
}

function Book({ book, model, chief, now, many }) {
  const chiefs = model.chiefs.filter(item => item.logbook === book.key);
  const boxes = [...chiefs, ...(book.runs.some(run => !run.chief) ? [{ key: `${book.key}/none`, id: null, name: "No chief recorded", provider: null, stopped: null, autopilot: null }] : [])]
    .filter(item => !chief || item.key === chief.key)
    .map(item => ({ chief: { ...item, waits: !!item.id && model.tasks.some(task => task.needsYou && !task.ended && task.chief?.id === item.id && task.key.startsWith(`${book.key}/`)) }, runs: book.runs.filter(run => run.chief === item.id) }));
  const full = book.running >= book.limit, leads = book.leads >= book.leadLimit;
  return (
    <div className="book" data-book={book.key}>
      {many && <h2 className="book-h">{book.key}</h2>}
      <div className="card seat-card">
        <Seats book={book} />
        <div className="kpis agents-kpis" aria-label="Counts against the limits">
          <div className={`kpi${full ? " full" : ""}`} data-count="agents"><div className="l">agents {RUN}{limitNote(book.running, book.limit)}</div><div className="n">{book.running} <span>of {book.limit}</span></div></div>
          <div className={`kpi${leads ? " full" : ""}`} data-count="leads"><div className="l">leads{limitNote(book.leads, book.leadLimit)}</div><div className="n">{book.leads} <span>of {book.leadLimit}</span></div></div>
          <div className={`kpi${book.queued ? " full" : ""}`} data-count="queued"><div className="l">{WAIT}</div><div className="n">{book.queued}</div></div>
          <div className={`kpi${book.look ? " look" : ""}`} data-count="look"><div className="l">{MARKS.problem} {FLAGGED}</div><div className="n">{book.look}</div></div>
        </div>
      </div>
      {boxes.length ? boxes.map(({ chief: item, runs }) => <ChiefBox key={item.key} chief={item} runs={runs} failedMore={book.failedMore} tasks={model.tasks} now={now} />)
        : <p className="empty card">{chief ? `${chief.id} has no agent in this project.` : "No agent is running now. When a chief starts an agent, it shows here within a few seconds."}</p>}
      <Timeline groups={boxes.map(({ chief: item, runs }) => lanesOf(item, runs)).filter(group => group.lanes.length)} now={now} />
    </div>
  );
}

export function Agents({ model, chief = null }) {
  const now = useNow(model.at);
  return (
    <>
      <div className="page-h">
        <h1>Agents</h1>
        <p>Each chief, its leads, and each lead's helpers, against the project's limits. A moving outline marks an agent that runs now. Open a card's title, "About" or an agent to see its task.</p>
      </div>
      {model.agents.length
        ? model.agents.map(book => <Book key={book.key} book={book} model={model} chief={chief} now={now} many={model.agents.length > 1} />)
        : <p className="empty card">No project to show, so no agents.</p>}
    </>
  );
}
