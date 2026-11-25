import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parseToml } from "./toml.mjs";
import { worktreeRoot } from "./worktrees.mjs";

const MAX_BYTES = 1 << 20;
const TMPDIR = "$TMPDIR";
const NAMES = { claude: "Claude Code", codex: "Codex" };
const LABELS = { on: "on, fails closed", "may-run-unsandboxed": "on, but may run unsandboxed", off: "off", strict: "strict rules (sage cannot confirm the sandbox)" };
const CLAUDE_MANAGED = process.platform === "darwin" ? "Library/Application Support/ClaudeCode" : "etc/claude-code";
const CODEX_SANDBOX_KEYS = ["sandbox_mode", "sandbox_workspace_write", "default_permissions", "permissions", "approval_policy", "approvals_reviewer"];
const ACCESS = ["read", "write", "deny"];

class Strict extends Error {}
const strict = (why) => { throw new Strict(why); };
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const homeOf = (env) => resolve(env.HOME || homedir());
const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function readLayer(file, shown, parse, kind) {
  let text;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) strict(`${shown} is not a file`);
    if (stat.size > MAX_BYTES) strict(`${shown} is over 1 MiB`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Strict) throw error;
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    strict(`${shown} cannot be read`);
  }
  let data;
  try { data = parse(text); } catch (error) { strict(`${shown} is not valid ${kind}${kind === "TOML" ? ` (${error.message})` : ""}`); }
  return isTable(data) ? data : strict(`${shown} is not a ${kind} table`);
}

function gitRoots(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    try {
      if (statSync(git).isDirectory()) return { top: dir, main: dir };
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, "utf8"))?.[1];
      const main = target && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir, target))?.[1];
      return { top: dir, main: main || dir };
    } catch {}
    if (dir === dirname(dir)) return {};
  }
}

function claude({ env, cwd, system }) {
  const home = homeOf(env), project = resolve(cwd), config = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const { main } = gitRoots(project);
  const user = join(config, "settings.json"), managed = join(system, CLAUDE_MANAGED);
  const files = [
    { kind: "user", file: user, shown: env.CLAUDE_CONFIG_DIR ? "$CLAUDE_CONFIG_DIR/settings.json" : "~/.claude/settings.json" },
    { kind: "project", file: join(project, ".claude", "settings.json") },
    { kind: "local", file: join(project, ".claude", "settings.local.json") },
    main && main !== home && { kind: "local", file: join(main, ".claude", "settings.local.json") },
    { kind: "managed", file: join(managed, "managed-settings.json") },
  ].filter((f, i, all) => f && all.findIndex((g) => g && g.file === f.file) === i);
  try { if (statSync(join(managed, "managed-settings.d"))) strict(`${join(managed, "managed-settings.d")} exists, and sage does not read it`); } catch (error) { if (error instanceof Strict) throw error; }
  const layers = files.map((f) => {
    const shown = f.shown ?? shownPath(f.file, { home, project });
    return { ...f, shown, data: readLayer(f.file, shown, JSON.parse, "JSON") };
  }).filter((l) => l.data);
  const at = (l, path, type) => {
    const v = path.reduce((o, part) => (isTable(o) ? o[part] : undefined), l.data);
    if (v === undefined) return undefined;
    if (type === "object" && !isTable(v)) strict(`${l.shown}: ${path.join(".")} is not an object`);
    if (type === "boolean" && typeof v !== "boolean") strict(`${l.shown}: ${path.join(".")} is not true or false`);
    if (type === "list" && !(Array.isArray(v) && v.every((s) => typeof s === "string"))) strict(`${l.shown}: ${path.join(".")} is not a list of strings`);
    return v;
  };
  for (const l of layers) for (const path of [["sandbox"], ["sandbox", "filesystem"], ["permissions"]]) at(l, path, "object");
  const last = (path, kinds) => layers.reduce((found, l) => (kinds && !kinds.includes(l.kind)) ? found : (at(l, path, "boolean") ?? found), undefined);
  const enabled = last(["sandbox", "enabled"]), failsClosed = last(["sandbox", "failIfUnavailable"]);
  const filesystemOff = last(["sandbox", "filesystem", "disabled"], ["user", "managed"]);
  const retrySource = layers.findLast((l) => at(l, ["sandbox", "allowUnsandboxedCommands"], "boolean") !== undefined);
  const retry = retrySource ? at(retrySource, ["sandbox", "allowUnsandboxedCommands"], "boolean") && !(["project", "local"].includes(retrySource.kind) && last(["sandbox", "allowUnsandboxedCommands"], ["user"]) === false) : true;
  const writes = [project, TMPDIR], allow = layers.flatMap((l) => (at(l, ["permissions", "allow"], "list") ?? []).map((rule) => ({ rule, l })));
  const base = (l) => (l.kind === "user" ? config : project);
  for (const l of layers) {
    for (const p of at(l, ["permissions", "additionalDirectories"], "list") ?? []) writes.push(fromHome(p, home, project));
    for (const p of at(l, ["sandbox", "filesystem", "allowWrite"], "list") ?? []) writes.push(sandboxPath(p, home, base(l)));
  }
  for (const { rule, l } of allow) {
    const spec = /^Edit\((.+)\)$/.exec(rule)?.[1];
    if (spec) writes.push(trimGlob(spec.startsWith("//") ? spec.slice(1) : spec.startsWith("~") ? fromHome(spec, home, project) : spec.startsWith("/") ? join(base(l), spec) : join(project, spec)));
  }
  const network = allow.some(({ rule }) => rule === "WebFetch(domain:*)");
  const outside = layers.reduce((n, l) => n + (at(l, ["sandbox", "excludedCommands"], "list") ?? []).length, 0);
  const state = enabled !== true || filesystemOff === true ? "off" : failsClosed !== true || retry !== false ? "may-run-unsandboxed" : "on";
  const sage = worktreeRoot(env);
  const missing = [
    enabled !== true && "sandbox.enabled: true",
    failsClosed !== true && "sandbox.failIfUnavailable: true",
    retry !== false && "sandbox.allowUnsandboxedCommands: false",
    filesystemOff === true && "no sandbox.filesystem.disabled",
    !writes.some((root) => within(sage, root)) && `"${shownPath(sage, { home })}" in sandbox.filesystem.allowWrite`,
    !network && '"WebFetch(domain:*)" in permissions.allow',
  ].filter(Boolean);
  return { state, writes: state === "off" ? [] : unique(writes), network, outside, missing };
}

