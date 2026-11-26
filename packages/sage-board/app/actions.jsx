import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PROJECT, answerOf, problemOf, when } from "./use-model.js";
import { DESIGN_OPTIONS, SCRIPT_PAGE_NOTE, UNKNOWN, WORDS_MAX, answerOption, chiefName, runWord } from "../../sage-core/state-words.mjs";
import { RestoreButton, day } from "./archive.jsx";
import { chiefState, chiefSub, encodeKey, questionLink, taskLink } from "./task.jsx";
import { othersLine, projectHref } from "./projects.jsx";

const TOKEN_KEY = "board-token";
const stored = { get: () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } }, set: value => { try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch {} } };
const on = document.querySelector('meta[name="sage-writes"]')?.content === "on";
const PAIR_COMMAND = document.querySelector('meta[name="sage-pair"]')?.content ?? "";
const access = { writes: !on ? "off" : stored.get() ? "paired" : "unpaired" };
const listeners = new Set();
const useShared = (set, read) => useSyncExternalStore(fn => { set.add(fn); return () => set.delete(fn); }, read);
const setAccess = writes => { access.writes = writes; listeners.forEach(fn => fn()); };
addEventListener("storage", event => { if (on && (event.key === TOKEN_KEY || event.key === null)) setAccess(stored.get() ? "paired" : "unpaired"); });
export let linkProject = null;
let linkNote = { outcome: null };
const noteListeners = new Set();
const setNote = (outcome, detail) => { linkNote = { outcome, detail }; noteListeners.forEach(fn => fn()); };
function readLink() {
  const [, link, project] = /^#pair=([\w-]{1,64})(?:&project=([^&]*))?$/.exec(location.hash) ?? [];
  if (!link) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${PROJECT.test(project ?? "") ? `#?project=${project}` : ""}`);
  linkProject = PROJECT.test(project ?? "") ? project : null;
  if (!on) return;
  setNote("loading");
  post("pair", { link }).then(({ json, text }) => {
    if (json.token) { stored.set(json.token); setAccess("paired"); }
    setNote(json.outcome ?? "error", json.at ?? text);
  });
}
readLink();
addEventListener("hashchange", readLink);
const VIA = { board: "on the board", chat: "in the chat", "claude-card": "on a Claude card", "codex-card": "on a Codex card" };
const clock = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "an unknown time";
const clocks = text => String(text).replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z\b/g, clock);
export const chiefOf = (chiefs, logbook, id) => chiefs.find(chief => chief.logbook === logbook && chief.id === id) ?? null;
export const chiefLabel = (chiefs, logbook, id) => { const chief = chiefOf(chiefs, logbook, id); return chief ? `${chiefName(chief.id, chief.provider)} · ${chiefSub(chief)}` : id ?? "the chief"; };

export const useAccess = () => useShared(listeners, () => access.writes);

export async function post(path, body) {
  try {
    const token = stored.get(), response = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sage-Token": token }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (path !== "pair" && (response.status === 401 || response.status === 403 && json.problem)) {
      if (response.status === 403 && stored.get() === token) stored.set("");
      setAccess(response.status === 403 && stored.get() ? "paired" : "unpaired");
    }
    return { ok: response.ok && json.ok !== false, text: clocks(json.text ?? json.problem ?? (response.ok ? "" : `The board refused the write (${response.status}).`)), json };
  } catch { return { ok: false, text: "The board lost its connection to its server on this Mac, so it cannot say whether the write landed. Reload the board to see it before you try again.", json: { pending: true } }; }
}

const NEW_LINK = "To pair this browser: type show board in a chief's chat, and click the new link.";
const NOTES = {
  loading: ["note", "Pairing this browser…"],
  paired: ["done", "This browser is paired. You can now answer questions and send from the board. The link is used up."],
  already: ["note", "This browser is paired already. Nothing changed. The link no longer pairs any browser."],
  used: ["refused", at => `Another browser on this Mac used this link at ${clock(at)}. This browser still reads only. ${NEW_LINK}`],
  replaced: ["refused", () => `A newer link replaced this one. ${NEW_LINK}`],
  expired: ["refused", at => `This link expired at ${clock(at)}: a link works for 10 minutes. ${NEW_LINK}`],
  refused: ["refused", () => `The board does not know this link: it is not a link of this board, or it is older than the board's last 8 links. ${NEW_LINK}`],
  error: ["refused", text => `The board could not pair this browser: ${text}`],
};
export function PairNote() {
  const [unpaired, setUnpaired] = useState(null), { outcome, detail } = useShared(noteListeners, () => linkNote);
  if (!outcome) return null;
  const [kind, text] = NOTES[outcome] ?? NOTES.error;
  const unpair = async () => { const result = await post("unpair", {}); if (result.ok) { stored.set(""); setAccess("unpaired"); } setUnpaired(result); };
  return (
    <div className={`card pair-note ${kind}`} role="status">
      <p>{typeof text === "function" ? text(detail) : text} <button type="button" className="btn" onClick={() => setNote(null)}>Close</button></p>
      {kind === "refused" && outcome !== "error" && <p>Not you? <button type="button" className="btn" disabled={unpaired?.ok} onClick={unpair}>Unpair every browser</button> Every browser then reads only, until you pair it again.</p>}
      {unpaired && <p className={unpaired.ok ? "done" : "refused"} role="alert">{unpaired.text}</p>}
    </div>
  );
}

