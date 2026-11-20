import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPart, readBoardSources } from "../packages/sage-core/board-reader.mjs";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
import { boardOverview } from "../packages/sage-core/board-overview.mjs";
import { renderBoardText, renderTaskText } from "../packages/sage-core/board-render.mjs";
import { replaceQuestion } from "../packages/sage-core/chiefs.mjs";
import { sharedRoot } from "../packages/sage-core/shared-root.mjs";
import { providerRoots, readSources, standardSources } from "../packages/sage-board/cli.mjs";
import * as view from "../packages/sage-core/board-view.mjs";
import { createBoardServer, loadBoardApp } from "../packages/sage-board/server.mjs";
import * as claude from "../plugins/sage/skills/sage/sage.mjs";

const NOW = Date.now(), iso = (ms = 0) => new Date(NOW + ms).toISOString(), MIN = 60_000, DAY = 86_400_000;
const FOLDER = "lantern-4be1a2", HARBOR = "harbor-90c1de";
const COLS = {
  tasks: "id title size risk route state branch pr round keys priority kind chief offer",
  runs: "id task role round candidate branch status tokens report started ended chief",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at kind",
  decisions: "at task decision why",
  milestones: "id name goal pilot gate at",
};
const LEGACY = { ...COLS, tasks: "id title size risk route state branch pr round keys priority kind", runs: "id task role round candidate branch status tokens report started ended", gates: "id task question options recommendation default answer at" };
const sheet = (columns, rows) => `${[columns.split(" "), ...rows.map(row => columns.split(" ").map(column => row[column] ?? ""))].map(cells => cells.join("\t")).join("\n")}\n`;
function logbook(dir, rows, columns = COLS, extra = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, list] of Object.entries(columns)) writeFileSync(join(dir, `${name}.tsv`), sheet((extra.cols ?? {})[name] ?? list, rows[name] ?? []));
  for (const [name, text] of Object.entries(extra.files ?? {})) writeFileSync(join(dir, name), text);
}
const BUILD = "build,code-review,qa";
const task = (id, title, state, fields = {}) => ({ id, title, size: "small", route: BUILD, state, branch: `sage/${id.toLowerCase()}`, round: "0", priority: "P2", ...fields });
const run = (id, taskId, role, status, started, fields = {}) => ({ id, task: taskId, role, round: "0", status, started, ...fields });

