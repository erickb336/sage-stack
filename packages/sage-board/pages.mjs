import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KEPT_FILE_MAX, PAGE_POLICY, PAGE_TYPES, REPORT_FIELDS, SWITCH_SCRIPT, fieldsOf, pageFile, pageTaskFolder, pageType } from "../sage-core/index.mjs";
import { readerUrl } from "./reader.mjs";

const SCAN = 2000, LIST = 200;
const SWITCH = `'sha256-${createHash("sha256").update(SWITCH_SCRIPT).digest("base64")}'`;
const rest = (folder = "", ancestors = "'none'") => `default-src 'none'; style-src 'unsafe-inline'; img-src data:${folder && ` ${folder}`}; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`;
const pagePolicy = (script, folder, ancestors) => `sandbox${script ? " allow-scripts" : ""}; script-src ${script || SWITCH}; ${rest(folder, ancestors)}`;
const INDEX_POLICY = `script-src 'none'; ${rest()}`;
const PICTURES = new Set(["png", "jpg", "gif", "webp", "svg"].map((type) => PAGE_TYPES[type]));
const PLAIN = "text/plain; charset=utf-8";

export const pagesRequest = (url) => typeof url === "string" && /^\/pages(?:[/?]|$)/.test(url);

const one = (request, name) => { const values = request.headersDistinct[name]; return values?.length === 1 ? values[0] : values ? null : undefined; };

function permitted(request) {
  const host = one(request, "host"), origin = one(request, "origin"), site = one(request, "sec-fetch-site"), mode = one(request, "sec-fetch-mode"), dest = one(request, "sec-fetch-dest");
  if (typeof host !== "string" || origin !== undefined && origin !== `http://${host.toLowerCase()}`) return false;
  if (site === undefined || site === "none" || site === "same-origin") return true;
  return mode === "navigate" && (dest === "iframe" || dest === "document" && one(request, "sec-fetch-user") === "?1") || mode === "no-cors" && dest === "image";
}

function parse(url) {
  if (url.length > 1024 || /[%\\?]/.test(url)) return null;
  const [logbook, task, ...parts] = url.split("/").slice(2);
  return { logbook, task, file: parts.join("/") || null };
}

function ownScript(page) {
  const html = page.replaceAll(`<script>${SWITCH_SCRIPT}</script>`, "");
  if (/<script\b/i.test(html)) return true;
  const tag = /<[a-z]/gi, next = /["'<>]|[\s/]on[a-z]+\s*=/gi;
  while (tag.exec(html)) {
    next.lastIndex = tag.lastIndex;
    for (let m; (m = next.exec(html));) {
      if (m[0].length > 1) return true;
      const end = m[0] === "<" || m[0] === ">" ? -1 : html.indexOf(m[0], next.lastIndex);
      if (end < 0) { tag.lastIndex = m.index; break; }
      next.lastIndex = end + 1;
    }
    if (!next.lastIndex) return false;
  }
  return false;
}

const OWN_TAG = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`;
const switchOnly = (bytes) => {
  const text = bytes.toString("latin1");
  return text.includes(SWITCH_SCRIPT) && !/^(?:\xfe\xff|\xff\xfe)/.test(text) && !/http-equiv|srcdoc/i.test(text.replaceAll(OWN_TAG, ""));
};

export function listPages(folder) {
  const pages = [];
  let seen = 0, more = false;
  for (const queue = [""]; queue.length && !more;) {
    const dir = queue.shift();
    let entries;
    try { entries = readdirSync(join(folder, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const entry of entries) {
      if (++seen > SCAN || pages.length === LIST) { more = true; break; }
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && pageType(`${name}/x.txt`)) queue.push(name);
      else if (entry.isFile()) { const page = pageFile(folder, name); if (page) pages.push({ name, size: page.size }); }
    }
  }
  return { pages, more };
}

const sizeText = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function indexHtml(logbook, task, folder, read) {
  const { pages, more } = listPages(folder);
  const base = `/pages/${logbook}/${task}/`;
  const rows = pages.map((page) => `<li><a href="${read(page.name) ?? base + page.name}">${page.name}</a> <span class="m">${sizeText(page.size)}</span></li>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pages of ${task}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:22px 20px 48px}h1{font-size:22px;margin:4px 0 8px}.m{color:#595959;font-size:13px}@media (prefers-color-scheme:dark){.m{color:#b3b3b3}}li{margin:4px 0;overflow-wrap:anywhere}.w{border-left:3px solid #c99a00;padding:4px 10px;margin:8px 0}</style></head>
<body><main><h1>Pages of ${task}</h1><p class="m">Logbook ${logbook} · read-only, on this Mac only</p>
<p class="w" role="note"><strong>Warning:</strong> a page may link to sites outside this Mac. When you click such a link, your browser opens that site, and the site gets everything in the link's address.</p>
${pages.length ? `<ul>${rows}</ul>` : "<p>This task has no pages yet.</p>"}
${more ? `<p class="m">The list stops at ${pages.length} pages: the folder holds more files than the index reads.</p>` : ""}</main></body></html>\n`;
}

function frameHtml(logbook, task, file) {
  const name = file.split("/").at(-1);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title>
<style>:root{color-scheme:light dark}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}p{margin:0;padding:5px 12px;border-bottom:3px solid #c99a00}iframe{flex:1;border:0;width:100%;background:#fff}</style></head>
<body><p role="note"><strong>Warning:</strong> this page runs its own scripts in a sandbox. They cannot read the board, your files or other pages, but they can send the text of this page to another site. Only a link to another page of ${task} opens here. <a href="/pages/${logbook}/${task}/">All pages of ${task}</a></p><iframe src="${name}" sandbox="allow-scripts" title="${name}"></iframe></body></html>\n`;
}