export function CopyCommand({ text }) {
  const [copied, setCopied] = useState(null);
  const copy = () => Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => setCopied(true), () => setCopied(false));
  return <>
    <div className="pair-cmd"><code>{text}</code><button type="button" className="btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
    {copied === false && <p className="refused" role="alert">This browser did not let the board copy. Select the text and copy it.</p>}
  </>;
}

export function PairBox({ id = "pair-h" }) {
  const writes = useAccess(), [code, setCode] = useState(""), [problem, setProblem] = useState(null);
  if (writes === "paired") return null;
  if (writes === "off") return <p className="note">This board only reads. Answer in the chief's chat.</p>;
  const pair = async event => {
    event.preventDefault();
    const result = await post("pair", { code });
    if (result.json.token) { stored.set(result.json.token); setAccess("paired"); }
    else setProblem(result.text);
  };
  return (
    <form className="card pair" onSubmit={pair} aria-labelledby={id}>
      <h2 id={id}>Pair this browser to act from the board</h2>
      <p className="hint">You do this once for each browser. Until then, the board only reads. Type show board in a chief's chat, and click the link that it sends: one click opens the board and pairs this browser.</p>
      <div className="pair-step">
        <p className="lbl">No chat open? Pair with a Terminal code</p>
        <CopyCommand text={PAIR_COMMAND} />
        <p className="hint">Run this command in Terminal on this Mac. It prints a one-time code.</p>
      </div>
      <label>Pairing code <input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck="false" placeholder="ABCD-EFGH" /></label>
      <button type="submit" className="btn primary" disabled={!code.trim()}>Pair</button>
      {problem && <p className="refused" role="alert">{problem}</p>}
    </form>
  );
}

const stop = { at: null, listeners: new Set() };
export const useStopped = () => useShared(stop.listeners, () => stop.at);
const AGAIN = "To open it again, type show board in a chief's chat.";
export function StopBoard() {
  const writes = useAccess(), [asking, setAsking] = useState(false), [said, setSaid] = useState(null), cancel = useRef(null), opener = useRef(null);
  useEffect(() => {
    if (!asking) return;
    cancel.current?.focus();
    const key = event => { if (event.key === "Escape") setAsking(false); };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); opener.current?.focus(); };
  }, [asking]);
  if (writes !== "paired") return <p>Ask the chief to stop the board.</p>;
  const send = async () => {
    const result = await post("stop", {});
    setSaid(result); setAsking(false);
    if (result.ok) { stop.at = new Date().toISOString(); stop.listeners.forEach(fn => fn()); }
  };
  return <>
    <button type="button" className="btn" ref={opener} onClick={() => setAsking(true)}>Stop the board</button>
    {said && !said.ok && <p className="refused" role="alert">{said.text}</p>}
    {asking && <div className="scrim"><div className="card stop-ask" role="dialog" aria-modal="true" aria-labelledby="stop-h">
      <h2 id="stop-h">Stop the board?</h2>
      <p>The board stops on this Mac for every browser. The chiefs and their agents keep working. {AGAIN}</p>
      <p className="row-btns"><button type="button" className="btn" ref={cancel} onClick={() => setAsking(false)}>Cancel</button><button type="button" className="btn primary" onClick={send}>Stop the board</button></p>
    </div></div>}
  </>;
}
export const Stopped = ({ at }) => (
  <main className="stopped-page"><section className="card" role="status"><h1>The board stopped</h1><p>You stopped it at {clock(at)}. The chiefs and their agents keep working.</p><p>{AGAIN} You can close this tab.</p></section></main>
);

