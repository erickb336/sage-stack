import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseToml } from "./toml.mjs";
import { worktreeRoot } from "./worktrees.mjs";

const MAX_BYTES = 1 << 20;
const TMPDIR = "$TMPDIR";
const NAMES = { claude: "Claude Code", codex: "Codex" };
const LABELS = { on: "on, fails closed", "may-run-unsandboxed": "on, but may run unsandboxed", off: "off", strict: "strict rules (sage cannot confirm the sandbox)" };
const SANDBOX_KEYS = ["sandbox_mode", "sandbox_workspace_write", "default_permissions", "permissions", "approval_policy", "approvals_reviewer"];
const ACCESS = ["read", "write", "deny"];
const NAMED = ["SAGE_WORKTREES", "SAGE_HOME", "TMPDIR"];
const LOOSE = [
  [["allowAppleEvents"], "boolean"], [["allowNestedUserNamespaces"], "boolean"], [["enableWeakerNestedSandbox"], "boolean"], [["enableWeakerNetworkIsolation"], "boolean"],
  [["network", "allowAllUnixSockets"], "boolean"], [["network", "allowLocalBinding"], "boolean"], [["network", "allowUnixSockets"], "list"], [["network", "allowMachLookup"], "list"],
  [["network", "httpProxyPort"], "number"], [["network", "socksProxyPort"], "number"],
];
const SAGE_ENTRY = /^node (\/[^\s*?[\]]+)\/(skills\/sage\/sage\.mjs|board\/cli\.mjs board) \*$/;
const GIT_GUARD = [".git/hooks", ".git/config"];

class Strict extends Error {}
const strict = (why) => { throw new Strict(why); };
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const homeOf = (env) => resolve(env.HOME || homedir());
const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function shower(env, project, named = []) {
  const roots = [...[...named, ...NAMED].filter((name) => env[name] && isAbsolute(env[name])).map((name) => [resolve(env[name]), `$${name}`]), ...(project ? [[project, ""]] : []), [homeOf(env), "~"]]
    .sort((a, b) => b[0].length - a[0].length);
  return (path) => {
    if (path === TMPDIR) return TMPDIR;
    const [root, name] = roots.find(([r]) => within(path, r)) ?? [];
    if (root === undefined) return path;
    const rest = path.slice(root.length + 1);
    if (name === "") return path === root ? "the project" : `the project's ${rest}`;
    return path === root ? name : `${name}/${rest}`;
  };
}

function readText(file, shown) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    strict(`${shown} cannot be read`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) strict(`${shown} is not a file`);
    if (stat.size > MAX_BYTES) strict(`${shown} is over 1 MiB`);
    return readFileSync(fd, "utf8");
  } catch (error) {
    if (error instanceof Strict) throw error;
    strict(`${shown} cannot be read`);
  } finally { closeSync(fd); }
}

function readLayer(file, shown, parse, kind) {
  const text = readText(file, shown);
  if (text === undefined) return undefined;
  let data;
  try { data = parse(text); } catch (error) { strict(`${shown} is not valid ${kind}${kind === "TOML" ? ` (${error.message})` : ""}`); }
  return isTable(data) ? data : strict(`${shown} is not a ${kind} table`);
}

function gitRoots(start, show) {
  for (let dir = start; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    let stat;
    try { stat = statSync(git); } catch {}
    if (stat?.isDirectory()) return { top: dir, main: dir };
    if (stat) {
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(readText(git, show(git)) ?? "")?.[1];
      const main = target && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir, target))?.[1];
      return { top: dir, main: main || dir };
    }
    if (dir === dirname(dir)) return {};
  }
}

