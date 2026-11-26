import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { sandboxLine, sandboxState, sandboxStatus } from "../packages/sage-core/index.mjs";
import { parseToml } from "../packages/sage-core/toml.mjs";
import { sandboxPlaces } from "../plugins/sage/skills/sage/sage.mjs";
import { sandboxPlaces as codexPlaces } from "../plugins/sage-codex/skills/sage/sage.mjs";

const CLAUDE_TOOL = join(ROOT, "plugins/sage/skills/sage/sage.mjs"), CODEX_TOOL = join(ROOT, "plugins/sage-codex/skills/sage/sage.mjs");
const GUIDE = { claude: readFileSync(join(ROOT, "docs/guide/using-sage.md"), "utf8"), codex: readFileSync(join(ROOT, "docs/guide/codex.md"), "utf8") };

function guideSection(provider) {
  const text = GUIDE[provider], start = text.indexOf("\n## Turn on the sandbox\n");
  assert.notEqual(start, -1, `the ${provider} guide has the section Turn on the sandbox`);
  return text.slice(start, text.indexOf("\n## ", start + 1)).replace(/^ {3}/gm, "");
}
const block = (provider, lang) => new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(guideSection(provider))[1];
const CLAUDE_BLOCK = block("claude", "json"), CODEX_BLOCK = block("codex", "toml");
const NEVER = 'approval_policy = "never"\n';

const TEMP = realpathSync(tmpdir());
const BASE = ["/tmp", "/private/tmp"].some((root) => TEMP === root || TEMP.startsWith(`${root}/`)) ? "/var/tmp" : TEMP;
function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(BASE, "sage-sandbox-")));
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
  const managed = join(system, "ClaudeCode"), systemConfig = join(system, "codex", "config.toml"), managedConfig = join(system, "codex", "managed_config.toml");
  const places = (all) => ({ claude: { ...all.claude, managed }, codex: { ...all.codex, system: systemConfig, managed: managedConfig } });
  const state = (provider, more = {}, cwd = project) => sandboxState(provider, { env: { ...env, ...more }, cwd, places: places(sandboxPlaces({ ...env, ...more }))[provider] });
  const line = (provider, more = {}) => sandboxLine(state(provider, more), { env: { ...env, ...more }, cwd: project });
  const plugin = join(home, ".claude", "plugins", "cache", "sage", "sage", "v1");
  const guide = () => {
    const json = JSON.parse(CLAUDE_BLOCK);
    json.sandbox.excludedCommands = entryLines(plugin);
    return json;
  };
  return { dir, home, project, system, managed, systemConfig, managedConfig, env, write, claude, codex, state, line, plugin, guide };
}

