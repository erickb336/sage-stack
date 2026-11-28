import { useEffect, useRef } from "react";

export const KEYS = [
  ["j k", "Next row, previous row"],
  ["Enter o", "Open the row"],
  ["u", "Up one level, back to your place"],
  ["1 2 3", "Answer the selected question with that choice. A design question opens its page."],
  ["g then i", "What needs you, on All projects"],
  ["g then p", "The list of projects"],
  ["?", "This list"],
  ["Esc", "Close a menu or this list"],
];
const NEEDS = "[data-part=needs]", G_WAIT = 1500;
const typing = el => !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const shown = el => el.getClientRects().length > 0;
const rows = () => [...document.querySelectorAll(".main [data-nav]")].filter(shown);
export const rowOf = el => el?.closest?.(".main [data-nav]") ?? null;

export function selectRow(row, came = false) {
  if (!row) return;
  document.querySelectorAll(".came").forEach(el => el !== row && el.classList.remove("came"));
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
  if (came) row.classList.add("came");
}
const openRow = row => (row.matches("a, button") ? row : row.querySelector("[data-open]"))?.click();

export function goNeeds() {
  if (location.hash.replace(/^#/, "")) {
    location.hash = "";
    history.replaceState({ to: NEEDS }, "");
  } else selectNeeds();
}
export const selectNeeds = () => {
  const part = document.querySelector(NEEDS);
  if (!part) return;
  part.scrollIntoView({ block: "nearest" });
  selectRow(part.querySelector("[data-nav]"));
};
const openProjects = () => [...document.querySelectorAll("[data-menu=projects], header button.picker")].find(shown)?.click();

export function Keys({ up }) {
  const list = useRef(null), now = useRef({ up, g: 0 });
  now.current.up = up;
  useEffect(() => {
    const press = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || event.target.closest?.("[role=menu], dialog")) return;
      const { key } = event, g = Date.now() - now.current.g < G_WAIT, row = rowOf(document.activeElement);
      now.current.g = key === "g" && !g ? Date.now() : 0;
      if (g && key === "i") return goNeeds();
      if (g && key === "p") return openProjects();
      if (key === "?") return list.current.showModal();
      if (key === "j" || key === "k") {
        const all = rows(), i = all.indexOf(row);
        return selectRow(all[i < 0 ? (key === "j" ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, i + (key === "j" ? 1 : -1)))]);
      }
      if (key === "u" && now.current.up) { location.hash = now.current.up; return; }
      if (!row) return;
      if (key === "o" || (key === "Enter" && !document.activeElement.matches("a, button"))) { event.preventDefault(); return openRow(row); }
      if (/^[1-3]$/.test(key)) {
        const option = row.querySelector(`[data-option="${key}"]`);
        if (option) option.click();
        else if (row.dataset.design !== undefined) openRow(row);
      }
    };
    addEventListener("keydown", press);
    return () => removeEventListener("keydown", press);
  }, []);
  return <>
    <button type="button" className="keyhint" onClick={() => list.current.showModal()} aria-haspopup="dialog">? Keys</button>
    <dialog className="keys" ref={list} aria-labelledby="keys-h" onClick={event => event.target === list.current && list.current.close()}><div>
      <h2 id="keys-h">Keys</h2>
      <p className="faint">They work when no text field has the focus.</p>
      <dl>{KEYS.map(([keys, what]) => <div key={keys}><dt>{keys.split(" ").map(one => one === "then" ? " then " : <kbd key={one}>{one}</kbd>)}</dt><dd>{what}</dd></div>)}</dl>
      <button type="button" className="btn" onClick={() => list.current.close()}>Close</button>
    </div></dialog>
  </>;
}