function claude({ env, cwd, places }) {
  const home = homeOf(env), project = resolve(cwd), config = dirname(places.user), show = shower(env, project, places.named);
  const { main } = gitRoots(project, show);
  const files = [
    { kind: "user", file: places.user, shown: places.userShown },
    { kind: "project", file: join(project, places.project) },
    { kind: "local", file: join(project, places.local) },
    main && main !== home && { kind: "local", file: join(main, places.local) },
    { kind: "managed", file: join(places.managed, "managed-settings.json") },
  ].filter((f, i, all) => f && all.findIndex((g) => g && g.file === f.file) === i);
  try { if (statSync(join(places.managed, "managed-settings.d"))) strict(`${join(places.managed, "managed-settings.d")} exists, and sage does not read it`); } catch (error) { if (error instanceof Strict) throw error; }
  const layers = files.map((f) => {
    const shown = f.shown ?? show(f.file);
    return { ...f, shown, data: readLayer(f.file, shown, JSON.parse, "JSON") };
  }).filter((l) => l.data);
  const at = (l, path, type) => {
    const v = path.reduce((o, part) => (isTable(o) ? o[part] : undefined), l.data);
    if (v === undefined) return undefined;
    if (type === "object" && !isTable(v)) strict(`${l.shown}: ${path.join(".")} is not an object`);
    if (type === "boolean" && typeof v !== "boolean") strict(`${l.shown}: ${path.join(".")} is not true or false`);
    if (type === "number" && typeof v !== "number") strict(`${l.shown}: ${path.join(".")} is not a number`);
    if (type === "list" && !(Array.isArray(v) && v.every((s) => typeof s === "string"))) strict(`${l.shown}: ${path.join(".")} is not a list of strings`);
    return v;
  };
  for (const l of layers) for (const path of [["sandbox"], ["sandbox", "filesystem"], ["sandbox", "network"], ["permissions"]]) at(l, path, "object");
  const last = (path, kinds) => layers.reduce((found, l) => (kinds && !kinds.includes(l.kind)) ? found : (at(l, path, "boolean") ?? found), undefined);
  const enabled = last(["sandbox", "enabled"]), failsClosed = last(["sandbox", "failIfUnavailable"]);
  const filesystemOff = last(["sandbox", "filesystem", "disabled"], ["user", "managed"]);
  const retrySource = layers.findLast((l) => at(l, ["sandbox", "allowUnsandboxedCommands"], "boolean") !== undefined);
  const retry = retrySource ? at(retrySource, ["sandbox", "allowUnsandboxedCommands"], "boolean") && !(["project", "local"].includes(retrySource.kind) && last(["sandbox", "allowUnsandboxedCommands"], ["user"]) === false) : true;
  const writes = [project, TMPDIR], allow = layers.flatMap((l) => (at(l, ["permissions", "allow"], "list") ?? []).map((rule) => ({ rule, l })));
  const base = (l) => (l.kind === "user" ? config : project);
  const plain = (p, l, key) => (p === "" || p.includes("$") || /^~[^/]/.test(p) ? strict(`${l.shown}: ${key} has "${p}", and sage cannot tell where it points`) : p);
  for (const l of layers) {
    for (const p of at(l, ["permissions", "additionalDirectories"], "list") ?? []) writes.push(fromHome(plain(p, l, "permissions.additionalDirectories"), home, project));
    for (const p of at(l, ["sandbox", "filesystem", "allowWrite"], "list") ?? []) writes.push(sandboxPath(plain(p, l, "sandbox.filesystem.allowWrite"), home, base(l)));
  }
  for (const { rule, l } of allow) {
    const spec = /^Edit\((.+)\)$/.exec(rule)?.[1];
    if (spec) plain(spec, l, `permissions.allow ${rule}`);
    if (spec) writes.push(trimGlob(spec.startsWith("//") ? spec.slice(1) : spec.startsWith("~") ? fromHome(spec, home, project) : spec.startsWith("/") ? join(base(l), spec) : join(project, spec)));
  }
  const network = allow.some(({ rule }) => rule === "WebFetch(domain:*)");
  const plugins = join(config, "plugins"), excluded = layers.flatMap((l) => (at(l, ["sandbox", "excludedCommands"], "list") ?? []).map((entry) => ({ entry, l })));
  const sageEntry = (entry) => {
    const [, dir, tool] = SAGE_ENTRY.exec(entry) ?? [];
    return dir && !dir.split("/").some((s) => s === "." || s === "..") && within(dir, plugins) && !writes.some((root) => within(dir, root)) ? tool : undefined;
  };
  const loose = excluded.filter(({ entry }) => entry !== "gh *" && !sageEntry(entry)).map(({ entry, l }) => `${l.shown}: excludedCommands ${JSON.stringify(entry)}`);
  for (const l of layers) for (const [path, type] of LOOSE) {
    const v = at(l, ["sandbox", ...path], type);
    if (v === true || (type === "list" && v?.length) || (type === "number" && v !== undefined)) loose.push(`${l.shown}: sandbox.${path.join(".")}`);
  }
  const tools = excluded.map(({ entry }) => sageEntry(entry));
  const denied = layers.some((l) => (at(l, ["sandbox", "filesystem", "denyRead"], "list") ?? []).some((p) => p && !p.includes("$") && sandboxPath(p, home, base(l)) === join(home, ".config", "sage-board")));
  const state = enabled !== true || filesystemOff === true ? "off" : failsClosed !== true || retry !== false || loose.length ? "may-run-unsandboxed" : "on";
  const sage = worktreeRoot(env);
  const missing = [
    enabled !== true && "sandbox.enabled: true",
    failsClosed !== true && "sandbox.failIfUnavailable: true",
    retry !== false && "sandbox.allowUnsandboxedCommands: false",
    last(["sandbox", "autoAllowBashIfSandboxed"]) !== true && "sandbox.autoAllowBashIfSandboxed: true",
    filesystemOff === true && "no sandbox.filesystem.disabled",
    !excluded.some(({ entry }) => entry === "gh *") && '"gh *" in sandbox.excludedCommands',
    !tools.includes("skills/sage/sage.mjs") && "the state tool's line in sandbox.excludedCommands (sage sandbox entries prints it)",
    !tools.includes("board/cli.mjs board") && "the board's line in sandbox.excludedCommands (sage sandbox entries prints it)",
    !writes.some((root) => within(sage, root)) && `"${show(sage)}" in sandbox.filesystem.allowWrite`,
    !denied && '"~/.config/sage-board" in sandbox.filesystem.denyRead',
    !network && '"WebFetch(domain:*)" in permissions.allow',
  ].filter(Boolean);
  return { state, writes: state === "off" ? [] : unique(writes), network, outside: excluded.filter(({ entry }, i) => entry === "gh *" || tools[i]).length, loose, missing };
}