const tool = (file, cwd, env, ...words) => spawnSync(process.execPath, [file, "sandbox", ...words], { cwd, env: { ...env, PATH: process.env.PATH }, encoding: "utf8" });
const entryLines = (plugin) => ["gh *", `node ${plugin}/skills/sage/sage.mjs *`, `node ${plugin}/board/cli.mjs board *`];
let printed;
const entries = () => printed ??= (() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-entries-")));
  try {
    const run = tool(CLAUDE_TOOL, dir, { HOME: dir, SAGE_HOME: join(dir, "sage") }, "entries");
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(`[${run.stdout}]`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();

const settings = (sandbox, permissions) => ({ ...(permissions ? { permissions } : {}), sandbox });
const FAILS_CLOSED = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };

test("Claude Code: the guide's block, with the lines of sage sandbox entries, reads as on and fails closed, with the folders that it lets a command write", (t) => {
  const s = scratch(t);
  assert.deepEqual(entries(), entryLines(join(ROOT, "plugins/sage")), "sage sandbox entries prints the lines for the installed plugin's folder");
  s.claude(s.guide());
  const found = s.state("claude");
  assert.equal(found.state, "on");
  assert.deepEqual(found.missing, []);
  assert.equal(found.network, true);
  for (const root of [s.project, "$TMPDIR", join(s.home, "sage-worktrees"), "/tmp", "/private/tmp"]) assert.ok(found.writes.includes(root), `${root} is a write root`);
  assert.equal(s.line("claude"), "Claude Code: on, fails closed · writes: the project, $TMPDIR, ~/sage-worktrees, /tmp, /private/tmp · network: on · 3 command patterns of the guide run outside the sandbox · known gap: git metadata, which git can run later outside the sandbox · missing: none");
  s.claude(CLAUDE_BLOCK);
  assert.equal(s.state("claude").state, "may-run-unsandboxed", "the block pasted with its example folder names no file of the installed plugin");
});

test("Claude Code: with no settings file the sandbox is off, and the line names each key that the guide sets (F-T1241-19)", (t) => {
  const s = scratch(t);
  assert.equal(s.state("claude").state, "off");
  assert.deepEqual(s.state("claude").writes, []);
  assert.equal(s.line("claude"), 'Claude Code: off · missing: sandbox.enabled: true; sandbox.failIfUnavailable: true; sandbox.allowUnsandboxedCommands: false; sandbox.autoAllowBashIfSandboxed: true; "gh *" in sandbox.excludedCommands; the state tool\'s line in sandbox.excludedCommands (sage sandbox entries prints it); the board\'s line in sandbox.excludedCommands (sage sandbox entries prints it); "~/sage-worktrees" in sandbox.filesystem.allowWrite; "~/.config/sage-board" in sandbox.filesystem.denyRead; "WebFetch(domain:*)" in permissions.allow');
  s.claude(settings({ ...FAILS_CLOSED, enabled: false }));
  assert.equal(s.state("claude").state, "off", "enabled false");
  s.claude(settings({ ...FAILS_CLOSED, filesystem: { disabled: true } }));
  assert.equal(s.state("claude").state, "off", "the file part of the sandbox is off");
  assert.ok(s.state("claude").missing.includes("no sandbox.filesystem.disabled"));
});

test("Claude Code: F-T1241-19, each key of the guide's block that is gone is named as missing", (t) => {
  const s = scratch(t);
  const without = (change) => {
    const json = s.guide();
    change(json.sandbox);
    s.claude(json);
    return s.state("claude").missing;
  };
  assert.deepEqual(without((x) => delete x.autoAllowBashIfSandboxed), ["sandbox.autoAllowBashIfSandboxed: true"]);
  assert.deepEqual(without((x) => delete x.filesystem.denyRead), ['"~/.config/sage-board" in sandbox.filesystem.denyRead']);
  assert.deepEqual(without((x) => x.excludedCommands.splice(0, 1)), ['"gh *" in sandbox.excludedCommands']);
  assert.deepEqual(without((x) => x.excludedCommands.splice(1, 1)), ["the state tool's line in sandbox.excludedCommands (sage sandbox entries prints it)"]);
  assert.deepEqual(without((x) => x.excludedCommands.splice(2, 1)), ["the board's line in sandbox.excludedCommands (sage sandbox entries prints it)"]);
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

test("F-T1241-1, F-T1241-12, F-T1241-2, F-T1241-10: an excluded command that is not one of the guide's lines, in any settings file, reads as may run unsandboxed and is named", (t) => {
  const s = scratch(t);
  s.claude(settings({ ...FAILS_CLOSED, excludedCommands: entryLines(s.plugin) }));
  const check = (file, entry) => {
    s.write(file, JSON.stringify(settings({ excludedCommands: [entry] })));
    const found = s.state("claude");
    assert.equal(found.state, "may-run-unsandboxed", entry);
    assert.ok(found.loose.some((item) => item.endsWith("excludedCommands entry 1")), `${entry} is named by its place: ${found.loose}`);
    assert.ok(s.line("claude").includes(`may run outside the sandbox: `), entry);
    rmSync(file);
  };
  const project = join(s.project, ".claude", "settings.json"), local = join(s.project, ".claude", "settings.local.json"), managed = join(s.managed, "managed-settings.json");
  check(project, "*");
  check(local, "node *");
  check(local, "bash *");
  check(managed, "python3 *");
  check(project, "node *skills/sage/sage.mjs *");
  check(project, "node *board/cli.mjs board *");
  check(project, `node ${s.plugin}/*/skills/sage/sage.mjs *`);
  check(project, `node ${s.plugin}/../../../../../../work/app/x/skills/sage/sage.mjs *`);
  check(project, `node ${join(s.project, "x")}/skills/sage/sage.mjs *`);
  check(project, `node ${s.plugin}/skills/sage/sage.mjs`);
  assert.equal(s.state("claude").state, "on", "the guide's lines alone");
  s.claude(settings({ ...FAILS_CLOSED, excludedCommands: entryLines(s.plugin), filesystem: { allowWrite: ["~/.claude/plugins"] } }));
  assert.equal(s.state("claude").state, "may-run-unsandboxed", "a sandboxed command can change a plugin file that a folder of allowWrite holds");
});

test("F-T1241-2, F-T1241-10: a settings key that opens the sandbox, in any file, reads as may run unsandboxed and is named; its closed value does not", (t) => {
  const s = scratch(t);
  s.claude(settings(FAILS_CLOSED));
  const file = join(s.project, ".claude", "settings.local.json");
  for (const [sandbox, key] of [
    [{ allowAppleEvents: true }, "allowAppleEvents"], [{ allowNestedUserNamespaces: true }, "allowNestedUserNamespaces"],
    [{ enableWeakerNestedSandbox: true }, "enableWeakerNestedSandbox"], [{ enableWeakerNetworkIsolation: true }, "enableWeakerNetworkIsolation"],
    [{ network: { allowAllUnixSockets: true } }, "network.allowAllUnixSockets"], [{ network: { allowLocalBinding: true } }, "network.allowLocalBinding"],
    [{ network: { allowUnixSockets: ["/var/run/docker.sock"] } }, "network.allowUnixSockets"], [{ network: { allowMachLookup: ["*"] } }, "network.allowMachLookup"],
    [{ network: { httpProxyPort: 8080 } }, "network.httpProxyPort"], [{ network: { socksProxyPort: 1080 } }, "network.socksProxyPort"],
  ]) {
    s.write(file, JSON.stringify({ sandbox }));
    const found = s.state("claude");
    assert.equal(found.state, "may-run-unsandboxed", key);
    assert.deepEqual(found.loose, [`the project's .claude/settings.local.json: sandbox.${key}`]);
  }
  s.write(file, JSON.stringify({ sandbox: { allowAppleEvents: false, network: { allowAllUnixSockets: false, allowUnixSockets: [], allowMachLookup: [] } } }));
  assert.equal(s.state("claude").state, "on", "a closed value opens nothing");
  s.write(file, JSON.stringify({ sandbox: { network: { httpProxyPort: "8080" } } }));
  assert.equal(s.state("claude").state, "strict", "a port that is not a number");
});

test("F-T1241-7: Claude's retry and Codex's approval both read as may run unsandboxed, and both turn into on when no command can leave", (t) => {
  const s = scratch(t);
  s.claude(settings({ ...FAILS_CLOSED, allowUnsandboxedCommands: true }));
  assert.equal(s.state("claude").state, "may-run-unsandboxed");
  s.codex(CODEX_BLOCK);
  assert.equal(s.state("codex").state, "may-run-unsandboxed", "on-request is the default: you can approve a command outside the sandbox");
  assert.deepEqual(s.state("codex").loose, ["you can approve a command outside the sandbox (approval_policy is on-request by default)"]);
  s.codex(`approval_policy = "on-request"\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed");
  s.codex(`approval_policy = { granular = { sandbox_approval = true, rules = false, request_permissions = false, skill_approval = false } }\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed", "a granular policy that lets sandbox prompts through");
  s.codex(`approval_policy = { granular = { sandbox_approval = false, rules = false, request_permissions = false, skill_approval = false, mcp_elicitations = true } }\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on", "a granular policy that turns off each prompt that can take a command outside");
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on");
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

test("F-T1241-16: the guide names Claude Code v2.1.285, from which a user false for the retry holds against a project true", () => {
  assert.match(guideSection("claude"), /You need Claude Code v2\.1\.285 or later\. Before v2\.1\.285, a project's `"allowUnsandboxedCommands": true` won/);
});

test("Claude Code: in a worktree, the local file of the main checkout counts", (t) => {
  const s = scratch(t);
  s.claude(settings(FAILS_CLOSED));
  const worktree = join(s.home, "sage-worktrees", "app-t1");
  s.write(join(worktree, ".git"), `gitdir: ${join(s.project, ".git", "worktrees", "app-t1")}\n`);
  s.write(join(s.project, ".claude", "settings.local.json"), JSON.stringify(settings({ enabled: false })));
  assert.equal(s.state("claude", {}, worktree).state, "off");
});

test("F-T1241-15: a .git that is not a folder or a regular file, such as a FIFO, gives strict rules at once and never hangs", (t) => {
  const s = scratch(t);
  s.claude(settings(FAILS_CLOSED));
  const folder = join(s.home, "fifo-project");
  mkdirSync(folder);
  const made = spawnSync("mkfifo", [join(folder, ".git")]);
  if (made.error || made.status !== 0) return t.skip("mkfifo is not here");
  const core = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href, plugin = pathToFileURL(CLAUDE_TOOL).href;
  const code = `const { sandboxState } = await import(${JSON.stringify(core)}); const { sandboxPlaces } = await import(${JSON.stringify(plugin)});
    const env = ${JSON.stringify(s.env)}, out = [];
    for (const p of ["claude", "codex"]) out.push(sandboxState(p, { env, cwd: ${JSON.stringify(folder)}, places: { ...sandboxPlaces(env)[p], managed: ${JSON.stringify(s.managed)}, system: ${JSON.stringify(s.systemConfig)} } }).reason);
    console.log(JSON.stringify(out));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...s.env, PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
  assert.equal(run.signal, null, "the reader did not end within 30 s: the limit is wide on purpose, because it only ends a hang, and a sound reader takes well under a second");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ["the project's .git is not a file", "the project's .git is not a file"]);
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
  s.claude(settings({ ...FAILS_CLOSED, excludedCommands: "gh *" }));
  strict("excludedCommands is a list");
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

test("F-T1241-21: a path entry with a variable, a ~name or nothing in it gives strict rules, not a made-up folder", (t) => {
  const s = scratch(t);
  for (const [sandbox, permissions, why] of [
    [{ ...FAILS_CLOSED, filesystem: { allowWrite: [""] } }, undefined, '""'],
    [{ ...FAILS_CLOSED, filesystem: { allowWrite: ["$HOME/x"] } }, undefined, '"$HOME/x"'],
    [{ ...FAILS_CLOSED, filesystem: { allowWrite: ["~root/x"] } }, undefined, '"~root/x"'],
    [FAILS_CLOSED, { additionalDirectories: ["${TMPDIR}/x"] }, '"${TMPDIR}/x"'],
    [FAILS_CLOSED, { allow: ["Edit($HOME/**)"] }, '"$HOME/**"'],
  ]) {
    s.claude(settings(sandbox, permissions));
    const found = s.state("claude");
    assert.equal(found.state, "strict", why);
    assert.ok(found.reason.endsWith(`has ${why}, and sage cannot tell where it points`), found.reason);
  }
});

test("F-T1241-5: the line names a path under CLAUDE_CONFIG_DIR or SAGE_WORKTREES by the variable, never by its value", (t) => {
  const s = scratch(t);
  const config = join(s.dir, "claude-config"), worktrees = join(s.dir, "elsewhere", "trees");
  s.write(join(config, "settings.json"), JSON.stringify(settings({ ...FAILS_CLOSED, filesystem: { allowWrite: ["build"] } })));
  const more = { CLAUDE_CONFIG_DIR: config, SAGE_WORKTREES: worktrees }, line = s.line("claude", more);
  assert.match(line, / · writes: the project, \$TMPDIR, \$CLAUDE_CONFIG_DIR\/build · /);
  assert.match(line, /"\$SAGE_WORKTREES" in sandbox\.filesystem\.allowWrite/);
  for (const value of [config, worktrees, s.dir]) assert.ok(!line.includes(value), `no value of the environment: ${line}`);
  s.write(join(config, "settings.json"), JSON.stringify(settings({ ...FAILS_CLOSED, excludedCommands: [`node ${s.home}/x.mjs *`, `node ${config}/y.mjs *`] })));
  assert.match(s.line("claude", more), /may run outside the sandbox: \$CLAUDE_CONFIG_DIR\/settings\.json: excludedCommands entry 1; \$CLAUDE_CONFIG_DIR\/settings\.json: excludedCommands entry 2 · /);
  assert.ok(!s.line("claude", more).includes(s.dir), "the line prints no entry's text, so no folder of the environment");
  s.codex('default_permissions = "x"\n[permissions.x]\nextends = ":workspace"\n');
  assert.match(s.line("codex", more), /"\$SAGE_WORKTREES" = "write" in \[permissions\.x\.filesystem\]/);
  assert.ok(!s.line("codex", more).includes(s.dir));
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
  s.codex(`${NEVER}sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = [\n  "~/sage-worktrees", # the worktrees\n  "/opt/cache",\n]\nexclude_slash_tmp = true\nnetwork_access = true\n`);
  const found = s.state("codex");
  assert.equal(found.state, "on");
  assert.deepEqual(found.writes, [s.project, "$TMPDIR", join(s.home, "sage-worktrees"), "/opt/cache"]);
  assert.equal(found.network, true);
  assert.equal(s.line("codex"), 'Codex: on, fails closed · writes: the project, $TMPDIR, ~/sage-worktrees, /opt/cache · network: on · known gap: git metadata, which git can run later outside the sandbox · missing: default_permissions = "sage", with the [permissions.sage] tables of the guide; no sandbox_mode line (Codex reads default_permissions only without it)');
  s.codex(`${NEVER}sandbox_mode = "read-only"\n`);
  assert.deepEqual([s.state("codex").state, s.state("codex").writes], ["on", []]);
  s.codex('default_permissions = ":danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  s.codex(`${NEVER}default_permissions = ":workspace"\n`);
  assert.deepEqual(s.state("codex").writes, [s.project, "$TMPDIR", "/tmp"]);
});

test("Codex: the guide's sage profile reads as on but may run unsandboxed, because you can approve a command outside; with no approvals it fails closed", (t) => {
  const s = scratch(t);
  s.codex(`model = "a-model"\n${CODEX_BLOCK}\n[agents]\nmax_concurrent_threads_per_session = 10\n`);
  const found = s.state("codex");
  assert.equal(found.state, "may-run-unsandboxed");
  assert.deepEqual(found.missing, []);
  assert.equal(found.network, true);
  assert.deepEqual(found.writes, [s.project, "$TMPDIR", "/tmp", join(s.home, "sage-worktrees"), join(s.project, ".git")]);
  assert.equal(s.line("codex"), "Codex: on, but may run unsandboxed · writes: the project, $TMPDIR, /tmp, ~/sage-worktrees, the project's .git · network: on · known gap: git metadata, which git can run later outside the sandbox · may run outside the sandbox: you can approve a command outside the sandbox (approval_policy is on-request by default) · missing: none");
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.line("codex"), "Codex: on, fails closed · writes: the project, $TMPDIR, /tmp, ~/sage-worktrees, the project's .git · network: on · known gap: git metadata, which git can run later outside the sandbox · missing: none");
  s.codex(CODEX_BLOCK.replace("enabled = true", "enabled = false"));
  assert.deepEqual(s.state("codex").missing, ["enabled = true in [permissions.sage.network]"]);
  s.codex(CODEX_BLOCK.replace('default_permissions = "sage"\n', 'default_permissions = "sage"\nsandbox_mode = "danger-full-access"\n'));
  assert.equal(s.state("codex").state, "off", "while sandbox_mode is set, Codex ignores default_permissions");
  assert.match(guideSection("codex"), /The Codex line must end with `missing: none`, and its state depends on your choice in step 4:\n- With no `approval_policy` line: `on, but may run unsandboxed`, with `you can approve a command outside the sandbox`\. The next part tells why\.\n- With `approval_policy = "never"`: `on, fails closed`\./);
});

test("F-T1241-9: the guide keeps .git/hooks and .git/config read-only under a writable .git, and the line names them when they are gone", (t) => {
  const s = scratch(t);
  assert.deepEqual(parseToml(CODEX_BLOCK).permissions.sage.filesystem[":workspace_roots"], { ".git": "write", ".git/hooks": "read", ".git/config": "read" });
  for (const gone of ['".git/hooks" = "read"\n', '".git/config" = "read"\n']) {
    s.codex(`${NEVER}${CODEX_BLOCK.replace(gone, "")}`);
    assert.deepEqual(s.state("codex").missing, ['".git/hooks" = "read" and ".git/config" = "read" in [permissions.sage.filesystem.":workspace_roots"]'], gone);
  }
  s.codex(`${NEVER}${CODEX_BLOCK.replace('".git/hooks" = "read"', '".git/hooks" = "write"')}`);
  assert.ok(s.state("codex").writes.includes(join(s.project, ".git/hooks")));
  assert.equal(s.state("codex").missing.length, 1, "a writable hooks folder is missing its read-only line");
  assert.match(guideSection("codex"), /such as `git push -u` \(it records the upstream branch\), `git remote add` or `git config`/);
});

test("F-T1241-9, F-T1241-24: the line names the known gap of git metadata for each provider while its sandbox lets a command write, and the guides and SECURITY.md tell it", (t) => {
  const s = scratch(t);
  const gap = "known gap: git metadata, which git can run later outside the sandbox";
  s.claude(s.guide());
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  for (const provider of ["claude", "codex"]) {
    assert.equal(s.state(provider).state, "on", provider);
    assert.ok(s.line(provider).includes(` · ${gap} · `), s.line(provider));
  }
  s.codex(`${NEVER}${CODEX_BLOCK.replace('".git" = "write"\n', "")}`);
  assert.deepEqual(s.state("codex").missing, [], "the guide offers a read-only .git, so the .git line is not missing");
  assert.ok(s.line("codex").includes(gap), "the worktrees in ~/sage-worktrees stay writable");
  s.codex(`${NEVER}sandbox_mode = "read-only"\n`);
  assert.ok(!s.line("codex").includes(gap), "a sandbox that lets a command write nothing has no such gap");
  s.codex('sandbox_mode = "danger-full-access"\n');
  assert.ok(!s.line("codex").includes(gap), "with no sandbox, the line gives no gap of the sandbox");
  const security = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
  for (const [name, text] of [["the Claude Code guide", guideSection("claude")], ["the Codex guide", guideSection("codex")], ["SECURITY.md", security]]) {
    assert.match(text, /Git metadata is a known gap/, name);
    assert.match(text, /`\.git\/commondir`/, name);
    assert.match(text, /later, outside the sandbox|runs it, with your full access/, name);
    assert.match(text, /cannot see such a write/, name);
  }
  assert.match(guideSection("claude"), /Claude Code's sandbox keeps only `hooks` and `config` read-only \(\[Claude Code: Sandboxing\]\(https:\/\/code\.claude\.com\/docs\/en\/sandboxing\.md#protected-paths\)\)/);
  assert.match(guideSection("codex"), /To close it for the project's own `\.git` folder, remove the `"\.git" = "write"` line/);
  assert.match(guideSection("codex"), /"This is why commands like `git commit` may still require approval to run outside the sandbox"/);
  assert.match(guideSection("codex"), /The gap stays for the worktrees in `~\/sage-worktrees`/);
});

test("F-T1241-26: a writable .git without the two read lines reads as may run unsandboxed and is named", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK.replace('".git/hooks" = "read"\n".git/config" = "read"\n', "")}`);
  const found = s.state("codex");
  assert.equal(found.state, "may-run-unsandboxed");
  assert.deepEqual(found.loose, ['the profile makes .git writable without ".git/hooks" = "read" and ".git/config" = "read"']);
  s.codex(`${NEVER}${CODEX_BLOCK.replace('".git/config" = "read"', '".git/config" = "write"')}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed", "a writable config");
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on");
});

test("F-T1241-22: a sage entry whose plugin folder holds a write root, or whose path has a $ or a backtick, reads as may run unsandboxed", (t) => {
  const s = scratch(t);
  const read = (change) => {
    const json = s.guide();
    change(json.sandbox);
    s.claude(json);
    return s.state("claude");
  };
  assert.equal(read(() => {}).state, "on", "the guide's lines alone");
  const inside = read((x) => x.filesystem.allowWrite.push(join(s.plugin, "skills", "sage")));
  assert.equal(inside.state, "may-run-unsandboxed", "a write root inside the plugin folder");
  assert.ok(inside.loose.some((item) => item.endsWith("excludedCommands entry 2")), inside.loose);
  const plugins = join(s.home, ".claude", "plugins");
  for (const part of ["$X", "`x`"]) {
    const found = read((x) => x.excludedCommands.splice(1, 1, `node ${plugins}/${part}/skills/sage/sage.mjs *`));
    assert.equal(found.state, "may-run-unsandboxed", part);
    assert.ok(found.missing.includes("the state tool's line in sandbox.excludedCommands (sage sandbox entries prints it)"), part);
  }
});

test("F-T1241-27: a CLAUDE_CONFIG_DIR inside the session's temp folder, which the sandbox lets a command write, reads as may run unsandboxed", (t) => {
  const s = scratch(t);
  const config = join(s.env.TMPDIR, "claude-config"), plugin = join(config, "plugins", "cache", "sage", "sage", "v1");
  const json = s.guide();
  json.sandbox.excludedCommands = entryLines(plugin);
  s.write(join(config, "settings.json"), JSON.stringify(json));
  const found = s.state("claude", { CLAUDE_CONFIG_DIR: config });
  assert.equal(found.state, "may-run-unsandboxed");
  assert.equal(found.loose.length, 2, `both sage entries are named: ${found.loose}`);
  const elsewhere = join(s.dir, "claude-config"), safe = s.guide();
  safe.sandbox.excludedCommands = entryLines(join(elsewhere, "plugins", "cache", "sage", "sage", "v1"));
  s.write(join(elsewhere, "settings.json"), JSON.stringify(safe));
  assert.equal(s.state("claude", { CLAUDE_CONFIG_DIR: elsewhere }).state, "on", "the same setup outside the temp folder");
});

test("F-T1241-25: a rule's decision counts as prompt or forbidden only when the quoted word stands alone before the next , or )", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  const file = join(s.home, ".codex", "rules", "default.rules");
  for (const [text, want] of [
    ['prefix_rule(pattern=["node"], decision="prompt" if False else "a" + "llow")\n', "may-run-unsandboxed"],
    ['prefix_rule(pattern=["node"], decision="prompt" + "")\n', "may-run-unsandboxed"],
    ['prefix_rule(pattern=["node"], decision = "prompt" )\n', "on"],
    ['prefix_rule(\n  pattern=["rm"],\n  decision="forbidden"\n  ,\n)\n', "on"],
  ]) {
    s.write(file, text);
    assert.equal(s.state("codex").state, want, text);
  }
});

test("F-T1241-18: a profile that does not extend :workspace names the missing extends line", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK.replace('extends = ":workspace"\n', "")}`);
  assert.ok(s.state("codex").missing.includes('extends = ":workspace" in [permissions.sage]'));
  s.codex(`${NEVER}${CODEX_BLOCK.replace('extends = ":workspace"', 'extends = ":read-only"')}`);
  assert.ok(s.state("codex").missing.includes('extends = ":workspace" in [permissions.sage]'));
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.deepEqual(s.state("codex").missing, []);
});

test("F-T1241-11: an allow rule in a rules file of Codex reads as may run unsandboxed and names the file; an unreadable rules file gives strict rules", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  const user = join(s.home, ".codex", "rules"), project = join(s.project, ".codex", "rules"), system = join(s.system, "codex", "rules");
  const allows = (file, text) => {
    s.write(file, text);
    const found = s.state("codex");
    rmSync(file);
    return found.state === "may-run-unsandboxed" && found.loose.length === 1 && found.loose[0].endsWith(" has an allow rule") ? found.loose[0] : found.state;
  };
  assert.equal(allows(join(user, "default.rules"), 'prefix_rule(pattern=["node"], decision="allow")\n'), "~/.codex/rules/default.rules has an allow rule");
  assert.equal(allows(join(project, "team.rules"), 'prefix_rule(pattern = ["npm", "test"])\n'), "the project's .codex/rules/team.rules has an allow rule", "allow is the default decision");
  assert.match(allows(join(system, "site.rules"), 'prefix_rule(\n  pattern = ["git"],\n  decision = "allow",\n)\n'), /codex\/rules\/site\.rules has an allow rule$/);
  assert.match(allows(join(user, "alias.rules"), 'rule = prefix_rule\nrule(pattern = ["git"])\n'), /has an allow rule$/, "a rule through another name");
  assert.match(allows(join(user, "var.rules"), 'd = "prompt"\nprefix_rule(pattern = ["git"], decision = d)\n'), /has an allow rule$/, "a decision that sage cannot read");
  assert.match(allows(join(user, "text.rules"), 'prefix_rule(pattern = ["git"], justification = "decision = \'prompt\'")\n'), /has an allow rule$/, "a decision inside a string");
  assert.equal(allows(join(user, "default.rules"), '# Prompt before allowing gh pr view outside the sandbox.\nprefix_rule(\n  pattern = ["gh", "pr", "view"],\n  decision = "prompt",\n  match = ["gh pr view (7888)"],\n)\nprefix_rule(pattern = ["rm"], decision = "forbidden")\n'), "on", "prompt and forbidden rules run nothing outside without you");
  assert.equal(allows(join(user, "notes.txt"), 'prefix_rule(pattern=["node"])\n'), "on", "Codex reads only .rules files");
  if (process.getuid?.() !== 0) {
    chmodSync(s.write(join(user, "default.rules"), 'prefix_rule(pattern=["rm"], decision="forbidden")\n'), 0o000);
    assert.deepEqual([s.state("codex").state, s.state("codex").reason], ["strict", "~/.codex/rules/default.rules cannot be read"]);
    rmSync(join(user, "default.rules"));
    chmodSync(user, 0o000);
    assert.deepEqual([s.state("codex").state, s.state("codex").reason], ["strict", "~/.codex/rules cannot be read"]);
    chmodSync(user, 0o700);
  }
  mkdirSync(join(user, "folder.rules"));
  assert.equal(s.state("codex").state, "on", "Codex reads only files");
});

test("F-T1241-17: a config that selects a profile, or a [profiles] table with a sandbox key, gives strict rules", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}profile = "fast"\n${CODEX_BLOCK}\n[profiles.fast]\nsandbox_mode = "danger-full-access"\n`);
  assert.deepEqual([s.state("codex").state, s.state("codex").reason], ["strict", 'a config sets profile = "fast", and sage does not follow profiles']);
  s.codex(`${NEVER}${CODEX_BLOCK}\n[profiles.yolo]\napproval_policy = "on-request"\n`);
  assert.deepEqual([s.state("codex").state, s.state("codex").reason], ["strict", "[profiles.yolo] sets approval_policy, and sage does not follow profiles"]);
  s.codex(`${NEVER}${CODEX_BLOCK}\n[profiles.deep]\nmodel = "m"\n`);
  assert.equal(s.state("codex").state, "on", "a profile with no sandbox key changes nothing");
});

test("F-T1241-6: Codex's managed config is above the user's config", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on");
  s.write(s.managedConfig, 'sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  s.write(s.managedConfig, 'approval_policy = "on-request"\n');
  assert.equal(s.state("codex").state, "may-run-unsandboxed");
  s.write(s.managedConfig, "[");
  assert.equal(s.state("codex").state, "strict");
  assert.deepEqual(codexPlaces({ HOME: "/h" }).codex.managed, "/etc/codex/managed_config.toml");
});

test("Codex: the system config is the lowest layer, and a profile can extend another profile", (t) => {
  const s = scratch(t);
  s.write(s.systemConfig, 'sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").state, "off");
  s.codex(`${NEVER}sandbox_mode = "read-only"\n`);
  assert.equal(s.state("codex").state, "on", "the user's config is above the system config");
  s.write(s.systemConfig, CODEX_BLOCK.replace('default_permissions = "sage"\n', ""));
  s.codex(`${NEVER}default_permissions = "team"\n\n[permissions.team]\nextends = "sage"\n\n[permissions.team.filesystem]\n"~/sage-worktrees" = "deny"\n`);
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
  assert.match(strict(`${CODEX_BLOCK}enabled = false\n`, "a key given twice"), /^~\/\.codex\/config\.toml is not valid TOML \(TOML line \d+: enabled is given twice\)$/);
  assert.equal(strict('default_permissions = "sage\n', "an open string"), "~/.codex/config.toml is not valid TOML (TOML line 1: line break in a string)");
  assert.match(strict('default_permissions = "missing"\n', "no such profile"), /"missing" has no \[permissions\.missing\] table/);
  assert.match(strict('default_permissions = "x"\n[permissions.x]\nextends = ":danger-full-access"\n', "Codex refuses this parent"), /extends ":danger-full-access", which Codex refuses/);
  assert.match(strict('default_permissions = "x"\n[permissions.x]\nextends = "y"\n[permissions.y]\nextends = "x"\n', "a loop"), /extends itself/);
  strict('default_permissions = "x"\n[permissions.x]\nextends = ":workspace"\n[permissions.x.filesystem]\n"~/a" = "all"\n', "an access that Codex does not have");
  strict('default_permissions = "x"\n[permissions.x]\nextends = ":workspace"\n[permissions.x.network]\nenabled = "yes"\n', "a string for a boolean");
  strict('sandbox_mode = "workspace"\n', "a mode that Codex does not have");
  strict("sandbox_mode = true\n", "a boolean for a string");
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on");
  s.write(join(s.project, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  assert.equal(s.state("codex").reason, `the project's .codex/config.toml sets sandbox_mode; sage reads these keys only in ~/.codex/config.toml, ${s.systemConfig} and ${s.managedConfig}`);
  s.write(join(s.project, ".codex", "config.toml"), 'model = "x"\n');
  assert.equal(s.state("codex").state, "on", "a project config without a sandbox key changes nothing");
  s.write(join(s.project, ".codex", "config.toml"), "model = \n");
  assert.equal(s.state("codex").state, "strict", "a project config that is not TOML");
  rmSync(join(s.project, ".codex"), { recursive: true });
  s.write(join(s.dir, "codex-home", "config.toml"), "[");
  assert.match(s.state("codex", { CODEX_HOME: join(s.dir, "codex-home") }).reason, /^\$CODEX_HOME\/config\.toml is not valid TOML/, "the line names the variable, not its value");
});

test("Codex: an automatic reviewer of approvals reads as on but may run unsandboxed, and asks for the user as the reviewer", (t) => {
  const s = scratch(t);
  s.codex(`approvals_reviewer = "auto_review"\n${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed");
  assert.deepEqual(s.state("codex").missing, ['approvals_reviewer = "user"']);
  assert.deepEqual(s.state("codex").loose, ["an automatic reviewer can approve a command outside the sandbox (approval_policy is on-request by default)"]);
  s.codex(`approvals_reviewer = "auto_review"\n${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.state("codex").state, "on", "with no approvals, nothing runs outside");
});

test("F-T1241-36: an open Unix socket of Codex, in the profile, a profile that it extends, or features.network_proxy of any config, reads as may run unsandboxed and is named; a deny or a false closes it", (t) => {
  const s = scratch(t);
  const read = (text) => {
    s.codex(`${NEVER}${CODEX_BLOCK}${text}`);
    return s.state("codex");
  };
  const open = (text, named) => {
    const found = read(text);
    assert.equal(found.state, "may-run-unsandboxed", text);
    assert.deepEqual(found.loose, [named], text);
    assert.deepEqual(found.missing, [], text);
  };
  open('\n[permissions.sage.network.unix_sockets]\n"/var/run/docker.sock" = "allow"\n', "permissions.sage.network.unix_sockets allows a socket");
  open("dangerously_allow_all_unix_sockets = true\n", "permissions.sage.network.dangerously_allow_all_unix_sockets");
  s.codex(`${NEVER}${CODEX_BLOCK.replace('extends = ":workspace"', 'extends = "base"')}\n[permissions.base]\nextends = ":workspace"\n[permissions.base.network.unix_sockets]\n"/var/run/docker.sock" = "allow"\n`);
  assert.deepEqual(s.state("codex").loose, ["permissions.sage.network.unix_sockets allows a socket"], "an allow of the profile that it extends");
  s.codex(`${NEVER}${CODEX_BLOCK.replace('extends = ":workspace"', 'extends = "base"')}[permissions.sage.network.unix_sockets]\n"/var/run/docker.sock" = "deny"\n[permissions.base]\nextends = ":workspace"\n[permissions.base.network]\ndangerously_allow_all_unix_sockets = true\n[permissions.base.network.unix_sockets]\n"/var/run/docker.sock" = "allow"\n`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed", "an inherited allow-all, which a deny of one path does not close");
  s.codex(`${NEVER}${CODEX_BLOCK.replace('extends = ":workspace"', 'extends = "base"')}dangerously_allow_all_unix_sockets = false\n[permissions.sage.network.unix_sockets]\n"/var/run/docker.sock" = "deny"\n[permissions.base]\nextends = ":workspace"\n[permissions.base.network]\ndangerously_allow_all_unix_sockets = true\n[permissions.base.network.unix_sockets]\n"/var/run/docker.sock" = "allow"\n`);
  assert.equal(s.state("codex").state, "on", "the profile's own false and deny close what it extends");
  open('\n[features.network_proxy.unix_sockets]\n"/var/run/docker.sock" = "allow"\n', "features.network_proxy.unix_sockets allows a socket");
  open("\n[features.network_proxy]\ndangerously_allow_all_unix_sockets = true\n", "features.network_proxy.dangerously_allow_all_unix_sockets");
  s.write(s.systemConfig, '[features.network_proxy]\ndangerously_allow_all_unix_sockets = true\n');
  open("", "features.network_proxy.dangerously_allow_all_unix_sockets");
  rmSync(s.systemConfig);
  s.write(join(s.project, ".codex", "config.toml"), '[features.network_proxy.unix_sockets]\n"/var/run/docker.sock" = "allow"\n');
  open("", "the project's .codex/config.toml: features.network_proxy.unix_sockets allows a socket");
  rmSync(join(s.project, ".codex"), { recursive: true });
  assert.equal(read('\n[permissions.sage.network.unix_sockets]\n"/tmp/old.sock" = "deny"\n[features]\nnetwork_proxy = true\n').state, "on", "a deny opens nothing, and network_proxy = true has no socket");
  assert.equal(read('\n[permissions.sage.network.unix_sockets]\n"/var/run/docker.sock" = "yes"\n').state, "strict", "a socket value that is not allow or deny");
  assert.equal(read('dangerously_allow_all_unix_sockets = "true"\n').state, "strict", "an allow-all that is not true or false");
  assert.match(guideSection("codex"), /A Unix socket is open: .*`dangerously_allow_all_unix_sockets = true` or a `unix_sockets` entry with `"allow"`/);
});

test("F-T1241-39: the guide's Codex profile closes the board's config folder, and a profile without the deny names it as missing", (t) => {
  const s = scratch(t);
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.equal(s.line("codex"), "Codex: on, fails closed · writes: the project, $TMPDIR, /tmp, ~/sage-worktrees, the project's .git · network: on · known gap: git metadata, which git can run later outside the sandbox · missing: none");
  const line = '"~/.config/sage-board" = "deny"\n', item = '"~/.config/sage-board" = "deny" in [permissions.sage.filesystem]';
  for (const text of [CODEX_BLOCK.replace(line, ""), CODEX_BLOCK.replace(line, '"~/.config/sage-board" = "read"\n')]) {
    s.codex(`${NEVER}${text}`);
    assert.deepEqual(s.state("codex").missing, [item], text);
    assert.ok(s.line("codex").endsWith(`missing: ${item}`));
  }
});

test("F-T1241-44: the Codex steps give both approval choices, where the never line goes, and the line of each; the never line fails closed only above the first table", (t) => {
  const s = scratch(t), steps = guideSection("codex");
  assert.match(steps, /\n4\. Choose the approval policy\. .*\n- \*\*No `approval_policy` line\*\* \(recommended; Codex then uses `on-request`\): Codex asks you .*\n- \*\*`approval_policy = "never"`\*\*: Codex never asks, and a command that the sandbox blocks fails\. Put this line at the top of the file, next to `default_permissions = "sage"` and above the first line that starts with `\[`\./);
  assert.match(steps, /\[Codex: Configuration reference\]\(https:\/\/learn\.chatgpt\.com\/docs\/config-file\/config-reference\.md\), key `approval_policy`/);
  s.codex(CODEX_BLOCK);
  assert.match(s.line("codex"), /^Codex: on, but may run unsandboxed · .* · may run outside the sandbox: you can approve a command outside the sandbox \(approval_policy is on-request by default\) · missing: none$/);
  s.codex(`${NEVER}${CODEX_BLOCK}`);
  assert.match(s.line("codex"), /^Codex: on, fails closed · .* · missing: none$/);
  s.codex(`${CODEX_BLOCK}${NEVER}`);
  assert.equal(s.state("codex").state, "may-run-unsandboxed", "below a table, the line is a key of that table");
});

test("F-T1241-42: the line names a loose excluded command by its place in the list and never prints its text, so an inline token stays out", (t) => {
  const s = scratch(t);
  const json = s.guide(), token = "sk-FAKE-TOKEN-123";
  json.sandbox.excludedCommands.push(`curl -H 'Authorization: Bearer ${token}' *`, `TOKEN=${token} make *`);
  s.claude(json);
  const found = s.state("claude"), line = s.line("claude");
  assert.equal(found.state, "may-run-unsandboxed");
  assert.deepEqual(found.loose, ["~/.claude/settings.json: excludedCommands entry 4", "~/.claude/settings.json: excludedCommands entry 5"]);
  assert.ok(!line.includes("FAKE") && !line.includes("curl") && !line.includes("Bearer"), line);
});

test("F-T1241-20: the guide's check of a refused write starts from the project's folder", () => {
  const step = /\n7\. (.*)\n/.exec(guideSection("codex"))[1];
  const go = step.indexOf("first go to the project's folder");
  assert.ok(go !== -1 && go < step.indexOf("codex sandbox macos"), step);
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

test("F-T1241-8: sage sandbox in each plugin prints the reader's lines for the machine's real system files, changes no file and prints no value of the environment", (t) => {
  const s = scratch(t);
  s.claude(s.guide());
  s.codex('sandbox_mode = "danger-full-access"\n');
  const before = files(s.dir);
  const claude = tool(CLAUDE_TOOL, s.project, s.env), codex = tool(CODEX_TOOL, s.project, s.env);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(claude.stdout, codex.stdout, "both plugins read the same files");
  assert.equal(claude.stdout.trimEnd(), sandboxStatus({ env: s.env, cwd: s.project, places: sandboxPlaces(s.env) }));
  assert.equal(claude.stdout.trimEnd().split("\n").length, 2);
  for (const value of [s.home, s.env.TMPDIR, s.env.SAGE_HOME, s.dir]) assert.ok(!claude.stdout.includes(value), "no value of the environment");
  assert.deepEqual(files(s.dir), before, "no file changed or added");
  const words = tool(CLAUDE_TOOL, s.project, s.env, "now");
  assert.equal(words.status, 1);
  assert.match(words.stderr, /^sage: sandbox takes no words/);
  const entries = tool(CODEX_TOOL, s.project, s.env, "entries");
  assert.equal(entries.status, 1, "only the Claude Code plugin knows its own folder");
  assert.match(entries.stderr, /run it with the Claude Code plugin's sage\.mjs/);
});

test("the guide's blocks parse: the JSON block as JSON, the TOML block with core's reader and with Python's tomllib", (t) => {
  const json = JSON.parse(CLAUDE_BLOCK);
  assert.deepEqual(Object.keys(json.sandbox), ["enabled", "failIfUnavailable", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed", "excludedCommands", "filesystem"]);
  assert.equal(json.sandbox.excludedCommands.length, entries().length, "the block has a line for each line of sage sandbox entries");
  const toml = parseToml(CODEX_BLOCK);
  assert.equal(toml.default_permissions, "sage", "the top line is a top-level key, not a key of a table");
  assert.deepEqual(toml.permissions.sage.filesystem, { "~/sage-worktrees": "write", "~/.config/sage-board": "deny", ":workspace_roots": { ".git": "write", ".git/hooks": "read", ".git/config": "read" } });
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
