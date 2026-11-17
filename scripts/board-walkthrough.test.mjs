import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardOverview, buildBoardModel, readBoardSources } from "../packages/sage-core/index.mjs";
import { boardAnswer } from "../packages/sage-core/logbook-fields.mjs";
import { answerInSample, concatList } from "./board-walkthrough.mjs";
import { writeTasksLogbook } from "./fixtures/board-app.mjs";

const NOW = "2026-11-16T12:00:00.000Z";

test("T1085: the walkthrough records its answer in the sample logbook as a board answer, which takes the question off Needs you", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-walkthrough-unit-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logbooks = join(dir, "logbooks"), sources = [{ id: "shared", label: "Shared", path: logbooks }];
  const project = writeTasksLogbook(logbooks, join(dir, "worktrees"), NOW, { agents: true, about: true, prs: true, documents: true });
  const read = () => readBoardSources(sources, { now: Date.parse(NOW) });
  const needs = () => boardOverview(buildBoardModel(read(), { now: NOW })).needs.flatMap(need => need.gate ? [need.gate] : []);
  const job = (...argv) => ({ shared: logbooks, folder: "sample-app-abc123", argv });
  assert.deepEqual(needs(), ["G4", "G5"]);

  const before = readFileSync(join(project, "gates.tsv"), "utf8");
  assert.equal(answerInSample(job("gate", "undo", "G4")).code, 1, "the stand-in records only answers");
  assert.equal(answerInSample(job("gate", "answer", "G4", "--via", "board", "--option", "3", "--seen", "0123456789abcdef")).code, 1, "G4 has two answers");
  assert.equal(readFileSync(join(project, "gates.tsv"), "utf8"), before, "a refused write changes nothing");

  assert.deepEqual(answerInSample(job("gate", "answer", "G4", "--via", "board", "--option", "1", "--seen", "0123456789abcdef"), NOW), { code: 0, text: "G4 answered: A: yes, as a new private list" });
  assert.deepEqual(needs(), ["G5"]);
  const gates = read().find(source => source.id === "shared").projects[0].tables.gates;
  assert.deepEqual(boardAnswer(gates.find(gate => gate.id === "G4")), { via: "board", at: NOW, answer: "A: yes, as a new private list" });
  assert.deepEqual(gates.filter(boardAnswer).map(gate => gate.id), ["G4"], "no other gate has an answer from the board");
});

test("T1085: the ffmpeg list shows each frame for its own time, and names the last frame again so that its time counts", () => {
  assert.equal(concatList([{ file: "/f/00.png", seconds: 3.5 }, { file: "/f/it's.png", seconds: 0.9 }]),
    "ffconcat version 1.0\nfile '/f/00.png'\nduration 3.5\nfile '/f/it'\\''s.png'\nduration 0.9\nfile '/f/it'\\''s.png'\n");
});
