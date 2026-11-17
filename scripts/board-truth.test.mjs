import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardOverview, buildBoardModel, readBoardSources, taskPanel } from "../packages/sage-core/index.mjs";
import { writeSampleLogbooks } from "./board-sample.mjs";

const NOW = new Date(Date.parse("2026-11-15T12:00:00Z")).toISOString();
function sample(t, change = null) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-truth-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sources = writeSampleLogbooks(join(dir, "sample"), { now: NOW });
  change?.(sources);
  const model = buildBoardModel(readBoardSources(sources, { now: Date.parse(NOW) }), { now: NOW }), overview = boardOverview(model);
  const row = id => overview.tasks.find(task => task.id === id && task.key.startsWith("claude/sage-"));
  return { model, overview, row };
}

test("T1120 S3: the problem count counts a failed run only while its task is open and no later run of the same role started", t => {
  const { overview } = sample(t);
  const failed = overview.agents.flatMap(book => book.runs.filter(run => run.look && run.status === "failed").map(run => `${run.id} ${run.task.id}`));
  assert.deepEqual(failed, ["R254 T210"], "R250 (T207 merged), R251 (T208 abandoned) and R252 (T209, which ran its implementer again) are not problems");
});

test("T1120 S6: a task that waits for an abandoned task says that it cannot start, on its row and its page", t => {
  const { model, row } = sample(t);
  assert.deepEqual([row("T211").waits, row("T211").cannotStart], ["Waits for T208 (stopped): it cannot start.", true]);
  assert.deepEqual([row("T6")?.cannotStart ?? false, row("T305").cannotStart], [false, false], "a task with no wait that never ends is not marked");
  assert.equal(taskPanel(model, row("T211").key).cannotStart, true);
});

test("T1120 S8: failed checks on the PR head are the chief's repair: in progress, with the reason, and not in Needs you", t => {
  const { overview, row } = sample(t);
  assert.deepEqual([row("T212").word, row("T212").needsYou, row("T212").why], ["in progress", false, "Checks failed on the recorded PR head; the chief repairs it."]);
  assert.ok(!overview.needs.some(need => need.task?.id === "T212"), "Needs you has no row that asks nothing");
});

test("T1120 S10: the task page of a task that needs an answer names the question to open", t => {
  const { model, row } = sample(t);
  const panel = taskPanel(model, row("T305").key);
  assert.deepEqual([panel.question, panel.now[0]], [`${row("T305").key.slice(0, -"/T305".length)}/G4`, "Sample: picker design A, B or C?"]);
  assert.equal(taskPanel(model, row("T212").key).question, null, "a task with no open question names none");
});

test("T1120 S11: a merged PR counts the clean cycle that the merge check carried over a clean merge of main", t => {
  const { model, row } = sample(t);
  const card = model.tasks.find(task => task.key === row("T206").key), reviewed = card.ledger.find(entry => entry.kind === "review-clean").sha;
  assert.notEqual(card.currentHead, reviewed, "the merged head is the clean merge of main, not the reviewed head");
  assert.deepEqual(row("T206").cycles, { required: 1, clean: 1, reviews: true, carriedFrom: reviewed });
  assert.deepEqual(row("T205").cycles, { required: 1, clean: null, reviews: true }, "a merged PR with no verdicts carries nothing, and its count stays unknown");
});

test("F-T1159-8: the board carries cycles from the task's verdict rows as the merge check does, also a row that names no PR", t => {
  let reviewed;
  const { row } = sample(t, sources => {
    for (const source of sources) for (const name of readdirSync(source.path)) {
      let text;
      try { text = readFileSync(join(source.path, name, "ledger.tsv"), "utf8"); } catch { continue; }
      const [head, ...rows] = text.trimEnd().split("\n"), cols = head.split("\t"), cells = rows.map(line => line.split("\t")), at = name => cols.indexOf(name);
      const review = cells.find(row => row[at("task")] === "T206" && row[at("kind")] === "review-clean");
      if (!review) continue;
      reviewed = review[at("sha")];
      for (const row of cells) if (row[at("task")] === "T206" && row[at("sha")] === reviewed) row[at("pr")] = "";
      writeFileSync(join(source.path, name, "ledger.tsv"), `${[head, ...cells.map(row => row.join("\t"))].join("\n")}\n`);
    }
  });
  assert.match(reviewed ?? "", /^[0-9a-f]{40}$/, "the sample has T206's reviewed head");
  assert.deepEqual(row("T206").cycles, { required: 1, clean: 1, reviews: true, carriedFrom: reviewed }, "the reviewed head's rows were kept before the PR number: the merge check still counts them, so the board does too");
});
