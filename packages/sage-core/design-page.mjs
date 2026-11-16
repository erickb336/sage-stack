import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DESIGN_PARTS = Object.freeze(["Title", "The problem", "After", "How it works", "What you will see", "What the agents do", "Rules", "Your choices", "Cost and plan", "Under the hood"]);
const SAMPLE_PARTS = Object.freeze(["After", "What you will see"]);
const PRIOR_ART_PART = "How it works";
const FETCHED = /^https?:\/\/[^\s/]/;
const TABS = new Set(["tab", "tablist", "tabpanel"]);
const CODE = new Set(["pre", "code", "samp"]);
const SWITCHES = new Set(["button", "input", "select", "textarea"]);
const SWITCH_ROLES = new Set(["button", "switch", "radio", "checkbox"]);
const SWITCH_ATTRIBUTES = ["aria-pressed", "aria-expanded", "aria-controls", "aria-selected"];
const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "data"];
const EVENTS = new Set(`abort afterprint afterscriptexecute animationcancel animationend animationiteration animationstart auxclick beforecopy beforecut
  beforeinput beforematch beforepaste beforeprint beforescriptexecute beforetoggle beforeunload begin blur cancel canplay canplaythrough change click
  close command contextlost contextmenu contextrestored copy cuechange cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop
  durationchange emptied end ended error focus focusin focusout formdata fullscreenchange fullscreenerror gotpointercapture hashchange input invalid
  keydown keypress keyup languagechange load loadeddata loadedmetadata loadend loadstart lostpointercapture message messageerror mousedown mouseenter
  mouseleave mousemove mouseout mouseover mouseup mousewheel offline online pagehide pagereveal pageshow pageswap paste pause play playing
  pointercancel pointerdown pointerenter pointerleave pointermove pointerout pointerover pointerrawupdate pointerup popstate progress ratechange
  readystatechange rejectionhandled repeat reset resize scroll scrollend search securitypolicyviolation seeked seeking select selectionchange
  selectstart show slotchange stalled storage submit suspend timeupdate toggle touchcancel touchend touchmove touchstart transitioncancel
  transitionend transitionrun transitionstart unhandledrejection unload visibilitychange volumechange waiting webkitanimationend
  webkitanimationiteration webkitanimationstart webkittransitionend wheel zoom`.split(/\s+/));
const ATTRIBUTES = `((?:=\\s*"[^"]*"|=\\s*'[^']*'|=(?!\\s*["'])|[^>=])*)`;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rarr: "→" };

const character = (point) => point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code) =>
  code[0] !== "#" ? ENTITIES[code.toLowerCase()] ?? whole : character(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : +code.slice(1)));

