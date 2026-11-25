import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { sandboxLine, sandboxState } from "../packages/sage-core/index.mjs";
import { parseToml } from "../packages/sage-core/toml.mjs";
import { sandboxPlaces } from "../plugins/sage/skills/sage/sage.mjs";
import { sandboxPlaces as codexPlaces } from "../plugins/sage-codex/skills/sage/sage.mjs";

const CLAUDE_TOOL = join(ROOT, "plugins/sage/skills/sage/sage.mjs"), CODEX_TOOL = join(ROOT, "plugins/sage-codex/skills/sage/sage.mjs");

function guideBlock(file, heading, lang) {
  const text = readFileSync(join(ROOT, file), "utf8"), start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `${file} has the section ${heading}`);
  const section = text.slice(start, text.indexOf("\n## ", start + 1)).replace(/^ {3}/gm, "");
  return new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(section)[1];
}
const CLAUDE_BLOCK = guideBlock("docs/guide/using-sage.md", "Turn on the sandbox", "json");
const CODEX_BLOCK = guideBlock("docs/guide/codex.md", "Turn on the sandbox", "toml");

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-sandbox-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), project = join(home, "work", "app"), system = join(dir, "system");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(system);
  const env = { HOME: home, SAGE_HOME: join(dir, "sage"), TMPDIR: join(dir, "private-temp-value") };
  const write = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const claude = (text) => write(join(home, ".claude", "settings.json"), typeof text === "string" ? text : JSON.stringify(text));
  const codex = (text) => write(join(home, ".codex", "config.toml"), text);
  const managed = join(system, "ClaudeCode"), systemConfig = join(system, "codex", "config.toml");
  const places = (all) => ({ claude: { ...all.claude, managed }, codex: { ...all.codex, system: systemConfig } });
  const state = (provider, more = {}, cwd = project) => sandboxState(provider, { env: { ...env, ...more }, cwd, places: places(sandboxPlaces({ ...env, ...more }))[provider] });
  const line = (provider, more = {}) => sandboxLine(state(provider, more), { env: { ...env, ...more }, cwd: project });
  return { dir, home, project, system, managed, systemConfig, env, write, claude, codex, state, line };
}

const settings = (sandbox, permissions) => ({ ...(permissions ? { permissions } : {}), sandbox });
const FAILS_CLOSED = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };

test("Claude Code: the guide's block reads as on and fails closed, with the folders that it lets a command write", (t) => {
  const s = scratch(t);
  s.claude(CLAUDE_BLOCK);
  const found = s.state("claude");
  assert.equal(found.state, "on");
  assert.deepEqual(found.missing, []);
  assert.equal(found.network, true);
  for (const root of [s.project, "$TMPDIR", join(s.home, "sage-worktrees"), "/tmp", "/private/tmp"]) assert.ok(found.writes.includes(root), `${root} is a write root`);
  assert.equal(s.line("claude"), "Claude Code: on, fails closed · writes: the project, $TMPDIR, ~/sage-worktrees, /tmp, /private/tmp · network: on · 3 command patterns run outside the sandbox · missing: none");
});

test("Claude Code: with no settings file the sandbox is off, and the line names each key that the guide sets", (t) => {
  const s = scratch(t);
  assert.equal(s.state("claude").state, "off");
  assert.deepEqual(s.state("claude").writes, []);
  assert.equal(s.line("claude"), 'Claude Code: off · missing: sandbox.enabled: true; sandbox.failIfUnavailable: true; sandbox.allowUnsandboxedCommands: false; "~/sage-worktrees" in sandbox.filesystem.allowWrite; "WebFetch(domain:*)" in permissions.allow');
  s.claude(settings({ ...FAILS_CLOSED, enabled: false }));
  assert.equal(s.state("claude").state, "off", "enabled false");
  s.claude(settings({ ...FAILS_CLOSED, filesystem: { disabled: true } }));
  assert.equal(s.state("claude").state, "off", "the file part of the sandbox is off");
  assert.ok(s.state("claude").missing.includes("no sandbox.filesystem.disabled"));
});

