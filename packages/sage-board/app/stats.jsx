import { useEffect, useState } from "react";
import { AlertIcon } from "./icons.jsx";
import { plural } from "./overview.jsx";

const big = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
const week = (day, month = true) => new Date(`${day}T00:00:00Z`).toLocaleDateString([], { day: "numeric", ...(month && { month: "short" }), timeZone: "UTC" });
const NONE = "not recorded yet";

function useStats(project, at) {
  const [state, set] = useState({ project: undefined });
  useEffect(() => {
    let live = true;
    const done = value => live && set({ project, ...value });
    fetch(`/app/stats${project ? `?project=${encodeURIComponent(project)}` : ""}`)
      .then(async reply => done(reply.ok ? { stats: await reply.json() } : { problem: (await reply.text()).trim() }))
      .catch(() => done({ problem: "The board cannot reach its server on this Mac." }));
    return () => { live = false; };
  }, [project, at]);
  return state.project === project ? state : {};
}

function Chart({ title, axis, rows, across, value = row => String(row.value) }) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return (
    <figure className="card chart">
      <figcaption className="card-h"><h2>{title}</h2></figcaption>
      {!rows.length ? <p className="empty">None in the last 8 weeks.</p> : across ? (
        <div className="hbars" aria-hidden="true">{rows.map(row => (
          <div key={row.label} title={`${row.label}: ${value(row)}`}><span className="n">{row.label}</span><span><i style={{ width: `${row.value / max * 100}%` }} /></span><span className="v">{value(row)}</span></div>
        ))}</div>
      ) : <>
        <div className="cols" aria-hidden="true">{rows.map(row => <div key={row.label} title={`${row.label}: ${value(row)}`}><b>{value(row)}</b><i style={{ height: `${row.value / max * 100}%` }} /></div>)}</div>
        <div className="xs" aria-hidden="true">{rows.map(row => <span key={row.label}>{row.tick ?? row.label}</span>)}</div>
      </>}
      <p className="ax">{axis}</p>
      <table className="sr"><caption>{title}. {axis}</caption><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{value(row)}</td></tr>)}</tbody></table>
    </figure>
  );
}

const TOP = 6;
function byProject(projects, field) {
  const rows = projects.filter(row => row[field] > 0).sort((a, b) => b[field] - a[field]).map(row => ({ ...row, label: `${row.name}${row.archived ? " (archived)" : ""}`, value: row[field] }));
  if (rows.length <= TOP + 1) return rows;
  const rest = rows.slice(TOP);
  return [...rows.slice(0, TOP), { label: `${rest.length} others`, value: rest.reduce((n, row) => n + row.value, 0), tokens: rest.reduce((n, row) => n + row.tokens, 0) }];
}

function Numbers({ stats }) {
  const { total, weeks } = stats, at = (list, i) => ({ label: `week of ${week(weeks[i])}`, tick: week(weeks[i], !i || weeks[i].slice(5, 7) !== weeks[i - 1].slice(5, 7)), value: list[i] });
  const perWeek = list => weeks.map((_, i) => at(list, i));
  const tiles = [
    [total.merged, "pull requests merged", total.undated ? `last 8 weeks; ${total.undated} more have no merge date` : "last 8 weeks"],
    [total.open, "open tasks", "now"],
    [total.needs, "need you", "questions and merges that wait for you, now"],
    [`${total.hours} h`, "agent time", `from start to end of ${plural(total.runs - total.noTime, "ended run")}, last 8 weeks`],
    [big(total.tokens), "tokens", total.noTokens ? `${total.noTokens} of ${total.runs} runs have no count and are left out` : "last 8 weeks"],
    [total.rounds ?? "none", "repair rounds", "median per merged pull request"],
    [NONE, "money spent", "the logbooks do not keep it"],
    [NONE, "your own time", "the logbooks do not keep it"],
  ];
  const all = stats.project === null;
  return <>
    <section className="kpis stat-tiles" aria-label="Totals">{tiles.map(([n, label, hint]) => (
      <div className={`kpi${n === NONE ? " none" : ""}`} key={label}><div className="n">{n}</div><div className="l">{label}</div><div className="h">{hint}</div></div>
    ))}</section>
    <div className="charts">
      <Chart title="Merged pull requests per week" axis="Pull requests, by week. Weeks start on Monday (UTC)." rows={perWeek(stats.perWeek.merged)} />
      <Chart title="Agent time per week" axis="Hours from start to end of each ended run, by the week it ended." rows={perWeek(stats.perWeek.hours)} />
      <Chart title="Tokens per week" axis="Tokens of the runs that have a count, by the week the run ended." rows={perWeek(stats.perWeek.tokens)} value={row => big(row.value)} />
      <Chart title="Repair rounds per merged pull request" axis="Pull requests merged in the last 8 weeks, by their repair rounds." rows={stats.rounds.map(row => ({ label: row.label, value: row.count }))} />
      <Chart title="Open tasks by state" axis="Open tasks now, by their state." across rows={stats.open.map(row => ({ label: row.word, value: row.count }))} />
      {all && <Chart title="Merged pull requests by project" axis="Pull requests merged in the last 8 weeks." across rows={byProject(stats.projects, "merged")} />}
      {all && <Chart title="Agent time and tokens by project" axis="Hours of ended runs and their tokens, last 8 weeks." across rows={byProject(stats.projects, "hours")} value={row => `${row.value} h · ${big(row.tokens)}`} />}
      {all && <Chart title="Need you, by project" axis="Questions and merges that wait for you now." across rows={byProject(stats.projects, "needs")} />}
    </div>
  </>;
}

export function Stats({ all, params }) {
  const projects = all.projects, asked = params.get("show"), show = projects.some(project => project.key === asked) ? asked : null;
  const { stats, problem } = useStats(show, all.at);
  const pick = event => { const next = new URLSearchParams(params); event.target.value ? next.set("show", event.target.value) : next.delete("show"); location.hash = `stats?${next}`; };
  const books = (show ? projects.filter(project => project.key === show) : projects).reduce((n, project) => n + project.books.length, 0);
  return <>
    <div className="page-h">
      <h1>Stats</h1>
      <p>Numbers and charts from the logbooks on this Mac: the last 8 weeks, and the open work now.</p>
    </div>
    <label className="stat-pick">Show <select value={show ?? ""} onChange={pick}>
      <option value="">All projects</option>
      {projects.map(project => <option key={project.key} value={project.key}>{project.name}{project.archived ? " (archived)" : ""}</option>)}
    </select></label>
    {asked && !show && <p className="banner" role="status">This board shows no project {asked.slice(0, 80)}, so Stats shows all projects.</p>}
    {problem ? <div className="banner fail" role="alert"><AlertIcon /><div><b>The board cannot give the numbers now.</b> {problem}</div></div>
      : !stats ? <div role="status"><p className="loading">Reading {plural(books, "logbook")}.</p><div className="card about-skel"><i /><i /></div></div>
      : <>
        {stats.gaps.length > 0 && <div className="banner fail" role="alert"><AlertIcon /><div><b>{plural(stats.gaps.length, "logbook")} could not be read.</b> The numbers below leave out {stats.gaps.map(gap => gap.what).join(", ")}.</div></div>}
        {stats.empty ? <p className="card empty">No numbers yet. Stats starts when a project records its first task.</p> : <Numbers stats={stats} />}
      </>}
  </>;
}
