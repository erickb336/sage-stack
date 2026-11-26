import { useEffect, useState } from "react";
import { age, span } from "./agent.jsx";
import { clock } from "./levels.jsx";
import { controlsShown, readLink, taskLink, useTask } from "./task.jsx";
import { answerOf, problemOf } from "./use-model.js";
import { runWord } from "../../sage-core/state-words.mjs";

function useActions(logbook, run, at) {
  const [state, setState] = useState({ actions: null, problem: null });
  useEffect(() => {
    if (!logbook || !run) return;
    const controller = new AbortController();
    fetch(`/api/actions/${encodeURIComponent(run)}?logbook=${encodeURIComponent(logbook)}`, { signal: controller.signal })
      .then(answerOf)
      .then(data => setState({ actions: data.actions, problem: null }))
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ actions: previous.actions, problem: problemOf(error) })); });
    return () => controller.abort();
  }, [logbook, run, at]);
  return state;
}

const line = action => `${action.tool} ${action.kind}${action.target ? ` ${action.target}` : ""}`;
const NEXT = { failed: "The chief decides the next run for this step. The board never starts or stops a run.", running: "Nothing.", flagged: "Ask the chief to look, or wait. The board never stops a run.", done: "Nothing. Its report is below.", queued: "Nothing. It starts when an agent slot is free." };

function facts(run, live, kept) {
  const flag = run.status === "running" ? live?.flag ?? null : null;
  if (run.status === "failed") return { tone: "red", what: runWord("failed").text, why: run.failure?.text ?? live?.why ?? "No reason recorded.", next: NEXT.failed };
  if (run.status === "queued") return { tone: "", what: runWord("queued").text, why: run.place ? `It is number ${run.place} in the queue for an agent slot.` : "It waits for an agent slot.", next: NEXT.queued };
  if (run.status === "running" && flag) return { tone: flag.level, what: flag.text, why: live?.why ?? "", next: flag.level === "calm" ? "Nothing. The report shows here when the run ends." : NEXT.flagged };
  if (run.status === "running") return { tone: "work", what: "At work, no flag", why: "", next: NEXT.running };
  return { tone: "done", what: runWord(run.status).text, why: kept?.result ? `It ended with a report: ${kept.result}` : run.report ? "It ended with a report." : "It ended with no report in the logbook.", next: NEXT.done };
}