function world(t, { bindings } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-shared-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const claudeRoot = join(base, "claude", "sage"), codexRoot = join(base, "codex", "sage"), shared = join(base, "shared");
  const checkout = join(base, "lantern"), harbor = join(base, "harbor");
  for (const [dir, repo] of [[checkout, "lantern"], [harbor, "harbor"]]) { mkdirSync(join(dir, ".git"), { recursive: true }); writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:sample-owner/${repo}.git\n`); }
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "bindings.tsv"), bindings ?? `root\tfolder\tcommits\tat\n${checkout}\t${FOLDER}\t${"a".repeat(40)}\t2026-10-01T00:00:00Z\n`);
  const offer = (id, from, to) => JSON.stringify({ id, from, to });
  logbook(join(shared, FOLDER), {
    tasks: [
      task("T321", "Show the board in both providers", "building", { chief: "C1", offer: offer("O1", "C1", "C2"), pr: "88" }),
      task("T322", "Retry a lost upload", "framed"),
      task("T319", "Make search easier to find", "designing", { chief: "C2", route: "design,build,code-review,qa", priority: "P1" }),
      task("T320", "Split the sync step", "building", { chief: "C1", priority: "P1" }),
      task("T323", "Tidy the docs", "reviewing", { chief: "C2", offer: offer("O2", "C2", "C1") }),
      task("T324", "A chief that the table lost", "framed", { chief: "C9" }),
      task("T326", "A stale run of another chief", "building", { chief: "C1" }),
    ],
    runs: [
      run("R407", "T321", "qa", "running", iso(-50 * MIN), { chief: "C1" }),
      run("R420", "T321", "lead", "running", iso(-60 * MIN), { chief: "C1" }),
      run("R430", "T322", "implementer", "done", iso(-3 * 60 * MIN), { ended: iso(-2 * 60 * MIN) }),
      run("R412", "T319", "designer", "running", iso(-3 * DAY), { chief: "C2" }),
      run("R410", "T320", "lead", "running", iso(-10 * MIN), { chief: "C1" }),
      run("R411", "T320", "implementer", "running", iso(-9 * MIN), { chief: "C1" }),
      run("R440", "T326", "implementer", "running", iso(-3 * DAY), { chief: "C2" }),
    ],
    gates: [{ id: "G7", task: "T320", question: replaceQuestion({ from: "C1", to: "C2", task: "T320", title: "Split the sync step", runs: [{ id: "R410", role: "lead" }, { id: "R411", role: "implementer" }], label: id => `${id} (${id === "C1" ? "claude" : "codex"})` }), options: "approve|decline", recommendation: "approve", at: iso(-5 * MIN), kind: "replace" }],
  }, COLS, { files: {
    "chiefs.tsv": "id\tprovider\tnative\tat\nC1\tclaude\tsession-a\t2026-10-01T00:00:00Z\nC2\tcodex\tsession-b\t2026-10-01T00:00:00Z\n",
    "sources.tsv": `provider\tpath\tat\nclaude\t${join(claudeRoot, FOLDER)}\t2026-10-02T00:00:00Z\ncodex\t${join(codexRoot, FOLDER)}\t2026-10-02T00:00:00Z\n`,
  } });
  logbook(join(claudeRoot, FOLDER), {
    tasks: [task("T316", "Old finished task of Claude", "merged"), { ...task("T90", "Open task that moved", "building"), moved: "T325" }],
    decisions: [{ at: iso(-DAY), task: "T316", decision: "state merged" }],
  }, LEGACY, { cols: { tasks: `${LEGACY.tasks} moved` }, files: { "checkout.txt": `${checkout}\n`, "moved.json": "{}\n" } });
  logbook(join(codexRoot, FOLDER), {
    tasks: [task("T96", "Old finished task of Codex", "concluded", { route: "investigate,evidence-review" })],
    decisions: [{ at: iso(-2 * DAY), task: "T96", decision: "state concluded" }],
  }, LEGACY, { files: { "checkout.txt": `${checkout}\n`, "moved.json": "{}\n" } });
  logbook(join(claudeRoot, HARBOR), {
    tasks: [task("T41", "Legacy task at work", "building")],
    runs: [run("R5", "T41", "implementer", "running", iso(-5 * MIN))],
  }, LEGACY, { files: { "checkout.txt": `${harbor}\n` } });
  const slot = (name, marks) => { const dir = join(claudeRoot, ".hooks", "slots", name); mkdirSync(dir, { recursive: true }); for (const mark of marks) writeFileSync(join(dir, mark), ""); };
  slot("slot-1", ["ok", "project-lantern", "role-sage_lead", "run-R420", `logbook-${createHash("sha256").update(join(shared, FOLDER)).digest("hex")}`]);
  slot("slot-2", ["ok", "project-lantern", "role-sage_qa", "run-R407"]);
  mkdirSync(join(claudeRoot, ".hooks", "helpers"), { recursive: true });
  const sources = [{ id: "claude", label: "Claude", provider: "claude", path: claudeRoot }, { id: "codex", label: "Codex", provider: "codex", path: codexRoot }, { id: "shared", label: "Shared", path: shared }];
  return { base, claudeRoot, codexRoot, shared, checkout, sources };
}
const modelOf = (sources, options = {}) => buildBoardModel(readBoardSources(sources, { now: NOW, ...options }), { now: iso() });
const card = (model, id) => model.tasks.find(item => item.id === id && !item.old) ?? model.tasks.find(item => item.id === id);

test("a shared project shows once, named from its bindings.tsv row, with its old logbooks; a damaged bindings.tsv gives a diagnostic and no checkout", t => {
  const w = world(t), model = modelOf(w.sources);
  const lantern = model.projects.filter(project => project.name === "lantern");
  assert.equal(lantern.length, 1, "one project, not one for each logbook");
  assert.deepEqual(lantern[0].books, [`shared/${FOLDER}`, `claude/${FOLDER}`, `codex/${FOLDER}`]);
  assert.deepEqual(lantern[0].providers, ["Claude", "Codex"]);
  assert.equal(lantern[0].sub, `sample-owner/lantern · folder lantern`);
  assert.deepEqual(model.notes, [], "no note that the checkout is not known");
  assert.equal(card(model, "T321").repository, "https://github.com/sample-owner/lantern");
  assert.match(renderTaskText(card(model, "T321")), /PR \[88\]\(https:\/\/github\.com\/sample-owner\/lantern\/pull\/88\)/);
  assert.deepEqual(model.tasks.filter(item => item.id === "T316").map(item => item.key), [`claude/${FOLDER}/T316`]);
  assert.deepEqual(model.tasks.filter(item => item.id === "T96").map(item => item.key), [`codex/${FOLDER}/T96`]);
  const damaged = world(t, { bindings: "root\tfolder\n/x\ty\n" }), broken = readBoardSources(damaged.sources, { now: NOW }).find(source => source.id === "shared").projects.find(project => project.key === `shared/${FOLDER}`);
  assert.deepEqual(broken.diagnostics, ["bindings: damaged table"]);
  assert.equal(broken.checkout, undefined);
  assert.equal(buildBoardModel(readBoardSources(damaged.sources, { now: NOW }), { now: iso() }).projects.find(project => project.books.includes(`shared/${FOLDER}`)).name, "lantern", "the folder still names it");
});

test("the provider of each run comes from its chief in chiefs.tsv; a run with no chief shows the dotted stand-in; only a shared task page has a Provider column", t => {
  const model = modelOf(world(t).sources);
  assert.deepEqual(card(model, "T321").runs.map(item => [item.id, item.provider]), [["R407", "Claude"], ["R420", "Claude"]]);
  assert.deepEqual(card(model, "T319").runs.map(item => [item.id, item.provider]), [["R412", "Codex"]]);
  assert.deepEqual(card(model, "T322").runs.map(item => [item.id, item.provider]), [["R430", null]]);
  assert.match(renderTaskText(card(model, "T319")), /R412 Codex · designer · in progress/);
});

test("each shared card names its owning chief or Unclaimed; the Who filter goes by the owning chief's provider", t => {
  const model = modelOf(world(t).sources);
  assert.deepEqual(["T321", "T322", "T323", "T324"].map(id => card(model, id).holder), ["Claude · C1", "Unclaimed", "Codex · C2", "C9"]);
  assert.equal(card(model, "T324").owner.unlisted, true, "an unknown chief id shows on its task's page");
  assert.ok(!model.needsOwner.some(item => item.id === "T324"), "an unknown chief id is a warning, not a need");
  assert.match(renderBoardText(model), /\*\*Show the board in both providers\*\* T321 · in progress · Claude · C1 · lantern · PR 88/);
});

test("F-T1182-3: a left-over offer of an older sage shows no offer cell and no accept text: accept is gone, and the next pick-up ends the offer", t => {
  const model = modelOf(world(t).sources), text = renderBoardText(model);
  assert.ok(["T321", "T323"].every(id => card(model, id).offer === undefined), "the tasks keep their offer in the logbook, but the card has no offer cell");
  assert.doesNotMatch(text, /accept|Offered to|⇄/);
  assert.doesNotMatch(renderTaskText(card(model, "T321")), /accept|Offered to|⇄/, "the chat lookup of one task");
  assert.doesNotMatch(JSON.stringify(boardOverview(model)), /accepts|can accept|Offered to/, "the board in the browser");
});

test("Needs you: an open takeover gate asks its question in one line, and a stale run of the owning chief says that the chief may have stopped (G103 default)", t => {
  const model = modelOf(world(t).sources);
  const replace = card(model, "T320").reasons, unknown = card(model, "T319").reasons;
  assert.deepEqual(replace.map(reason => reason.text), ["Hand T320 from Claude · C1 to Codex · C2? R410 and R411 end as failed."]);
  assert.deepEqual(unknown.map(reason => [reason.kind, reason.text, reason.recommendation]), [["chief-unknown", "The owning chief, Codex · C2, may have stopped: R412 shows no change for over 24 h.", "if it stopped, ask any chief to open a takeover gate."]]);
  assert.deepEqual(card(model, "T326").reasons, []);
  const lantern = model.projects.find(project => project.name === "lantern");
  assert.deepEqual(model.needsOwner.filter(item => item.group === lantern.key).map(item => item.id).sort(), ["T319", "T320"]);
  assert.equal(lantern.needsOwner, 2);
  const text = renderBoardText(model);
  assert.match(text, /> shared\/lantern-4be1a2\/G7 · Hand T320 from Claude · C1 to Codex · C2\? R410 and R411 end as failed\\\./);
  assert.match(text, /> The owning chief, Codex · C2, may have stopped\\: R412 shows no change for over 24 h\\\./);
});

test("old logbooks: finished tasks show in Done with their old label, a moved row is hidden, and a path that is not an old logbook folder is never read", t => {
  const w = world(t), model = modelOf(w.sources);
  assert.deepEqual(["T316", "T96"].map(id => [card(model, id).holder, card(model, id).who, card(model, id).column]), [["Old · Claude · read-only", "claude", "done"], ["Old · Codex · read-only", "codex", "done"]]);
  assert.ok(!model.tasks.some(item => item.id === "T90"), "the moved row shows only in the shared logbook");
  assert.match(renderTaskText(card(model, "T316")), /A finished task of the old Claude logbook\\\. It stays there, read-only/);
  writeFileSync(join(w.codexRoot, FOLDER, "decisions.tsv"), sheet(COLS.decisions, [{ at: iso(-8 * DAY), task: "T96", decision: "state concluded" }]));
  assert.equal(card(modelOf(w.sources), "T96").visible, false);
  const outside = join(w.base, "elsewhere", FOLDER), link = join(w.claudeRoot, "other-111111");
  logbook(outside, { tasks: [task("T1", "Outside", "merged")] }, LEGACY);
  symlinkSync(join(w.codexRoot, FOLDER), link);
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\nclaude\t${outside}\tx\nclaude\t${link}\tx\nclaude\t${join(w.claudeRoot, ".hooks")}\tx\n`);
  const read = readBoardSources(w.sources, { now: NOW }), shared = read.find(source => source.id === "shared");
  assert.deepEqual(shared.projects.map(project => project.key), [`shared/${FOLDER}`]);
  assert.deepEqual([shared.projects[0].diagnostics, shared.projects[0].notes], [[], [2, 3, 4].map(line => `sources: line ${line} does not name a moved logbook of its provider under a provider root`)]);
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\ncodex\t${join(w.codexRoot, FOLDER)}\tx\n`);
  const session = sources => readBoardSources([{ id: "current", path: w.claudeRoot }, { id: "shared", path: w.shared }], { now: NOW, ...sources }).find(source => source.id === "shared");
  assert.deepEqual(session({ providerRoots: view.sessionRoots(w.claudeRoot, [w.claudeRoot, w.codexRoot], "claude") }).projects.map(project => project.key), [`shared/${FOLDER}`, `old-codex/${FOLDER}`]);
  assert.deepEqual(session({}).projects.map(project => project.key), [`shared/${FOLDER}`], "a root that the board does not know is not read");
});

test("the hook notes of each provider root join the shared runs: no false may be stuck for a shared Claude run, and a Codex run shows from the logbook", t => {
  const model = modelOf(world(t).sources);
  const lantern = model.agents.projects.find(project => project.name === "lantern");
  const all = lantern.agents.flatMap(agent => [agent, ...agent.children]);
  const agent = id => all.find(item => item.runId === id);
  assert.deepEqual(["R420", "R407", "R412"].map(id => agent(id)?.state), ["work", "work", "unk"]);
  assert.deepEqual(model.agents.unmatched.map(item => item.run).sort(), ["R410", "R411", "R5"], "only the runs that no slot holds");
  assert.equal(agent("R412").provider, "codex");
  assert.doesNotMatch(agent("R420").why ?? "", /may be stuck/);
});

test("a lead slot's logbook mark, as the hook writes it for a linked project, equals the reader's name of the shared folder", t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-shared-link-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_TEST_PIDS: "{}" };
  delete env.SAGE_HOME;
  const project = join(base, "lantern");
  mkdirSync(project);
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "first");
  claude.sage(["link", "--separate", "--project", project], env);
  const chief = claude.chiefFor(project, "session-a", env);
  claude.sage(["task", "add", "--title", "Sample shared task", "--size", "small", "--priority", "P2", "--project", project, "--chief", chief], env);
  const mark = createHash("sha256").update(claude.logbookView(project, env).dir).digest("hex");
  const read = readBoardSources([{ id: "shared", path: sharedRoot(env) }], { now: NOW }).find(source => source.id === "shared");
  assert.equal(read.projects.length, 1);
  assert.equal(read.projects[0].logbook, mark);
  assert.equal(read.projects[0].checkout, realpathSync(project), "the checkout comes from the bindings.tsv row");
  const files = () => readdirSync(sharedRoot(env), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), "hex")]).sort();
  const before = files();
  const chat = claude.sage(["board", "this", "--view", "chat", "--project", project], env);
  assert.match(chat, /\*\*Sample shared task\*\* T1 · not started · Claude · C1 · lantern/);
  mkdirSync(join(project, "sub"));
  assert.match(claude.sage(["board", "this", "--view", "chat", "--project", join(project, "sub")], env), /Sample shared task\*\* T1/);
  assert.match(claude.sage(["board", "T1", "--view", "task", "--project", project], env), /^\*\*Sample shared task\*\* T1\nClaude · C1 · lantern/);
  assert.deepEqual(files(), before, "the board writes nothing");
});

test("the board server: a config with only the two old sources shows the shared project; standardSources lists the shared root", async t => {
  const w = world(t), env = { HOME: join(w.base, "home"), SAGE_SHARED_HOME: w.shared };
  assert.deepEqual(standardSources({ HOME: "/h" }).map(source => [source.id, source.path]), [["claude", "/h/.claude/sage"], ["codex", "/h/.codex/sage"], ["shared", "/h/.sage"]]);
  assert.deepEqual(standardSources({ HOME: "/h", SAGE_HOME: "/s" }).map(source => [source.id, source.path]), [["sage", "/s"], ["shared", "/s/shared"]]);
  const old = w.sources.slice(0, 2);
  assert.deepEqual(readSources(old, env).map(source => source.id), ["claude", "codex", "shared"]);
  assert.deepEqual(readSources(w.sources, env), w.sources, "a config that names the shared root keeps its sources");
  const server = createBoardServer({ sources: readSources(old, env), port: 0, app: APP });
  t.after(() => server.close());
  const { port } = await server.start();
  const model = await boardModel(port), row = id => model.tasks.find(item => item.id === id);
  assert.deepEqual([row("T321").key, row("T321").chief.id, row("T321").chief.provider], [`shared/${FOLDER}/T321`, "C1", "Claude"]);
  assert.ok(row("T96").key.startsWith("codex/"), "the old Codex task shows from the old logbook");
  assert.deepEqual(model.problems, []);
});

const APP = loadBoardApp(fileURLToPath(new URL("../plugins/sage/board/app", import.meta.url)));
async function boardModel(port) {
  const controller = new AbortController(), guard = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/app/events`, { signal: controller.signal }), reader = response.body.getReader(), decoder = new TextDecoder();
    for (let buffer = ""; ;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the app stream ended");
      buffer += decoder.decode(value, { stream: true });
      const frame = buffer.split("\n\n").find(part => part.startsWith("id: ") && part.includes("\nevent: model\n") && buffer.includes(`${part}\n\n`));
      if (frame) return JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
    }
  } finally { clearTimeout(guard); controller.abort(); }
}

