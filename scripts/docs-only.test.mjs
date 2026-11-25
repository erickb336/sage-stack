import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { keepReport } from "../plugins/sage/skills/sage/sage.mjs";
import { backed } from "./verdict-backing.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const DOCS = /^T1 may merge: [0-9a-f]{7} is docs-only: (?:the one file|each of the \d+ files) that it changes since its merge base with origin\/main is /;

function world(t, { size = "large", risk = ["--risk", "input"], origin = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-docs-only-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const work = (files, gone = []) => {
    for (const [name, text] of Object.entries(files)) mkdirSync(dirname(join(project, name)), { recursive: true }), writeFileSync(join(project, name), text);
    for (const name of gone) git("rm", "-q", name);
    git("add", "-A");
    git("commit", "-q", "-m", "work");
    return git("rev-parse", "HEAD");
  };
  work({ "src/app.js": "app\n", "README.md": "start\n" });
  const fetch = () => git("update-ref", "refs/remotes/origin/main", "main");
  if (origin) fetch();
  git("checkout", "-q", "-b", "sage/t1");
  const env = { ...process.env, HOME: join(dir, "home"), SAGE_HOME: join(dir, "sage") };
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout: 60_000 });
  const cli = (...args) => {
    const r = run(...args);
    if (r.status) throw Error(`sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const ok = (...args) => cli(...backed(args, { cli, keep: (fields) => keepReport(project, fields, env) }));
  cli("init");
  ok("task", "add", "--priority", "P2", "--title", "t", "--size", size, ...risk);
  ok("task", "T1", "set", "branch=sage/t1", "pr=41");
  for (const state of ["briefed", "building", "reviewing"]) ok("task", "T1", "set", `state=${state}`);
  return {
    project, git, work, fetch, ok, cli, run,
    checked: (sha) => ok("verdict", "T1", "--sha", sha, "--kind", "checks-pass", "--cycle", "1", "--pr", "41"),
    check: (sha) => cli("merge-check", "--sha", sha, "--pr", "41"),
    refused: (sha) => {
      const r = run("merge-check", "--sha", sha, "--pr", "41");
      assert.equal(r.status, 1, `merge-check should refuse ${sha}, printed: ${r.stdout}`);
      return r.stderr.trim();
    },
  };
}

test("T1239: a docs-only head of a large task with a risk flag merges on checks-pass alone, and the message says why", (t) => {
  const w = world(t);
  const head = w.work({ "docs/guide.md": "how\n", "README.md": "more\n", "packages/x/docs/deep/page.txt": "deep\n", "plugins/sage/license": "MIT\n", "Changelog.rst": "1.0\n", "notes/CONTRIBUTING": "be kind\n" });
  const before = w.refused(head);
  assert.match(before, /^sage: no verdicts recorded for [0-9a-f]{40}\. .* [0-9a-f]{7} is docs-only: each of the 6 files .* no review cycle\.$/, "the read form that the lead runs before any verdict names the head docs-only");
  w.checked(head);
  const said = w.check(head);
  assert.match(said, DOCS);
  assert.match(said, /each of the 6 files/);
});

test("T1239: one file that is not documentation brings back the task's clean cycles: code, a skill, an agent file, a principle, markdown elsewhere", (t) => {
  const w = world(t);
  const docs = w.work({ "docs/guide.md": "how\n" });
  w.checked(docs);
  assert.match(w.check(docs), DOCS, "the docs-only head merges");
  for (const file of ["src/app.js", "packages/sage-claude/skills/report/SKILL.md", "packages/sage-claude/agents/lead.md", "principles/prove-it-works.md", "notes.md"]) {
    w.git("reset", "-q", "--hard", docs);
    const head = w.work({ [file]: "changed\n" });
    w.checked(head);
    assert.match(w.refused(head), /^sage: T1: 0 of 2 clean cycles on this SHA; never recorded: review-clean, security-clean, ux-clean, qa-pass\./, `${file} is not documentation, so the large task with a risk flag needs its 2 cycles`);
    assert.doesNotMatch(w.refused(head), /docs-only/);
  }
});

test("T1239: a later commit that adds a non-doc file brings the full rules back on that head", (t) => {
  const w = world(t, { size: "small", risk: [] });
  const docs = w.work({ "docs/guide.md": "how\n" });
  w.checked(docs);
  assert.match(w.check(docs), DOCS);
  const code = w.work({ "src/new.js": "code\n" });
  w.checked(code);
  assert.match(w.refused(code), /^sage: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\./);
});

test("T1239: a rename or a deletion counts by its old path too: a move from src/ into docs/ is not docs-only", (t) => {
  const w = world(t);
  const moved = w.work({ "docs/app.js": "app\n" }, ["src/app.js"]);
  w.checked(moved);
  assert.match(w.refused(moved), /^sage: T1: 0 of 2 clean cycles on this SHA/);
  w.git("reset", "-q", "--hard", "main");
  const docsMove = w.work({ "docs/readme-old.md": "start\n" }, ["README.md"]);
  w.checked(docsMove);
  assert.match(w.check(docsMove), DOCS, "a move between two documentation paths stays docs-only");
});

test("T1239: open findings still block a docs-only head", (t) => {
  const w = world(t);
  const head = w.work({ "docs/guide.md": "how\n" });
  w.checked(head);
  assert.match(w.check(head), DOCS);
  w.cli("finding", "add", "T1", "--source", "checks", "--severity", "medium", "--summary=wrong-link");
  assert.match(w.refused(head), /^sage: T1 has open findings: F-T1-1\. .* is docs-only/);
});

test("T1239: docs_paths widens the documentation files of one project", (t) => {
  const w = world(t);
  const head = w.work({ "guides/start.txt": "go\n", "docs/a.md": "a\n" });
  w.checked(head);
  assert.match(w.refused(head), /^sage: T1: 0 of 2 clean cycles on this SHA/, "guides/ is not documentation by default");
  assert.equal(w.cli("config", "docs_paths=guides/**, **/*.adoc"), "name= archived=no start=normal docs_paths=guides/**,**/*.adoc");
  const said = w.check(head);
  assert.match(said, DOCS);
  assert.match(said, /, or matches the project's docs_paths\./);
  assert.equal(w.cli("config", "docs_paths="), "name= archived=no start=normal");
  assert.match(w.refused(head), /^sage: T1: 0 of 2 clean cycles on this SHA/, "an empty docs_paths removes the globs");
});

test("T1239: docs_paths refuses a glob that matches every file, and keeps the earlier value", (t) => {
  const w = world(t);
  w.cli("config", "docs_paths=guides/**");
  for (const glob of ["**", "**/*", "guides/**,**", "**/**/*"]) {
    const r = w.run("config", `docs_paths=${glob}`);
    assert.equal(r.status, 1, `docs_paths=${glob} is refused`);
    assert.match(r.stderr, /matches every file, so every pull request would merge with no review\. Nothing changed\./);
  }
  assert.equal(w.cli("config", "docs_paths=guides/**"), "name= archived=no start=normal docs_paths=guides/**");
});

test("T1239: when git gives no diff (no origin/main) the merge check keeps today's rules", (t) => {
  const w = world(t, { origin: false });
  const head = w.work({ "docs/guide.md": "how\n" });
  w.checked(head);
  assert.match(w.refused(head), /^sage: T1: 0 of 2 clean cycles on this SHA/, "no origin/main: no merge base, so no docs-only");
  w.fetch();
  assert.match(w.check(head), DOCS, "with origin/main the same head is docs-only");
});

test("T1239: a docs-only head moves to verified with checks-pass alone", (t) => {
  const w = world(t);
  const head = w.work({ "docs/guide.md": "how\n" });
  w.checked(head);
  w.ok("task", "T1", "set", "state=verifying");
  assert.match(w.ok("task", "T1", "set", "state=verified"), /^T1 verified/);
});