const unique = (list) => [...new Set(list)];
const trimGlob = (path) => path.replace(/\/\*\*?$|\*\*$/, "").replace(/(.)\/+$/, "$1") || "/";
const fromHome = (path, home, project) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(project, path));
function sandboxPath(path, home, base) {
  const p = trimGlob(path);
  return p.startsWith("//") ? resolve(p.slice(1)) : p.startsWith("/") ? resolve(p) : p === "~" || p.startsWith("~/") ? fromHome(p, home, base) : resolve(base, p);
}

function codex({ env, cwd, system }) {
  const home = homeOf(env), project = resolve(cwd), codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
  const user = join(codexHome, "config.toml"), userShown = env.CODEX_HOME ? "$CODEX_HOME/config.toml" : "~/.codex/config.toml";
  const systemFile = join(system, "etc", "codex", "config.toml");
  const top = gitRoots(project).top ?? project;
  for (let dir = project; ; dir = dirname(dir)) {
    const file = join(dir, ".codex", "config.toml"), shown = shownPath(file, { home, project });
    const keys = file === user ? [] : Object.keys(readLayer(file, shown, parseToml, "TOML") ?? {}).filter((key) => CODEX_SANDBOX_KEYS.includes(key));
    if (keys.length) strict(`${shown} sets ${keys.join(", ")}; sage reads these keys only in ${userShown} and ${shownPath(systemFile, { home })}`);
    if (dir === top || dir === dirname(dir)) break;
  }
  const merged = merge(readLayer(systemFile, shownPath(systemFile, { home }), parseToml, "TOML") ?? {}, readLayer(user, userShown, parseToml, "TOML") ?? {});
  const text = (key) => (merged[key] === undefined || typeof merged[key] === "string" ? merged[key] : strict(`${key} is not a string`));
  const mode = text("sandbox_mode"), chosen = text("default_permissions");
  let found;
  if (mode !== undefined) found = legacy(mode, merged.sandbox_workspace_write, { home, project });
  else if (chosen !== undefined) found = profile(chosen, merged.permissions, { home, project });
  else found = { state: "on", writes: [project, TMPDIR, "/tmp"], network: false, git: false };
  const sage = worktreeRoot(env), custom = chosen !== undefined && mode === undefined && !chosen.startsWith(":");
  const autoReview = merged.approvals_reviewer === "auto_review" && merged.approval_policy !== "never";
  const missing = custom ? [
    !found.git && `".git" = "write" in [permissions.${chosen}.filesystem.":workspace_roots"]`,
    !found.network && `enabled = true in [permissions.${chosen}.network]`,
    found.state !== "off" && !found.writes.some((root) => within(sage, root)) && `"${shownPath(sage, { home })}" = "write" in [permissions.${chosen}.filesystem]`,
  ] : [`default_permissions = "sage", with the [permissions.sage] tables of the guide`, mode !== undefined && `no sandbox_mode line (Codex reads default_permissions only without it)`];
  if (autoReview) missing.push(`approvals_reviewer = "user"`);
  return { state: found.state === "on" && autoReview ? "may-run-unsandboxed" : found.state, writes: found.state === "off" ? [] : unique(found.writes), network: found.network, missing: missing.filter(Boolean) };
}

function merge(low, high) {
  const out = { ...low };
  for (const [key, value] of Object.entries(high)) out[key] = isTable(value) && isTable(out[key]) ? merge(out[key], value) : value;
  return out;
}

