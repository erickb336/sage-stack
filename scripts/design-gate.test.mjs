import "./test-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";
import { pageQuestion } from "./fixtures/question-message.mjs";

const ADD = ["--size", "large", "--priority", "P2"];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const hex = (text) => Buffer.from(text, "utf8").toString("hex");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-design-gate-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_WORKTREES: join(base, "worktrees"), SAGE_TEST_PIDS: "{}", SAGE_TEST_MACHINE_ID: "test-machine" };
  delete env.SAGE_HOME;
  const project = join(base, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "first"], { env: gitEnv });
  claude.sage(["link", "--separate", "--project", project], env);
  const dir = claude.storeDir(project, env), chief = claude.chiefFor(project, "s-a", env);
  const as = (...args) => claude.sage([...args, "--project", project, "--chief", chief], env);
  const owner = (...args) => claude.sage([...args, "--project", project], env);
  const refused = (run) => { try { run(); } catch (error) { return error.message; } return assert.fail("no refusal"); };
  as("task", "add", "--title", "Receipt mail", ...ADD);
  as("task", "T1", "set", "state=designing");
  const pages = as("pages", "T1");
  mkdirSync(join(pages, "designs", "final", "shots"), { recursive: true });
  const files = { "index.html": "<h1>Receipt mail, SAMPLE</h1>\n", "shots/wide.png": "png-bytes" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(pages, "designs", "final", name), text);
  writeFileSync(join(pages, "designs", "final", "notes.json"), "{}");
  const ask = (design = "designs/final", question = "Approve design v1 of the receipt mail?") =>
    as("gate", "add", "T1", "--design", design, "--question", question, "--recommend", "1", "--message", pageQuestion("T1", "designs/final/index.html"));
  const task = () => claude.read(dir, "tasks").find((r) => r.id === "T1");
  const gate = (id) => claude.read(dir, "gates").find((r) => r.id === id);
  const decisions = () => claude.read(dir, "decisions");
  const copy = (g) => join(dir, "designs", "T1", g);
  return { base, env, project, dir, pages, files, as, owner, refused, ask, task, gate, decisions, copy };
}
const awaiting = (w) => w.as("task", "T1", "set", "state=awaiting-you");

test("T1222: a design gate answered Approve copies the design with a manifest and moves the task to briefed", (t) => {
  const w = world(t);
  awaiting(w);
  assert.equal(w.ask(), "G1 open · Approve design v1 of the receipt mail?");
  assert.deepEqual([w.gate("G1").options, w.gate("G1").kind], ["Approve|Approve with your words|New version", "design"]);
  const said = w.owner("gate", "answer", "G1", "--option", "1");
  assert.equal(said, "G1 answered · Approve · T1 awaiting-you → briefed · copied 2 pages to designs/T1/G1");
  assert.equal(w.task().state, "briefed");
  const manifest = JSON.parse(readFileSync(join(w.copy("G1"), "manifest.json"), "utf8"));
  assert.deepEqual({ ...manifest, at: "" }, { gate: "G1", task: "T1", design: "designs/final", answer: "Approve", at: "",
    files: Object.entries(w.files).sort().map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: sha(text) })) });
  assert.match(manifest.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  for (const [path, text] of Object.entries(w.files)) assert.equal(readFileSync(join(w.copy("G1"), path), "utf8"), text);
  assert.equal(existsSync(join(w.copy("G1"), "notes.json")), false, "only pages are copied");
  assert.deepEqual(w.decisions().slice(-2).map((d) => [d.decision, d.why]), [
    ["Approve design v1 of the receipt mail? → Approve", "the user's answer"],
    ["G1 design: T1 awaiting-you → briefed · copied 2 pages to designs/T1/G1", "the user's answer to a design question"]]);
  rmSync(join(w.pages, "designs"), { recursive: true });
  assert.equal(readFileSync(join(w.copy("G1"), "index.html"), "utf8"), w.files["index.html"], "a cleanup of the pages folder keeps the approved copy");
});

test("T1222: Approve with your words stores 'Approve with your words: <words>', copies, and moves the task to briefed", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask();
  assert.equal(w.owner("gate", "answer", "G1", "--option", "2", "--other-hex", hex("Use the shop's logo in the header.")),
    "G1 answered · Approve with your words: Use the shop's logo in the header. · T1 awaiting-you → briefed · copied 2 pages to designs/T1/G1");
  assert.equal(w.gate("G1").answer, "Approve with your words: Use the shop's logo in the header.");
  assert.equal(JSON.parse(readFileSync(join(w.copy("G1"), "manifest.json"), "utf8")).answer, "Approve with your words: Use the shop's logo in the header.");
  assert.equal(w.task().state, "briefed");
  assert.equal(w.decisions().at(-2).why, "the user's own words");
});