const attributesOf = (source) => Object.fromEntries([...source.matchAll(/([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
  .map(([, name, value = ""]) => [name.toLowerCase(), decode(value.replace(/^["']|["']$/g, ""))]));

function tokens(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(new RegExp(`<(script|style)\\b${ATTRIBUTES}>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), "<$1$2></$1>");
  return [...source.matchAll(new RegExp(`<(\\/?)([a-zA-Z][\\w-]*)${ATTRIBUTES}>|([^<]+)`, "g"))].map(([, closing, name, attributes, text]) =>
    text !== undefined ? { text: decode(text) }
      : { name: name.toLowerCase(), closing: closing === "/", selfClosing: /(?:^|[\s"'])\/\s*$/.test(attributes), attributes: closing ? {} : attributesOf(attributes) });
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

const rolesOf = ({ attributes }) => (attributes.role ?? "").toLowerCase().split(/\s+/).filter(Boolean);

function switchOf({ name, attributes }, roles) {
  if (name === "input" && attributes.type?.toLowerCase() === "hidden") return undefined;
  if (SWITCHES.has(name)) return name === "input" ? `<input type="${attributes.type || "text"}">` : `<${name}>`;
  if (name === "label" && "for" in attributes) return "<label for>";
  const role = roles.find((word) => SWITCH_ROLES.has(word));
  return role ? `role="${role}"` : SWITCH_ATTRIBUTES.find((attribute) => attribute in attributes);
}

function scriptOf({ name, attributes = {} }) {
  if (name === "script") return "<script>";
  const handler = Object.keys(attributes).find((attribute) => attribute.startsWith("on") && EVENTS.has(attribute.slice(2)));
  if (handler) return handler;
  if (URL_ATTRIBUTES.some((attribute) => /^javascript:/i.test((attributes[attribute] ?? "").replace(/[\s\0-\x1f]/g, "")))) return "a javascript: URL";
}

function outline(list) {
  const close = [], open = {}, ids = new Map(), elements = [0], words = [0], boxes = [0];
  list.forEach((token, at) => {
    const { name, closing, selfClosing, text, attributes } = token, element = text === undefined && !closing;
    elements.push(elements[at] + element);
    words.push(words[at] + Boolean(text?.trim()));
    boxes.push(boxes[at] + (element && name === "div"));
    if (!element) { if (closing) { const opened = open[name]?.pop(); if (opened !== undefined) close[opened] = at; } return; }
    if (attributes.id && !ids.has(attributes.id)) ids.set(attributes.id, at);
    if (!selfClosing) (open[name] ??= []).push(at);
  });
  const content = (at) => {
    const end = close[at];
    if (end === undefined) return { end: at, elements: 0, text: false, boxes: 0 };
    return { end, elements: elements[end] - elements[at + 1], text: words[end] > words[at + 1], boxes: boxes[end] - boxes[at + 1] };
  };
  return { content, ids };
}

function named({ attributes }, { content, ids }) {
  if (attributes["aria-label"]?.trim()) return true;
  return (attributes["aria-labelledby"] ?? "").split(/\s+/).some((id) => ids.has(id) && content(ids.get(id)).text);
}

function isPicture(list, at, roles, page) {
  const token = list[at], { name, attributes } = token;
  if (name === "svg") return page.content(at).elements > 0;
  if (roles.includes("img") && named(token, page)) return true;
  if (name === "img") return Boolean(attributes.alt?.trim());
  if (name === "figure") { const { elements, text } = page.content(at); return elements > 0 || text; }
  return name === "div" && !roles.length && named(token, page) && page.content(at).boxes > 0;
}

export function designPageProblems(html) {
  const list = tokens(html), problems = [], page = outline(list);
  const places = partPlaces(list, problems);
  const hood = places.at(-1) ?? list.length;
  const above = new Set(), say = (key, text) => { if (!above.has(key)) { above.add(key); problems.push(text); } };
  const script = list.map(scriptOf).find(Boolean);
  if (script) problems.push(`the page has a script (${script}): show every part and every state in plain HTML, with no script`);
  let diagrams = 0;
  for (let at = 0; at < hood; at++) {
    const token = list[at];
    if (token.text !== undefined || token.closing) continue;
    const { name, attributes } = token, roles = rolesOf(token);
    if (isPicture(list, at, roles, page)) {
      diagrams++;
      if (CODE.has(name)) { at = page.content(at).end; continue; }
    }
    const tab = roles.find((role) => TABS.has(role)), control = switchOf(token, roles);
    if (tab) say("tab", `a tab (role="${tab}") is above "Under the hood": show every part on one scrolling page, with no tabs`);
    else if (control) say("switch", `a switch (${control}) is above "Under the hood": show each state side by side, with no button and no switch`);
    if (name === "details") say("details", `a <details> block is above "Under the hood": show its content open, with no click`);
    if (name === "template" || (name === "dialog" && !("open" in attributes)) || "hidden" in attributes
      || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes.style ?? "")) say("hidden", `a hidden element is above "Under the hood": show every part with no click and no switch`);
    if (CODE.has(name)) say(`code-${name}`, `<${name}> is above "Under the hood": move code and command output to part 10, "Under the hood"`);
  }
  if (!diagrams) problems.push(`no diagram: draw at least one state chart, architecture diagram or flow chart, as an <svg>, an <img> with alt text, a <figure>, an element with role="img" and a name (aria-label or aria-labelledby), or a <div> of <div> boxes with a name`);
  for (const part of SAMPLE_PARTS) {
    const index = DESIGN_PARTS.indexOf(part);
    if (places[index] !== undefined && !/\bsamples?\b/i.test(partText(list, places, index))) problems.push(`${label(index)} does not say "sample": label its invented data as sample`);
  }
  const how = DESIGN_PARTS.indexOf(PRIOR_ART_PART);
  if (places[how] !== undefined) {
    const end = places.slice(how + 1).find((place) => place !== undefined) ?? list.length;
    const links = new Set(list.slice(places[how], end).filter((token) => token.name === "a" && !token.closing)
      .map((token) => (token.attributes.href ?? "").trim().toLowerCase()).filter((href) => FETCHED.test(href)));
    if (links.size < 2) problems.push(`${label(how)} links to ${links.size} source${links.size === 1 ? "" : "s"} of its prior art: link at least 2 pages that you read, each in an <a href> with an http or https address`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const page = process.argv[2];
  if (!page) { console.error("usage: node design-page.mjs <page.html>"); process.exit(2); }
  let html;
  try { html = readFileSync(page, "utf8"); } catch (error) { console.error(`✗ ${page}: cannot read it (${error.code ?? error.message})`); process.exit(2); }
  const problems = designPageProblems(html);
  if (!problems.length) { console.log(`✓ ${page}: the design page has the ten parts in order, a diagram, 2 or more prior-art links, no script, no hidden content, no switch and no code above "Under the hood", and labelled sample data`); process.exit(0); }
  console.log(`✗ ${page}: ${problems.length} problem${problems.length === 1 ? "" : "s"} with the design format (core/references/design-format.md):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