const rewrite = (dir, title) => { writeFileSync(join(dir, "tasks.next"), sheet(LEGACY.tasks, [task("T41", title, "building")])); renameSync(join(dir, "tasks.next"), join(dir, "tasks.tsv")); };

test("a table that changes during a read gives a retry; after two more differences the third read stays with the changing note", t => {
  const w = world(t), dir = join(w.claudeRoot, HARBOR), sources = [w.sources[0]];
  const title = key => readBoardSources(sources, { now: NOW, duringRead: key }).find(Boolean).projects.find(project => project.name === HARBOR);
  let writes = 0;
  const once = title((key, attempt) => { if (key.endsWith(HARBOR) && attempt === 1) rewrite(dir, `Write ${++writes}`); });
  assert.equal(once.changing, undefined);
  assert.equal(once.tables.tasks[0].title, "Write 1");
  writes = 0;
  const busy = title((key, attempt) => { if (key.endsWith(HARBOR)) rewrite(dir, `Write ${++writes} after read ${attempt}`); });
  assert.deepEqual([busy.changing?.at, busy.diagnostics, writes], [iso(), [], 3]);
  assert.equal(busy.tables.tasks[0].title, "Write 2 after read 2", "the third read saw the second write");
  const model = buildBoardModel(readBoardSources(sources, { now: NOW, duringRead: (key, attempt) => key.endsWith(HARBOR) && rewrite(dir, `Again ${attempt}`) }), { now: iso() });
  assert.deepEqual(model.changing, [{ project: "harbor", at: iso() }]);
  assert.deepEqual(model.diagnostics, []);
  assert.match(renderBoardText(model), /The logbook is changing: harbor · read at \d\d\\:\d\d UTC\. The board shows that read; ask for the board again for a read with no change\./);
});

test("the server keeps its last good read, not stale, while the logbook changes, and the next read with no change shows it", async t => {
  const w = world(t), dir = join(w.claudeRoot, HARBOR);
  let churn = false, n = 0;
  const server = createBoardServer({ sources: [w.sources[0]], port: 0, settleReads: [], app: APP, duringRead: key => { if (churn && key.endsWith(HARBOR)) rewrite(dir, `Busy write ${++n}`); } });
  t.after(() => server.close());
  const { port } = await server.start();
  assert.match(JSON.stringify(await boardModel(port)), /Legacy task at work/);
  churn = true;
  rewrite(dir, "Trigger title");
  for (const end = Date.now() + 30_000; n < 3 && Date.now() < end;) await new Promise(done => setTimeout(done, 50));
  assert.ok(n >= 3, "the logbook changed during three reads");
  const busy = await boardModel(port), text = JSON.stringify(busy);
  assert.match(text, /Legacy task at work/, "the last good read stays");
  assert.doesNotMatch(text, /Busy write|Trigger title/);
  assert.deepEqual([busy.stale, busy.problems], [false, []], "changing is not a diagnostic");
  churn = false;
  rewrite(dir, "Calm title");
  await until(port, text => text.includes("Calm title"));
});

async function until(port, ok) {
  for (const hangGuardEnd = Date.now() + 30_000; Date.now() < hangGuardEnd;) {
    const model = await boardModel(port);
    if (ok(JSON.stringify(model), model)) return model;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("the board page never matched");
}

test("a legacy project's board is the same with the shared root missing, empty or holding another project", t => {
  const w = world(t), legacy = [w.sources[0]];
  const harbor = sources => { const read = readBoardSources(sources, { now: NOW }); return buildBoardModel(read.map(source => ({ ...source, projects: source.projects.filter(project => project.name === HARBOR) })), { now: iso() }); };
  const views = model => [renderBoardText(model), renderTaskText(model.tasks[0])];
  const today = views(harbor(legacy));
  assert.deepEqual(views(harbor([...legacy, { id: "shared", label: "Shared", path: join(w.base, "no-shared-root") }])), today, "missing shared root");
  const empty = join(w.base, "empty-shared"); mkdirSync(empty);
  assert.deepEqual(views(harbor([...legacy, { id: "shared", label: "Shared", path: empty }])), today, "empty shared root");
  const both = buildBoardModel(readBoardSources([...legacy, w.sources[2]], { now: NOW }), { now: iso() });
  const t41 = both.tasks.find(item => item.id === "T41"), alone = harbor(legacy).tasks[0];
  assert.equal(renderTaskText(t41), renderTaskText(alone));
  assert.equal(t41.holder, undefined);
});

test("F-T624-1: a slot joins the run of its own source when a legacy project runs the same run id in Claude and Codex", t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-shared-twin-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const claudeRoot = join(base, "claude"), codexRoot = join(base, "codex");
  for (const root of [claudeRoot, codexRoot]) logbook(join(root, "app-aaaaaa"), { tasks: [task("T1", "Twin", "building")], runs: [run("R3", "T1", "code-reviewer", "running", iso(-5 * MIN))] }, LEGACY);
  const dir = join(claudeRoot, ".hooks", "slots", "slot-1");
  mkdirSync(dir, { recursive: true });
  for (const mark of ["ok", "project-app", "role-sage_code-reviewer", "run-R3"]) writeFileSync(join(dir, mark), "");
  mkdirSync(join(claudeRoot, ".hooks", "helpers"));
  const agents = modelOf([{ id: "claude", label: "Claude", provider: "claude", path: claudeRoot }, { id: "codex", label: "Codex", provider: "codex", path: codexRoot }]).agents;
  const rows = agents.projects.flatMap(project => project.agents).map(agent => [agent.key, agent.slot ? "slot" : agent.how, agent.state]).sort();
  assert.deepEqual(rows, [["claude/app-aaaaaa/R3", "slot", "work"], ["codex/app-aaaaaa/R3", "logbook", "unk"]]);
  assert.deepEqual(agents.unmatched, []);
});

