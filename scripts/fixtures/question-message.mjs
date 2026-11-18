import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = mkdtempSync(join(tmpdir(), "sage-question-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
export const QUESTION = join(folder, "question.json");
writeFileSync(QUESTION, JSON.stringify({ kind: "question", title: "Go on?", blocks: [
  { t: "field", label: "Where", text: "The work waits." }, { t: "field", label: "Approve", text: "The next step." },
  { t: "field", label: "Choice", text: "Go on or stop." },
  { t: "table", head: ["Answer", "Next", "Cost"], rows: [["yes", "The work goes on.", "none"], ["no", "The work stops.", "none"]], pick: 0 },
  { t: "field", label: "Default", text: "It waits." }, { t: "field", label: "Due", text: "Today." }, { t: "field", label: "Next", text: "I go on." }] }));
export const pageQuestion = (task, file) => {
  const path = join(folder, `question-${task}-${file.replace(/\W/g, "-")}.json`), message = JSON.parse(readFileSync(QUESTION, "utf8"));
  writeFileSync(path, JSON.stringify({ ...message, blocks: [...message.blocks, { t: "page", title: "The page to look at", task, file }] }));
  return path;
};
