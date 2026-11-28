import { join } from "node:path";

const COLUMNS = ["id", "provider", "native", "at"];
export const CHIEF = /^C[1-9]\d*$/;
const NATIVE = /^[A-Za-z0-9_.:-]{1,256}$/;
const TASK = /^T[1-9]\d*$/;
const TABLE_MAX = 1024 * 1024;

const READ = { kind: "read" }, ANY = { kind: "any" }, NEW = { kind: "new" }, OWNER = { kind: "owner" };
const onTask = (task) => ({ kind: "task", task });
export function writerClass(cmd, [sub, id] = []) {
  switch (cmd) {
    case "task": return sub === "add" || sub === "names" ? NEW : id === "set" ? onTask(sub) : READ;
    case "unclaim": return onTask(sub);
    case "pickup": return ANY;
    case "release": return sub === "add" ? ANY : READ;
    case "task-adopt": case "round": case "verdict": case "lint": return onTask(sub);
    case "finding": return sub === "show" ? READ : onTask(id);
    case "milestone": case "program": return id === "set" ? ANY : { kind: "milestone" };
    case "run": return sub === "add" ? onTask(id) : sub === "done" ? { kind: "task", run: id } : sub === "usage" ? ANY : READ;
    case "gate": return ["answer", "undo", "give"].includes(sub) ? OWNER : sub === "replace" ? ANY : sub === "add" ? (id === undefined ? ANY : onTask(id)) : READ;
    case "log": return id === undefined ? READ : TASK.test(sub ?? "") ? onTask(sub) : ANY;
    case "observe": return { ...ANY, task: sub };
    case "pages": return id === "record" ? { ...ANY, task: sub } : READ;
    case "standing": return sub === undefined ? READ : ANY;
    case "logbook": return sub === "repair" ? OWNER : READ;
    case "projects": return OWNER;
    case "move": return OWNER;
    case "config": return sub === undefined ? READ : id === undefined && sub.startsWith("archived=") ? OWNER : ANY;
    case "init": return ANY;
    case "chief": return sub === "name" ? OWNER : READ;
    case "storage": return sub === "clean" ? ANY : READ;
    default: return READ;
  }
}

export const chiefOnly = (cmd, [sub] = []) => ["unclaim", "pickup"].includes(cmd) || (cmd === "gate" && sub === "replace");

export function offerOf(task) {
  try {
    const offer = JSON.parse(task.offer || "null");
    return typeof offer?.id === "string" && CHIEF.test(offer.from) && CHIEF.test(offer.to) ? offer : undefined;
  } catch {
    return undefined;
  }
}