const replaceFolder = dir => { renameSync(dir, `${dir}.gone`); mkdirSync(dir); for (const name of readdirSync(`${dir}.gone`)) writeFileSync(join(dir, name), readFileSync(join(`${dir}.gone`, name))); rmSync(`${dir}.gone`, { recursive: true }); };

test("F-T624-2: when the third read lost its data, the changing note says what does not show", t => {
  const w = world(t), dir = join(w.claudeRoot, HARBOR), sources = [w.sources[0]];
  const read = readBoardSources(sources, { now: NOW, duringRead: key => key.endsWith(HARBOR) && replaceFolder(dir) });
  const harbor = read[0].projects.find(project => project.name === HARBOR);
  assert.deepEqual([harbor.tables, harbor.diagnostics, harbor.changing], [{}, [], { at: iso(), dropped: ["the whole logbook"] }]);
  const model = buildBoardModel(read, { now: iso() });
  assert.deepEqual(model.changing, [{ project: "harbor", at: iso(), dropped: ["the whole logbook"] }]);
  assert.match(renderBoardText(model), /The logbook is changing: harbor · read at \d\d\\:\d\d UTC, without what changed during it \(the whole logbook\)\. The board shows that read;/);
  const calm = buildBoardModel(readBoardSources(sources, { now: NOW, duringRead: key => key.endsWith(HARBOR) && rewrite(dir, "Busy") }), { now: iso() });
  assert.deepEqual(calm.changing, [{ project: "harbor", at: iso() }]);
  assert.doesNotMatch(renderBoardText(calm), /without what changed/);
});

test("F-T624-3: the in-session board reads its provider's hook notes for a shared run, as the server does", t => {
  const w = world(t);
  const session = view.sessionSources(w.claudeRoot, w.shared, "claude");
  assert.equal(session[0].label, "Current provider", "the legacy label stays");
  const state = sources => { const agents = modelOf(sources).agents.projects.flatMap(project => project.agents.flatMap(agent => [agent, ...agent.children])); return ["R410", "R411", "R412"].map(id => agents.find(agent => agent.runId === id)?.state); };
  assert.deepEqual(state(session), ["stuck", "stuck", "unk"]);
  assert.deepEqual(state(session), state(w.sources), "the same as the server");
});

test("F-T624-4 and F-T624-7: a chief id that chiefs.tsv does not list shows on its task's pages only, not as a setting that the board ignores", t => {
  const model = modelOf(world(t).sources), t324 = card(model, "T324");
  assert.deepEqual(model.warnings, []);
  assert.equal(t324.holder, "C9");
  assert.match(renderTaskText(t324), /\nOwning chief: C9\nC9 is not in chiefs\\\.tsv, so the board does not know its provider\\\.\n/);
  assert.doesNotMatch(renderTaskText(card(model, "T321")), /not in chiefs/);
  assert.doesNotMatch(renderBoardText(model), /Setting ignored|chiefs\\?\.tsv/);
});