const unique = (list) => [...new Set(list)];
const trimGlob = (path) => path.replace(/\/\*\*?$|\*\*$/, "").replace(/(.)\/+$/, "$1") || "/";
const fromHome = (path, home, project) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(project, path));
function sandboxPath(path, home, base) {
  const p = trimGlob(path);
  return p.startsWith("//") ? resolve(p.slice(1)) : p.startsWith("/") ? resolve(p) : p === "~" || p.startsWith("~/") ? fromHome(p, home, base) : resolve(base, p);
}

const RULE_TOKENS = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*|\bdecision\s*=\s*(["'])(?:prompt|forbidden)\1|\bprefix_rule\b|[()]/g;
function rulesAllow(text) {
  if (/\ballow\b/.test(text)) return true;
  const tokens = [...text.matchAll(RULE_TOKENS)];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i][0] !== "prefix_rule") continue;
    const open = tokens[i + 1];
    if (open?.[0] !== "(" || text.slice(tokens[i].index + 11, open.index).trim()) return true;
    let depth = 0, decided = false, j = i + 1;
    for (; j < tokens.length; j++) {
      const t = tokens[j][0];
      if (t === "(") depth++;
      else if (t === ")" && --depth === 0) break;
      else if (depth === 1 && t.startsWith("decision")) decided = true;
    }
    if (j === tokens.length || !decided) return true;
    i = j;
  }
  return false;
}

function allowRules(dir, show) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    strict(`${show(dir)} cannot be read`);
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".rules")).map((e) => join(dir, e.name)).filter((file) => rulesAllow(readText(file, show(file))));
}

