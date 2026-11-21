import { clock } from "./agent.jsx";
import { when } from "./use-model.js";
import { sessionRow } from "../../sage-core/state-words.mjs";

const plural = (count, one) => `${count} ${count === 1 ? one : `${one}s`}`;

const BADGE = { live: " done", quiet: " need" };

export function Sessions({ chiefs, now }) {
  if (!chiefs.length) return null;
  return (
    <section className="card sessions" aria-labelledby="sessions-h">
      <div className="card-h"><h2 id="sessions-h">Sessions</h2><span className="grow" /><span className="hint">{plural(chiefs.filter(chief => chief.session === "live").length, "live session")}</span></div>
      <ul className="needs ses">{chiefs.map(chief => {
        const row = sessionRow(chief, now, clock, when);
        return (
          <li key={chief.key} data-session={chief.key} title={row.note ?? undefined}>
            <span className={`dot ${row.dot}`} aria-hidden="true" />
            <div><p className="q">{row.head}</p><p className="meta">{row.sub}</p></div>
            <span className={`badge${BADGE[row.dot] ?? ""}`}>{row.word}</span>
          </li>
        );
      })}</ul>
    </section>
  );
}