test("F-T624-6: a sources.tsv row reads an old logbook only when it has moved.json and its provider is its root's", t => {
  const w = world(t);
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\ncodex\t${join(w.codexRoot, "..", "..", "claude", "sage", HARBOR)}\tx\nclaude\t${join(w.claudeRoot, HARBOR)}\tx\ncodex\t${join(w.claudeRoot, FOLDER)}\tx\n`);
  const read = readBoardSources(w.sources, { now: NOW });
  assert.deepEqual(read.find(source => source.id === "shared").projects.map(project => [project.key, project.diagnostics, project.notes]), [[`shared/${FOLDER}`, [], [2, 3, 4].map(line => `sources: line ${line} does not name a moved logbook of its provider under a provider root`)]]);
  assert.deepEqual(read.find(source => source.id === "claude").projects.map(project => project.key), [`claude/${HARBOR}`, `claude/${FOLDER}`]);
  const t41 = card(buildBoardModel(read, { now: iso() }), "T41");
  assert.deepEqual([t41.key, t41.holder, t41.old], [`claude/${HARBOR}/T41`, undefined, undefined]);
});

test("F-T624-8: a damaged chiefs.tsv gives its one table diagnostic, and no warning for each task", t => {
  const w = world(t);
  writeFileSync(join(w.shared, FOLDER, "chiefs.tsv"), "id\tprovider\nC1\tclaude\n");
  const model = modelOf(w.sources);
  assert.deepEqual(model.warnings, []);
  assert.deepEqual(model.diagnostics.filter(item => item.project === `shared/${FOLDER}`).map(item => item.message), ["chiefs: damaged table"]);
  assert.doesNotMatch(renderTaskText(card(model, "T321")), /not in chiefs/);
});

test("F-T624-12: a milestone that moved with its open task leaves the old logbook, as no stuck or second milestone; a finished old milestone stays", t => {
  const w = world(t), old = join(w.claudeRoot, FOLDER);
  rmSync(old, { recursive: true });
  const gate = (id, taskId) => ({ id, task: taskId, question: "Approve the breakdown?", options: "approve|change|drop", recommendation: "approve", answer: "approve", at: iso(-3 * DAY) });
  logbook(old, {
    tasks: [task("T4", "Sync part one", "merged", { milestone: "M1" }), { ...task("T5", "Sync pilot", "building", { milestone: "M1" }), moved: "T20" }, task("T6", "Old export", "merged", { milestone: "M2" }), { ...task("T7", "Lone pilot", "building", { milestone: "M3" }), moved: "T21" }],
    milestones: [{ id: "M1", name: "Sync", goal: "Sync", pilot: "T5", gate: "G1", at: iso(-3 * DAY) }, { id: "M2", name: "Export", goal: "Export", pilot: "T6", gate: "G2", at: iso(-3 * DAY) }, { id: "M3", name: "Lone", goal: "Lone", pilot: "T7", gate: "G3", at: iso(-3 * DAY) }],
    gates: [gate("G1", "T5"), gate("G2", "T6"), gate("G3", "T7")],
    decisions: ["T4", "T6"].map(id => ({ at: iso(-DAY), task: id, decision: "state merged" })),
  }, LEGACY, { cols: { tasks: `${LEGACY.tasks} milestone moved` }, files: { "checkout.txt": `${w.checkout}\n`, "moved.json": "{}\n" } });
  const model = modelOf(w.sources), lantern = model.projects.find(project => project.name === "lantern");
  assert.deepEqual(model.milestoneNeeds.filter(need => need.group === lantern.key), []);
  assert.equal(lantern.needsOwner, 2, "the two shared tasks only");
  assert.deepEqual(model.milestones.filter(milestone => milestone.group === lantern.key).map(milestone => [milestone.key, milestone.state]), [[`claude/${FOLDER}/M2`, "done"]]);
  assert.equal(card(model, "T4").milestone, null, "a finished task of the moved milestone shows with no milestone");
  assert.doesNotMatch(renderBoardText(model), /M1|M3|is stuck/);
});

test("F-T624-13: the board server reads an old logbook under a provider root that its config leaves out, as the one-shot board does", async t => {
  const w = world(t);
  const server = createBoardServer({ sources: [w.sources[0], w.sources[2]], port: 0, settleReads: [], app: APP, providerRoots: [{ path: w.codexRoot, provider: "codex" }] });
  t.after(() => server.close());
  const { port } = await server.start();
  const model = await boardModel(port);
  assert.ok(model.tasks.find(item => item.id === "T96")?.key.startsWith("old-codex/"), JSON.stringify(model.tasks.map(item => item.key)));
  assert.deepEqual(model.problems, []);
  assert.deepEqual(providerRoots({ HOME: "/h" }), [{ path: "/h/.claude/sage", provider: "claude" }, { path: "/h/.codex/sage", provider: "codex" }]);
  assert.deepEqual(providerRoots({ HOME: "/h", SAGE_HOME: "/s" }), [{ path: "/s", provider: null }]);
});

test("F-T624-9 and F-T624-10: the chat board and the server judge a sources.tsv row by the same provider rule, with one root or two", t => {
  const w = world(t);
  const oldOf = (sources, roots) => { const model = modelOf(sources, { providerRoots: roots }); return [model.notes.map(item => item.message), model.tasks.filter(item => item.old).map(item => [item.id, item.holder])]; };
  const refused = [["sources: line 2 does not name a moved logbook of its provider under a provider root"], []];
  const session = view.sessionSources(w.claudeRoot, w.shared, "claude"), roots = view.sessionRoots(w.claudeRoot, [w.claudeRoot, w.codexRoot], "claude");
  for (const row of [`claude\t${join(w.codexRoot, FOLDER)}`, `codex\t${join(w.claudeRoot, FOLDER)}`]) {
    writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\n${row}\tx\n`);
    assert.deepEqual(oldOf(session, roots), refused, `chat: ${row}`);
    assert.deepEqual(oldOf(w.sources, providerRoots({ HOME: w.base })), refused, `server: ${row}`);
  }
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\ncodex\t${join(w.codexRoot, FOLDER)}\tx\n`);
  assert.deepEqual(oldOf(session, roots), [[], [["T96", "Old · Codex · read-only"]]], "the right provider reads");
  assert.deepEqual(roots, [{ path: w.claudeRoot, provider: "claude" }, { path: w.codexRoot, provider: null }]);
  const one = view.sessionRoots(w.codexRoot, [w.codexRoot], "claude");
  assert.deepEqual(one, [{ path: w.codexRoot, provider: null }]);
  const read = [[], [["T96", "Old · Codex · read-only"]]];
  assert.deepEqual(oldOf(view.sessionSources(w.codexRoot, w.shared, "claude"), one), read, "chat");
  assert.deepEqual(oldOf([{ id: "sage", label: "Sage", path: w.codexRoot }, w.sources[2]], []), read, "server");
});

test("F-T624-11: the changing note names the whole logbook, a table, a file or an artifact in plain words, not a code message", t => {
  const w = world(t), dir = join(w.claudeRoot, HARBOR);
  const read = readBoardSources([w.sources[0]], { now: NOW, duringRead: key => key.endsWith(HARBOR) && replaceFolder(dir) });
  const text = renderBoardText(buildBoardModel(read, { now: iso() }));
  assert.match(text, /without what changed during it \(the whole logbook\)/);
  assert.doesNotMatch(text, /changed during the read/);
  assert.deepEqual(["tasks: file changed during the read", "chiefs: file changed during the read", "observations: file changed during the read", "checkout: file changed during the read", "artifact A3: artifact parent changed during the read", "artifact A4: file changed during the read", "project changed during the read"].map(changedPart),
    ["tasks.tsv", "chiefs.tsv", "observations.json", "checkout.txt", "artifact A3", "artifact A4", "the whole logbook"]);
});

test("T625: a shared run shows its checkout folder under its role, never the path; a gone folder says so, with one note while the task is active", t => {
  const w = world(t), dir = join(w.shared, FOLDER), moved = join(w.base, "moved", "lantern");
  writeFileSync(join(dir, "tasks.tsv"), readFileSync(join(dir, "tasks.tsv"), "utf8") + sheet(COLS.tasks, [task("T330", "Retry a sync", "reviewing", { chief: "C1" }), task("T318", "An ended task", "merged", { chief: "C1" })]).split("\n").slice(1).join("\n"));
  writeFileSync(join(dir, "runs.tsv"), sheet(`${COLS.runs} checkout`, [
    run("R407", "T321", "qa", "running", iso(-50 * MIN), { chief: "C1", checkout: w.checkout }),
    run("R420", "T321", "lead", "running", iso(-60 * MIN), { chief: "C1" }),
    run("R451", "T330", "implementer", "done", iso(-90 * MIN), { chief: "C1", ended: iso(-80 * MIN), checkout: moved, branch: "sage/t330" }),
    run("R452", "T330", "code-reviewer", "running", iso(-20 * MIN), { chief: "C1", checkout: moved }),
    run("R460", "T318", "implementer", "done", iso(-DAY), { chief: "C1", ended: iso(-DAY + MIN), checkout: moved }),
  ]));
  const model = modelOf(w.sources), text = renderTaskText(card(model, "T321"));
  assert.match(text, /^R407 Claude · qa · checkout lantern · in progress · /m);
  assert.match(text, /^R420 Claude · lead · in progress · /m);
  const note = "The folder lantern of R451 is not on this Mac now, so sage cannot read the branch there. The next review step of T330 stops until the folder is back.";
  const activeText = renderTaskText(card(model, "T330"));
  assert.match(activeText, /^R451 Claude · implementer · checkout lantern \(gone\) · done · /m);
  assert.match(activeText, /^R452 Claude · code-reviewer · checkout lantern \(gone\) · in progress · /m);
  assert.ok(activeText.includes(`\n${note}\n\n**Evidence**`), "one line after the runs");
  const endedText = renderTaskText(card(model, "T318"));
  assert.match(endedText, /^R460 Claude · implementer · checkout lantern \(gone\) · done · /m);
  assert.ok(!endedText.includes("is not on this Mac now"));
  for (const out of [text, activeText, endedText, renderBoardText(model), JSON.stringify(model.tasks)]) assert.ok(!out.includes(moved), "no full path");
  writeFileSync(join(w.claudeRoot, HARBOR, "runs.tsv"), sheet(`${LEGACY.runs} checkout`, [run("R5", "T41", "implementer", "running", iso(-5 * MIN), { checkout: moved })]));
  const legacy = renderTaskText(modelOf(w.sources).tasks.find(item => item.id === "T41"));
  assert.match(legacy, /^R5 .* · implementer · in progress · /m);
  assert.ok(!legacy.includes(moved) && !legacy.includes("lantern (gone)"), "a legacy run shows no checkout");
});

function linked(t, extra, { live = extra.map(([path]) => path) } = {}) {
  const w = world(t), at = path => join(w.base, path);
  const row = ([root, when, commits = "a".repeat(40)]) => `${root}\t${FOLDER}\t${commits}\t${when}`;
  writeFileSync(join(w.shared, "bindings.tsv"), ["root\tfolder\tcommits\tat", row([w.checkout, "2026-10-01T00:00:00Z"]), ...extra.map(([path, ...rest]) => row([at(path), ...rest]))].join("\n") + "\n");
  for (const path of live) { mkdirSync(join(at(path), ".git"), { recursive: true }); writeFileSync(join(at(path), ".git", "config"), `[remote "origin"]\n\turl = git@github.com:sample-owner/lantern.git\n`); }
  return { ...w, at };
}
const viewsOf = model => [renderBoardText(model), renderTaskText(card(model, "T321"))];
function withRuns(w, checkouts) {
  writeFileSync(join(w.shared, FOLDER, "runs.tsv"), sheet(`${COLS.runs} checkout`, checkouts.map((checkout, i) => run(`R50${i}`, "T321", "implementer", "running", iso(-(10 + i) * MIN), { chief: "C1", checkout }))));
  const model = modelOf(w.sources), views = viewsOf(model);
  return { model, lantern: model.projects.find(project => project.books.includes(`shared/${FOLDER}`)), views, text: views[1] };
}
const noPath = (w, views) => { for (const out of views) assert.ok(!out.includes(w.base), "no page or chat text holds a checkout path"); };

test("T633: one checkout reads as before: its row adds nothing to the board, the task page or the chat text", t => {
  const w = linked(t, []);
  writeFileSync(join(w.shared, FOLDER, "runs.tsv"), sheet(`${COLS.runs} checkout`, [run("R500", "T321", "implementer", "running", iso(-10 * MIN), { chief: "C1", checkout: w.checkout })]));
  const read = readBoardSources(w.sources, { now: NOW });
  assert.deepEqual(read.find(source => source.shared).projects[0].checkouts, [{ root: w.checkout, gone: false }], "the reader has the row");
  const before = read.map(source => ({ ...source, projects: source.projects.map(({ checkouts, foreignCheckouts, ...project }) => project) }));
  const now = buildBoardModel(read, { now: iso() });
  assert.deepEqual(viewsOf(now), viewsOf(buildBoardModel(before, { now: iso() })));
  assert.equal(now.projects.find(project => project.name === "lantern").sub, "sample-owner/lantern · folder lantern");
  assert.match(viewsOf(now)[1], /^R500 Claude · implementer · checkout lantern · in progress · /m);
  assert.deepEqual(now.notes, []);
});

test("T633: two checkouts of one folder name get #1 and #2 by link order, and a gone #1 keeps #2 on the second", t => {
  const w = linked(t, [["clones/lantern", "2026-10-02T00:00:00Z"]]);
  const both = withRuns(w, [w.checkout, w.at("clones/lantern")]);
  assert.equal(both.lantern.sub, "sample-owner/lantern · 2 checkouts: lantern #1, lantern #2");
  assert.match(both.text, /^R500 Claude · implementer · checkout lantern \\#1 · in progress · /m);
  assert.match(both.text, /^R501 Claude · implementer · checkout lantern \\#2 · in progress · /m);
  noPath(w, both.views);
  rmSync(w.checkout, { recursive: true });
  const gone = withRuns(w, [w.checkout, w.at("clones/lantern")]);
  assert.equal(gone.lantern.sub, "sample-owner/lantern · folder lantern", "only live checkouts count");
  assert.match(gone.text, /^R500 Claude · implementer · checkout lantern \\#1 \(gone\) · in progress · /m);
  assert.match(gone.text, /^R501 Claude · implementer · checkout lantern \\#2 · in progress · /m);
  noPath(w, gone.views);
});

test("T633: a row with no first commit in common is one logbook note with its folder name, and it is not a checkout", t => {
  const w = linked(t, [["work/harbor-new", "2026-10-02T00:00:00Z", "b".repeat(40)]]);
  const { model, lantern, views } = withRuns(w, [w.checkout]);
  assert.equal(lantern.sub, "sample-owner/lantern · folder lantern");
  const message = "A checkout named harbor-new is linked to this logbook, but it has no first commit in common with it. sage does not use that link: commands in harbor-new stop and offer a new link. Ask the chief in harbor-new.";
  assert.deepEqual(model.notes, [{ source: "shared", project: FOLDER, message }]);
  assert.match(views[0].replaceAll("\\", ""), /\nLogbook note: shared · lantern-4be1a2 · A checkout named harbor-new is linked to this logbook/);
  noPath(w, views);
});

test("T633 (Q3): the in-session board of an unlinked clone does not show a shared logbook of the same folder name", t => {
  const w = world(t), clone = join(w.base, "elsewhere", "lantern");
  mkdirSync(clone, { recursive: true });
  const board = (project, here = null) => view.boardView({ sources: w.sources, scope: "this", project, here, format: "chat", now: iso() });
  assert.throws(() => board(clone), /No recorded project matches this board scope/);
  assert.match(board(clone, `shared/${FOLDER}`), /Show the board in both providers\*\* T321/, "a linked clone finds it by its logbook");
  assert.match(board(join(w.base, "harbor")), /Legacy task at work\*\* T41/, "a legacy logbook still matches by folder name");
});

test("T633: one project with two linked clones: the board of this project from either clone, the owner when one is gone, one Agents group", t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-clones-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), SAGE_SHARED_HOME: join(base, "shared"), SAGE_TEST_PIDS: "{}" };
  delete env.SAGE_HOME;
  const a = join(base, "lantern"), b = join(base, "lantern-b");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  mkdirSync(a);
  git(a, "init", "-q", "-b", "main"); git(a, "commit", "-q", "--allow-empty", "-m", "first");
  git(base, "clone", "-q", a, b);
  claude.sage(["link", "--separate", "--project", a], env);
  claude.sage(["link", "--to", basename(claude.logbookView(a, env).dir), "--project", b], env);
  claude.sage(["task", "add", "--title", "Task from clone A", "--size", "small", "--priority", "P2", "--project", a, "--chief", claude.chiefFor(a, "session-a", env)], env);
  claude.sage(["task", "add", "--title", "Task from clone B", "--size", "small", "--priority", "P2", "--project", b, "--chief", claude.chiefFor(b, "session-b", env)], env);
  const chat = project => claude.sage(["board", "this", "--view", "chat", "--project", project], env);
  for (const project of [a, b]) for (const title of ["Task from clone A** T1", "Task from clone B** T2"]) assert.ok(chat(project).includes(title), `${title} from ${basename(project)}`);
  const sources = [{ id: "shared", label: "Shared", path: sharedRoot(env) }];
  assert.deepEqual(modelOf(sources).projects.map(project => [project.name, project.sub]), [["lantern", "no GitHub remote · 2 checkouts: lantern, lantern-b"]]);
  const mark = createHash("sha256").update(claude.logbookView(b, env).dir).digest("hex"), slots = join(env.CLAUDE_CONFIG_DIR, "sage", ".hooks", "slots");
  assert.equal(mark, createHash("sha256").update(claude.logbookView(a, env).dir).digest("hex"));
  const runsFile = join(claude.logbookView(a, env).dir, "runs.tsv"), columns = readFileSync(runsFile, "utf8").split("\n")[0].split("\t").join(" ");
  writeFileSync(runsFile, sheet(columns, [run("R1", "T1", "lead", "running", iso(-MIN), { chief: "C1", checkout: a }), run("R2", "T2", "lead", "running", iso(-MIN), { chief: "C2", checkout: b })]));
  mkdirSync(join(env.CLAUDE_CONFIG_DIR, "sage", ".hooks", "helpers"), { recursive: true });
  for (const [name, runId] of [["slot-1", "R1"], ["slot-2", "R2"]]) { mkdirSync(join(slots, name), { recursive: true }); for (const file of ["ok", "project-lantern", "role-sage_lead", `run-${runId}`, `logbook-${mark}`]) writeFileSync(join(slots, name, file), ""); }
  const agents = modelOf([{ id: "claude", label: "Claude", provider: "claude", path: join(env.CLAUDE_CONFIG_DIR, "sage") }, ...sources]).agents.projects;
  assert.deepEqual(agents.map(group => group.name), ["lantern"]);
  assert.deepEqual(agents[0].agents.map(agent => [agent.runId, agent.state]).sort(), [["R1", "work"], ["R2", "work"]], "each slot holds its run");
  renameSync(a, `${a}.away`);
  assert.ok(chat(b).includes("Task from clone A** T1"));
  assert.equal(readBoardSources(sources, { now: NOW })[0].projects[0].checkout, b);
  assert.equal(modelOf(sources).projects[0].sub, "no GitHub remote · folder lantern-b");
  renameSync(`${a}.away`, a); renameSync(b, `${b}.away`);
  assert.ok(chat(a).includes("Task from clone B** T2"));
  assert.equal(modelOf(sources).projects[0].sub, "no GitHub remote · folder lantern");
});

test("F-T630-1 and F-T624-23: a sources.tsv row that the board cannot search, or a folder name over 255 characters, refuses only its own row", t => {
  const w = world(t), locked = join(w.claudeRoot, "locked-abcdef"), long = join(w.claudeRoot, `${"a".repeat(260)}-abcdef`);
  logbook(locked, { tasks: [task("T1", "Locked", "merged")] }, LEGACY, { files: { "moved.json": "{}\n" } });
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\nclaude\t${join(w.claudeRoot, FOLDER)}\tx\nclaude\t${locked}\tx\nclaude\t${long}\tx\n`);
  chmodSync(locked, 0o000);
  try {
    const shared = readBoardSources(w.sources, { now: NOW }).find(source => source.id === "shared");
    assert.deepEqual(shared.diagnostics, []);
    assert.deepEqual(shared.projects.map(project => project.key), [`shared/${FOLDER}`, `claude/${FOLDER}`], "the shared project and the good row stay");
    assert.deepEqual(shared.projects[0].notes, ["sources: line 3 names a folder that the board cannot read (EACCES)", "sources: line 4 names a folder that the board cannot read (ENAMETOOLONG)"]);
    const model = buildBoardModel(readBoardSources(w.sources, { now: NOW }), { now: iso() });
    assert.ok(card(model, "T321") && card(model, "T316"), "every shared task shows");
    assert.deepEqual(model.notes.map(note => [note.project, note.message]), [["lantern", "sources: line 3 names a folder that the board cannot read (EACCES)"], ["lantern", "sources: line 4 names a folder that the board cannot read (ENAMETOOLONG)"]]);
  } finally { chmodSync(locked, 0o755); }
});

