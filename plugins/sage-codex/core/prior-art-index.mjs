import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedRoot } from "./shared-root.mjs";

export const PRIOR_ART_FOLDER = "prior-art";
export const PRIOR_ART_COLUMNS = Object.freeze(["Name", "What they do", "What we take", "Where we differ, and why", "Link", "Read on"]);
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADDRESS = /https?:\/\/[^\s<>()|\]]+/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROWS_MAX = 64 * 1024;
const FORM = `a table row of ${PRIOR_ART_COLUMNS.length} cells: | ${PRIOR_ART_COLUMNS.join(" | ")} |, with an http or https address in Link and the date in Read on as YYYY-MM-DD`;
const USAGE = "prior-art takes no words (the index folder and its topics), <topic> (print the topic), or <topic> add --rows <the table rows>";

const cellsOf = (line) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
const linkOf = (row) => ADDRESS.exec(cellsOf(row)[4] ?? "")?.[0].replace(/[.,;:]+$/, "").toLowerCase();
const fileOf = (folder, topic) => join(folder, `${topic}.md`);
const plainFile = (path) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? readFileSync(path, "utf8") : undefined;
};

function rowProblem(line) {
  if (/\p{Cc}/u.test(line)) return "it has a control character";
  if (!line.startsWith("|") || !line.endsWith("|")) return "it does not start and end with |";
  const cells = cellsOf(line);
  if (cells.length !== PRIOR_ART_COLUMNS.length) return `it has ${cells.length} cells, not ${PRIOR_ART_COLUMNS.length}`;
  const empty = PRIOR_ART_COLUMNS.find((_, at) => !cells[at]);
  if (empty) return `its ${empty} cell is empty`;
  if (!ADDRESS.test(cells[4])) return `its Link cell has no http or https address: ${JSON.stringify(cells[4])}`;
  const date = DATE.exec(cells[5]), day = date && new Date(Date.UTC(+date[1], +date[2] - 1, +date[3]));
  if (!date || day.getUTCMonth() !== +date[2] - 1 || day.getUTCDate() !== +date[3]) return `its Read on cell is not a date YYYY-MM-DD: ${JSON.stringify(cells[5])}`;
}

const headerOrRule = (line) => {
  const cells = cellsOf(line);
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell)) || cells.join("|").toLowerCase() === PRIOR_ART_COLUMNS.join("|").toLowerCase();
};

export function priorArtCommand(pos, opt, env, refuse) {
  const [topic, verb, ...more] = pos, folder = join(sharedRoot(env), PRIOR_ART_FOLDER);
  if (more.length || (verb !== undefined && verb !== "add") || (verb === undefined && opt.rows !== undefined)) refuse(`${USAGE}. Nothing changed.`);
  if (topic !== undefined && (!TOPIC.test(topic) || topic.length > 40)) refuse(`the topic is 1 to 40 lower-case letters, digits and dashes, for example reviews or design-pages; not ${JSON.stringify(topic)}. Nothing changed.`);
  if (topic === undefined) {
    let names = [];
    try { names = readdirSync(folder).filter((name) => name.endsWith(".md") && TOPIC.test(name.slice(0, -3))).sort(); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const lines = names.map((name) => {
      const rows = (plainFile(join(folder, name)) ?? "").split("\n").filter((line) => line.startsWith("|") && !headerOrRule(line)).length;
      return `${name.slice(0, -3)} · ${rows} row${rows === 1 ? "" : "s"}`;
    });
    return [`the prior-art index: ${folder}`, ...(lines.length ? lines : ["no topics yet"])].join("\n");
  }
  const file = fileOf(folder, topic);
  if (verb === undefined) return plainFile(file)?.trimEnd() ?? `no rows for ${topic} yet: ${file}`;
  const text = opt.rows ?? refuse(`add needs --rows with the table rows, each ${FORM}. Nothing changed.`);
  if (Buffer.byteLength(text) > ROWS_MAX) refuse("--rows is at most 64 KiB. Nothing changed.");
  const rows = [], problems = [];
  text.split(/\r?\n/).forEach((raw, at) => {
    const line = raw.trim();
    if (!line || (line.startsWith("|") && line.endsWith("|") && headerOrRule(line))) return;
    const why = rowProblem(line);
    if (why) problems.push(`line ${at + 1}: ${why}`);
    else rows.push(line);
  });
  if (problems.length) refuse(`each line of --rows is ${FORM}. ${problems.join("; ")}. Nothing changed.`);
  if (!rows.length) refuse(`--rows has no row: give each row as ${FORM}. Nothing changed.`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, `# Prior art: ${topic}\n\n| ${PRIOR_ART_COLUMNS.join(" | ")} |\n|${PRIOR_ART_COLUMNS.map(() => " --- |").join("")}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const kept = plainFile(file);
  if (kept === undefined) refuse(`${file} is not a regular file, so the index cannot add to it. Ask the owner to check it. Nothing changed.`);
  const links = new Set(kept.split("\n").filter((line) => line.startsWith("|")).map(linkOf).filter(Boolean));
  const added = [], skipped = [];
  for (const row of rows) {
    const link = linkOf(row);
    if (links.has(link)) skipped.push(link);
    else { links.add(link); added.push(row); }
  }
  if (added.length) appendFileSync(file, `${added.join("\n")}\n`);
  return `prior-art ${topic}: added ${added.length} row${added.length === 1 ? "" : "s"}${skipped.length ? `; kept out ${skipped.length}, whose link is in the topic already (${skipped.join(", ")})` : ""} · ${file}`;
}
