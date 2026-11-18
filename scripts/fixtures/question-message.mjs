import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = mkdtempSync(join(tmpdir(), "sage-question-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
const BLOCKS = [
  { t: "field", label: "Where", text: "The work waits." }, { t: "field", label: "Approve", text: "The next step." },
  { t: "field", label: "Choice", text: "Go on or stop." },
  { t: "table", head: ["Answer", "Next", "Cost"], rows: [["yes", "The work goes on.", "none"], ["no", "The work stops.", "none"]], pick: 0 },
  { t: "field", label: "Default", text: "It waits." }, { t: "field", label: "Due", text: "Today." }, { t: "field", label: "Next", text: "I go on." }];
let count = 0;
export const questionFile = (title, page) => {
  const path = join(folder, `question-${++count}.json`);
  writeFileSync(path, JSON.stringify({ kind: "question", title, blocks: page ? [...BLOCKS, { t: "page", title: "The page to look at", ...page }] : BLOCKS }));
  return path;
};
export const QUESTION = questionFile("Go on?");
export const pageQuestion = (task, file) => questionFile("Go on?", { task, file });
