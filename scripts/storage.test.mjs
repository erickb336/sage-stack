import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { storageClean, storagePlan } from "../packages/sage-core/storage.mjs";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-storage-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, SAGE_HOME: join(base, "sage"), HOME: join(base, "home"), NODE_OPTIONS: `--import=${JSON.stringify(SPY)}`, SAGE_TEST_KILLS: join(base, "kills"), SAGE_TEST_PIDS: "{}" };
  mkdirSync(env.HOME);
  const origin = join(base, "origin.git"), project = join(base, "project");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", project], { env: gitEnv });
  git(project, "remote", "add", "origin", origin);
  const run = (args) => spawnSync("node", [TOOL, ...args, "--project", project], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  const ok = (args) => { const r = run(args); assert.equal(r.status, 0, `sage ${args.join(" ")} failed: ${r.stderr}`); return r.stdout.trim(); };
  const no = (args) => { const r = run(args); assert.equal(r.status, 1, `sage ${args.join(" ")} did not refuse: ${r.stdout}`); return r.stderr.trim(); };
  const commit = (cwd, file, text = file) => { writeFileSync(join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-q", "-m", file); };
  commit(project, ".gitignore", "node_modules/\n.env\n");
  commit(project, "README.md");
  git(project, "push", "-q", "-u", "origin", "main");
  ok(["init"]);
  const dir = ok(["logbook"]), folder = join(env.HOME, "sage-worktrees", basename(dir));
  const cell = (id, column, value) => {
    const file = join(dir, "tasks.tsv"), [head, ...lines] = readFileSync(file, "utf8").split("\n"), at = head.split("\t").indexOf(column);
    writeFileSync(file, [head, ...lines.map((l) => (l.startsWith(`${id}\t`) ? l.split("\t").with(at, value).join("\t") : l))].join("\n"));
  };
  const wt = {};
  const task = (id, state, path = join(folder, id.toLowerCase())) => {
    ok(["task", "add", "--title", `task ${id}`, "--size", "small", "--priority", "P2"]);
    git(project, "worktree", "add", "-q", "-b", `claude/${id.toLowerCase()}`, path, "main");
    ok(["task", id, "set", "state=briefed", `branch=claude/${id.toLowerCase()}`]);
    cell(id, "state", state);
    return (wt[id] = path);
  };
  task("T1", "merged");
  mkdirSync(join(wt.T1, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt.T1, "node_modules", "pkg", "index.js"), "x".repeat(20_000));
  task("T2", "merged");
  writeFileSync(join(wt.T2, "README.md"), "changed, not committed");
  task("T3", "concluded");
  commit(wt.T3, "late.txt");
  task("T4", "building");
  task("T5", "reviewing");
  task("T6", "abandoned");
  mkdirSync(join(folder, "pages", "T1"), { recursive: true });
  writeFileSync(join(folder, "pages", "T1", "design.html"), "<p>a design version</p>");
  task("T7", "merged", join(folder, "pages", "T7", "checkout"));
  task("T8", "merged");
  mkdirSync(join(base, "outside"));
  renameSync(wt.T8, join(base, "outside", "t8"));
  symlinkSync(join(base, "outside", "t8"), wt.T8);
  mkdirSync(join(dir, "briefs"), { recursive: true });
  writeFileSync(join(dir, "briefs", "R1.md"), "GOAL a brief");
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(join(dir, "reports", "R1.md"), "STATUS done");
  return { base, env, project, dir, folder, wt, ok, no, cell };
}

const tokenOf = (plan) => plan.match(/sage storage clean ([0-9a-f]{12})$/)?.[1];
const decisions = (dir) => readFileSync(join(dir, "decisions.tsv"), "utf8");

test("T1095: storage shows sizes by kind and by task, and changes nothing", (t) => {
  const w = world(t);
  const before = decisions(w.dir);
  const view = w.ok(["storage"]);
  t.diagnostic(`sage storage\n${view}`);
  for (const kind of [`Logbook ${w.dir}: `, "  logbook tables · ", "  kept briefs · ", "  kept reports · ", `Sage worktrees folder ${w.folder}: `, "  pages · ", "  task worktrees · ", "  other folders · ", "By task (the largest first):"]) assert.ok(view.includes(kind), kind);
  assert.match(view, /^ {2}task worktrees · [\d.]+ [kMG]?B · 6 worktrees$/m, "T1 to T6 are worktrees of the folder; T7 is in pages and T8 behind a link");
  assert.match(view, /^ {2}T1 · merged · [\d.]+ kB · worktree [\d.]+ kB · pages [\d.]+ [k]?B$/m);
  assert.match(view, /^ {2}T4 · building · /m);
  assert.match(view, /^ {2}other folders · .* 1 entry: t8 /m);
  assert.equal(decisions(w.dir), before);
  for (const id of Object.keys(w.wt)) assert.ok(existsSync(w.wt[id]), id);
});

test("T1095: the plan lists only ended tasks' clean worktrees for removal, keeps unsaved work, and never lists open tasks, pages or the logbook", (t) => {
  const w = world(t);
  const plan = w.ok(["storage", "plan"]);
  t.diagnostic(`sage storage plan\n${plan}`);
  const lines = plan.split("\n");
  assert.match(lines.find((l) => l.startsWith(`remove ${w.wt.T1} `)) ?? "", /^remove \S+ · T1 merged · [\d.]+ kB · with the build leftovers node_modules\/ \([\d.]+ kB\)$/);
  assert.match(lines.find((l) => l.startsWith(`remove ${w.wt.T6} `)) ?? "", /^remove \S+ · T6 abandoned · /);
  assert.equal(lines.find((l) => l.includes(w.wt.T2)), `kept ${w.wt.T2} · T2 merged · has unsaved work: uncommitted changes`);
  assert.equal(lines.find((l) => l.includes(w.wt.T3)), `kept ${w.wt.T3} · T3 concluded · has unsaved work: 1 unpushed commit`);
  assert.equal(lines.find((l) => l.includes(w.wt.T8)), `kept ${w.wt.T8} · T8 merged · its path has a link in it`);
  for (const never of [w.wt.T4, w.wt.T5, join(w.folder, "pages"), w.dir, "briefs", "reports"]) assert.ok(!lines.some((l) => /^(remove|kept) /.test(l) && l.includes(never)), never);
  assert.equal(lines.filter((l) => /^(remove|kept) /.test(l)).length, 5);
  assert.match(lines.at(-1), /^The plan removes 2 worktrees, [\d.]+ kB in all, with git worktree remove \(no --force\), and deletes no branch\. After the owner's yes: sage storage clean [0-9a-f]{12}$/);
  assert.equal(w.ok(["storage", "plan"]), plan, "the same state gives the same plan and token");
  for (const id of Object.keys(w.wt)) assert.ok(existsSync(w.wt[id]), `the plan removes nothing: ${id}`);
});

test("T1095: storage clean refuses without the token, with a wrong token and with a stale plan, and removes nothing", (t) => {
  const w = world(t);
  const before = decisions(w.dir);
  const token = tokenOf(w.ok(["storage", "plan"]));
  assert.match(w.no(["storage", "clean"]), /storage clean needs the token that sage storage plan prints/);
  assert.match(w.no(["storage", "clean", "0123456789ab"]), /is not the token of the plan now/);
  writeFileSync(join(w.wt.T1, "notes.txt"), "new work after the plan");
  assert.match(w.no(["storage", "clean", token]), /is not the token of the plan now: a task state or a worktree changed since that plan/, "a folder change makes the plan stale");
  rmSync(join(w.wt.T1, "notes.txt"));
  assert.equal(tokenOf(w.ok(["storage", "plan"])), token, "the same state gives the token again");
  w.cell("T4", "state", "merged");
  assert.match(w.no(["storage", "clean", token]), /is not the token of the plan now/, "a state change makes the plan stale");
  for (const id of Object.keys(w.wt)) assert.ok(existsSync(w.wt[id]), `nothing removed: ${id}`);
  assert.equal(decisions(w.dir), before, "no decision row");
});

test("T1095: storage clean with the plan's token removes exactly the planned worktrees and writes a decision row for each", (t) => {
  const w = world(t);
  const token = tokenOf(w.ok(["storage", "plan"]));
  const out = w.ok(["storage", "clean", token]);
  t.diagnostic(`sage storage clean ${token}\n${out}`);
  assert.match(out, new RegExp(`^removed ${w.wt.T1} · T1 merged · `, "m"));
  assert.match(out, new RegExp(`^removed ${w.wt.T6} · T6 abandoned · `, "m"));
  assert.equal(out.split("\n").at(-1), "Removed 2 of 2 planned. No branch was deleted.");
  for (const id of ["T1", "T6"]) assert.ok(!existsSync(w.wt[id]), `${id} removed`);
  for (const id of ["T2", "T3", "T4", "T5", "T7", "T8"]) assert.ok(existsSync(w.wt[id]), `${id} kept`);
  assert.ok(existsSync(join(w.folder, "pages", "T1", "design.html")), "pages stay");
  assert.ok(existsSync(join(w.dir, "briefs", "R1.md")) && existsSync(join(w.dir, "reports", "R1.md")), "briefs and reports stay");
  assert.equal(readFileSync(join(w.wt.T2, "README.md"), "utf8"), "changed, not committed");
  git(w.project, "rev-parse", "--verify", "claude/t1");
  const rows = decisions(w.dir).split("\n").filter((l) => l.includes("storage clean removed"));
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`\\tT1\\tstorage clean removed the worktree ${w.wt.T1}\\tthe owner's yes to plan ${token}: T1 merged, `));
  assert.match(w.no(["storage", "clean", token]), /the plan has nothing to remove now/, "a second apply removes nothing");
});

test("T1095: storage clean checks each worktree again just before it removes it", (t) => {
  const w = world(t);
  const real = (args) => execFileSync("git", args, { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const read = (name) => readFileSync(join(w.dir, `${name}.tsv`), "utf8").trim().split("\n").map((l, k, all) => (k ? Object.fromEntries(all[0].split("\t").map((c, n) => [c, l.split("\t")[n] ?? ""])) : null)).slice(1);
  const input = { git: real, root: w.project, dir: w.dir, folder: w.folder, tasks: read("tasks"), runs: read("runs"), ledger: read("ledger"), here: [w.project] };
  const token = tokenOf(storagePlan(input));
  let statuses = 0;
  const late = { ...input, git: (args) => {
    if (args[1] === w.wt.T1 && args[2] === "status" && ++statuses === 2) writeFileSync(join(w.wt.T1, ".env"), "SECRET=kept");
    return real(args);
  } };
  const rows = [];
  const out = storageClean(late, token, { refuse: (m) => { throw new Error(m); }, record: (row) => rows.push(row) });
  assert.match(out, new RegExp(`^kept ${w.wt.T1} · T1 merged · has unsaved work: ignored files that the prune would delete: .env$`, "m"));
  assert.equal(readFileSync(join(w.wt.T1, ".env"), "utf8"), "SECRET=kept");
  assert.deepEqual(rows.map((r) => r.task), ["T6"]);
  assert.throws(() => storageClean(input, undefined, { refuse: (m) => { throw new Error(m); }, record: () => assert.fail("no record") }), /needs the token/);
});
