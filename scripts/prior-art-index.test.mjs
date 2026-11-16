import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { sharedRoot } from "../packages/sage-core/index.mjs";

const CLAUDE = join(ROOT, "plugins/sage/skills/sage/sage.mjs"), CODEX = join(ROOT, "plugins/sage-codex/skills/sage/sage.mjs");
const HEADER = "| Name | What they do | What we take | Where we differ, and why | Link | Read on |";
const RULE = "| --- | --- | --- | --- | --- | --- |";
const PSTACK = "| pstack | Principles as skills | The principle format | We add a hook | https://github.com/example/pstack | 2026-11-16 |";
const SONAR = "| SonarQube | Judges new code only | Judge the change, not the past | No server | [new code](https://docs.example.com/new-code) | 2026-11-15 |";
const ODD = "| Betterer | Keeps a results file | Nothing: the opposite example | No file in the project | <https://example.org/betterer> | 2026-11-14 |";

function scratchHomeWithSharedRootFromSageHome(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-prior-art-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage"), CODEX_HOME: join(dir, "codex-home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  mkdirSync(env.HOME);
  const run = (tool, ...args) => spawnSync(process.execPath, [tool, "prior-art", ...args, "--project", dir], { cwd: dir, env, encoding: "utf8" });
  return { dir, env, run, folder: join(dir, "sage", "shared", "prior-art") };
}

test("the index is one folder in the shared root: SAGE_HOME/shared in a scratch home, and ~/.sage on the owner's Mac", () => {
  assert.equal(sharedRoot({ HOME: "/Users/owner" }), "/Users/owner/.sage");
  assert.equal(sharedRoot({ HOME: "/Users/owner", SAGE_HOME: "/scratch/sage" }), "/scratch/sage/shared");
});

test("a row that Claude's chief adds is in the same file that Codex's tool reads, and the other way round", (t) => {
  const s = scratchHomeWithSharedRootFromSageHome(t);
  const empty = s.run(CLAUDE);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, `the prior-art index: ${s.folder}\nno topics yet\n`);
  assert.equal(s.run(CODEX, "reviews").stdout, `no rows for reviews yet: ${join(s.folder, "reviews.md")}\n`);
  assert.equal(existsSync(s.folder), false, "a read makes no folder");

  const added = s.run(CLAUDE, "reviews", "add", "--rows", [HEADER, RULE, PSTACK, SONAR].join("\n"));
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, `prior-art reviews: added 2 rows · ${join(s.folder, "reviews.md")}\n`);
  const file = join(s.folder, "reviews.md");
  assert.equal(readFileSync(file, "utf8"), `# Prior art: reviews\n\n${HEADER}\n${RULE}\n${PSTACK}\n${SONAR}\n`);
  assert.equal(statSync(s.folder).mode & 0o777, 0o700);

  const read = s.run(CODEX, "reviews");
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, `# Prior art: reviews\n\n${HEADER}\n${RULE}\n${PSTACK}\n${SONAR}\n`);

  const more = s.run(CODEX, "reviews", "add", `--rows=${SONAR.replace("2026-11-15", "2026-11-16")}\n${ODD}`);
  assert.equal(more.stdout, `prior-art reviews: added 1 row; kept out 1, whose link is in the topic already (https://docs.example.com/new-code) · ${file}\n`);
  assert.equal(readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("| ")).length, 5, "the header, the rule and 3 rows");
  assert.equal(s.run(CLAUDE, "boards", "add", "--rows", PSTACK).status, 0);
  assert.equal(s.run(CLAUDE).stdout, `the prior-art index: ${s.folder}\nboards · 1 row\nreviews · 3 rows\n`);
});

test("a bad row refuses the whole add, names each line, and changes nothing", (t) => {
  const s = scratchHomeWithSharedRootFromSageHome(t);
  assert.equal(s.run(CLAUDE, "reviews", "add", "--rows", PSTACK).status, 0);
  const file = join(s.folder, "reviews.md"), before = readFileSync(file, "utf8");
  const bad = [
    SONAR,
    "| Aider | Edits code | Repo map | | https://aider.chat | 2026-11-16 |",
    "| Aider | Edits code | Repo map | No map | aider.chat | 2026-11-16 |",
    "| Aider | Edits code | Repo map | No map | https://aider.chat | 16 Nov 2026 |",
    "| Aider | Edits code | Repo map | No map | https://aider.chat | 2026-02-30 |",
    "| Aider | Edits code | https://aider.chat | 2026-11-16 |",
    "Aider, read on 2026-11-16",
  ].join("\n");
  const r = s.run(CLAUDE, "reviews", "add", "--rows", bad);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^sage: each line of --rows is a table row of 6 cells: \| Name \| What they do \| What we take \| Where we differ, and why \| Link \| Read on \|/);
  for (const why of ["line 2: its Where we differ, and why cell is empty", 'line 3: its Link cell has no http or https address: "aider.chat"',
    'line 4: its Read on cell is not a date YYYY-MM-DD: "16 Nov 2026"', 'line 5: its Read on cell is not a date YYYY-MM-DD: "2026-02-30"',
    "line 6: it has 4 cells, not 6", "line 7: it does not start and end with |"]) assert.ok(r.stderr.includes(why), `${why}: ${r.stderr}`);
  assert.match(r.stderr, /Nothing changed\.\n$/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(s.run(CLAUDE, "reviews", "add", "--rows", `${HEADER}\n${RULE}\n`).stderr, "sage: --rows has no row: give each row as a table row of 6 cells: | Name | What they do | What we take | Where we differ, and why | Link | Read on |, with an http or https address in Link and the date in Read on as YYYY-MM-DD. Nothing changed.\n");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("the topic is a plain name, add needs rows, and a topic file that is not a regular file is not touched", (t) => {
  const s = scratchHomeWithSharedRootFromSageHome(t);
  for (const topic of ["../logbook", "Reviews", "a_b", "x".repeat(41), "-a"]) {
    const r = s.run(CLAUDE, topic, "add", "--rows", PSTACK);
    assert.equal(r.status, 1, topic);
    assert.match(r.stderr, /^sage: the topic is 1 to 40 lower-case letters, digits and dashes/, topic);
  }
  assert.equal(existsSync(s.folder), false);
  assert.match(s.run(CLAUDE, "reviews", "add").stderr, /^sage: add needs --rows with the table rows/);
  assert.match(s.run(CLAUDE, "reviews", "--rows", PSTACK).stderr, /^sage: prior-art takes no words .*, or <topic> add --rows <the table rows>\. Nothing changed\.\n$/);
  assert.match(s.run(CLAUDE, "reviews", "remove").stderr, /^sage: prior-art takes no words/);
  assert.match(s.run(CLAUDE, "reviews", "add", "--rows", PSTACK, "--tokens", "5").stderr, /^sage: prior-art takes no --tokens\. Its options: --rows, --project\./);
  mkdirSync(s.folder, { recursive: true });
  const elsewhere = join(s.dir, "elsewhere.md");
  writeFileSync(elsewhere, "kept\n");
  symlinkSync(elsewhere, join(s.folder, "boards.md"));
  const r = s.run(CLAUDE, "boards", "add", "--rows", PSTACK);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boards\.md is not a regular file, so the index cannot add to it/);
  assert.equal(readFileSync(elsewhere, "utf8"), "kept\n");
});