function codex({ env, cwd, places }) {
  const home = homeOf(env), project = resolve(cwd), { user, userShown, system, managed } = places, show = shower(env, project, places.named);
  const top = gitRoots(project, show).top ?? project;
  const ruleDirs = [join(dirname(user), "rules"), join(dirname(system), "rules")];
  for (let dir = project; ; dir = dirname(dir)) {
    const file = join(dir, places.project), shown = show(file);
    const keys = file === user ? [] : Object.keys(readLayer(file, shown, parseToml, "TOML") ?? {}).filter((key) => SANDBOX_KEYS.includes(key));
    if (keys.length) strict(`${shown} sets ${keys.join(", ")}; sage reads these keys only in ${userShown}, ${show(system)} and ${show(managed)}`);
    ruleDirs.push(join(dirname(file), "rules"));
    if (dir === top || dir === dirname(dir)) break;
  }
  const layers = [[system, show(system)], [user, userShown], [managed, show(managed)]].map(([file, shown]) => readLayer(file, shown, parseToml, "TOML") ?? {});
  const merged = layers.reduce(merge, {});
  if (merged.profile !== undefined) strict(`a config sets profile = ${JSON.stringify(String(merged.profile))}, and sage does not follow profiles`);
  for (const [name, table] of Object.entries(isTable(merged.profiles) ? merged.profiles : {})) {
    const keys = isTable(table) ? Object.keys(table).filter((key) => SANDBOX_KEYS.includes(key)) : [];
    if (keys.length) strict(`[profiles.${name}] sets ${keys.join(", ")}, and sage does not follow profiles`);
  }
  const text = (key) => (merged[key] === undefined || typeof merged[key] === "string" ? merged[key] : strict(`${key} is not a string`));
  const mode = text("sandbox_mode"), chosen = text("default_permissions");
  let found;
  if (mode !== undefined) found = legacy(mode, merged.sandbox_workspace_write, { home, project });
  else if (chosen !== undefined) found = profile(chosen, merged.permissions, { home, project });
  else found = { state: "on", writes: [project, TMPDIR, "/tmp"], network: false, git: false };
  const sage = worktreeRoot(env), custom = chosen !== undefined && mode === undefined && !chosen.startsWith(":");
  const policy = merged.approval_policy, granular = isTable(policy) && isTable(policy.granular) ? policy.granular : undefined;
  const asks = !(policy === "never" || (granular && ["sandbox_approval", "rules", "request_permissions", "skill_approval"].every((key) => granular[key] === false)));
  const autoReview = merged.approvals_reviewer === "auto_review" && asks;
  const loose = [
    ...unique(ruleDirs).flatMap((dir) => allowRules(dir, show)).map((file) => `${show(file)} has an allow rule`),
    asks && `${autoReview ? "an automatic reviewer" : "you"} can approve a command outside the sandbox (approval_policy ${policy === undefined ? "is on-request by default" : typeof policy === "string" ? `= "${policy}"` : "is granular"})`,
  ].filter(Boolean);
  const missing = custom ? [
    found.base !== ":workspace" && `extends = ":workspace" in [permissions.${chosen}]`,
    !found.git && `".git" = "write" in [permissions.${chosen}.filesystem.":workspace_roots"]`,
    found.git && !found.gitGuard && `".git/hooks" = "read" and ".git/config" = "read" in [permissions.${chosen}.filesystem.":workspace_roots"]`,
    !found.network && `enabled = true in [permissions.${chosen}.network]`,
    found.state !== "off" && !found.writes.some((root) => within(sage, root)) && `"${show(sage)}" = "write" in [permissions.${chosen}.filesystem]`,
  ] : [`default_permissions = "sage", with the [permissions.sage] tables of the guide`, mode !== undefined && `no sandbox_mode line (Codex reads default_permissions only without it)`];
  if (autoReview) missing.push(`approvals_reviewer = "user"`);
  const state = found.state === "on" && loose.length ? "may-run-unsandboxed" : found.state;
  return { state, writes: found.state === "off" ? [] : unique(found.writes), network: found.network, loose: found.state === "off" ? [] : loose, missing: missing.filter(Boolean) };
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
  const gitGuard = GIT_GUARD.every((path) => ["read", "deny"].includes(rules.get(`:workspace_roots/${path}`)));
  return { state: "on", writes, network, git: rules.get(":workspace_roots/.git") === "write", gitGuard, base: name };
}

export function sandboxState(provider, { env = process.env, cwd = process.cwd(), places }) {
  const read = { claude, codex }[provider];
  if (!read || !places) throw new TypeError(`sandboxState needs a provider (claude or codex) and the places of its settings files, not ${provider}`);
  try {
    return { provider, named: places.named ?? [], ...read({ env, cwd, places }) };
  } catch (error) {
    if (!(error instanceof Strict)) throw error;
    return { provider, named: places.named ?? [], state: "strict", reason: error.message, writes: [], loose: [], missing: [] };
  }
}

export function sandboxLine(found, { env = process.env, cwd = process.cwd() } = {}) {
  const show = shower(env, resolve(cwd), found.named);
  const parts = [`${NAMES[found.provider]}: ${LABELS[found.state]}${found.reason ? `: ${found.reason}` : ""}`];
  if (found.state === "on" || found.state === "may-run-unsandboxed") {
    parts.push(`writes: ${found.writes.length ? found.writes.map(show).join(", ") : "nothing"}`);
    parts.push(`network: ${found.network ? "on" : found.provider === "claude" ? "the hosts that you allow" : "off"}`);
    if (found.outside) parts.push(`${found.outside} command pattern${found.outside === 1 ? "" : "s"} of the guide run outside the sandbox`);
    if (found.loose?.length) parts.push(`may run outside the sandbox: ${found.loose.join("; ")}`);
  }
  if (found.state !== "strict") parts.push(`missing: ${found.missing.length ? found.missing.join("; ") : "none"}`);
  return parts.join(" · ");
}

export const sandboxStatus = ({ places, ...options }) => ["claude", "codex"].map((provider) => sandboxLine(sandboxState(provider, { ...options, places: places[provider] }), options)).join("\n");