test("T1222: a design answer takes one of its three choices; choice 2 needs words, and words go with choice 2 only", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask();
  const before = ["gates", "tasks", "decisions"].map((table) => readFileSync(join(w.dir, `${table}.tsv`), "utf8"));
  for (const args of [["--option", "2"], ["--option", "1", "--other-hex", hex("more")], ["--option", "3", "--other-hex", hex("more")], ["--other-hex", hex("ship it")], ["--option", "4"]]) {
    assert.match(w.refused(() => w.owner("gate", "answer", "G1", ...args)), /^G1 is a design question, so its answer is one of its three choices: --option 1 \(Approve\), --option 2 with --other-hex .* Words go only with choice 2: after choice 2, ask the owner for the words\. Nothing changed\.$/, args.join(" "));
  }
  assert.match(w.refused(() => w.owner("gate", "answer", "G1", "--option", "2", "--other-hex", hex("x".repeat(1001)))), /^the owner's words have 1001 characters, and an answer keeps at most 1000\./);
  assert.deepEqual(["gates", "tasks", "decisions"].map((table) => readFileSync(join(w.dir, `${table}.tsv`), "utf8")), before, "a refused answer writes nothing");
  assert.equal(existsSync(join(w.dir, "designs")), false, "and copies nothing");
});

test("T1222: New version moves the task to designing and copies nothing", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask();
  assert.equal(w.owner("gate", "answer", "G1", "--option", "3"), "G1 answered · New version · T1 awaiting-you → designing · nothing copied: the owner asked for a new version");
  assert.equal(w.task().state, "designing");
  assert.equal(existsSync(w.copy("G1")), false);
});

test("T1222: an oversize or unreadable page gives 'not copied' with the reason, and the answer still applies", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask("designs/final/index.html");
  writeFileSync(join(w.pages, "designs", "final", "index.html"), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(w.owner("gate", "answer", "G1", "--option", "1"), "G1 answered · Approve · T1 awaiting-you → briefed · not copied: designs/final/index.html is gone, is not a plain file, has a link in its path or is over 16 MiB");
  assert.deepEqual([w.gate("G1").answer, w.task().state, existsSync(w.copy("G1"))], ["Approve", "briefed", false]);
  assert.equal(w.decisions().at(-1).decision, "G1 design: T1 awaiting-you → briefed · not copied: designs/final/index.html is gone, is not a plain file, has a link in its path or is over 16 MiB");

  const v = world(t);
  awaiting(v);
  v.ask();
  rmSync(join(v.pages, "designs", "final", "index.html"));
  symlinkSync(join(v.base, "elsewhere.html"), join(v.pages, "designs", "final", "index.html"));
  writeFileSync(join(v.base, "elsewhere.html"), "<p>not in the pages folder</p>");
  assert.match(v.owner("gate", "answer", "G1", "--option", "2", "--other-hex", hex("ok")), / · T1 awaiting-you → briefed · not copied: designs\/final\/index\.html is gone, is not a plain file, has a link in its path or is over 16 MiB$/);
  assert.deepEqual([v.task().state, readdirSync(join(v.dir, "designs")).filter((name) => name !== "T1"), readdirSync(join(v.dir, "designs", "T1"))], ["briefed", [], []], "no copy and no temporary folder stay");
});

test("T1222: a design gate's board answer is copied at the chief's pickup, and a copy error there is 'not copied', not a cleared answer", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask();
  assert.match(w.owner("gate", "answer", "G1", "--option", "2", "--other-hex", hex("Shorter subject line."), "--via", "board"), /^G1 recorded · Approve with your words: Shorter subject line\. · from the board/);
  assert.equal(existsSync(join(w.dir, "designs")), false, "a board answer only records: nothing is copied before the pickup");
  const [line] = claude.pickupAnswers(w.project, "s-a", w.env);
  assert.match(line, /^G1 \(T1\): the owner answered "Approve with your words: Shorter subject line\." on the board at .* G1 answered · Approve with your words: Shorter subject line\. · T1 awaiting-you → briefed · copied 2 pages to designs\/T1\/G1$/);

  const v = world(t);
  awaiting(v);
  v.ask();
  v.owner("gate", "answer", "G1", "--option", "1", "--via", "board");
  rmSync(join(v.pages, "designs"), { recursive: true });
  const [gone] = claude.pickupAnswers(v.project, "s-a", v.env);
  assert.match(gone, /G1 answered · Approve · T1 awaiting-you → briefed · not copied: designs\/final is not a page or a folder in the task's pages folder$/);
  assert.equal(v.gate("G1").answer, "Approve", "the answer stays applied");
});

