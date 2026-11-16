import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DESIGN_PARTS = Object.freeze(["Title", "The problem", "After", "How it works", "What you will see", "What the agents do", "Rules", "Your choices", "Cost and plan", "Under the hood"]);
const SAMPLE_PARTS = Object.freeze(["After", "What you will see"]);
const TABS = new Set(["tab", "tablist", "tabpanel"]);
const CODE = new Set(["pre", "code", "samp"]);
const PICTURES = new Set(["svg", "img", "canvas", "figure"]);
const CONTROLS = new Set(["a", "button", "input", "select", "textarea", "label", "option", "summary"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rarr: "→" };

const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code) =>
  code[0] !== "#" ? ENTITIES[code.toLowerCase()] ?? whole : String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : +code.slice(1)));

const attributesOf = (source) => Object.fromEntries([...source.matchAll(/([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
  .map(([, name, value = ""]) => [name.toLowerCase(), decode(value.replace(/^["']|["']$/g, ""))]));

function tokens(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return [...source.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)].map(([, closing, name, attributes, text]) =>
    text !== undefined ? { text: decode(text) } : { name: name.toLowerCase(), closing: closing === "/", attributes: closing ? {} : attributesOf(attributes) });
}

function headings(list) {
  const found = [];
  for (let at = 0; at < list.length; at++) {
    const { name, closing } = list[at];
    if (closing || (name !== "h1" && name !== "h2")) continue;
    let text = "", end = at + 1;
    for (; end < list.length && !(list[end].closing && list[end].name === name); end++) text += list[end].text ?? " ";
    found.push({ level: name, at, text: text.replace(/\s+/g, " ").trim() });
  }
  return found;
}

const startsWithPart = (text, part) => text.toLowerCase().replace(/^(?:part\s*)?\d+\s*[.):·-]?\s*/, "").startsWith(part.toLowerCase());
const label = (index) => `part ${index + 1} "${DESIGN_PARTS[index]}"`;

function partPlaces(list, problems) {
  const all = headings(list), h2s = all.filter((h) => h.level === "h2");
  const title = all.find((h) => h.level === "h1");
  const places = new Array(DESIGN_PARTS.length).fill(undefined);
  if (!title) problems.push(`missing ${label(0)}: the page has no <h1> heading`);
  else places[0] = title.at;
  let cursor = title ? title.at : -1, last = title ? 0 : -1;
  for (let index = 1; index < DESIGN_PARTS.length; index++) {
    const matching = h2s.filter((h) => startsWithPart(h.text, DESIGN_PARTS[index]));
    const next = matching.find((h) => h.at > cursor);
    if (next) { places[index] = next.at; cursor = next.at; last = index; continue; }
    problems.push(matching.length
      ? `${label(index)} is out of order: its heading comes before ${label(last)}`
      : `missing ${label(index)}: no <h2> heading that starts with "${DESIGN_PARTS[index]}"`);
  }
  return places;
}

function partText(list, places, index) {
  const end = places.slice(index + 1).find((place) => place !== undefined) ?? list.length;
  return list.slice(places[index], end).map((token) => token.text ?? " ").join("");
}

const isPicture = ({ name, attributes }) => PICTURES.has(name) || attributes.role === "img" || attributes.role === "figure"
  || (Boolean(attributes["aria-label"]?.trim()) && !CONTROLS.has(name));

export function designPageProblems(html) {
  const list = tokens(html), problems = [];
  const places = partPlaces(list, problems);
  const hood = places.at(-1) ?? list.length;
  const above = new Set(), say = (key, text) => { if (!above.has(key)) { above.add(key); problems.push(text); } };
  let diagrams = 0, inPicture = 0;
  for (const token of list.slice(0, hood)) {
    if (token.text !== undefined) continue;
    const { name, closing, attributes } = token;
    if (name === "pre" && inPicture) { inPicture += closing ? -1 : 1; continue; }
    if (closing) continue;
    if (isPicture(token)) { diagrams++; if (name === "pre") { inPicture = 1; continue; } }
    if (inPicture) continue;
    const role = attributes.role?.toLowerCase();
    if (TABS.has(role)) say("tab", `a tab (role="${role}") is above "Under the hood": show every part on one scrolling page, with no tabs`);
    if (name === "details") say("details", `a <details> block is above "Under the hood": show its content open, with no click`);
    if ("hidden" in attributes || /display\s*:\s*none/i.test(attributes.style ?? "")) say("hidden", `a hidden element is above "Under the hood": show every part with no click and no switch`);
    if (CODE.has(name)) say(`code-${name}`, `<${name}> is above "Under the hood": move code and command output to part 10, "Under the hood"`);
  }
  if (!diagrams) problems.push(`no diagram: draw at least one state chart, architecture diagram or flow chart, as <svg>, <img> or <figure>, or as an element with role="img" and an aria-label`);
  for (const part of SAMPLE_PARTS) {
    const index = DESIGN_PARTS.indexOf(part);
    if (places[index] !== undefined && !/\bsample\b/i.test(partText(list, places, index))) problems.push(`${label(index)} does not say "sample": label its invented data as sample`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const page = process.argv[2];
  if (!page) { console.error("usage: node design-page.mjs <page.html>"); process.exit(2); }
  let html;
  try { html = readFileSync(page, "utf8"); } catch (error) { console.error(`✗ ${page}: cannot read it (${error.code ?? error.message})`); process.exit(2); }
  const problems = designPageProblems(html);
  if (!problems.length) { console.log(`✓ ${page}: the design page has the ten parts in order, a diagram, no hidden content and no code above "Under the hood", and labelled sample data`); process.exit(0); }
  console.log(`✗ ${page}: ${problems.length} problem${problems.length === 1 ? "" : "s"} with the design format (core/references/design-format.md):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