function legacy(mode, options = {}, { home, project }) {
  if (mode === "danger-full-access") return { state: "off", writes: [], network: true, git: true };
  if (mode === "read-only") return { state: "on", writes: [], network: false, git: false };
  if (mode !== "workspace-write") strict(`sandbox_mode = "${mode}" is not a mode that sage knows`);
  if (!isTable(options)) strict("sandbox_workspace_write is not a table");
  const roots = options.writable_roots ?? [];
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== "string")) strict("sandbox_workspace_write.writable_roots is not a list of strings");
  return {
    state: "on", network: options.network_access === true, git: false,
    writes: [project, ...(options.exclude_tmpdir_env_var === true ? [] : [TMPDIR]), ...(options.exclude_slash_tmp === true ? [] : ["/tmp"]), ...roots.map((r) => fromHome(r, home, project))],
  };
}

function profile(chosen, all = {}, { home, project }) {
  if (chosen === ":danger-full-access") return { state: "off", writes: [], network: true, git: true };
  const rules = new Map(), roots = [project], chain = [];
  let name = chosen, network = false;
  while (!name.startsWith(":")) {
    const table = isTable(all) ? all[name] : undefined;
    if (!isTable(table)) strict(`the permission profile "${name}" has no [permissions.${name}] table`);
    if (chain.includes(table)) strict(`the permission profile "${name}" extends itself`);
    chain.unshift(table);
    if (table.extends === undefined) { name = undefined; break; }
    if (typeof table.extends !== "string" || ![":read-only", ":workspace"].includes(table.extends) && table.extends.startsWith(":")) strict(`[permissions.${name}] extends "${table.extends}", which Codex refuses`);
    name = table.extends;
  }
  if (name === ":workspace") for (const key of [":workspace_roots/.", TMPDIR, "/tmp"]) rules.set(key, "write");
  else if (name !== undefined && name !== ":read-only") strict(`default_permissions = "${chosen}" is not a profile that sage knows`);
  for (const table of chain) {
    for (const [path, on] of Object.entries(table.workspace_roots ?? {})) {
      if (typeof on !== "boolean") strict(`workspace_roots."${path}" is not true or false`);
      if (on) roots.push(fromHome(path, home, project));
    }
    for (const [path, value] of Object.entries(table.filesystem ?? {})) {
      if (path === "glob_scan_max_depth") continue;
      for (const [sub, access] of isTable(value) ? Object.entries(value) : [[".", value]]) {
        if (!ACCESS.includes(access)) strict(`filesystem."${path}" has an access that is not read, write or deny`);
        if (path === ":workspace_roots") rules.set(`:workspace_roots/${sub}`, access);
        else if (path.startsWith(":") && sub !== ".") strict(`filesystem."${path}" takes only "."`);
        else rules.set(join({ ":root": "/", ":tmpdir": TMPDIR, ":slash_tmp": "/tmp", ":minimal": ":minimal" }[path] ?? (path.startsWith("/") || path.startsWith("~") ? fromHome(path, home, project) : strict(`filesystem."${path}" is not a path that sage knows`)), sub), access);
      }
    }
    const on = table.network?.enabled;
    if (on !== undefined && typeof on !== "boolean") strict("network.enabled is not true or false");
    network = on ?? network;
  }
  const writes = [...rules].filter(([, access]) => access === "write").flatMap(([key]) => key.startsWith(":workspace_roots/") ? roots.map((root) => join(root, key.slice(17))) : [key]);
  return { state: "on", writes, network, git: rules.get(":workspace_roots/.git") === "write" };
}

function shownPath(path, { home, project }) {
  if (path === TMPDIR) return TMPDIR;
  if (project && within(path, project)) return path === project ? "the project" : `the project's ${path.slice(project.length + 1)}`;
  return within(path, home) ? `~${path.slice(home.length)}` : path;
}

export function sandboxState(provider, { env = process.env, cwd = process.cwd(), system = "/" } = {}) {
  const read = { claude, codex }[provider] ?? strict(`no provider ${provider}`);
  try {
    return { provider, ...read({ env, cwd, system }) };
  } catch (error) {
    if (!(error instanceof Strict)) throw error;
    return { provider, state: "strict", reason: error.message, writes: [], missing: [] };
  }
}

export function sandboxLine(found, { env = process.env, cwd = process.cwd() } = {}) {
  const at = { home: homeOf(env), project: resolve(cwd) };
  const parts = [`${NAMES[found.provider]}: ${LABELS[found.state]}${found.reason ? `: ${found.reason}` : ""}`];
  if (found.state === "on" || found.state === "may-run-unsandboxed") {
    parts.push(`writes: ${found.writes.length ? found.writes.map((p) => shownPath(p, at)).join(", ") : "nothing"}`);
    parts.push(`network: ${found.network ? "on" : found.provider === "claude" ? "the hosts that you allow" : "off"}`);
    if (found.outside) parts.push(`${found.outside} command pattern${found.outside === 1 ? "" : "s"} run outside the sandbox`);
  }
  if (found.state !== "strict") parts.push(`missing: ${found.missing.length ? found.missing.join("; ") : "none"}`);
  return parts.join(" · ");
}

export const sandboxStatus = (options) => ["claude", "codex"].map((provider) => sandboxLine(sandboxState(provider, options), options)).join("\n");