test("T1222: a leftover temporary copy from a crash is removed at the next copy, and a copy that is there already stays as it is", (t) => {
  const w = world(t);
  awaiting(w);
  w.ask();
  const leftover = join(w.dir, "designs", ".G7-0b9c2f4e-1a2b-4c3d-8e9f-001122334455.tmp");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "index.html"), "half a copy");
  mkdirSync(w.copy("G1"), { recursive: true });
  writeFileSync(join(w.copy("G1"), "manifest.json"), "{\"kept\":true}\n");
  assert.equal(w.owner("gate", "answer", "G1", "--option", "1"), "G1 answered · Approve · T1 awaiting-you → briefed · copied already to designs/T1/G1");
  assert.equal(existsSync(leftover), false, "the leftover is gone");
  assert.equal(readFileSync(join(w.copy("G1"), "manifest.json"), "utf8"), "{\"kept\":true}\n", "a second copy of the same approval does nothing");
});

test("T1222: a design task moves from awaiting-you to briefed only when its latest design gate is approved; a plain gate does not do it", (t) => {
  const w = world(t);
  awaiting(w);
  w.as("gate", "add", "T1", "--question", "Approve the design?", "--options", "approve|change", "--recommend", "approve", "--message", pageQuestion("T1", "designs/final/index.html"));
  w.owner("gate", "answer", "G1", "--option", "1");
  const rule = /^T1 moves from awaiting-you to briefed only on the owner's approval of its design\. Ask it with a design question: sage gate add T1 --design .* Nothing changed\.$/;
  assert.match(w.refused(() => w.as("task", "T1", "set", "state=briefed")), rule, "a plain gate's approve is not a design approval");
  assert.equal(w.task().state, "awaiting-you");

  w.as("task", "T1", "set", "state=designing");
  w.ask();
  assert.equal(w.owner("gate", "answer", "G2", "--option", "1"), "G2 answered · Approve · T1 stays designing · copied 2 pages to designs/T1/G2");
  awaiting(w);
  w.ask("designs/final", "Approve design v2?");
  w.owner("gate", "answer", "G3", "--option", "3");
  w.as("task", "T1", "set", "state=awaiting-you");
  assert.match(w.refused(() => w.as("task", "T1", "set", "state=briefed")), rule, "the latest design gate counts: New version is not an approval");
  w.ask("designs/final", "Approve design v3?");
  assert.match(w.refused(() => w.as("task", "T1", "set", "state=briefed")), rule, "an open design gate is not an approval");
  w.as("task", "T1", "set", "state=designing");
  w.owner("gate", "answer", "G4", "--option", "1");
  awaiting(w);
  assert.match(w.as("task", "T1", "set", "state=briefed"), /^T1 /, "an approved latest design gate lets the chief move it");
  assert.equal(w.task().state, "briefed");
});

test("T1222: gate add --design has fixed options, needs its task and a design that sage can copy", (t) => {
  const w = world(t);
  const message = pageQuestion("T1", "designs/final/index.html");
  assert.match(w.refused(() => w.as("gate", "add", "T1", "--design", "designs/final", "--options", "yes|no", "--question", "q?", "--recommend", "1", "--message", message)), /^a design question has three fixed choices \(Approve, Approve with your words, New version\), so it takes no --options\./);
  assert.match(w.refused(() => w.as("gate", "add", "--design", "designs/final", "--question", "q?", "--recommend", "1", "--message", message)), /^a design question belongs to its task/);
  assert.match(w.refused(() => w.as("gate", "add", "T1", "--design", "designs/v9", "--question", "q?", "--recommend", "1", "--message", message)), /^--design designs\/v9 cannot be copied when the owner approves it: designs\/v9 is not a page or a folder in the task's pages folder\. Save the design in the pages folder/);
  assert.match(w.refused(() => w.as("gate", "add", "T1", "--design", "../T2", "--question", "q?", "--recommend", "1", "--message", message)), /^--design names the design's page or folder in T1's pages folder/);
  assert.equal(claude.read(w.dir, "gates").length, 0);
  assert.equal(w.as("gate", "add", "T1", "--design", "designs/final/index.html", "--question", "q?", "--recommend", "Approve with your words", "--message", message), "G1 open · q?");
  assert.equal(w.gate("G1").recommendation, "Approve with your words");
});