export const replaceQuestion = ({ from, to, task, pr, title, runs, label, released, moved, fresh, offered }) => {
  const what = `${task}${pr ? ` and PR ${pr}` : ""}`;
  const ask = from ? `Hand ${what} from ${label(from)} to ${label(to)}?` : `Hand ${what} to ${label(to)}? ${task} has no owning chief${released ? `: ${label(released)} unclaimed it last` : moved ? `: it came in the move from the ${moved} logbook` : ""}.`;
  const approve = [`${to} owns ${task}.`, runs.length ? "Each of those runs ends as failed, and work that it did not report may be lost." : "", from ? `${from} can no longer write ${task}.` : "",
    `The branch keeps its name${pr ? `, and PR ${pr} keeps its number` : ""}.`, fresh ? FRESH(to, "its head") : "The verdicts on its head still count."].filter(Boolean).join(" ");
  const decline = offered ? `${from} stays the owning chief, and ${OFFER_ENDS(to)}` : `nothing changes, and ${from ? `${from} stays the owning chief` : `${task} stays with no owning chief`}`;
  return `${ask} Runs that end as failed: ${runs.map((r) => `${r.id} (${r.role})`).join(", ") || "none"}. Approve: ${approve} Decline: ${decline}. Title of ${task}: ${title}`;
};
const OFFER_ENDS = (to) => `the offer to ${to} ends`;
const FRESH = (to, head) => `The verdicts stay, and ${to} runs one fresh cycle on ${head} before it merges.`;
const taskRef = (t) => `${t.id}${t.pr ? ` (PR ${t.pr})` : ""}`;
export const batchQuestion = ({ from, to, tasks, runs, label, fresh }) => {
  const n = tasks.length;
  const approve = [`${to} owns the ${n} tasks.`, runs.length ? "Each of those runs ends as failed, and work that it did not report may be lost." : "", `${from} can no longer write them.`,
    "Each branch keeps its name, and each PR keeps its number.", fresh ? FRESH(to, "each head") : "The verdicts on each head still count."].filter(Boolean).join(" ");
  return `Hand ${n} tasks from ${label(from)} to ${label(to)}? Runs that end as failed: ${runs.length || "none"}. Approve: ${approve} Decline: nothing changes, and ${from} stays the owning chief of the ${n} tasks. Ref: ${tasks.map(taskRef).join(", ")}${runs.length ? ` · runs ${runs.map((r) => `${r.id} (${r.task} ${r.role})`).join(", ")}` : ""}`;
};
export const TAKEOVER_OPTIONS = "approve|decline";
const ID = (c) => `(?<${c}>C[1-9]\\d*)(?: \\((?<${c}P>\\S+)\\))?`, RUNS = "(?<runs>none|R[1-9]\\d* \\([^)]*\\)(?:, R[1-9]\\d* \\([^)]*\\))*)";
const HAND = new RegExp(`^Hand (?<task>T[1-9]\\d*)(?: and PR [1-9]\\d*)? (?:from ${ID("from")} to ${ID("to")}\\?|to ${ID("to2")}\\? T[1-9]\\d* has no owning chief(?:: (?:${ID("rel")} (?:unclaimed|released) it last|it came in the move from the (?<moved>\\S+) logbook))?\\.) Runs that end as failed: ${RUNS}\\. Approve: (?<approve>.*?) Decline: (?<decline>[^.]*)\\. `);
const REPLACE = new RegExp(`^Replace chief ${ID("from")} of (?<task>T[1-9]\\d*) with ${ID("to")}\\? Runs that end as failed: ${RUNS}\\. Replace: `);
const REF = "T[1-9]\\d*(?: \\(PR [1-9]\\d*\\))?", BATCH_RUN = "R[1-9]\\d* \\([^)]*\\)";
const BATCH = new RegExp(`^Hand (?<n>[1-9]\\d*) tasks from ${ID("from")} to ${ID("to")}\\? Runs that end as failed: (?:none|[1-9]\\d*)\\. Approve: (?<approve>.*?) Decline: (?<decline>[^.]*)\\. Ref: (?<list>${REF}(?:, ${REF})*)(?: · runs (?<runs>${BATCH_RUN}(?:, ${BATCH_RUN})*))?`);
export function replaceOf(gate) {
  const batch = BATCH.exec(gate.question)?.groups;
  const { from = "", fromP, to, toP, to2, to2P, relP, moved, runs, approve, decline, task, list } = batch ?? (HAND.exec(gate.question) ?? REPLACE.exec(gate.question))?.groups ?? {};
  const chief = to ?? to2, tasks = list ? list.split(", ").map((t) => t.split(" ")[0]) : [task];
  if (!chief || (batch && Number(batch.n) !== tasks.length)) return undefined;
  return { from, to: chief, tasks, fromProvider: fromP ?? relP ?? moved, toProvider: toP ?? to2P, runs: !runs || runs === "none" ? [] : runs.split(", ").map((r) => r.split(" ")[0]),
    fresh: !!approve?.endsWith(FRESH(chief, batch ? "each head" : "its head")), offered: !batch && !!from && decline === `${from} stays the owning chief, and ${OFFER_ENDS(chief)}` };
}
export const crossed = (p) => (p.fromProvider || p.from ? p.fromProvider !== p.toProvider || !p.toProvider : false);

export const chiefsWhole = (cols, lines, rows) => cols.join("\t") === COLUMNS.join("\t") && lines.every((line) => line.split("\t").length === COLUMNS.length)
  && rows.every((r) => CHIEF.test(r.id) && r.provider && NATIVE.test(r.native))
  && new Set(rows.map((r) => r.id)).size === rows.length && new Set(rows.map((r) => `${r.provider}\t${r.native}`)).size === rows.length;

export function createChiefs({ now, provider, readRegular, refuse, rowsOf, sheetText, swap }) {
  function chiefs(dir) {
    const file = join(dir, "chiefs.tsv");
    const damaged = () => refuse(`${file} is damaged, so sage cannot tell which chief owns a task. Nothing changed. Ask the user to fix it, or update the sage plugin if a newer sage wrote it.`);
    let text;
    try {
      text = readRegular(file, { link: false, max: TABLE_MAX });
    } catch {
      damaged();
    }
    if (text === undefined) return [];
    const { cols, lines } = sheetText(text), rows = rowsOf({ cols, lines });
    if (!chiefsWhole(cols, lines, rows)) damaged();
    return rows;
  }
  const rowOf = (dir, native) => chiefs(dir).find((r) => r.provider === provider && r.native === native);
  function chiefRow(dir, native, chief, from) {
    if (!provider || !NATIVE.test(native ?? "")) refuse("sage has no session identity for this chief, so it cannot name the chief of this write. Nothing changed.");
    const rows = chiefs(dir), found = rowOf(dir, native);
    if (found) return found;
    const old = chief === undefined ? undefined : rows.find((r) => r.id === chief && r.provider === provider && r.native === from);
    if (chief !== undefined && !old) return undefined;
    const row = old ? { ...old, native } : { id: `C${Math.max(0, ...rows.map((r) => Number(r.id.slice(1)))) + 1}`, provider, native, at: now() };
    swap(join(dir, "chiefs.tsv"), `${[COLUMNS, ...(old ? rows.map((r) => (r === old ? row : r)) : [...rows, row]).map((r) => COLUMNS.map((c) => r[c]))].map((cells) => cells.join("\t")).join("\n")}\n`);
    return row;
  }
  return { chiefs, chiefRow, rowOf };
}
