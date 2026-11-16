import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createStateTool } from "../core/index.mjs";

const OWNER = [["gate", "answer"], ["gate", "undo"], ["gate", "give"], ["chief", "name"]];
const ARCHIVE = [["config", "archived=yes"], ["config", "archived=no"]];
const WRITE_MS = 30_000;
const UNEXPECTED = { code: 2, pending: true, text: "The logbook write stopped with an unexpected error, so the board cannot say whether it landed. Reload the board to see it before you try again." };
const open = new Set();
export const archiveCommand = argv => Array.isArray(argv) && ARCHIVE.some(form => form.length === argv.length && form.every((word, i) => argv[i] === word));
export const ownerCommand = argv => archiveCommand(argv) || Array.isArray(argv) && argv.every(word => typeof word === "string") && OWNER.some(([cmd, sub]) => argv[0] === cmd && argv[1] === sub);
export const writesEnded = () => Promise.all(open);

function checkouts(shared, folder) {
  let text;
  try { text = readFileSync(join(shared, "bindings.tsv"), "utf8"); } catch { return []; }
  const [head, ...lines] = text.split("\n"), cols = head.split("\t");
  return lines.map(line => Object.fromEntries(line.split("\t").map((cell, i) => [cols[i], cell]))).filter(row => row.folder === folder && row.root?.startsWith("/")).flatMap(row => {
    try { return [realpathSync(row.root)]; } catch { return []; }
  });
}

function toldCheckout(dir) {
  try {
    const file = join(dir, "checkout.txt"), stat = lstatSync(file);
    const told = stat.isFile() && stat.size <= 65536 ? readFileSync(file, "utf8").trim() : "";
    return isAbsolute(told) ? [realpathSync(told)] : [];
  } catch { return []; }
}

export function ownerWrite({ shared, folder, argv, root = null }, env = process.env) {
  if (!ownerCommand(argv)) return { code: 1, text: "The board sends only the owner's commands: gate answer, gate undo, gate give, chief name, archive and restore." };
  if (root !== null && !archiveCommand(argv)) return { code: 1, text: "The board writes a Claude or Codex logbook only to archive or restore its project. Answer in the chief's chat." };
  const settings = { ...env, SAGE_SHARED_HOME: shared, ...(root !== null && { SAGE_HOME: root }) };
  const tool = createStateTool({ defaultRoot: () => root ?? join(shared, ".board-has-no-provider-root") });
  const dir = join(root ?? shared, folder);
  const project = (root === null ? checkouts(shared, folder) : toldCheckout(dir)).find(at => { try { return tool.locate(at, settings).dir === dir; } catch { return false; } });
  if (!project) return { code: 1, text: `No checkout of this project is on this Mac, so the board cannot write its logbook. ${archiveCommand(argv) ? "Ask the chief in the project's chat" : "Answer in the chief's chat"}.` };
  const done = tool.command([...argv, "--project", project], settings);
  if (done.code !== 2) return done;
  console.error(done.text);
  return UNEXPECTED;
}

export function writeInWorker(job, { timeout = WRITE_MS } = {}) {
  return new Promise(done => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { write: job } });
    const ended = new Promise(end => worker.once("exit", end)).then(() => open.delete(ended));
    open.add(ended);
    const timer = setTimeout(() => done({ code: 2, pending: true, text: "Not confirmed yet: the logbook was busy. The write may still finish: reload the board to see it before you try again." }), timeout);
    worker.once("message", result => { clearTimeout(timer); done(result); });
    worker.once("error", error => { clearTimeout(timer); console.error(error); done(UNEXPECTED); });
    worker.once("exit", () => { clearTimeout(timer); done(UNEXPECTED); });
  });
}

if (!isMainThread && workerData?.write) parentPort.postMessage(ownerWrite(workerData.write));