test("Claude Code: a sandbox that a command can leave reads as on but may run unsandboxed, and names what is missing", (t) => {
  const s = scratch(t);
  s.claude(settings({ enabled: true, allowUnsandboxedCommands: false }));
  assert.equal(s.state("claude").state, "may-run-unsandboxed", "no failIfUnavailable: a sandbox that cannot start runs commands with none");
  assert.match(s.line("claude"), /^Claude Code: on, but may run unsandboxed · .* · missing: sandbox\.failIfUnavailable: true;/);
  s.claude(settings({ enabled: true, failIfUnavailable: true }));
  assert.equal(s.state("claude").state, "may-run-unsandboxed", "allowUnsandboxedCommands is true by default: Claude can run a blocked command again outside");
  assert.deepEqual(s.state("claude").missing.slice(0, 1), ["sandbox.allowUnsandboxedCommands: false"]);
  s.claude(settings(FAILS_CLOSED));
  assert.equal(s.state("claude").state, "on");
});

test("Claude Code: the project's files count in Claude Code's order, and a user false for the retry holds against a project true", (t) => {
  const s = scratch(t);
  s.claude(settings(FAILS_CLOSED));
  s.write(join(s.project, ".claude", "settings.local.json"), JSON.stringify(settings({ enabled: false })));
  assert.equal(s.state("claude").state, "off", "the project's local file is above the user file");
  s.write(join(s.project, ".claude", "settings.local.json"), JSON.stringify(settings({ allowUnsandboxedCommands: true })));
  assert.equal(s.state("claude").state, "on", "the user's false holds against the project's true");
  s.claude(settings({ enabled: true, failIfUnavailable: true }));
  s.write(join(s.project, ".claude", "settings.json"), JSON.stringify(settings({ allowUnsandboxedCommands: false })));
  s.write(join(s.project, ".claude", "settings.local.json"), "{}");
  assert.equal(s.state("claude").state, "on", "the shared project file sets the retry off");
  s.write(join(s.managed, "managed-settings.json"), JSON.stringify(settings({ enabled: false })));
  assert.equal(s.state("claude").state, "off", "the managed file is above every other file");
});

test("Claude Code: in a worktree, the local file of the main checkout counts", (t) => {
  const s = scratch(t);
  s.claude(settings(FAILS_CLOSED));
  const worktree = join(s.home, "sage-worktrees", "app-t1");
  s.write(join(worktree, ".git"), `gitdir: ${join(s.project, ".git", "worktrees", "app-t1")}\n`);
  s.write(join(s.project, ".claude", "settings.local.json"), JSON.stringify(settings({ enabled: false })));
  assert.equal(s.state("claude", {}, worktree).state, "off");
});

test("Claude Code: a settings file that sage cannot read or parse, or a key of a wrong type, gives strict rules, never on", (t) => {
  const s = scratch(t);
  const strict = (why) => {
    const found = s.state("claude");
    assert.equal(found.state, "strict", why);
    assert.deepEqual(found.writes, [], why);
    return found.reason;
  };
  s.claude(`${JSON.stringify(settings(FAILS_CLOSED)).slice(0, -1)},}`);
  assert.equal(strict("a trailing comma is not JSON"), "~/.claude/settings.json is not valid JSON");
  assert.equal(s.line("claude"), "Claude Code: strict rules (sage cannot confirm the sandbox): ~/.claude/settings.json is not valid JSON");
  s.claude(settings({ ...FAILS_CLOSED, enabled: "true" }));
  assert.equal(strict("a string is not a boolean"), "~/.claude/settings.json: sandbox.enabled is not true or false");
  s.claude(settings({ ...FAILS_CLOSED, filesystem: { allowWrite: "~/sage-worktrees" } }));
  strict("allowWrite is a list");
  s.claude(settings([]));
  strict("sandbox is an object");
  s.claude("[]");
  strict("the file is an object");
  s.claude(settings(FAILS_CLOSED));
  s.write(join(s.project, ".claude", "settings.local.json"), "{ not json");
  assert.equal(strict("a project file counts too"), "the project's .claude/settings.local.json is not valid JSON");
  rmSync(join(s.project, ".claude", "settings.local.json"));
  mkdirSync(join(s.project, ".claude", "settings.local.json"));
  assert.equal(strict("a folder in the place of the file"), "the project's .claude/settings.local.json is not a file");
  rmSync(join(s.project, ".claude"), { recursive: true });
  if (process.getuid?.() !== 0) {
    chmodSync(s.claude(settings(FAILS_CLOSED)), 0o000);
    assert.equal(strict("a file with no read permission"), "~/.claude/settings.json cannot be read");
    chmodSync(join(s.home, ".claude", "settings.json"), 0o600);
  }
  assert.equal(s.state("claude").state, "on");
  mkdirSync(join(s.managed, "managed-settings.d"), { recursive: true });
  assert.match(strict("sage does not read the managed folder"), /managed-settings\.d exists, and sage does not read it$/);
});