const SEEN_KEY = "board-seen", AWAY_MS = 5 * 60_000;
const keep = (name, value) => { try { if (value !== undefined) window[name].setItem(SEEN_KEY, value); return window[name].getItem(SEEN_KEY); } catch { return null; } };
const time = value => Number.isFinite(Date.parse(value)) ? value : "", session = keep("sessionStorage");
const seen = { previous: time(session ?? keep("localStorage")), listeners: new Set() };
keep("sessionStorage", seen.previous);
let away = null, timer;
addEventListener("pagehide", () => keep("localStorage", new Date().toISOString()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { const at = new Date().toISOString(); timer = setTimeout(() => { away = keep("localStorage", at); }, AWAY_MS); return; }
  clearTimeout(timer);
  if (away) { seen.previous = keep("sessionStorage", away); away = null; seen.listeners.forEach(fn => fn()); }
});
export const useSeen = () => useShared(seen.listeners, () => seen.previous || null);
export const markSeen = () => { seen.previous = keep("sessionStorage", new Date().toISOString()); keep("localStorage", seen.previous); seen.listeners.forEach(fn => fn()); };

const dot = chief => chief.stopped ? "stopped" : chief.waitsForOwner ? "waits" : chief.session ?? "unknown";
const STATE = { live: chiefState("live"), quiet: chiefState("quiet"), stopped: chiefState("stopped"), waits: chiefState("waits"), unknown: UNKNOWN };

function ChiefMenu({ chief, onFilter, close }) {
  const [name, setName] = useState(chief.named ? chief.name.replace(new RegExp(` · ${chief.id}$`), "") : ""), [said, setSaid] = useState(null);
  const writes = useAccess();
  const save = async event => {
    event.preventDefault();
    const result = await post("name", { logbook: chief.logbook, chief: chief.id, name });
    setSaid(result);
  };
  return (
    <div className="menu" role="dialog" aria-label={chiefName(chief.id, chief.provider)}>
      <p className="menu-h"><span className={`dot ${dot(chief)}`} aria-hidden="true" />{chiefName(chief.id, chief.provider)}<span className="grow" />{STATE[dot(chief)]}</p>
      <dl className="facts">
        <dt>Started</dt><dd>{chief.startedAt ? when(chief.startedAt) : UNKNOWN}</dd>
        <dt>Last event</dt><dd>{chief.heartbeat ? clock(chief.heartbeat) : UNKNOWN}</dd>
        <dt>Agents</dt><dd>{chief.agents} {runWord("running").text}</dd>
        <dt>Autopilot</dt><dd>{chief.autopilot === null ? UNKNOWN : chief.autopilot ? "on" : "off"} · you switch it in the chief's chat</dd>
      </dl>
      {writes === "paired" ? (
        <form onSubmit={save} className="rename">
          <label>Name <input value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder="Empty: the default name" /></label>
          <button type="submit" className="btn">Rename</button>
          {said && <p className={said.ok ? "done" : "refused"} role="status">{said.text}</p>}
        </form>
      ) : <p className="hint">Pair this browser to rename the chief.</p>}
      <button type="button" className="btn" onClick={() => { onFilter(chief.key); close(); }}>Show only {chief.id}'s work</button>
    </div>
  );
}

