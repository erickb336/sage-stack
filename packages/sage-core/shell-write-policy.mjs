import { flowOf, shellCommands, programsRun } from "./command-reader.mjs";
import { curlTargets, ghTargets, outputDispatchWrites } from "./output-writes.mjs";
import { GIT_VALUE, gitSubcommand, programName } from "./command-policy.mjs";
import { pythonRead } from "./python-read.mjs";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const CODE = /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/;
const WRITE_NAMES = new Set(["less", "tee", "cp", "mv", "rm", "rmdir", "ln", "link", "install", "touch", "dd", "truncate", "rsync", "sponge", "patch", "unlink", "shred", "tar", "unzip", "set-content", "out-file", "add-content", "copy-item", "move-item", "remove-item", "rename-item", "new-item", "ni", "sc", "ac", "del"]);
const READERS = /^(?:cat|grep|egrep|fgrep|rg|head|tail|wc|echo|printf|ls|diff|cut|stat|file|jq|cd|pushd)$/;
const READER_OPTIONS = {
  rg: {
    shortRun: "z", shortValue: "ABCEdefgjmMrtT",
    run: "pre pre-glob search-zip hostname-bin",
    value: "regexp file dfa-size-limit encoding engine max-count regex-size-limit threads glob iglob ignore-file max-depth max-filesize type type-not type-add type-clear after-context before-context color colors context context-separator field-context-separator field-match-separator hyperlink-format max-columns path-separator replace sort sortr generate",
  },
  file: {
    shortRun: "CzZ", shortValue: "efFmMP", prefixes: true,
    run: "compile uncompress uncompress-noreport",
    value: "magic-file exclude exclude-quiet files-from separator parameter",
    flag: "help version brief checking-printout mime apple extension mime-type mime-encoding keep-going list dereference no-dereference no-buffer no-pad print0 preserve-date raw special-files no-sandbox debug",
  },
  diff: {
    shortRun: "l", shortValue: "ACDFILSUWxX", prefixes: true,
    run: "paginate",
    value: "algorithm changed-group-format exclude exclude-from from-file horizon-lines ifdef ignore-matching-lines label line-format new-group-format new-line-format old-group-format old-line-format palette show-function-line starting-file tabsize to-file unchanged-group-format unchanged-line-format width",
    flag: "color context unified binary brief ed expand-tabs forward-ed help ignore-all-space ignore-blank-lines ignore-case ignore-file-name-case ignore-space-change ignore-tab-expansion ignore-trailing-space inhibit-hunk-merge initial-tab left-column minimal new-file no-dereference no-ignore-file-name-case normal rcs recursive report-identical-files sdiff-merge-assist show-c-function side-by-side speed-large-files strip-trailing-cr suppress-blank-empty suppress-common-lines text unidirectional-new-file version -no-directory -presume-output-tty",
  },
};
for (const options of Object.values(READER_OPTIONS)) {
  options.run = new Set(options.run.split(" "));
  options.value = new Set(options.value.split(" "));
  options.names = [...options.run, ...options.value, ...(options.flag ?? "").split(" ")];
}
function readerRuns(name, args) {
  if (!Object.hasOwn(READER_OPTIONS, name)) return false;
  const options = READER_OPTIONS[name];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("="), raw = arg.slice(2, equals < 0 ? undefined : equals);
      let option = raw;
      if (options.prefixes && !options.names.includes(raw)) {
        const matches = options.names.filter(candidate => candidate.startsWith(raw));
        if (matches.length === 1) option = matches[0];
        else if (name === "diff" && (raw === "p" || raw === "pa")) option = "paginate";
      }
      if (options.run.has(option)) return true;
      if (options.value.has(option) && equals < 0) i++;
    } else if (arg.startsWith("-")) {
      for (let k = 1; k < arg.length; k++) {
        if (options.shortRun.includes(arg[k])) return true;
        if (options.shortValue.includes(arg[k])) { if (k === arg.length - 1) i++; break; }
      }
    }
  }
  return false;
}
export const readerDispatch = entry => !entry.wrapper &&
  readerRuns(programName(entry.run.word), entry.run.args);