test("F-T624-14: a sources.tsv row reads only under the provider words claude and codex, also under a root of no known provider", t => {
  const w = world(t), session = view.sessionSources(w.claudeRoot, w.shared, "claude"), roots = view.sessionRoots(w.claudeRoot, [w.claudeRoot, w.codexRoot], "claude");
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\ngemini\t${join(w.codexRoot, FOLDER)}\tx\n`);
  const model = modelOf(session, { providerRoots: roots });
  assert.deepEqual(model.tasks.filter(item => item.old).map(item => item.holder), [], "no Old · Gemini task");
  assert.deepEqual(model.notes.map(note => note.message), ["sources: line 2 does not name a moved logbook of its provider under a provider root"]);
  writeFileSync(join(w.shared, FOLDER, "sources.tsv"), `provider\tpath\tat\ncodex\t${join(w.codexRoot, FOLDER)}\tx\n`);
  assert.deepEqual(modelOf(session, { providerRoots: roots }).tasks.filter(item => item.old).map(item => item.holder), ["Old · Codex · read-only"], "the codex word reads there");
});

test("F-T624-15 and F-T624-25: an open gate on a finished old task does not need you; an open row that did not move says that it is open", t => {
  const w = world(t), old = join(w.claudeRoot, FOLDER);
  writeFileSync(join(old, "tasks.tsv"), sheet(`${LEGACY.tasks} moved`, [task("T316", "Old finished task of Claude", "merged"), task("T91", "Open row that did not move", "building")]));
  writeFileSync(join(old, "gates.tsv"), sheet(LEGACY.gates, [{ id: "G7", task: "T316", question: "An open plain gate on a finished old task?", options: "yes|no", at: iso(-DAY) }]));
  const model = modelOf(w.sources);
  assert.deepEqual(card(model, "T316").reasons, []);
  assert.ok(!model.needsOwner.some(item => item.id === "T316"));
  assert.ok(!renderBoardText(model).includes("An open plain gate on a finished old task"), "not in Needs you");
  assert.ok(model.needsOwner.some(item => item.id === "T320"), "a gate of the shared logbook still needs you");
  const open = card(model, "T91");
  assert.deepEqual([open.holder, open.column, open.old.finished], ["Old · Claude · read-only", "building", false]);
  assert.match(renderTaskText(open), /An open task of the old Claude logbook\\\. The move did not take it to the shared logbook\\\. It stays there/);
});

test("F-T624-16: a source of another id at the shared root's path reads as the shared root, as readSources counts it", t => {
  const w = world(t), env = { HOME: join(w.base, "home"), SAGE_SHARED_HOME: w.shared };
  const sources = readSources([...w.sources.slice(0, 2), { id: "mine", label: "Mine", path: w.shared }], env);
  assert.deepEqual(sources.map(source => [source.id, source.label]), [["claude", "Claude"], ["codex", "Codex"], ["shared", "Mine"]]);
  const model = modelOf(sources), lantern = model.projects.find(project => project.books.includes(`shared/${FOLDER}`));
  assert.equal(lantern?.sub, "sample-owner/lantern · folder lantern", "its checkout comes from bindings.tsv");
  assert.equal(card(model, "T321").holder, "Claude · C1");
});

test("F-T624-20: a sources.tsv row that stays refused is a note: the server stays live for every project", async t => {
  const w = world(t), dir = join(w.claudeRoot, HARBOR);
  const server = createBoardServer({ sources: w.sources, port: 0, settleReads: [], app: APP });
  t.after(() => server.close());
  const { port } = await server.start();
  assert.match(JSON.stringify(await boardModel(port)), /Legacy task at work/);
  rmSync(join(w.codexRoot, FOLDER), { recursive: true, force: true });
  await until(port, (text, model) => !model.tasks.some(item => item.key.startsWith("codex/")));
  rewrite(dir, "A change after the refused row");
  const model = await until(port, text => text.includes("A change after the refused row"));
  assert.deepEqual([model.stale, model.problems], [false, []], "a refused row is a note, not a problem");
});

test("F-T624-21: the in-session task view of a shared logbook finds an old finished task by its id", t => {
  const w = world(t), sources = view.sessionSources(w.claudeRoot, w.shared, "claude"), providerRoots = view.sessionRoots(w.claudeRoot, [w.claudeRoot, w.codexRoot], "claude");
  const task = id => view.boardView({ sources, scope: "this", project: w.checkout, logbookKey: `shared/${FOLDER}`, providerRoots, taskId: id, format: "task" });
  assert.match(task("T316"), /^\*\*Old finished task of Claude\*\* T316\nOld · Claude · read-only/);
  assert.match(task("T96"), /^\*\*Old finished task of Codex\*\* T96\nOld · Codex · read-only/);
  assert.match(task("T321"), /^\*\*Show the board in both providers\*\* T321\nClaude · C1/);
});

test("F-T624-22: a shared root that is a link or a file gives a legacy-only owner one quiet note, not a lasting diagnostic", t => {
  const w = world(t), link = join(w.base, "shared-link"), file = join(w.base, "shared-file");
  symlinkSync(w.shared, link); writeFileSync(file, "");
  for (const [path, what] of [[link, "a link"], [file, "not a folder"]]) {
    const model = modelOf([w.sources[0], { id: "shared", label: "Shared", path }]);
    assert.deepEqual(model.diagnostics, [], path);
    assert.deepEqual(model.notes, [{ source: "shared", project: "Shared", message: `The shared root is ${what}, so the board reads no shared project there.` }]);
    assert.ok(card(model, "T41"), "the legacy project shows");
    assert.doesNotMatch(renderBoardText(model), /Incomplete source/);
  }
});

test("F-T625-2, F-T625-5 and F-T625-6: a checkout name loses bidi characters; a folder past the 64 checks says not checked; a file or an empty folder is gone", t => {
  const w = world(t), dir = join(w.shared, FOLDER), bidi = join(w.base, "abc‮fdp.exe"), file = join(w.base, "now-a-file"), empty = join(w.base, "now-empty");
  writeFileSync(file, ""); mkdirSync(empty);
  const many = Array.from({ length: 64 }, (_, i) => join(w.base, `c${i}`));
  writeFileSync(join(dir, "runs.tsv"), sheet(`${COLS.runs} checkout`, [
    run("R1", "T321", "implementer", "done", iso(-90 * MIN), { chief: "C1", checkout: bidi, branch: "sage/t321" }),
    run("R2", "T321", "implementer", "done", iso(-80 * MIN), { chief: "C1", checkout: file, branch: "sage/t321" }),
    run("R3", "T321", "implementer", "done", iso(-70 * MIN), { chief: "C1", checkout: empty, branch: "sage/t321" }),
    ...many.map((checkout, i) => run(`R${i + 10}`, "T320", "qa", "done", iso(-60 * MIN), { chief: "C1", checkout })),
    run("R90", "T320", "qa", "running", iso(-MIN), { chief: "C1", checkout: w.checkout }),
  ]));
  const model = modelOf(w.sources), t321 = renderTaskText(card(model, "T321"));
  assert.ok(!t321.includes("\u202e") && t321.includes("checkout abcfdp\\.exe"), "no bidi character in the task text");
  assert.match(t321, /^R2 Claude · implementer · checkout now-a-file \(gone\) · /m);
  assert.match(t321, /^R3 Claude · implementer · checkout now-empty \(gone\) · /m);
  assert.equal(card(model, "T321").goneRun, "R3", "the newest writer run's folder stops the review");
  assert.equal(card(model, "T321").runs[0].checkoutName, "abcfdp.exe");
  const t320 = card(model, "T320"), past = t320.runs.find(item => item.id === "R90");
  assert.deepEqual([past.checkoutName, past.checkoutGone], ["lantern", null], "the 68th distinct path is not checked");
  assert.equal(t320.runs.find(item => item.id === "R10").checkoutGone, true, "a path within the 64 checks is");
  assert.match(renderTaskText(t320), /^R90 Claude · qa · checkout lantern \(not checked\) · in progress · /m);
});

test("F-T624-5: the takeover gate's recommendation says when, as the design does: when you know that the chief stopped", t => {
  const model = modelOf(world(t).sources);
  assert.equal(card(model, "T320").reasons[0].recommendation, "approve, when you know that Claude · C1 stopped");
  assert.match(renderBoardText(model), /Recommended: approve, when you know that Claude · C1 stopped/);
});

test("T656: the takeover gate's recommendation says that the owning chief offered the task, when its open offer names the gate's new chief; a task with no owning chief says so", t => {
  const w = world(t), file = join(w.shared, FOLDER, "gates.tsv"), label = id => `${id} (${id === "C1" ? "claude" : "codex"})`;
  const gate = (id, taskId, from, to, fresh = false) => [id, taskId, replaceQuestion({ from, to, task: taskId, title: "x", runs: [], label, fresh }), "approve|decline", "approve", "", "", iso(-MIN), "replace"].join("\t");
  const old = ["G11", "T324", "Replace chief C9 of T324 with C1 (claude)? Runs that end as failed: none. Replace: C1 owns T324, each of those runs ends as failed and work that it did not report may be lost, C9 can no longer write T324, and an open offer is cleared. Then C1 goes on with T324. Keep: nothing changes, and C9 stays the owning chief. Title of T324: x", "replace|keep", "replace", "", "", iso(-MIN), "replace"].join("\t");
  writeFileSync(file, `${readFileSync(file, "utf8")}${[gate("G8", "T321", "C1", "C2"), gate("G9", "T323", "C2", "C2"), gate("G10", "T322", "", "C1", true), old].join("\n")}\n`);
  const model = modelOf(w.sources), first = id => card(model, id).reasons.find(reason => reason.replace);
  assert.deepEqual([first("T321").text, first("T321").recommendation], ["Hand T321 and PR 88 from Claude · C1 to Codex · C2? No run ends as failed.", "approve, because Claude · C1 offered T321 to Codex · C2"]);
  assert.equal(first("T323").recommendation, "approve, because no run of T323 ends as failed", "an offer to another chief is not this gate's");
  assert.deepEqual([first("T322").text, first("T322").recommendation], ["Hand T322 to Claude · C1? It has no owning chief. No run ends as failed. Claude · C1 runs one fresh cycle before it merges.", "approve, because T322 has no owning chief"]);
  assert.deepEqual([first("T324").text, first("T324").recommendation], ["Hand T324 from C9 to Claude · C1? No run ends as failed.", "replace, because no run of T324 ends as failed"]);
  assert.equal(card(model, "T320").reasons[0].recommendation, "approve, when you know that Claude · C1 stopped", "a gate with no offer keeps the T631 text");
  assert.match(renderBoardText(model), /Recommended: approve, because Claude · C1 offered T321 to Codex · C2/);
});

test("T656: inferred work on an open PR reads the owning chief's provider, not the codex/ prefix of the branch, which a takeover keeps", () => {
  const head = "c".repeat(40), at = iso();
  const pr = (taskId, number) => ({ id: `O${number}`, task: taskId, kind: "pr", source: "sample recorder", basis: "observed", observedAt: at, recordedAt: at, data: { number, head, state: "open" } });
  const tasks = [task("T1", "Taken from Codex", "reviewing", { chief: "C1", branch: "codex/t1-retry", pr: "12" }), task("T2", "Codex work", "reviewing", { chief: "C2", branch: "sage/t2-sync", pr: "13" })];
  const project = { key: `shared/${FOLDER}`, name: FOLDER, shared: true, chiefs: [{ id: "C1", provider: "claude" }, { id: "C2", provider: "codex" }], diagnostics: [], tables: { tasks }, observations: { version: 1, records: [pr("T1", 12), pr("T2", 13)] } };
  const model = buildBoardModel([{ id: "shared", label: "Shared", diagnostics: [], projects: [project] }], { now: at });
  assert.deepEqual(model.tasks.map(item => [item.id, item.inferredWork]), [["T1", false], ["T2", true]]);
  assert.equal(model.counts.inferredWork, 1);
});

test("F-T624-24 and F-T624-19: a shared run with no chief stands in as Unknown, not Shared; an old logbook's milestone names that logbook", t => {
  const w = world(t), model = modelOf(w.sources), t322 = card(model, "T322");
  assert.match(renderTaskText(t322), /^R430 Unknown \(the run names no chief\) · implementer · done/m);
  assert.doesNotMatch(renderTaskText(t322), /Shared \(logbook source\)/);
  assert.equal(card(model, "T316").providerStandIn, "claude");
  assert.equal(card(model, "T41").providerStandIn, "claude");
  const old = join(w.claudeRoot, FOLDER);
  rmSync(old, { recursive: true });
  logbook(old, {
    tasks: [task("T6", "Old export", "merged", { milestone: "M2" })],
    milestones: [{ id: "M2", name: "Export", goal: "Export", pilot: "T6", gate: "G2", at: iso(-3 * DAY) }],
    gates: [{ id: "G2", task: "T6", question: "Approve the breakdown?", options: "approve|change|drop", recommendation: "approve", answer: "approve", at: iso(-3 * DAY) }],
    decisions: [{ at: iso(-DAY), task: "T6", decision: "state merged" }],
  }, LEGACY, { cols: { tasks: `${LEGACY.tasks} milestone moved` }, files: { "checkout.txt": `${w.checkout}\n`, "moved.json": "{}\n" } });
  const milestones = modelOf(w.sources).milestones.filter(milestone => milestone.id === "M2");
  assert.deepEqual(milestones.map(milestone => [milestone.key, milestone.sourceLabel]), [[`claude/${FOLDER}/M2`, "Old Claude"]]);
});

test("F-T625-4, F-T625-8 and F-T625-9: only the gone folder of the branch's newest writer run stops the review, and its note names that run", t => {
  const w = world(t), dir = join(w.shared, FOLDER), gone1 = join(w.base, "moved", "lantern"), gone2 = join(w.base, "other", "lantern");
  writeFileSync(join(dir, "tasks.tsv"), readFileSync(join(dir, "tasks.tsv"), "utf8") + sheet(COLS.tasks, [task("T330", "Retry a sync", "reviewing", { chief: "C1" })]).split("\n").slice(1).join("\n"));
  const runs = list => writeFileSync(join(dir, "runs.tsv"), sheet(`${COLS.runs} checkout`, list));
  const writer = (id, at, checkout) => run(id, "T330", "implementer", "done", iso(-at * MIN), { chief: "C1", ended: iso(-(at - 5) * MIN), checkout, branch: "sage/t330" });
  const view = () => { const model = modelOf(w.sources); return { text: renderTaskText(card(model, "T330")), task: card(model, "T330") }; };
  runs([writer("R451", 90, gone1), writer("R455", 40, w.checkout), run("R456", "T330", "qa", "done", iso(-30 * MIN), { chief: "C1", checkout: gone2 })]);
  let page = view();
  assert.equal(page.task.goneRun, null);
  assert.ok(!page.text.includes("is not on this Mac now"));
  runs([writer("R451", 90, gone1), writer("R455", 40, gone2), run("R407", "T330", "qa", "done", iso(-20 * MIN), { chief: "C1", checkout: w.checkout })]);
  page = view();
  assert.equal(page.task.goneRun, "R455");
  assert.ok(page.text.includes("\nThe folder lantern of R455 is not on this Mac now, so sage cannot read the branch there. The next review step of T330 stops until the folder is back.\n"));
  runs([writer("R451", 90, w.checkout), { ...writer("R460", 10, gone1), branch: "sage/other" }]);
  assert.equal(view().task.goneRun, null);
});

test("F-T630-2 and F-T633-10: a project named by its folder, and the picker's folder line, keep no bidi or control character", t => {
  const w = world(t), folder = join(w.base, "evil\u202egnp.exe\u2028");
  mkdirSync(join(folder, ".git"), { recursive: true });
  logbook(join(w.claudeRoot, "evil-abc123"), { tasks: [task("T1", "A task", "framed")] }, LEGACY, { files: { "checkout.txt": `${folder}\n` } });
  const model = modelOf(w.sources), project = model.projects.find(item => item.books.includes("claude/evil-abc123"));
  assert.deepEqual([project.name, project.sub], ["evilgnp.exe", "no GitHub remote · folder evilgnp.exe"]);
  const all = renderBoardText(model);
  assert.ok(!/[\u202e\u2028]/.test(all), "no bidi or line separator on a page or in the chat");
});

test("F-T630-3: the picker counts a linked checkout by the run rule: a folder with no Git checkout is gone in both", t => {
  const w = linked(t, [["clones/lantern-b", "2026-10-02T00:00:00Z"]], { live: [] });
  mkdirSync(w.at("clones/lantern-b"), { recursive: true });
  const { model, lantern } = withRuns(w, [w.checkout, w.at("clones/lantern-b")]);
  assert.equal(lantern.sub, "sample-owner/lantern · folder lantern", "one live checkout");
  assert.equal(card(model, "T321").runs.find(item => item.id === "R501").checkoutGone, true);
});

test("F-T633-7: with the first checkout gone, a live clone keeps the logbook, and the note names the foreign row, not the clone", t => {
  const w = linked(t, [["work/harbor-new", "2026-10-02T00:00:00Z", "b".repeat(40)], ["clones/lantern-c", "2026-10-03T00:00:00Z"]]);
  rmSync(w.checkout, { recursive: true });
  const { model, lantern } = withRuns(w, [w.at("clones/lantern-c")]);
  assert.equal(lantern.sub, "sample-owner/lantern · folder lantern-c", "the live clone names the project");
  assert.deepEqual(model.notes.map(note => note.message.split(" is linked")[0]), ["A checkout named harbor-new"]);
});

test("F-T633-11: the task lookup from a linked second clone finds the shared project, also with the same folder name", t => {
  const w = linked(t, [["clones/lantern", "2026-10-02T00:00:00Z"]]);
  const text = view.boardView({ sources: w.sources, scope: "this", project: w.at("clones/lantern"), taskId: "T321", format: "task" });
  assert.match(text, /^\*\*Show the board in both providers\*\* T321/);
});

test("F-T633-12: a folder named lantern #2 beside two lantern folders gets its own label", t => {
  const w = linked(t, [["clones/lantern", "2026-10-02T00:00:00Z"], ["work/lantern #2", "2026-10-03T00:00:00Z"]]);
  const { lantern } = withRuns(w, [w.checkout]);
  assert.equal(lantern.sub, "sample-owner/lantern · 3 checkouts: lantern #1, lantern #2, lantern #2 #3");
});