export function servePages(request, response, { onMac, model }) {
  const send = (status, type, body, policy = pagePolicy(), alone = false) => {
    response.setHeader("Content-Security-Policy", policy);
    if (alone) response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("X-DNS-Prefetch-Control", "off");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", PICTURES.has(type) ? "cross-origin" : "same-origin");
    response.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const missing = () => send(404, PLAIN, "This page does not exist.\n");
  const target = parse(request.url);
  if (typeof one(request, "host") !== "string" || !onMac(request)) return missing();
  if (!permitted(request)) return send(403, PLAIN, "This request is not permitted.\n");
  if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("Allow", "GET, HEAD"); return send(405, PLAIN, "This method is not permitted.\n"); }
  const logbooks = new Set((model?.projects ?? []).flatMap((project) => project.books ?? []).map((key) => key.slice(key.indexOf("/") + 1)));
  if (!target || !logbooks.has(target.logbook)) return missing();
  const folder = pageTaskFolder(target.logbook, target.task);
  if (!folder) return missing();
  const onBoard = model?.tasks?.find((task) => task.id === target.task && task.project.slice(task.project.indexOf("/") + 1) === target.logbook);
  const read = (file) => onBoard && file.endsWith(".md") ? readerUrl(onBoard.key, "page", file) : null;
  if (!target.file) { try { return send(200, "text/html; charset=utf-8", indexHtml(target.logbook, target.task, folder, read), INDEX_POLICY, true); } catch { return send(503, PLAIN, "This index is unavailable.\n"); } }
  const bytes = pageFile(folder, target.file, true)?.bytes;
  if (!bytes) return missing();
  const origin = `http://${one(request, "host").toLowerCase()}`, own = `${origin}/pages/${target.logbook}/${target.task}/`;
  const type = pageType(target.file), html = type === PAGE_TYPES.html, dest = one(request, "sec-fetch-dest");
  if (dest === "document" && one(request, "sec-fetch-site") === "none" && read(target.file)) { response.setHeader("Location", read(target.file)); return send(303, PLAIN, ""); }
  if (dest === "iframe") return send(200, type, bytes, pagePolicy(html && "'unsafe-inline'", own, origin));
  if (html && dest === "document" && ownScript(bytes.toString("utf8"))) return send(200, type, frameHtml(target.logbook, target.task, target.file), `default-src 'none'; style-src 'unsafe-inline'; frame-src ${own}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, true);
  return send(200, type, bytes, pagePolicy(html && switchOnly(bytes) && SWITCH, own));
}

const NAMES_MAX = 100;
const realFolder = dir => { try { return lstatSync(dir).isDirectory(); } catch { return false; } };
const folderNames = dir => { try { return realFolder(dir) ? readdirSync(dir) : []; } catch { return []; } };
function keptReport(file) {
  try { const stat = lstatSync(file); return stat.isFile() && stat.size <= KEPT_FILE_MAX ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { return null; }
}
const RUN = /(?:^|[^a-z0-9])(r[1-9]\d*)(?![0-9])/gi;
const resultOf = data => fieldsOf(data.text, REPORT_FIELDS).find(item => item.name === "RESULT")?.rest.slice(0, 300) || null;

export function failureOf({ dir, task, run }) {
  if (run.failure) return { text: String(run.failure).slice(0, 300), from: "failure" };
  const data = dir && /^R[1-9]\d*$/.test(run.id) ? keptReport(join(dir, "kept", `${run.id}.json`)) : null, result = data?.task === task.id && data.run === run.id && typeof data.text === "string" ? resultOf(data) : null;
  if (result) return { text: result, from: "report" };
  const decision = (task.decisionRows ?? []).findLast(row => String(row.decision ?? "").startsWith(`${run.id} failed: `))?.decision.slice(`${run.id} failed: `.length);
  return decision ? { text: decision.slice(0, 300), from: "decision" } : null;
}

export function taskFiles({ dir, logbook, task, runs }) {
  const folder = pageTaskFolder(logbook, task), ids = new Set(runs.map(run => run.id));
  const { pages, more } = folder ? listPages(folder) : { pages: [], more: false };
  const kept = dir && realFolder(join(dir, "kept")) ? runs.flatMap(run => {
    const data = /^R[1-9]\d*$/.test(run.id) ? keptReport(join(dir, "kept", `${run.id}.json`)) : null;
    if (data?.task !== task || data.run !== run.id || typeof data.text !== "string") return [];
    const fields = fieldsOf(data.text, REPORT_FIELDS), field = name => fields.find(item => item.name === name)?.rest.slice(0, 300) || null;
    return [{ run: run.id, role: run.role, sha: /^[0-9a-f]{40}$/.test(data.sha) ? data.sha : null, at: typeof data.at === "string" ? data.at : null, status: field("STATUS"), result: field("RESULT") }];
  }) : [];
  const own = new RegExp(`(?:^|[^a-z0-9])${task}(?![0-9])`, "i");
  const named = sub => dir ? folderNames(join(dir, sub)).filter(name => /\.(?:json|md)$/.test(name) && (own.test(name) || [...name.matchAll(RUN)].some(match => ids.has(match[1].toUpperCase())))).sort() : [];
  const listed = names => names.slice(0, NAMES_MAX).map(name => ({ name, run: [...name.matchAll(RUN)].map(match => match[1].toUpperCase()).find(id => ids.has(id)) ?? null }));
  const briefs = named("briefs"), reports = named("reports");
  return { pages: folder ? pages : null, more, kept, briefs: listed(briefs), reports: listed(reports), unlisted: { briefs: Math.max(0, briefs.length - NAMES_MAX), reports: Math.max(0, reports.length - NAMES_MAX) } };
}
