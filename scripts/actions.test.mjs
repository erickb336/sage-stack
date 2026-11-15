import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { actionOf, appendAction, readActions } from "../packages/sage-core/actions.mjs";

const CWD = "/work/sample-project", HOME = "/home/sample";
const target = (tool, input, cwd = CWD) => actionOf({ run: "R7", tool, input, call: "toolu_sample", cwd, home: HOME, at: 0 })?.target;
const scratch = t => { const dir = mkdtempSync(join(tmpdir(), "sage-actions-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const record = (i, run = "R1") => actionOf({ run, tool: "Read", input: { file_path: `src/sample-${i}.mjs` }, call: `toolu_${i}`, cwd: CWD, home: HOME, at: Date.UTC(2026, 10, 14, 12, 0, 0, i) });

test("T1088 5.1 row 1: a file tool keeps only a path inside the agent's folder, with safe segments, cut to 80 characters", () => {
  assert.equal(target("Read", { file_path: `${CWD}/packages/sage-core/board-model.mjs` }), "packages/sage-core/board-model.mjs");
  assert.equal(target("Edit", { file_path: "src/app.js", old_string: "a", new_string: "b" }), "src/app.js", "a relative path is inside the folder");
  assert.equal(target("Write", { file_path: "/etc/passwd", content: "x" }), "a file outside the worktree");
  assert.equal(target("Read", { file_path: "src/../../other/file.js" }), "a file outside the worktree", "a path that climbs out is outside");
  assert.equal(target("Read", { file_path: `${HOME}/notes.txt` }, HOME), "a file outside the worktree", "a path under the home folder never shows, also when the agent's folder is the home folder");
  for (const name of [".env", ".env.local", "server.pem", "deploy.key", "id_ed25519", ".npmrc", ".netrc", "credentials.json", ".ssh/config", ".aws/config"])
    assert.equal(target("Read", { file_path: name }), "a secrets file", name);
  assert.equal(target("Read", { file_path: "src/my file?.js" }), "a file with an unusual name", "a segment with an unsafe character");
  assert.equal(target("NotebookEdit", { notebook_path: "notebooks/sample.ipynb" }), "notebooks/sample.ipynb");
  const long = `${"deep/".repeat(30)}file.mjs`, kept = target("MultiEdit", { file_path: long });
  assert.equal(kept.length, 80); assert.ok(kept.startsWith("…") && long.endsWith(kept.slice(1)), "the last 80 characters");
  assert.equal(target("Read", {}), null, "no path, no target");
});

test("T1088 5.1 row 2: a search keeps its folder by the path rule, never the pattern or the glob", () => {
  assert.equal(target("Grep", { pattern: "sk-sample-pattern", path: "packages", glob: "*.secret" }), "packages");
  assert.equal(target("Glob", { pattern: "**/*.mjs" }), null);
  assert.equal(target("Grep", { pattern: "x", path: "/var/private" }), "a file outside the worktree");
});

test("T1088 5.1 row 3: a command keeps the first program word, a known git, npm or gh subcommand and a count; never an argument, an assignment or a body", () => {
  assert.equal(target("Bash", { command: "TOKEN=sample curl -H 'Authorization: Bearer sample' https://example.com/x?token=sample" }), "curl");
  assert.equal(target("Bash", { command: "git -C /work/other -c user.email=x@y.z commit -m 'sample message'" }), "git commit");
  assert.equal(target("Bash", { command: "npm run build && npm test" }), "npm run +1 more");
  assert.equal(target("Bash", { command: "gh pr create --title sample" }), "gh pr");
  assert.equal(target("Bash", { command: "git sample-unknown-subcommand" }), "git", "a subcommand outside the list is dropped");
  assert.equal(target("Bash", { command: "cat <<'EOF'\nsample body\nEOF" }), "cat");
  assert.equal(target("Bash", { command: "/usr/local/bin/node script.mjs | tee out.txt" }), "node +1 more", "a program path keeps its basename");
  assert.equal(target("Bash", { command: "Sample-Program --x" }), "a command", "a program word with an unsafe shape");
  assert.equal(target("Monitor", { command: "tail -f log.txt" }), "tail");
  assert.equal(target("PowerShell", { command: "ls" }), "ls");
  assert.equal(target("mcp__terminal__run_in_terminal", { command: "npm ci" }), "npm ci");
});

test("T1088 5.1 row 4: a web fetch keeps only the URL host", () => {
  assert.equal(target("WebFetch", { url: "https://user:pass@docs.example.com:8443/path/x?token=1#part", prompt: "sample" }), "docs.example.com");
  assert.equal(target("WebFetch", { url: "not a url" }), null);
  assert.equal(target("WebSearch", { query: "sample query" }), null);
});

test("T1088 5.1 row 5: an agent start keeps the role and the run of the new agent, never the prompt", () => {
  assert.equal(target("Agent", { subagent_type: "sage:qa", prompt: "Run R4120 · task T1 (qa)\nGOAL sample" }), "sage:qa R4120");
  assert.equal(target("Task", { subagent_type: "Explore", prompt: "sample prompt" }), "an agent", "only a sage role's name shows");
});

test("T1088 5.1 row 6: a message keeps the recipient only when it is main, a lead or a run", () => {
  assert.equal(target("SendMessage", { to: "lead-T12", message: "sample" }), "lead-T12");
  assert.equal(target("SendMessage", { to: "main", message: "sample" }), "main");
  assert.equal(target("SendMessage", { to: "someone else", message: "sample" }), null);
});

test("T1088 5.1 row 7: an MCP tool keeps server:tool and drops its arguments", () => {
  const found = actionOf({ run: "R7", tool: "mcp__sample-server__create_item", input: { body: "sample" }, cwd: CWD, home: HOME });
  assert.deepEqual([found.tool, found.kind, found.target], ["sample-server:create_item", "mcp", null]);
});

test("T1088 5.1 row 8: any other tool keeps its name, and a tool name with an unsafe shape becomes unknown", () => {
  const other = actionOf({ run: "R7", tool: "TodoWrite", input: { todos: ["sample"] }, cwd: CWD, home: HOME });
  assert.deepEqual([other.tool, other.kind, other.target], ["TodoWrite", "other", null]);
  assert.equal(actionOf({ run: "R7", tool: "Read​", input: {}, cwd: CWD, home: HOME }).tool, "unknown");
  const end = actionOf({ run: "R7", tool: "Read", input: { file_path: "src/a.js" }, mark: "end", at: 0 });
  assert.deepEqual(end, { v: 1, at: "1970-01-01T00:00:00.000Z", run: "R7", tool: "end", kind: "end", target: null, call: "00000000", mark: "end" });
  assert.equal(actionOf({ run: "7", tool: "Read" }), null, "no run, no record");
  assert.equal(actionOf({ run: "R7", tool: "Read", mark: "maybe" }), null);
});

test("T1088 5.1: kept strings lose control and format characters, and the call is a hash, never the raw id", () => {
  assert.equal(target("Read", { file_path: "src/a‮b.js" }), "a file with an unusual name");
  assert.equal(target("SendMessage", { to: "main​" }), null);
  const found = actionOf({ run: "R7", tool: "Read", input: {}, call: "toolu_01SAMPLE", cwd: CWD, home: HOME });
  assert.match(found.call, /^[0-9a-f]{8}$/); assert.ok(!JSON.stringify(found).includes("toolu_01SAMPLE"));
});

test("T1088 K1: 400 random secrets, each planted in every dropped field of every tool, never reach a record", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_./=:?&%+@";
  const secretOf = () => `Q${[...randomBytes(12 + randomBytes(1)[0] % 28)].map(byte => alphabet[byte % alphabet.length]).join("")}`;
  for (let i = 0; i < 400; i++) {
    const s = secretOf(), word = `q${randomBytes(8).toString("hex")}`;
    const cases = [
      ["Read", { file_path: `/opt/${s}/file.txt` }, CWD], ["Read", { file_path: `.env.${s}` }, CWD], ["Read", { file_path: `${CWD}/src/x.js` }, `/work/${s}`],
      ["Read", { file_path: `src/${s}?` }, CWD], ["Read", { file_path: `${HOME}/${s}` }, HOME],
      ["Edit", { file_path: "src/a.js", old_string: s, new_string: s, replace_all: s }, CWD], ["Write", { file_path: "src/a.js", content: s }, CWD],
      ["MultiEdit", { file_path: "src/a.js", edits: [{ old_string: s, new_string: s }] }, CWD], ["NotebookEdit", { notebook_path: "n.ipynb", new_source: s }, CWD],
      ["Grep", { pattern: s, glob: s, type: s, path: `/srv/${s}` }, CWD], ["Glob", { pattern: s, path: "src" }, CWD],
      ["Bash", { command: `TOKEN=${s} curl -H "Authorization: Bearer ${s}" "https://example.com/${s}?token=${s}" | tee '${s}'`, description: s }, CWD],
      ["Bash", { command: `${word.toUpperCase()}_KEY='${s}' git -C '/work/${s}' -c 'user.name=${s}' push origin '${s}'` }, CWD],
      ["Bash", { command: `cat <<'EOF'\n${s}\nEOF` }, CWD], ["Bash", { command: ["npm", "run", s] }, CWD], ["Bash", { command: `echo '${s}' > '/tmp/${s}' && gh api '${s}'` }, CWD],
      ["Monitor", { command: `${word} --token '${s}'`, description: s }, CWD], ["PowerShell", { command: `Write-Output '${s}'` }, CWD],
      ["mcp__terminal__run_in_terminal", { command: `node -e '${s}'`, cwd: s }, CWD],
      ["WebFetch", { url: `https://${encodeURIComponent(s)}:${encodeURIComponent(s)}@docs.example.com/${encodeURIComponent(s)}?q=${encodeURIComponent(s)}#${encodeURIComponent(s)}`, prompt: s }, CWD],
      ["WebSearch", { query: s, allowed_domains: [s] }, CWD],
      ["Agent", { subagent_type: "sage:qa", description: s, prompt: `Run R12 · task T3 (qa)\n${s}`, name: s }, CWD], ["Task", { subagent_type: s, prompt: s }, CWD],
      ["SendMessage", { to: s, message: s, summary: s }, CWD], ["TaskStop", { task_id: s }, CWD],
      [`mcp__sample__${word}`, { body: s, title: s }, CWD], ["TodoWrite", { todos: [{ content: s }] }, CWD], ["UnknownTool", s, CWD],
    ];
    for (const [tool, input, cwd] of cases) {
      for (const mark of ["ok", "refused", "failed"]) {
        const found = actionOf({ run: "R12", tool, input, call: s, cwd, mark, home: HOME });
        assert.ok(found, `${tool} gives a record`);
        assert.ok(!JSON.stringify(found).includes(s) && !JSON.stringify(found).includes(encodeURIComponent(s)), `${tool} leaked a planted secret: ${JSON.stringify(found)}`);
      }
    }
  }
});

test("T1088: appendAction appends one valid line, and readActions reads it back", t => {
  const logbook = join(scratch(t), "project-abcdef"); mkdirSync(logbook);
  appendAction(logbook, record(1));
  assert.deepEqual(readActions(logbook, "R1"), { actions: [record(1)], dropped: 0 });
  assert.equal(lstatSync(join(logbook, "actions")).mode & 0o777, 0o700); assert.equal(lstatSync(join(logbook, "actions", "R1.jsonl")).mode & 0o777, 0o600);
  assert.throws(() => appendAction(logbook, { ...record(2), input: "sample" }), TypeError, "only a record of actionOf");
  assert.throws(() => appendAction(join(logbook, "missing-abcdef"), record(2)), { code: "ENOENT" }, "it never makes a logbook folder");
  const outside = join(logbook, "..", "outside"); mkdirSync(outside);
  rmSync(join(logbook, "actions"), { recursive: true }); symlinkSync(outside, join(logbook, "actions"));
  assert.throws(() => appendAction(logbook, record(2)), { code: "ELOOP" }, "a linked actions folder");
  rmSync(join(logbook, "actions")); mkdirSync(join(logbook, "actions")); symlinkSync(join(outside, "x"), join(logbook, "actions", "R1.jsonl"));
  assert.throws(() => appendAction(logbook, record(2)), { code: "ELOOP" }, "a linked action file");
  assert.deepEqual(readdirSync(outside), [], "nothing is written through a link");
});

test("T1088: one writer's file never holds more than 20 lines after a compaction, and the reader always gets the last 20", t => {
  const logbook = join(scratch(t), "project-abcdef"), file = join(logbook, "actions", "R1.jsonl"); mkdirSync(logbook);
  let compactions = 0, before = 0;
  for (let i = 1; i <= 200; i++) {
    appendAction(logbook, record(i));
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    if (lines.length < before) { compactions++; assert.ok(lines.length <= 20, `${lines.length} lines after a compaction`); }
    before = lines.length;
    assert.ok(readFileSync(file).length <= 8 * 1024 + 300, "the file stays near 8 KiB");
    assert.deepEqual(readActions(logbook, "R1").actions.map(item => item.call), Array.from({ length: Math.min(i, 20) }, (_, k) => record(i - Math.min(i, 20) + k + 1).call));
  }
  assert.ok(compactions >= 2, `${compactions} compactions in 200 lines`);
});

test("T1088: 8 parallel writers of 100 lines each leave only whole, valid lines, at most 20 after the last compaction", async t => {
  const logbook = join(scratch(t), "project-abcdef"), file = join(logbook, "actions", "R1.jsonl"); mkdirSync(logbook);
  const code = `const { workerData } = require("node:worker_threads");
    import(workerData.module).then(({ actionOf, appendAction }) => {
      for (let i = 0; i < 100; i++) appendAction(workerData.logbook, actionOf({ run: "R1", tool: "Read", input: { file_path: "src/w" + workerData.w + "-" + i + ".mjs" }, call: "c" + workerData.w + "-" + i, cwd: "/work/sample", home: "/home/sample" }));
    });`;
  const module = new URL("../packages/sage-core/actions.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, w) => new Promise((done, fail) => {
    const worker = new Worker(code, { eval: true, workerData: { module, logbook, w } });
    worker.on("error", fail); worker.on("exit", code => code === 0 ? done() : fail(new Error(`writer ${w} ended with ${code}`)));
  })));
  const lines = readFileSync(file, "utf8").split("\n");
  assert.equal(lines.pop(), "", "the file ends with a whole line");
  for (const line of lines) assert.equal(JSON.parse(line).run, "R1", line);
  assert.equal(readActions(logbook, "R1").dropped, 0, "every line is a valid record");
  assert.ok(lines.length >= 20 && Buffer.byteLength(lines.join("\n")) <= 8 * 1024 + 8 * 300, `${lines.length} lines stay under the cap and its slack`);
  const count = () => readFileSync(file, "utf8").trimEnd().split("\n").length;
  for (let i = 0, before = count(); i < 100; i++, before = count()) { appendAction(logbook, record(1000 + i)); if (count() < before) break; }
  const after = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.ok(after.length <= 20, `${after.length} lines after the last compaction`);
  assert.deepEqual(readActions(logbook, "R1").actions.length, after.length);
  assert.deepEqual(readdirSync(join(logbook, "actions")), ["R1.jsonl"], "no temporary file stays");
});

test("T1088 retention: a run's first line deletes action files with no write for 7 days, and keeps newer ones", t => {
  const logbook = join(scratch(t), "project-abcdef"), dir = join(logbook, "actions"), now = Date.UTC(2026, 10, 14);
  mkdirSync(dir, { recursive: true });
  const old = (name, days) => { writeFileSync(join(dir, name), "x\n"); const at = new Date(now - days * 86_400_000); utimesSync(join(dir, name), at, at); };
  old("R1.jsonl", 8); old("R2.jsonl", 6); old(".R3.00000000-0000-4000-8000-000000000000.tmp", 9); old("notes.txt", 30);
  appendAction(logbook, record(1, "R4"), { now });
  assert.deepEqual(readdirSync(dir).sort(), ["R2.jsonl", "R4.jsonl", "notes.txt"]);
  old("R5.jsonl", 8);
  appendAction(logbook, record(2, "R4"), { now });
  assert.ok(readdirSync(dir).includes("R5.jsonl"), "a later line of the same run sweeps nothing");
});