export function RunPage({ taskKey, runId, all }) {
  const at = all?.at, { data: task, problem } = useTask(taskKey, at);
  const logbook = taskKey.slice(0, taskKey.lastIndexOf("/")), run = task?.runs.find(item => item.id === runId) ?? null;
  const { actions, problem: unread } = useActions(run ? logbook : null, runId, at);
  const live = all?.agents.flatMap(book => book.runs).find(item => item.id === runId && item.task.key === taskKey) ?? null;
  if (!task) return <div className="lv"><p className="kind">Run</p><h1>{problem === "gone" ? "This task is not on the board" : problem ? "The board cannot read this run now" : "Reading the run"}</h1>
    {problem && problem !== "gone" && <p className="lv-note bad" role="alert" data-part="failure">{problem === "read" ? "It tries again when the logbook changes." : problem}</p>}
    {!problem && <section className="lv-part" aria-busy="true"><i className="skel w6" /><i className="skel" /><i className="skel w4" /></section>}</div>;
  if (!runId) return <div className="lv"><p className="kind">Run</p><h1>The link names no run</h1><p className="sub">Open the task and pick one of its runs. <a href={taskLink(task.key)}>Open the task</a></p></div>;
  const unreadRuns = all?.projects.find(item => item.key === all.tasks.find(row => row.key === taskKey)?.project)?.unread?.some(book => book.tables.includes("runs"));
  if (!run && unreadRuns) return <div className="lv"><p className="kind">Run</p><h1>The board cannot read this run now</h1><p className="lv-note bad" role="alert" data-part="failure">The board cannot read the runs table of this logbook, so it cannot show {runId}. Ask the chief to repair the logbook. <a href={taskLink(task.key)}>Open the task</a></p></div>;
  if (!run) return <div className="lv"><p className="kind">Run</p><h1>This run is not in the logbook</h1><p className="sub">{task.title} has no run {runId}. <a href={taskLink(task.key)}>Open the task</a></p></div>;
  const atWork = run.status === "running" && run.flag?.level !== "red", stopped = run.status === "failed" || run.status === "running" && !atWork;
  const kept = task.files.kept.find(item => item.run === run.id), said = facts(run, live, kept), now = Date.parse(task.at) || Date.now();
  const last = actions?.at(-1);
  return (
    <div className="lv" data-level="run">
      <p className="kind">Run</p>
      <h1>{run.role}<span className="id">{run.id}</span></h1>
      <p className="sub">Of <a href={taskLink(task.key)}>{controlsShown(task.title)}</a> · {run.status === "queued" ? `queued ${clock(run.started, task.at)}` : run.ended ? `ended ${clock(run.ended, task.at)}, after ${age(run, now)}` : `started ${clock(run.started, task.at)}, ${span(now - Date.parse(run.started))} ago`}</p>
      {problem && <p className="lv-note" role="status">{problem === "read" ? "The page could not refresh. It shows what it read last." : problem}</p>}
      <section className={`lv-facts ${said.tone}`} data-part="facts">
        <p className="lbl2">What happened</p>
        <p className="big2">{said.what}</p>
        {said.why && <p>{controlsShown(said.why)}</p>}
        {run.status === "running" && <><p className="lbl2">Last note</p><p>{last ? `${clock(last.at, task.at)} ${line(last)}` : unread ? "The board cannot read the log now." : "No note yet."}</p></>}
        <p className="lbl2">What next</p>
        <p>{said.next}</p>
      </section>
      <section className="lv-part" aria-labelledby="lv-report" data-part="report">
        <h2 id="lv-report">Report</h2>
        {kept ? <p><b>STATUS</b> {controlsShown(kept.status ?? "not recorded")} · <b>RESULT</b> {controlsShown(kept.result ?? "not recorded")}</p>
          : <p className="faint">{run.report ? "The logbook keeps the report file only." : stopped ? "No report. The run stopped." : atWork ? "No report yet: the run is at work." : "No report in the logbook."}</p>}
        {run.report && <p><a href={readLink(task.key, "report", run.id)}>Open the report of {run.id}</a></p>}
      </section>
      <section className="lv-part" aria-labelledby="lv-log" data-part="log">
        <h2 id="lv-log">Log <span className="r">last lines, newest last</span></h2>
        {unread ? <p className="lv-note bad" role="alert" data-part="failure">The board cannot read this run's log now. {typeof unread === "string" ? unread : "It tries again when the logbook changes."}</p>
          : !actions ? <i className="skel w6" aria-busy="true" />
          : actions.length ? <pre className="lv-log">{actions.map(action => `${clock(action.at, task.at)} ${line(action)}`).join("\n")}{live?.look && live.why ? <span className="gap">{`\n▲ ${live.why}`}</span> : null}</pre>
          : <p className="lv-fold">{atWork ? "The log shows here when the agent writes its first note." : "This run wrote no note to the log."}</p>}
      </section>
      <section className="lv-part" aria-labelledby="lv-brief" data-part="brief">
        <h2 id="lv-brief">Brief</h2>
        {task.brief?.state === "kept" && task.brief.run === run.id && task.brief.goal && <p>Goal: {controlsShown(task.brief.goal.split("\n")[0])}</p>}
        {run.brief ? <p><a href={readLink(task.key, "brief", run.id)}>Open the brief of {run.id}</a></p> : <p className="faint">The logbook keeps no brief of this run.</p>}
      </section>
    </div>
  );
}