test("Claude Code: CLAUDE_CONFIG_DIR names the user file; Edit allow rules and additional folders add write roots", (t) => {
  const s = scratch(t);
  const config = join(s.dir, "claude-config");
  s.write(join(config, "settings.json"), JSON.stringify(settings({ ...FAILS_CLOSED, filesystem: { allowWrite: ["build"] } }, { allow: ["Edit(//srv/data/**)", "Edit(~/notes/**)", "Edit(/docs/**)", "Edit", "Read(//etc)"], additionalDirectories: ["~/shared"] })));
  const found = s.state("claude", { CLAUDE_CONFIG_DIR: config });
  assert.equal(found.state, "on");
  assert.deepEqual(found.writes, [s.project, "$TMPDIR", join(s.home, "shared"), join(config, "build"), "/srv/data", join(s.home, "notes"), join(config, "docs")]);
  s.write(join(config, "settings.json"), "{");
  assert.equal(s.state("claude", { CLAUDE_CONFIG_DIR: config }).reason, "$CLAUDE_CONFIG_DIR/settings.json is not valid JSON", "the line names the variable, not its value");
});

test("Codex: full access is off; workspace-write is on with its writable roots; read-only is on with no write root", (t) => {
  const s = scratch(t);
  s.codex('sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  assert.equal(s.line("codex"), 'Codex: off · missing: default_permissions = "sage", with the [permissions.sage] tables of the guide; no sandbox_mode line (Codex reads default_permissions only without it)');
  s.codex('sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = [\n  "~/sage-worktrees", # the worktrees\n  "/opt/cache",\n]\nexclude_slash_tmp = true\nnetwork_access = true\n');
  const found = s.state("codex");
  assert.equal(found.state, "on");
  assert.deepEqual(found.writes, [s.project, "$TMPDIR", join(s.home, "sage-worktrees"), "/opt/cache"]);
  assert.equal(found.network, true);
  assert.equal(s.line("codex"), 'Codex: on, fails closed · writes: the project, $TMPDIR, ~/sage-worktrees, /opt/cache · network: on · missing: default_permissions = "sage", with the [permissions.sage] tables of the guide; no sandbox_mode line (Codex reads default_permissions only without it)');
  s.codex('sandbox_mode = "read-only"\n');
  assert.deepEqual([s.state("codex").state, s.state("codex").writes], ["on", []]);
  s.codex('default_permissions = ":danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  s.codex('default_permissions = ":workspace"\n');
  assert.deepEqual(s.state("codex").writes, [s.project, "$TMPDIR", "/tmp"]);
});

test("Codex: the guide's sage profile is on and fails closed, with .git, ~/sage-worktrees and the network", (t) => {
  const s = scratch(t);
  s.codex(`model = "a-model"\n${CODEX_BLOCK}\n[agents]\nmax_concurrent_threads_per_session = 10\n`);
  const found = s.state("codex");
  assert.equal(found.state, "on");
  assert.deepEqual(found.missing, []);
  assert.equal(found.network, true);
  assert.deepEqual(found.writes, [s.project, "$TMPDIR", "/tmp", join(s.home, "sage-worktrees"), join(s.project, ".git")]);
  assert.equal(s.line("codex"), "Codex: on, fails closed · writes: the project, $TMPDIR, /tmp, ~/sage-worktrees, the project's .git · network: on · missing: none");
  s.codex(CODEX_BLOCK.replace('".git" = "write"', '".git" = "read"').replace("enabled = true", "enabled = false"));
  assert.deepEqual(s.state("codex").missing, ['".git" = "write" in [permissions.sage.filesystem.":workspace_roots"]', "enabled = true in [permissions.sage.network]"]);
  s.codex(CODEX_BLOCK.replace('default_permissions = "sage"\n', 'default_permissions = "sage"\nsandbox_mode = "danger-full-access"\n'));
  assert.equal(s.state("codex").state, "off", "while sandbox_mode is set, Codex ignores default_permissions");
});

test("Codex: the system config is the lowest layer, and a profile can extend another profile", (t) => {
  const s = scratch(t);
  s.write(s.systemConfig, 'sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  s.codex('sandbox_mode = "read-only"\n');
  assert.equal(s.state("codex").state, "on", "the user's config is above the system config");
  s.write(s.systemConfig, CODEX_BLOCK.replace('default_permissions = "sage"\n', ""));
  s.codex('default_permissions = "team"\n\n[permissions.team]\nextends = "sage"\n\n[permissions.team.filesystem]\n"~/sage-worktrees" = "deny"\n');
  const found = s.state("codex");
  assert.equal(found.state, "on");
  assert.equal(found.network, true, "the parent's network");
  assert.ok(!found.writes.includes(join(s.home, "sage-worktrees")), "the child's deny wins over the parent's write");
});

test("Codex: a config that sage cannot read or parse, or a profile that Codex refuses, gives strict rules, never on", (t) => {
  const s = scratch(t);
  const strict = (text, why) => {
    s.codex(text);
    const found = s.state("codex");
    assert.equal(found.state, "strict", why);
    assert.deepEqual(found.writes, [], why);
    return found.reason;
  };
  assert.equal(strict(`${CODEX_BLOCK}enabled = false\n`, "a key given twice"), "~/.codex/config.toml is not valid TOML (TOML line 15: enabled is given twice)");
  assert.equal(strict('default_permissions = "sage\n', "an open string"), "~/.codex/config.toml is not valid TOML (TOML line 1: line break in a string)");
  assert.match(strict('default_permissions = "missing"\n', "no such profile"), /"missing" has no \[permissions\.missing\] table/);
  assert.match(strict('default_permissions = "x"\n[permissions.x]\nextends = ":danger-full-access"\n', "Codex refuses this parent"), /extends ":danger-full-access", which Codex refuses/);
  assert.match(strict('default_permissions = "x"\n[permissions.x]\nextends = "y"\n[permissions.y]\nextends = "x"\n', "a loop"), /extends itself/);
  strict('default_permissions = "x"\n[permissions.x]\nextends = ":workspace"\n[permissions.x.filesystem]\n"~/a" = "all"\n', "an access that Codex does not have");
  strict('default_permissions = "x"\n[permissions.x]\nextends = ":workspace"\n[permissions.x.network]\nenabled = "yes"\n', "a string for a boolean");
  strict('sandbox_mode = "workspace"\n', "a mode that Codex does not have");
  strict("sandbox_mode = true\n", "a boolean for a string");
  s.codex(CODEX_BLOCK);
  assert.equal(s.state("codex").state, "on");
  s.write(join(s.project, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").reason, `the project's .codex/config.toml sets sandbox_mode; sage reads these keys only in ~/.codex/config.toml and ${s.systemConfig}`);
  s.write(join(s.project, ".codex", "config.toml"), 'model = "x"\n');
  assert.equal(s.state("codex").state, "on", "a project config without a sandbox key changes nothing");
  s.write(join(s.project, ".codex", "config.toml"), "model = \n");
  assert.equal(s.state("codex").state, "strict", "a project config that is not TOML");
  rmSync(join(s.project, ".codex"), { recursive: true });
  s.write(join(s.dir, "codex-home", "config.toml"), "[");
  assert.match(s.state("codex", { CODEX_HOME: join(s.dir, "codex-home") }).reason, /^\$CODEX_HOME\/config\.toml is not valid TOML/, "the line names the variable, not its value");
});

test("Codex: an automatic reviewer of approvals reads as on but may run unsandboxed", (t) => {
  const s = scratch(t);
  s.codex(`approvals_reviewer = "auto_review"\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed");
  assert.deepEqual(s.state("codex").missing, ['approvals_reviewer = "user"']);
  s.codex(`approvals_reviewer = "auto_review"\napproval_policy = "never"\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on", "with no approvals, nothing runs outside");
});

function files(dir) {
  return readdirSync(dir, { recursive: true }).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return `${name} ${stat.isFile() ? readFileSync(join(dir, name), "utf8") : "folder"}`;
  });
}

test("both plugins name the same settings files: Claude Code's and Codex's, from HOME, CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
  for (const env of [{ HOME: "/h" }, { HOME: "/h", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }]) assert.deepEqual(codexPlaces(env), sandboxPlaces(env));
  assert.deepEqual([sandboxPlaces({ HOME: "/h" }).claude.user, sandboxPlaces({ HOME: "/h" }).codex.user], ["/h/.claude/settings.json", "/h/.codex/config.toml"]);
  assert.deepEqual([sandboxPlaces({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }).claude.user, sandboxPlaces({ HOME: "/h", CODEX_HOME: "/x" }).codex.user], ["/c/settings.json", "/x/config.toml"]);
});

test("sage sandbox in each plugin prints one line for each provider, changes no file and prints no value of the environment", (t) => {
  const s = scratch(t);
  s.claude(CLAUDE_BLOCK);
  s.codex('sandbox_mode = "danger-full-access"\n');
  const before = files(s.dir);
  const run = (tool, ...words) => spawnSync(process.execPath, [tool, "sandbox", ...words], { cwd: s.project, env: { ...s.env, PATH: process.env.PATH }, encoding: "utf8" });
  const claude = run(CLAUDE_TOOL), codex = run(CODEX_TOOL);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(claude.stdout, codex.stdout, "both plugins read the same files");
  const lines = claude.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Claude Code: on, fails closed · writes: the project, \$TMPDIR, ~\/sage-worktrees, \/tmp, \/private\/tmp · /);
  assert.match(lines[1], /^Codex: off · missing: /);
  for (const value of [s.home, s.env.TMPDIR, s.env.SAGE_HOME, s.dir]) assert.ok(!claude.stdout.includes(value), "no value of the environment");
  assert.deepEqual(files(s.dir), before, "no file changed or added");
  const words = run(CLAUDE_TOOL, "now");
  assert.equal(words.status, 1);
  assert.match(words.stderr, /^sage: sandbox takes no words/);
});

test("the guide's blocks parse: the JSON block as JSON, the TOML block with core's reader and with Python's tomllib", (t) => {
  const json = JSON.parse(CLAUDE_BLOCK);
  assert.deepEqual(Object.keys(json.sandbox), ["enabled", "failIfUnavailable", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed", "excludedCommands", "filesystem"]);
  const toml = parseToml(CODEX_BLOCK);
  assert.equal(toml.default_permissions, "sage", "the top line is a top-level key, not a key of a table");
  assert.deepEqual(toml.permissions.sage.filesystem, { "~/sage-worktrees": "write", ":workspace_roots": { ".git": "write" } });
  const s = scratch(t);
  const python = spawnSync("python3", ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: CODEX_BLOCK, env: { PATH: process.env.PATH, HOME: s.home }, encoding: "utf8" });
  if (python.error || python.status !== 0) return t.skip(`python3 with tomllib is not here: ${python.error?.message ?? python.stderr}`);
  assert.deepEqual(JSON.parse(python.stdout), toml);
});

test("core's TOML reader reads what tomllib reads, and refuses what TOML refuses", (t) => {
  const sample = [
    "# a comment", 'model = "m" # a comment after a value', "n = 1_000", "hex = 0xff", "f = -1.5e3", "yes = true",
    'text = """', "a line [not a table]", 'x = 1', '"""', "raw = '''C:\\path'''", 'escaped = "tab\\tu\\u00e9 \\"q\\""', 'joined = """a \\', '    b"""',
    "roots = [", '  "/a", # one', "  '~/b',", "]", 'inline = { a = 1, "b.c" = { d = true } }', '"quoted key".x = "y"',
    "[permissions.sage]", 'extends = ":workspace"', '[permissions.sage.filesystem.":workspace_roots"]', '".git" = "write"',
    "[[skills.config]]", 'path = "a"', "[[skills.config]]", 'path = "b"', "[skills.config.sub]", "q = 2",
  ].join("\n") + "\n";
  const read = parseToml(sample);
  assert.equal(read.text, "a line [not a table]\nx = 1\n");
  assert.equal(read.joined, "a b");
  assert.deepEqual(read.skills.config, [{ path: "a" }, { path: "b", sub: { q: 2 } }]);
  const s = scratch(t);
  const python = spawnSync("python3", ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: sample, env: { PATH: process.env.PATH, HOME: s.home }, encoding: "utf8" });
  if (!python.error && python.status === 0) assert.deepEqual(JSON.parse(python.stdout), read);
  for (const bad of ["a = 1\na = 2", 'a = "x', "a =", "[a]\n[a]", "a = 1 b", "a = [1, 2", "a.b = 1\na = 2", "a = 007", "[x]\nk = 1\n[x.k]", 'a = """x', "a = { b = 1", "a = 1\n[[a]]"])
    assert.throws(() => parseToml(bad), /^Error: TOML line \d+: /, JSON.stringify(bad));
});