export function ChiefChips({ chiefs, filter, setFilter }) {
  const [open, setOpen] = useState(null), [unfolded, setUnfolded] = useState(false);
  useEffect(() => {
    if (!open) return;
    const key = event => { if (event.key === "Escape") setOpen(null); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);
  if (!chiefs.length) return null;
  return (
    <div className={`chips${unfolded ? " unfolded" : ""}`} role="group" aria-label="Chiefs">
      <button type="button" className="chip fold" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
        {chiefs.map(chief => <span key={chief.key}><span className={`dot ${dot(chief)}`} aria-hidden="true" />{chief.id} · <span className="state">{dot(chief) === "live" && chief.autopilot !== null ? `autopilot ${chief.autopilot ? "on" : "off"}` : STATE[dot(chief)]}</span> </span>)}{unfolded ? "▴" : "▾"}
      </button>
      <button type="button" className="chip all" aria-pressed={!filter} onClick={() => setFilter(null)}>All chiefs</button>
      {chiefs.map(chief => (
        <span className="chip-wrap" key={chief.key}>
          <button type="button" className="chip" aria-pressed={filter === chief.key} data-chief={chief.key} onClick={() => setFilter(filter === chief.key ? null : chief.key)}
            title={`${STATE[dot(chief)]} · show only this chief's work`}>
            <span className={`dot ${dot(chief)}`} aria-hidden="true" /><b>{chiefName(chief.id, chief.provider)}</b> <span className="faint">{chiefSub(chief)}</span>
            <span className="state">{STATE[dot(chief)]}{dot(chief) === "live" && chief.autopilot !== null && ` · autopilot ${chief.autopilot ? "on" : "off"}`}</span>
          </button>
          <button type="button" className="chip caret" aria-expanded={open === chief.key} aria-label={`More about ${chief.id}`} onClick={() => setOpen(open === chief.key ? null : chief.key)}>▾</button>
          {open === chief.key && <ChiefMenu chief={chief} onFilter={setFilter} close={() => setOpen(null)} />}
        </span>
      ))}
    </div>
  );
}

export function GiveBox({ task, logbook, from, chiefs, close }) {
  const others = chiefs.filter(chief => chief.logbook === logbook && chief.id !== from && !chief.stopped);
  const fromProvider = chiefOf(chiefs, logbook, from)?.provider;
  const sorted = [...others].sort((a, b) => (b.provider === fromProvider) - (a.provider === fromProvider) || (b.stopped === false) - (a.stopped === false));
  const [to, setTo] = useState(sorted[0]?.id ?? null), [said, setSaid] = useState(null);
  const give = async () => setSaid(await post("give", { logbook, task: task.id, to }));
  return (
    <div className="give" role="group" aria-label={`Give ${task.id} to another chief`}>
      {sorted.length ? sorted.map((chief, i) => (
        <label key={chief.id} className="pickable">
          <input type="radio" name={`give-${task.key}`} checked={to === chief.id} onChange={() => setTo(chief.id)} />
          <span><b>{chiefName(chief.id, chief.provider)}</b> · {chiefSub(chief)}{i === 0 && <span className="badge pick">Recommended</span>}</span>
        </label>
      )) : <p className="hint">No other chief of this project is live. Start a chief, then give the task to it.</p>}
      <p className="hint">The board opens the takeover question. Nothing moves until you answer it in Needs you.</p>
      <span className="row-btns">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!to || said?.ok} onClick={give}>Open the takeover question</button>
      </span>
      {said && <p className={said.ok ? "done" : "refused"} role="status">{said.ok ? `${said.text.split(" Runs that end")[0]} Answer it in Needs you.` : said.text}</p>}
    </div>
  );
}

function Blocks({ blocks }) {
  return (blocks ?? []).map((block, i) => {
    if (block.t === "field") return <section key={i}><h3 className="lbl">{block.label}</h3><p>{block.text}</p></section>;
    if (block.t === "p") return <p key={i}>{block.text}</p>;
    if (block.t === "section") return <section key={i}><h3 className="lbl">{block.label}</h3><Blocks blocks={block.body} /></section>;
    if (block.t === "list" || block.t === "steps") return <ul key={i}>{block.items.map((item, k) => <li key={k}>{typeof item === "string" ? item : item.text}</li>)}</ul>;
    if (block.t === "code" || block.t === "picture") return <pre key={i}>{(block.lines ?? []).join("\n")}</pre>;
    if (block.t === "table") return <table key={i}><thead><tr>{block.head.map(cell => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{block.rows.map((row, k) => <tr key={k}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table>;
    return null;
  });
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isAnswers = block => block.t === "table" && same(block.head[0], "Answer");
const holdsAnswers = block => isAnswers(block) || block.t === "section" && block.body.some(holdsAnswers);
const withoutAnswers = blocks => blocks.filter(block => !isAnswers(block)).map(block => block.t === "section" ? { ...block, body: withoutAnswers(block.body) } : block);
function answerRows(message) {
  const found = { head: ["Answer", "Next", "Cost"], rows: [] };
  const walk = blocks => (blocks ?? []).forEach(block => { if (block.t === "section") walk(block.body); if (isAnswers(block)) { found.head = block.head; found.rows.push(...block.rows); } });
  walk(message?.blocks);
  return found;
}

function useGate(key, at) {
  const [state, setState] = useState({ key, gate: null, problem: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/app/gate/${encodeKey(key)}`, { signal: controller.signal })
      .then(answerOf)
      .then(gate => setState({ key, gate, problem: null }))
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ key, gate: previous.key === key ? previous.gate : null, problem: problemOf(error) })); });
    return () => controller.abort();
  }, [key, at]);
  return state.key === key ? state : { gate: null, problem: null };
}

export function Answered({ gate, chiefs }) {
  const owner = chiefLabel(chiefs, gate.logbook, gate.owner);
  if (gate.answered?.via === "board" && !gate.answer) return <>You answered {gate.id} on the board at {clock(gate.answered.at)}: <b>{gate.answered.answer}</b>. It waits for {owner} to pick it up.</>;
  if (gate.picked?.chief && gate.answered?.via === "board") return <>You answered {gate.id} on the board: <b>{gate.answer}</b>. {gate.picked.chief} picked it up at {clock(gate.picked.at)}, so it has no Undo now. To change it, tell the chief in its chat.</>;
  const where = gate.answered?.via === "chat" ? `in ${gate.owner ?? "the chief"}'s chat` : VIA[gate.answered?.via] ?? "in a place that sage did not record";
  return <>Answered first {where} at {clock(gate.answered?.at)}: <b>{gate.answer}</b>. The first answer wins; to change it, tell the chief in its chat.</>;
}

export function UndoButton({ logbook, gate, onDone }) {
  const [said, setSaid] = useState(null);
  return (
    <>
      <button type="button" className="btn" onClick={async () => { const result = await post("undo", { logbook, gate }); setSaid(result); onDone?.(result); }}>Undo</button>
      {said && !said.ok && <span className="refused" role="alert">{said.text}</span>}
    </>
  );
}

const KINDS = { design: "Design", arena: "Arena", page: "Page", prototype: "Prototype", picture: "Picture", file: "File", report: "Report", brief: "Brief" };
const SANDBOX = { reader: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", script: "allow-scripts", plain: "" };
const itemId = item => `${item.task}/${item.file ?? item.kind}`;
const shows = (item, option, i) => !!item.answer && (same(item.answer, option) || same(item.answer, String.fromCharCode(65 + i)));
const narrow = () => matchMedia("(max-width: 1279px)").matches;
const pickKey = key => `board-pick ${key}`;
const keptPick = key => { try { const n = Number(sessionStorage.getItem(pickKey(key))); return Number.isInteger(n) && sessionStorage.getItem(pickKey(key)) !== null ? n : null; } catch { return null; } };
const keepPick = (key, n) => { try { n === null ? sessionStorage.removeItem(pickKey(key)) : sessionStorage.setItem(pickKey(key), String(n)); } catch {} };
const pagesPath = gate => `/pages/${gate.logbook.slice(gate.logbook.indexOf("/") + 1)}/${gate.task.id}/`;
function itemOf(gate, id) {
  const found = gate.material.items.find(entry => itemId(entry) === id);
  if (found || !id?.startsWith(`${gate.task.id}/`)) return found ?? null;
  const file = id.slice(gate.task.id.length + 1);
  return /^[\w./-]+\.html$/.test(file) && !file.includes("..") ? { task: gate.task.id, file, kind: "prototype", frame: "script", title: file.split("/").at(-1), src: pagesPath(gate) + file, open: pagesPath(gate) + file, why: `A prototype of ${gate.task.id}, opened from a link in the material.` } : null;
}

function Viewer({ item, gate, close, open, theme }) {
  const src = item.frame === "reader" && theme === "light" ? `${item.src}&theme=light` : item.src, [moved, setMoved] = useState(null);
  const loaded = event => {
    const doc = event.target.contentDocument;
    if (!doc) return;
    const at = doc.location.pathname + doc.location.search, part = item.at && doc.getElementById(item.at);
    const back = at === src.split("#")[0];
    setMoved(back ? null : doc.querySelector("h1")?.textContent || doc.title || null);
    if (back && part) doc.scrollingElement.scrollTop += part.getBoundingClientRect().top - 8;
    doc.addEventListener("click", click => {
      const link = click.target.closest?.("a[href]"), url = link && new URL(link.getAttribute("href"), doc.location.href);
      if (!url || url.origin !== location.origin) return;
      const own = url.pathname.startsWith(pagesPath(gate)) && url.pathname.endsWith(".html");
      if (url.pathname === "/app/" && new URLSearchParams(url.hash.split("?")[1] ?? "").get("key") === gate.key) { click.preventDefault(); close(); }
      else if (own) { click.preventDefault(); open(`${gate.task.id}/${decodeURIComponent(url.pathname.slice(pagesPath(gate).length))}`); }
    }, true);
  };
  return (
    <section className="viewer" aria-label={`${KINDS[item.kind]}: ${moved ?? item.title}`}>
      <p className="viewer-h"><button type="button" className="btn" onClick={close}>‹ The question</button><span className="grow" />{item.src && <a href={item.open} target="_blank" rel="noopener noreferrer">Open in a new tab</a>}</p>
      <p className="lbl">{KINDS[item.kind]}</p><h2 id="viewer-h" tabIndex={-1}>{moved ?? item.title}</h2>
      {item.frame === "script" && <p className="frame-warn" role="note">{SCRIPT_PAGE_NOTE}</p>}
      {!item.src ? <p className="note">The board does not show this page: it has no task {item.task} in the logbook of this question.</p>
        : item.gone ? <p className="note">The file is gone from {item.task}'s pages folder.</p>
        : item.frame === "picture" ? <img src={item.src} alt={item.title} />
        : /\.pdf$/i.test(item.file ?? "") ? <p className="note">The board does not show a PDF inside the page. <a href={item.open} target="_blank" rel="noopener noreferrer">Open {item.title} in a new tab</a>.</p>
        : <iframe key={src} src={src} sandbox={SANDBOX[item.frame]} referrerPolicy="no-referrer" title={item.title} onLoad={loaded} />}
      <p className="hint">Why it is here: {moved ? `you opened it from a link in ${item.title}.` : item.why}</p>
    </section>
  );
}

function Material({ gate, open, setOpen }) {
  const { items, more, missing } = gate.material, task = gate.task.id;
  const groups = [["named", "Named", "Named in the question"], ["task", "Task pages", `In ${task}'s pages folder`], ["run", "Asking run", gate.run ? `The run that asked, ${gate.run}` : "The run that asked is not recorded"]];
  return (
    <section className="material" aria-labelledby="material-h">
      <h2 className="lbl" id="material-h">Material</h2>
      <p className="hint">{items.length ? "Open one to read it here, beside the answers." : `The question names no page, and ${task}'s pages folder has none to show.`}</p>
      {groups.map(([key, label, full]) => {
        const list = items.filter(item => item.group === key);
        return (list.length > 0 || key === "run" && missing) && (
          <div key={key}>
            <h3 className="lbl">{label}</h3><p className="hint">{full}</p>
            {key === "run" && missing && <p className="hint">The logbook names {missing} as the run that asked, but {task} has no such run.</p>}
            <ul className="mat-list">{list.map(item => (
              <li key={itemId(item)}><button type="button" className="mat" data-item={itemId(item)} aria-pressed={open === itemId(item)} onClick={() => setOpen(itemId(item))}>
                <span className="lbl">{KINDS[item.kind]}</span><b>{item.title}</b>{(item.gone || item.sub !== item.title) && <span className="faint">{item.gone && <span className="need">file gone · </span>}{item.sub !== item.title && item.sub}</span>}
              </button></li>
            ))}</ul>
          </div>
        );
      })}
      {more > 0 && <a href={taskLink(gate.task.key, "artifacts")}>All of {task}'s pages · {more} more</a>}
    </section>
  );
}

function Fits({ gate, where }) {
  return (
    <section className="fits" aria-labelledby="fits-h">
      <h2 className="lbl" id="fits-h">Where it fits</h2>
      {where && <p>{where}</p>}
      <p><span className="lbl">Task</span><a href={taskLink(gate.task.key)}>{gate.task.id} · {gate.task.title}</a></p>
    </section>
  );
}

function Next({ model, gate }) {
  const left = model.needs.filter(need => need.key !== gate.key), next = left.find(need => need.gate && need.logbook);
  if (left.length) return <p><a href={next ? questionLink(next.key) : "#"}>Needs you · {left.length} left{next && `: ${next.gate}${next.owner ? ` from ${next.owner}` : ""}`}</a></p>;
  if (!model.others.length) return <p><a href="#">Nothing else waits in {gate.project}</a></p>;
  return <p>Nothing else waits in {gate.project} · {othersLine(model.others)}: {model.others.map((project, i) => <span key={project.key}>{i > 0 && ", "}<a href={projectHref(project)}>{project.name}</a></span>)}</p>;
}

export function QuestionView({ needKey, openId, model, theme, project }) {
  const { gate, problem } = useGate(needKey, model.at), writes = useAccess(), archived = !!project?.archived;
  const [pick, setPickState] = useState(() => keptPick(needKey)), [words, setWords] = useState(""), [said, setSaid] = useState(null), [busy, setBusy] = useState(false), sending = useRef(false), closed = useRef(null), was = useRef(archived), bar = useRef(null);
  const setPick = n => { setPickState(n); keepPick(needKey, n); };
  const setOpen = id => {
    if (!id) closed.current = openId;
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    id ? params.set("open", id) : params.delete("open");
    location.hash = `question?${params}`;
  };
  useEffect(() => { document.getElementById("question-h")?.focus(); }, [needKey, !gate]);
  useEffect(() => {
    if (openId) { narrow() ? document.querySelector(".viewer")?.scrollIntoView({ block: "start" }) : scrollTo(0, 0); document.getElementById("viewer-h")?.focus({ preventScroll: true }); }
    else if (closed.current) { (document.querySelector(`[data-item="${CSS.escape(closed.current)}"]`) ?? document.getElementById("question-h"))?.focus(); closed.current = null; }
  }, [openId, !gate]);
  useEffect(() => { if (said) document.getElementById("said")?.focus({ preventScroll: true }); }, [said]);
  useEffect(() => { if (was.current && !archived) document.querySelector(".answer input")?.focus(); was.current = archived; }, [archived]);
  useEffect(() => {
    const box = bar.current, page = box?.closest(".question");
    if (!box || !page) return;
    const watch = new ResizeObserver(() => page.style.setProperty("--qbar", `${box.offsetHeight}px`));
    watch.observe(box);
    return () => { watch.disconnect(); page.style.removeProperty("--qbar"); };
  }, [openId, !gate]);
  if (!gate) return <div className="page-h"><a href="#" className="back">‹ Needs you</a><h1 id="question-h" tabIndex={-1}>{problem === "gone" ? "This question is not on the board" : problem ? "The board cannot read this question now" : "Reading the question"}</h1>{problem && !["gone", "read"].includes(problem) && <p className="none" role="alert">{problem}</p>}</div>;
  const rows = answerRows(gate.message), unanswered = !gate.answer && !gate.answered, chief = chiefOf(model.chiefs, gate.logbook, gate.owner), owner = chief ? chiefName(chief.id, chief.provider) : gate.owner ?? "the chief";
  const item = itemOf(gate, openId), ready = unanswered && writes === "paired" && !archived && !said?.ok;
  const tone = !said ? null : said.ok ? "done" : said.json?.pending ? "note" : "refused";
  const kept = archived ? `The project is archived now, so it waits until you restore it. Then ${owner} picks it up.` : `It waits for ${owner} to pick it up, at its next step.`;
  const result = !said ? null : said.ok ? (said.text.startsWith(gate.id) ? `You answered ${gate.id}: ${gate.options[pick]}. Recorded in the logbook. ${kept}` : said.text) : `${tone === "note" ? "" : "Not recorded. "}${said.text}`;
  const needsWords = gate.options[pick] === DESIGN_OPTIONS[1], cannotSend = pick === null || busy || needsWords && !words.trim();
  const send = async () => {
    if (sending.current || cannotSend) return;
    sending.current = true; setBusy(true);
    setSaid(await post("answer", { logbook: gate.logbook, gate: gate.id, option: pick + 1, digest: gate.digest, ...(needsWords && { words }) }));
    sending.current = false; setBusy(false);
  };
  const wordsField = ready && needsWords && <label className="words"><span><b>{DESIGN_OPTIONS[1]}</b>: type your words. They go with your choice, as one answer.</span>
    <textarea value={words} maxLength={WORDS_MAX} rows={3} onChange={event => setWords(event.target.value)} /></label>;
  const blocks = gate.message?.blocks ?? [], table = blocks.findIndex(holdsAnswers);
  const field = label => block => block.t === "field" && same(block.label, label);
  const where = blocks.find(field("Where"))?.text, before = withoutAnswers(blocks.slice(0, table < 0 ? blocks.length : table + 1).filter(block => !field("Where")(block))), after = table < 0 ? [] : withoutAnswers(blocks.slice(table + 1));
  const restore = writes === "paired" ? <RestoreButton project={project} primary /> : <span className="hint">Pair this browser on the Overview to restore it here, or ask the chief in the chat.</span>;
  const waiting = archived ? restore : <UndoButton logbook={gate.logbook} gate={gate.id} onDone={done => done.ok && setSaid(null)} />;
  const top = archived && unanswered && !said?.ok;
  const shelved = archived && <><p><b>{project.name} {project.archivedAt ? `was archived on ${day(project.archivedAt)}` : "is archived"}.</b> It takes no answer. Restore brings the project back where it was, and you answer here.</p>
    <p>{restore}</p></>;
  const sendBox = <div className="send" role="status">
      {said?.ok ? <><p className="done" id="said" tabIndex={-1}>{result} {waiting}</p><Next model={model} gate={gate} /></>
        : !unanswered ? <p><span><Answered gate={gate} chiefs={model.chiefs} /></span>{gate.answered?.via === "board" && !gate.answer && <>{archived && <span>{kept}</span>} {waiting}</>}</p>
        : archived ? shelved
        : writes !== "paired" ? <PairBox />
        : <p>{pick === null ? "Pick one answer." : <>Your answer: <b>{gate.options[pick]}</b></>} <span className="grow" />
            <button type="button" className="btn" onClick={() => setPick(null)}>Clear</button>
            <button type="button" className="btn primary" disabled={cannotSend} onClick={send}>Send answer</button></p>}
      {said && !said.ok && <p className={tone} role="alert" id="said" tabIndex={-1}>{result}</p>}
      {ready && <p className="hint">The first answer wins: from the board or from the chief's chat. A later answer is refused and names the first one.</p>}
    </div>;
  const form = <div className="q-form">
    <h2 className="lbl">Answers</h2>
    <div className="answers" role="radiogroup" aria-label="Answers">
      {gate.options.map((option, i) => {
        const row = rows.rows.find(item => same(item[0], option) || same(item[0].replace(/^[A-Z]\s*[·:.)-]\s*/, ""), option));
        const chosen = [gate.answer, gate.answered?.answer].some(answer => answer && answerOption(gate.options, answer) === i), drawn = gate.material.items.find(item => shows(item, option, i));
        return (
          <label key={option} className={`answer${pick === i ? " picked" : ""}${chosen ? " chosen" : ""}`}>
            <input type="radio" name="answer" disabled={!ready} checked={pick === i} onChange={() => setPick(i)} />
            <span className="what"><b>{option}</b>{gate.recommendation === option && <span className="badge pick">{gate.owner ?? "The chief"}'s pick</span>}{chosen && <span className="badge done">The answer</span>}</span>
            {(row || drawn) && <span className="more">{row?.slice(1).map((cell, k) => <span key={k}><span className="col">{rows.head[k + 1]}</span>{cell}</span>)}
              {drawn && <button type="button" className="see" onClick={event => { event.preventDefault(); setOpen(itemId(drawn)); }}>See answer {String.fromCharCode(65 + i)} in {drawn.title}</button>}</span>}
          </label>
        );
      })}
    </div>
    {wordsField}
    {!(top && !item) && sendBox}
  </div>;
  return (
    <article className={`question${item ? " reading" : ""}`} aria-labelledby="question-h">
      <div className="q-main">
        <a href="#" className="back">‹ Needs you</a>
        <p className="facts-line">{owner} · <span className="mono">{gate.id}</span> · asked {gate.at ? clock(gate.at) : "at a time not recorded"} · <a href={`/read/${encodeKey(gate.task.key)}/question/${gate.id}${theme === "light" ? "?theme=light" : ""}`}>Read the full question</a></p>
        <h1 id="question-h" tabIndex={-1}>{gate.message?.title ?? gate.text ?? gate.question}</h1>
        {gate.default && <p className="facts-line">If you do not answer: {gate.owner ?? "the chief"} takes {gate.default}.</p>}
        {top && !item && sendBox}
        {item ? <Viewer key={openId} item={item} gate={gate} close={() => setOpen(null)} open={setOpen} theme={theme} /> : <>
          {gate.message ? <div className="context"><Blocks blocks={before} /></div>
            : <p className="hint">This question has no kept message, so the board shows its question and its options only.</p>}
          {form}
          {after.length > 0 && <div className="context"><Blocks blocks={after} /></div>}
        </>}
      </div>
      <aside className="q-side">
        {item ? form : <Fits gate={gate} where={where} />}
        <Material gate={gate} open={openId} setOpen={setOpen} />
      </aside>
      {item && <div className="qbar" ref={bar}><p><button type="button" className="btn" onClick={() => setOpen(null)}>‹ Question</button><button type="button" className="btn" onClick={() => document.getElementById("material-h")?.scrollIntoView({ block: "start" })}>Material</button><span className="grow" />
        {ready && <>{gate.options.map((option, i) => <button type="button" key={option} className="btn" aria-pressed={pick === i} aria-label={option} title={option} onClick={() => setPick(i)}>{String.fromCharCode(65 + i)}</button>)}
          <button type="button" className="btn primary" disabled={cannotSend} onClick={send}>Send</button></>}</p>
        {wordsField}
        {archived && unanswered && !said ? <p className="said">{project.name} is archived: restore it to answer.</p>
          : said && <><p className={`said ${tone}`}>{result} {said.ok && waiting}</p>{said.ok && <Next model={model} gate={gate} />}</>}</div>}
    </article>
  );
}