function toFile({ operator: op, target: to }) {
  if (op === "<" || op === "<&" || (op === ">&" && /^(?:\d+-?|-)$/.test(to))) return false;
  return !/^\/dev\/(?:null|stdout|stderr)$/.test(to);
}
export function uniqWrites(words, base) {
  const at = base.indexOf("uniq");
  if (at < 0) return false;
  if (at !== words.findIndex((w) => !FLOW_WORD.test(w) && !/^\w+=/.test(w)) || base.indexOf("uniq", at + 1) >= 0) return true;
  let operands = 0, options = true;
  for (let k = at + 1; k < words.length; k++) {
    const w = words[k];
    if (options && w === "--") options = false;
    else if (options && /^(?:-[cdDiuz]*[fsw]|--(?:skip-fields|skip-chars|check-chars))$/.test(w)) k++;
    else if (options && /^-./.test(w)) continue;
    else if (/[$`*?[{]/.test(w)) return true;
    else { operands++; options = false; }
  }
  return operands > 1;
}
const INTERPRETER = /^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/;
const runsCode = (words) => words.some((word, i) => INTERPRETER.test(programName(word)) && words.slice(i + 1).some((arg) => CODE.test(arg.toLowerCase())));
const writesCode = (words) => words.some((word, i) => INTERPRETER.test(programName(word)) && words.slice(i + 1).some((arg) => CODE.test(arg.toLowerCase())) && !pythonRead(programName(word), words.slice(i + 1)));
export function inlineCode(text) {
  try {
    return shellCommands(text).some(({ words }) => runsCode(words));
  } catch {
    return false;
  }
}
const PLACED = new Set(["rm", "rmdir", "touch", "tee", "cp", "mv"]);
function placedTargets(name, args) {
  const end = args.indexOf("--"), options = end < 0 ? args : args.slice(0, end);
  const operands = [...options.filter((a) => !a.startsWith("-")), ...(end < 0 ? [] : args.slice(end + 1))];
  if (!operands.length || options.some((a) => /^-[^-]*t|^--t/.test(a))) return true;
  return name === "cp" ? operands.slice(-1) : operands;
}
function writesIn({ words }, runs, placed, protect) {
  const low = words.map((w) => w.toLowerCase());
  const base = words.map(programName);
  const at = low.findIndex((w) => !/^\w+=/.test(w)), program = base[at] ?? "";
  if (READERS.test(program) || program === "gh") return false;
  if (program === "git") return /^(?:rm|mv)$/.test(gitSubcommand(words, at + 1));
  const has = (re) => base.some((w) => re.test(w) && runs.has(w));
  return (
    base.some((w) => WRITE_NAMES.has(w) && runs.has(w) && !(placed && PLACED.has(w))) || (runs.has("uniq") && uniqWrites(words, base)) ||
    (has(protect ? /^perl$|^ruby$/ : /^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^[gmn]?awk$/) && (low.includes("inplace") || words.some(awkWrites))) ||
    (has(/^g?sort$/) && low.some((w) => /^-[a-z]*o|^--o/.test(w))) ||
    (has(/^find$/) && low.some((w, k) => /^-(?:delete|fprint|fprint0|fprintf|fls)$/.test(w) || (/^-(?:exec|execdir|ok|okdir)$/.test(w) && !FIND_READS.test(programName(low[k + 1] ?? ""))))) ||
    writesCode(words) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
const FIND_READS = /^(?:ls|cat|head|tail|wc|stat|grep|egrep|fgrep|echo|printf|jq|cut)$/;
const AWK_RUNS = /\|&?\s*getline\b|\bsystem\s*\(/;
const AWK_PRINTS = /\bprintf?\b[^;{}\n]*[>|]/;
const awkWrites = (word) => {
  const code = word.replace(/>>?\s*"\/dev\/(?:stdout|stderr|null)"/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let printed = code;
  for (let last; last !== printed;) [last, printed] = [printed, printed.replace(/\([^()]*\)/g, "")];
  return AWK_RUNS.test(code) || AWK_PRINTS.test(printed);
};
function modeTargets(name, args) {
  const operands = [];
  let reference = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg.startsWith("-") && arg !== "-" && !(name === "chmod" && /^-[rwxXst]+$/.test(arg) && !operands.length && !reference)) {
      if (arg === "--") { operands.push(...args.slice(k + 1)); break; }
      if (/^--reference(?:=|$)/.test(arg)) { reference = true; if (!arg.includes("=")) k++; }
      continue;
    }
    operands.push(arg);
  }
  return reference ? operands : operands.slice(1);
}
const GIT_CHANGES = /^(?:checkout|switch|restore|reset|clean|apply|am|merge|pull|rebase|cherry-pick|revert|commit|add|rm|mv)$/;
const GIT_DRY = { clean: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, add: /^(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)$/, commit: /^--dry-run$/, apply: /^--(?:check|stat|numstat|summary)$/ };
const BRANCH_CHANGES = /^(?:-[a-zA-Z]*[dDmMcCfu][a-zA-Z]*|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)(?:=.*)?)$/;
const BRANCH_VALUE = /^--(?:sort|format|contains|no-contains|merged|no-merged|points-at)$/;
const CONFIG_CHANGES = /^(?:--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e)$/;
const CONFIG_VALUE = /^(?:-f|--file|--blob|--type|--default|--comment|--value)$/;
const CONFIG_READS = /^--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list|show-origin|show-scope|name-only|null)$|^-[lz]$/;
function gitDestroys(sub, rest) {
  const options = rest.slice(0, rest.includes("--") ? rest.indexOf("--") : undefined), paths = rest.length - options.length > 1;
  if (sub === "reset") return options.includes("--hard");
  if (sub === "checkout") return paths || options.some((a) => a === "." || /^(?:-f|--force)$/.test(a));
  if (sub === "switch") return options.some((a) => /^(?:-f|--force|--discard-changes)$/.test(a));
  if (sub === "clean") return !options.some((a) => GIT_DRY.clean.test(a)) && options.some((a) => /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force)$/.test(a));
  if (sub !== "restore") return false;
  let staged = false, worktree = false;
  for (let i = 0; i < options.length; i++) {
    const a = options[i];
    if (a === "--staged") staged = true;
    else if (a === "--worktree") worktree = true;
    else if (a === "--source") i++;
    else if (/^-[^-]/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "S") staged = true;
        if (c === "W") worktree = true;
        if (c === "s") { if (a.endsWith("s") && a.indexOf("s") === a.length - 1) i++; break; }
      }
    }
  }
  return worktree || !staged;
}
const CLONE_VALUE = /^(?:-[obucj]|--(?:origin|branch|initial-branch|upload-pack|reference|reference-if-able|depth|shallow-since|shallow-exclude|config|template|jobs|filter|server-option|bundle-uri|ref-format|object-format|revision))$/;
const repoName = (url) => url && basename(url.replace(/\/+$/, "").replace(/\/\.git$/, "").replace(/^[^/]*:/, "")).replace(/\.(?:git|bundle)$/, "") || undefined;
function gitTargets(args, destroys = false) {
  let tree = ".", k = 0, other = false;
  for (; args[k]?.startsWith("-"); k++) {
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[k])) other = true;
    if (args[k] === "-C") tree = isAbsolute(args[k + 1] ?? "") ? args[k + 1] : join(tree, args[k + 1] ?? "");
    if (GIT_VALUE.test(args[k])) k++;
  }
  if (destroys && args[k] === "worktree" && args[k + 1] === "remove") return args.slice(k + 2).some((a) => /^(?:-f+|--force)$/.test(a)) ? gitTargets(args) : [];
  if (destroys) return !gitDestroys(args[k] ?? "", args.slice(k + 1)) ? [] : other || [tree];
  if (other) return true;
  const sub = args[k] ?? "", rest = args.slice(k + 1);
  if (GIT_CHANGES.test(sub)) return Object.hasOwn(GIT_DRY, sub) && rest.some((a) => GIT_DRY[sub].test(a)) ? [] : [tree];
  if (sub === "branch") {
    for (let i = 0; i < rest.length; i++) {
      if (BRANCH_VALUE.test(rest[i])) i++;
      else if (BRANCH_CHANGES.test(rest[i])) return [tree];
    }
    return [];
  }
  if (sub === "config") {
    const operands = [];
    let change = false;
    for (let i = 0; i < rest.length; i++) {
      if (CONFIG_CHANGES.test(rest[i])) change = true;
      else if (CONFIG_READS.test(rest[i])) return [];
      else if (CONFIG_VALUE.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) operands.push(rest[i]);
    }
    change ||= /^(?:set|unset|rename-section|remove-section|edit)$/.test(operands[0] ?? "") || (operands.length > 1 && !/^(?:get|list)$/.test(operands[0]));
    return !change ? [] : rest.some((a) => /^--(?:global|system)$/.test(a)) ? true : [tree];
  }
  const into = (paths) => paths.map((p) => (isAbsolute(p) ? p : join(tree, p)));
  if (sub === "clone" || sub === "init") {
    const operands = [], gitDirs = [];
    for (let i = 0; i < rest.length; i++) {
      const separate = /^--separate-git-dir(?:=(.*))?$/.exec(rest[i]);
      if (rest[i] === "--") { operands.push(...rest.slice(i + 1)); break; }
      if (separate) gitDirs.push(separate[1] ?? rest[++i]);
      else if (CLONE_VALUE.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) operands.push(rest[i]);
    }
    const dir = sub === "init" ? operands[0] ?? "." : operands[1] ?? repoName(operands[0]);
    return dir === undefined || gitDirs.includes(undefined) ? true : into([dir, ...gitDirs]);
  }
  if (sub === "archive" || sub === "format-patch") {
    const option = sub === "archive" ? /^(?:-o|--output)(?:=(.*))?$/ : /^(?:-o|--output-directory|--output)(?:=(.*))?$/;
    for (let i = 0; i < rest.length && rest[i] !== "--"; i++) {
      const out = option.exec(rest[i]);
      if (out) return out[1] ?? rest[i + 1] ? into([out[1] ?? rest[i + 1]]) : true;
    }
    return sub === "format-patch" && !rest.includes("--stdout") ? [tree] : [];
  }
  if (sub === "bundle" && rest[0] === "create") {
    const file = rest.slice(1).find((a) => !a.startsWith("-"));
    return file === undefined ? true : file === "-" ? [] : into([file]);
  }
  if (sub === "worktree" && /^(?:add|move|remove)$/.test(rest[0] ?? "")) {
    const paths = [];
    for (let i = 1; i < rest.length; i++) {
      if (/^(?:-b|-B|--reason)$/.test(rest[i])) i++;
      else if (!rest[i].startsWith("-")) paths.push(rest[i]);
    }
    const changed = rest[0] === "move" ? paths.slice(0, 2) : paths.slice(0, 1);
    return changed.length ? into(changed) : true;
  }
  return [];
}
function realPath(path, links = 40) {
  try { return realpathSync.native(path); } catch {}
  let target;
  try { if (links && lstatSync(path).isSymbolicLink()) target = readlinkSync(path); } catch {}
  if (target !== undefined) return realPath(isAbsolute(target) ? target : `${realPath(dirname(path), links - 1)}/${target}`, links - 1);
  return dirname(path) === path ? path : join(realPath(dirname(path), links), basename(path));
}
const under = (path, folder) => path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const meets = (path, folder) => path === folder || under(path, folder) || under(folder, path);
function intoScratch({ target, dir, uncertainDirectory }, cwd, scratch, place = {}) {
  const { home, guard = [], protect } = place;
  const word = home && /^~(?:\/|$)/.test(target) ? home + target.slice(1) : target;
  if ((!protect && !scratch.length) || uncertainDirectory || /[$`*?[\]{}~!]/.test(word)) return false;
  const written = isAbsolute(word) ? word : `${resolve(dir ?? cwd)}/${word}`;
  const paths = [...new Set([resolve(written), written].flatMap((absolute) => [join(realPath(dirname(absolute)), basename(absolute)), realPath(absolute)]))];
  if (protect) {
    const open = scratch.map((folder) => realPath(resolve(folder)));
    const places = [...checkouts(cwd, scratch).map((path) => ({ path, name: "the project's checkout" })), ...protect.map((p) => ({ ...p, path: realPath(resolve(p.path)), prefix: p.prefix && join(realPath(dirname(resolve(p.path))), basename(p.path)) }))];
    const hits = ({ path: folder, prefix }, path) => (meets(path, folder) || (prefix && path.startsWith(prefix))) && !open.some((inner) => under(inner, folder) && under(path, inner));
    const hit = paths.flatMap((path) => places.filter((p) => hits(p, path)))[0];
    place.hit ??= hit?.name;
    return !hit;
  }
  const project = mainCheckout(realPath(resolve(cwd)));
  return paths.every((path) => !meets(path, project) && scratch.some((folder) => under(path, realPath(resolve(folder)))) && !inWorkTree(path, guard));
}
function checkouts(cwd, scratch) {
  const main = mainCheckout(realPath(resolve(cwd))), list = join(main, ".git", "worktrees"), folders = [main];
  let names = [];
  try { names = readdirSync(list); } catch {}
  for (const name of names) {
    let gitdir;
    try { gitdir = readFileSync(join(list, name, "gitdir"), "utf8").trim(); } catch { continue; }
    const tree = realPath(dirname(resolve(list, name, gitdir)));
    if (!scratch.some((folder) => under(tree, realPath(resolve(folder))))) folders.push(tree);
  }
  return folders;
}
const WALK_MAX = 2000;
function inWorkTree(path, guard) {
  const root = guard.map((folder) => realPath(resolve(folder))).find((folder) => path === folder || path.startsWith(folder + sep));
  if (!root) return false;
  for (let dir = path; dir.startsWith(root + sep); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return true;
  const folders = [path];
  for (let i = 0; i < folders.length; i++) {
    if (i === WALK_MAX) return true;
    let entries;
    try { entries = readdirSync(folders[i], { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.isDirectory()) folders.push(join(folders[i], entry.name));
    }
  }
  return false;
}
function mainCheckout(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    const marker = join(dir, ".git"), stat = statSync(marker, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(marker, "utf8"))?.[1].trim(), worktrees = gitdir && dirname(resolve(dir, gitdir));
      return worktrees && basename(worktrees) === "worktrees" && basename(dirname(worktrees)) === ".git" ? realPath(dirname(dirname(worktrees))) : dir;
    }
    if (stat) return dir;
    if (dirname(dir) === dir) return folder;
  }
}
function inProject({ target, dir, uncertainDirectory }, cwd) {
  if (/^~(?:\/|$)/.test(target)) return false;
  if (/[$`]/.test(target) || (uncertainDirectory && !isAbsolute(target))) return true;
  const cut = target.search(/[*?[{]/), literal = cut < 0 ? target : target.slice(0, target.lastIndexOf("/", cut) + 1);
  const path = realPath(resolve(dir ?? cwd, literal || ".")), project = realPath(resolve(cwd));
  return path === project || path.startsWith(project.endsWith(sep) ? project : project + sep);
}
export const commandWrites = (...args) => commandWritePart(...args) !== undefined;
export function commandWritePart(text, cwd, scratch = [], { readOnly = false, placed = false, home, guard, protect, known } = {}) {
  if (typeof text === "string" && HOME_SET.test(text)) home = null;
  const place = { home, guard, protect }, part = writePart(text, cwd, scratch, { readOnly, placed, home, protect, known }, place);
  return part === undefined ? undefined : { part, place: place.hit, ...(place.error ? { error: place.error } : {}) };
}
function writePart(text, cwd, scratch, { readOnly, placed, home, protect, known }, place) {
  const whole = String(text);
  placed ||= Boolean(protect);
  if (typeof text !== "string") return whole;
  try {
    if (protect && CDPATH_SET.test(text) && /\b(?:cd|pushd|popd)\b/.test(text)) return whole;
    if (known) text = literalNames(text, known);
    const commands = shellCommands(text);
    const evidence = programsRun(text, cwd, undefined, { contextEvidence: true, redirectParts: true, ...(home !== undefined ? { home } : {}) });
    const runs = new Set(evidence.programs.map(({ run }) => programName(run.word)));
    const command = commands.find((command) => writesIn(command, runs, placed, Boolean(protect)));
    if (command) return command.words.join(" ");
    const placeWrites = (entry, i) => {
      const name = programName(entry.run.word), wrapped = Boolean(evidence.programs[i - 1]?.wrapper);
      if (placed && PLACED.has(name)) return wrapped || outsideScratch(placedTargets(name, entry.run.args), entry, cwd, scratch, place);
      if (protect && /^g?sed$/.test(name)) { const files = sedTargets(entry.run.args, name === "sed"); return (wrapped && files !== EMPTY) || outsideScratch(files, entry, cwd, scratch, place); }
      if (/^(?:chmod|chown|chgrp|chflags)$/.test(name)) return modeTargets(name, entry.run.args).some((target) => inProject(at(entry, target), cwd));
      return outsideScratch(name === "gh" ? ghTargets(entry.run.args) : name === "curl" ? curlTargets(entry.run.args) : readOnly && name === "git" ? gitTargets(entry.run.args) : [], entry, cwd, scratch, place);
    };
    const redirect = evidence.redirects.find(r => toFile(r) && !intoScratch(r, cwd, scratch, place));
    if (redirect) return `${redirect.operator} ${redirect.target}`;
    const entry = evidence.programs.find((entry, i) => readerDispatch(entry) || writesCode([entry.run.word, ...entry.run.args]) || outputDispatchWrites(entry) || placeWrites(entry, i));
    return entry && [entry.run.word, ...entry.run.args].join(" ");
  } catch (error) {
    place.error = error;
    return whole;
  }
}
const EMPTY = [], SED_FLAGS = new Set(["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data", "--posix", "--debug", "--sandbox", "--follow-symlinks", "--binary"]);
function sedTargets(args, bsd) {
  let inPlace = false, script = false;
  const operands = [], suffixes = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === "--") { operands.push(...args.slice(k + 1)); break; }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("="), name = equals < 0 ? arg : arg.slice(0, equals);
      if (name === "--in-place") inPlace = true;
      else if (name === "--expression" || name === "--file" || name === "--line-length") { script ||= name !== "--line-length"; if (equals < 0) k++; }
      else if (!SED_FLAGS.has(arg)) return true;
    } else if (arg.length > 1 && arg.startsWith("-")) {
      for (let j = 1; j < arg.length; j++) {
        const option = arg[j], last = j === arg.length - 1;
        if (option === "i" || option === "I") { inPlace = true; if (bsd && last && /^(?:|\.[\w.~-]*)$/.test(args[k + 1] ?? "-")) { k++; if (args[k]) suffixes.push(args[k]); } break; }
        if ("efl".includes(option)) { script ||= option !== "l"; if (last) k++; break; }
        if (!"nErsuz".includes(option)) return true;
      }
    } else operands.push(arg);
  }
  return !inPlace ? EMPTY : [...suffixes, ...(script ? operands : operands.slice(1))];
}

const SAFE_VALUE = /^[\w./@%+,:=-]+$/, KEPT_NAMES = /^(?:HOME|CDPATH|PWD|OLDPWD|IFS|PATH|ENV|BASH_ENV|ZDOTDIR)$/;
const setsName = (name) => new RegExp(String.raw`(?<![\w$])${name}\+?=|\$\{${name}:?[=?]|\b(?:export|declare|typeset|local|readonly|read|unset|for|select|getopts|mapfile|readarray|printf|vared|zparseopts)\b[^;&|\n]*(?<![\w$])(?<!\$\{)${name}(?!\w)`);
const HOME_SET = setsName("HOME"), CDPATH_SET = setsName("CDPATH");
function scanNames(text) {
  const bare = new Map(), uses = [], bad = new Set(), add = (name, at) => bare.set(name, [...(bare.get(name) ?? []), at]);
  let state = "plain";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (state === "single") { if (c === "'") state = "plain"; }
    else if (c === "\\") { i += 2; continue; }
    else if (c === '"') state = state === "plain" ? "double" : "plain";
    else if (state === "plain" && c === "'") state = "single";
    else if (state === "plain" && c === "#" && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) { while (i < text.length && text[i] !== "\n") i++; continue; }
    else if (state === "plain" && text.startsWith("<<", i)) { if (text[i + 2] !== "<") return undefined; i += 3; continue; }
    else if (state === "double" && (c === "`" || text.startsWith("$(", i))) return undefined;
    else if (c === "$") {
      if (state === "plain" && text[i + 1] === "'") return undefined;
      const use = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(text.slice(i));
      if (use) {
        const name = use[1] ?? use[2], end = i + use[0].length;
        if (use[2] && /[:[]/.test(text[end] ?? "")) bad.add(name);
        uses.push({ name, at: i, end });
        i = end;
        continue;
      }
      i += text[i + 1] === "$" ? 2 : 1;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (word && !/\w/.test(text[i - 1] ?? "")) { add(word[0], i); i += word[0].length; continue; }
    i++;
  }
  return state === "plain" ? { bare, uses, bad } : undefined;
}
export function literalNames(text, known = {}) {
  if (!text.includes("$")) return text;
  const scan = scanNames(text);
  if (!scan || scan.bare.has("IFS")) return text;
  const commands = shellCommands(text), nodes = flowOf(commands)?.nodes ?? [], values = new Map();
  nodes.forEach((node, k) => {
    const c = node.cmd, before = nodes[k - 1]?.after;
    if (!c || c.host || c.grouped || c.piped || /^(?:\||&)$/.test(node.after ?? "") || (k && !/^(?:;|&)?$/.test(before ?? ""))) return;
    const start = c.words[0] === "export" && !c.syntax[0].quoted ? 1 : 0;
    if (start === c.words.length || !c.syntax.slice(start).every((s) => s.assignment)) return;
    for (const word of c.words.slice(start)) {
      const name = word.slice(0, word.indexOf("=")), value = word.slice(name.length + 1), at = scan.bare.get(name);
      values.set(name, at?.length === 1 && text[at[0] + name.length] === "=" && SAFE_VALUE.test(value) && !KEPT_NAMES.test(name) && !values.has(name) && !scan.bad.has(name) ? { value, at: at[0] } : null);
    }
  });
  for (const [name, value] of Object.entries(known)) {
    if (!values.has(name) && !scan.bare.has(name) && !scan.bad.has(name) && typeof value === "string" && isAbsolute(value) && SAFE_VALUE.test(value)) values.set(name, { value, at: -1 });
  }
  let out = text;
  for (const use of [...scan.uses].sort((a, b) => b.at - a.at)) {
    const known = values.get(use.name);
    if (known && scan.uses.every((other) => other.name !== use.name || other.at > known.at)) out = out.slice(0, use.at) + known.value + out.slice(use.end);
  }
  return out;
}
const at = ({ run, uncertainDirectory }, target) => ({ target, dir: run.dir, uncertainDirectory });
export const scratchTarget = (path, cwd, scratch, guard = []) => intoScratch({ target: path }, cwd, scratch, { guard });
const outsideScratch = (targets, entry, cwd, scratch, place) => targets === true || targets.some((target) => !intoScratch(at(entry, target), cwd, scratch, place));
export function gitDestroysWork(text, cwd, scratch = [], guard = []) {
  try {
    return programsRun(text, cwd, undefined, { contextEvidence: true }).programs.some((entry) => programName(entry.run.word) === "git" && outsideScratch(gitTargets(entry.run.args, true), entry, cwd, scratch, { guard }));
  } catch {
    return false;
  }
}

const FLOW_WORD = /^(?:if|then|elif|else|fi|for|while|until|do|done|select|case|esac|function|time|coproc|\{|\}|\[\[|!)$/;
const REDEFINES = /^(?:export|unset|readonly|declare|typeset|local|set|shopt|setopt|alias|unalias|hash|enable|builtin|command|eval|source|\.)$/;
const GIT_READS = /^(?:log|show|status|diff|rev-parse)$/;
const shellQuoted = (word) => (/^[\w./=:@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
const plainReader = ({ words }, cwd) =>
  (words[0] === "git" ? GIT_READS.test(words[1] ?? "") : READERS.test(words[0] ?? "") && !/^(?:cd|pushd)$/.test(words[0])) &&
  !commandWrites(words.map(shellQuoted).join(" "), cwd);

export function shellWriteEvidence(text, cwd, path) {
  try {
    const commands = shellCommands(text, { provenance: true });
    const evidence = programsRun(text, cwd, path, { contextEvidence: true, redirectParts: true });
    const writes = evidence.redirects.filter(toFile);
    if (writes.some(r => r.uncertainDirectory || /[$`*?\[\]{}~!]/.test(r.target))) return { uncertain: true };
    if (!commands.length || commands.some(c => c.host || c.grouped || FLOW_WORD.test(c.words[0] ?? "") ||
      REDEFINES.test(c.words[0] ?? "") || c.syntax.some(s => s.assignment) ||
      c.wordLiterals.some(literal => !literal) || c.bodyLiterals.some(literal => !literal) || c.redirectLiterals.some(literal => !literal) ||
      (c.words.length && !plainReader(c, cwd) && !/^(?:cd|pushd)$/.test(c.words[0])) ||
      (c.words[0] === "printf" && (c.words.slice(1).some(word => /^-v/.test(word)) ||
        /%[^%]*n/.test(c.words[c.words[1] === "--" ? 2 : 1] ?? ""))))) return undefined;
    if (evidence.programs.some(p => p.wrapper || p.uncertainDirectory)) return undefined;
    const reads = evidence.programs.flatMap(({ run }) => /^(?:echo|printf)$/.test(run.word) ? [] :
      [run.word, ...run.args].map(word => ({ word, dir: run.dir ?? cwd })));
    reads.push(...evidence.redirects.filter(r => !toFile(r)).map(r => ({ word: r.target, dir: r.dir ?? cwd })));
    return { reads, writes: writes.map(r => ({ word: r.target, dir: r.dir ?? cwd })) };
  } catch { return undefined; }
}
