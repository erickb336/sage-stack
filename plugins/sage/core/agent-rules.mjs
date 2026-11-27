import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { programsRun } from "./command-reader.mjs";
import { GIT_VALUE, gitSubcommand, programName, unreadable } from "./command-policy.mjs";
import { canonical } from "./protected-paths.mjs";
import { commandWritePart, gitDestroysWork, scratchTarget } from "./shell-write-policy.mjs";
import { worktreeRoot } from "./worktrees.mjs";

const fold = (text) => text.normalize("NFKC").toLowerCase();
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
const quoted = (name) => `"${[...String(name).replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`‘-‟＂]/gu, "")].slice(0, 60).join("")}"`;
const from = (cwd, path) => (isAbsolute(path) ? path : `${cwd}/${path}`);

const NO_STASH = "an agent never runs git stash: every worktree of a repo shares one stash list, so another agent can pop or drop your work. To test old code, use git worktree add --detach <scratch> <sha>, or git show <sha>:<path> into your scratch folder.";
const LOOKS = "ps|pgrep|lsof";
const UNIX_PROCESS = "pkill|kill|killall|top|htop|fuser|pidof|kill-port|fkill|launchctl";
const POWERSHELL_PROCESS = "get-process|stop-process|gps|spps";
const isProcess = (name = "", looks = true) => {
  const bare = programName(name.replace(/(?<=.)@.*$/, ""));
  return new RegExp(`^(?:${UNIX_PROCESS}|${POWERSHELL_PROCESS}${looks ? "" : `|${LOOKS}`})$`, "i").test(bare);
};
const NO_LOOK = (word) => `a proof never reads the real process list, so ${quoted(word)} is refused: the proof check reruns the proof, and the list is not the same on another run.`;
const NO_PROCESS = (word) => `an agent never signals or controls a real process, so ${quoted(word)} is refused: an agent only looks at the processes, with lsof, pgrep or ps. Code that you test never reads or signals the real process list (standing order 14): put a fake ps or kill in a folder under the temp folder (/tmp, or the folder that TMPDIR names) and put that folder first on PATH: a fake in any other folder is refused. The fake ps prints a start time in the past (for example "Sat Jan  1 00:00:00 2000"). Run a fake kill by its path: a bare kill is the shell's builtin. Use literal paths: the hook does not expand variables. To stop your own server or background job, run it as a background task and stop that task.`;
const NO_ENVIRONMENT = (word) => `an agent prints no process environment, so ${quoted(word)} with this option is refused: the environment of a process can hold a token (standing order 40). Run ps without E in an option and without e in an option word with no dash, for example ps aux, ps -ef, ps -p <pid> or ps -o pid,command.`;
const PS_LONG_VALUE = /^--(?:cols|columns|format|group|Group|lines|pid|ppid|quick-pid|rows|sid|sort|tty|user|User|width)$/;
function psEnvironment(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (/^-[^-]/.test(arg)) {
      for (let k = 1; k < arg.length; k++) {
        if (arg[k] === "E") return true;
        if ("CGgMNOopqstUu".includes(arg[k])) { if (k === arg.length - 1) i++; break; }
      }
    } else if (PS_LONG_VALUE.test(arg)) i++;
    else if (/^[A-Za-z]+$/.test(arg)) {
      if (arg.includes("e")) return true;
      if ("kOopqtU".includes(arg.at(-1))) i++;
    }
  }
  return false;
}
export const TEMP = [...new Set([tmpdir(), "/tmp", process.env.TMPDIR].filter(Boolean).map((d) => { try { return realpathSync.native(d); } catch { return resolve(d); } }))];
export const CHIEF_SHELL = 'sage mode is on, so the chief does not change files, also not from the shell: this command has a write form (a redirection or a heredoc into a file, tee, cp, mv, rm, sed -i, code in node -e, or gh repo clone, gh run download or gh extension install) outside your scratch places. Brief an implementer to make this change. Your scratch places are the temp folder and the sage worktrees folder (~/sage-worktrees, which holds the pages folder that the pages command of the state tool prints), outside the project. There a redirection, rm, rmdir, touch, tee, cp, mv and a gh clone or download run, with literal paths (for example > /tmp/notes/out.txt, or rm -rf /tmp/notes). sed -i, code in node -e and the other forms are refused also there. gh, the sage tools, reads and git run as before, except git rm, git mv and the git forms that throw away uncommitted work. The user ends sage mode with the message "sage mode off", alone.';
export const chiefPlaces = (env = process.env) => [...TEMP, worktreeRoot(env)];
export const CHIEF_FILE = 'sage mode is on, so the chief does not change files outside its scratch places: the temp folder and the sage worktrees folder (~/sage-worktrees, which holds the pages folder that the pages command of the state tool prints), outside the project. A git work tree in the sage worktrees folder is not a scratch place. Brief an implementer to make this change. The user ends sage mode with the message "sage mode off", alone.';
export function chiefFileProblem(path, cwd, env = process.env) {
  const places = chiefPlaces(env);
  if (typeof path !== "string" || !path) return CHIEF_FILE;
  if (scratchTarget(path, cwd, places, [worktreeRoot(env)])) return undefined;
  return scratchTarget(path, cwd, places) ? CHIEF_WORKTREE : CHIEF_FILE;
}
const HOME_PLACES = [".claude", ".claude.json", ".codex", ".ssh", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile"];
export function readOnlyPlace(roots, env = process.env, settings = {}) {
  const home = env.HOME || homedir();
  const protect = [...roots.map((path) => ({ path, name: "the logbook" })), { path: worktreeRoot(env), name: "the sage worktrees folder" },
    ...Object.entries(settings).filter(([, path]) => path).map(([name, path]) => ({ path, name })),
    ...HOME_PLACES.map((file) => ({ path: join(home, file), name: `~/${file}`, prefix: file === ".claude.json" }))];
  return { readOnly: true, protect, home, known: knownNames(env) };
}
const knownNames = (env) => ({ TMPDIR: env.TMPDIR });
export const CHIEF_WORKTREE = 'sage mode is on, so the chief does not change a git work tree in the sage worktrees folder (~/sage-worktrees): a task worktree or a clone there holds repository files, and rm -rf can lose uncommitted work. This change writes into a work tree there, or removes a folder that holds one. To remove a worktree, run git worktree remove <path> (without --force): git refuses a worktree with changes. For a clone or any other change, brief an implementer or ask the owner. Folders there that hold no work tree stay your scratch place.';
export const CHIEF_GIT = 'sage mode is on, so the chief does not throw away uncommitted work: git reset --hard, git checkout -- <path> (or ., or --force), git clean -f, git restore of the work tree and git worktree remove --force can destroy changes in the owner\'s checkout or a task\'s worktree. Make a scratch worktree in the temp folder and run the command there (for example git worktree add --detach /tmp/<name>/wt <sha>, then git -C /tmp/<name>/wt reset --hard), or ask the owner. git commit, git checkout <branch>, git fetch, git merge-tree, git commit-tree, git worktree add, git worktree remove without --force, and reads run as before.';
export function chiefShellProblem(command, cwd, env = process.env) {
  const guard = [worktreeRoot(env)];
  if (gitDestroysWork(command, cwd, TEMP, guard)) return CHIEF_GIT;
  const places = chiefPlaces(env), options = { placed: true, home: env.HOME || homedir(), known: knownNames(env) };
  const write = commandWritePart(command, cwd, places, { ...options, guard });
  if (!write) return undefined;
  if (write.error) return unreadable(write.error);
  return commandWritePart(command, cwd, places, options) ? CHIEF_SHELL : CHIEF_WORKTREE;
}
export const READ_ONLY_SHELL_WAY = "To keep output or a probe, redirect it into your scratch folder in the temp folder, with a literal path (for example > /tmp/<run>/out.txt). To try a changed copy, write the copy the same way: git show <sha>:<path> | sed 's/a/b/' > /tmp/<run>/copy.mjs. To check out a head, make a worktree in your scratch folder: git worktree add --detach /tmp/<run>/head <sha>; git commands run there.";
export const READ_ONLY_PAGE_NOTE = "The investigate agent writes only its pages, in the task's pages folder that its brief names, and files in its scratch folder.";
const quotedPart = (text) => `"${[...String(text).replace(/\\\n/g, "").replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`\u2018-\u201f\uff02\\]/gu, "")].slice(0, 60).join("")}"`;
export const readOnlyShell = (role, { part, place, error } = {}) => error ? unreadable(error) : `in sage mode, the ${role} agent changes no file in the project, the logbook or the agent's settings, also not from the shell, so ${quotedPart(part)} is refused: ${place ? `it writes into ${place}. The agent has no write form` : "it has a write form"} into the project's checkout, the sage worktrees folder, the logbook, an agent config folder (~/.claude, ~/.claude.json and its backups, ~/.codex, or the folder that the provider's setting names), ~/.ssh or a shell start file (~/.zshenv, ~/.zprofile, ~/.zshrc, ~/.zlogin, ~/.zlogout, ~/.bashrc, ~/.bash_profile, ~/.bash_login, ~/.bash_logout or ~/.profile), or a write form whose target the hook cannot tell (for example code in node -e, tar, a pattern, a variable that the command does not set to a literal path before, or a git command that changes the checkout, such as git checkout, reset, commit or branch -D). A write into another folder passes, with a literal path, $TMPDIR or a variable set to a literal path earlier in the command; sed -i, curl -o and find -exec ls too. ${role === "investigate" ? `${READ_ONLY_PAGE_NOTE} Redirect a page into its pages folder, with a literal path.` : "Report the finding instead."} ${READ_ONLY_SHELL_WAY}`;
const inTemp = (file) => !!file && TEMP.some((t) => file.startsWith(`${t}/`));
const processText = (looks) => new RegExp(`(?:^|[\\s;&|(\`'"/<>])(?:${UNIX_PROCESS}|${POWERSHELL_PROCESS}${looks ? "" : `|${LOOKS}`})(?:\\.exe)?(?=$|[\\s;&|)\`'"<>])`, "im");

const COMMIT_WORDS = "commit|commit-tree|merge|pull|cherry-pick|revert|am|rebase";
const COMMITS = new RegExp(`^(?:${COMMIT_WORDS})$`);
const STOPS = /^--(?:abort|quit)$/;
const sh = (text) => /^[\w.@+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
const IDENTITY_FORM = ({ email, name }, sub = "commit") => `git ${name ? `-c user.name=${sh(name)} ` : ""}-c user.email=${sh(email)} ${sub} <its arguments>`;
const NO_IDENTITY = (identity, sub, used) => `an agent commits only with the project's no-reply identity (the logbook setting commit_email), so this git ${sub} is refused: ${used}. With HOME in a scratch folder, git cannot read the global config and falls back to a machine-name email. Pass the identity on the command, before the subcommand: ${IDENTITY_FORM(identity, sub)}.`;
function commitEmails(args, vars) {
  const config = {}, env = {};
  let k = 0;
  for (; args[k]?.startsWith("-"); k += GIT_VALUE.test(args[k]) ? 2 : 1) {
    if (args[k] !== "-c") continue;
    const at = String(args[k + 1] ?? "").indexOf("=");
    if (at > 0) config[args[k + 1].slice(0, at).toLowerCase()] = args[k + 1].slice(at + 1);
  }
  for (const word of vars) env[word.slice(0, word.indexOf("="))] = word.slice(word.indexOf("=") + 1);
  let author;
  for (let j = k + 1; j < args.length && args[j] !== "--"; j++) {
    if (args[j] === "--author") author = args[++j] ?? "";
    else if (args[j].startsWith("--author=")) author = args[j].slice(9);
  }
  return {
    sub: args[k] ?? "",
    rest: args.slice(k + 1),
    author: author !== undefined ? (/<([^<>]*)>\s*$/.exec(author)?.[1] ?? author) : env.GIT_AUTHOR_EMAIL ?? config["author.email"] ?? config["user.email"],
    committer: env.GIT_COMMITTER_EMAIL ?? config["committer.email"] ?? config["user.email"],
  };
}
function identityProblem(args, vars, identity) {
  const { sub, rest, author, committer } = commitEmails(args, vars);
  if (!COMMITS.test(sub) || rest.some((a) => STOPS.test(a))) return undefined;
  const wanted = identity();
  if (!wanted) return undefined;
  const same = (email) => typeof email === "string" && email.toLowerCase() === wanted.email.toLowerCase();
  if (same(author) && same(committer)) return undefined;
  const used = author === undefined && committer === undefined ? "the command sets no email, so git would take it from a config file or the machine's name"
    : [["author", author], ["committer", committer]].filter(([, email]) => !same(email)).map(([who, email]) => email === undefined ? `it sets no ${who} email` : `the ${who} email would be ${quoted(email)}`).join(", and ");
  return NO_IDENTITY(wanted, sub, used);
}

export function agentCommandProblem(command, cwd, path = process.env.PATH ?? "", { identity = () => undefined, looks = true } = {}) {
  const refuse = (word, ...names) => (names.some((n) => isProcess(n)) ? NO_PROCESS : NO_LOOK)(word);
  let runs;
  try {
    runs = programsRun(command, cwd, path);
  } catch (e) {
    const text = bare(command), program = processText(looks).exec(text)?.[0].replace(/^\W/, "");
    const commits = COMMIT_WORDS.split("|").some((word) => gitThen(text, word)) && identity();
    const [what, why] = gitThen(text, "stash") ? ["git stash", NO_STASH] : program ? [`a process program (${quoted(program)})`, refuse(program, program)]
      : commits ? ["a git command that can write a commit", `run it plainly, with the identity on the command: ${IDENTITY_FORM(commits)}.`] : [];
    return why && `${unreadable(e, what)} ${why[0].toUpperCase()}${why.slice(1)}`;
  }
  for (const { word, file, args, vars = [] } of runs) {
    const name = programName(word);
    if (name === "git" && /^stash$/i.test(gitSubcommand(args, 0))) return NO_STASH;
    if ((isProcess(name, looks) || isProcess(file ?? "", looks)) && !inTemp(file)) return refuse(word, name, file ?? "");
    if ([name, programName(file ?? "")].some((n) => /^ps$/i.test(n)) && !inTemp(file) && psEnvironment(args)) return NO_ENVIRONMENT(word);
    const commit = name === "git" ? identityProblem(args, vars, identity) : undefined;
    if (commit) return commit;
  }
  return undefined;
}

const BOARD_CONFIG = "the board config rule (T229): no agent reads, copies or replaces the board config (~/.config/sage-board/board.json), or lists, searches, copies or moves the board's folder or a folder that holds it, because only the owner and the board command change the board's state. The board command's own output (board --ensure, the chat board) says what you need. The rule covers the board's state folder (~/.config/sage-board/state) too, because it holds the browser pairing (T1059).";
const BOARD_PAIR = "the board pairing rule (T1059, T1125): no agent runs board --pair, and only the chief runs board --ensure --link. Each one pairs the owner's browser with the board, so that the browser can answer questions and rename chiefs: --pair prints a one-time code for the owner's eyes only, and --link prints a one-time pairing link that only the chief shows, in the chat text. The owner runs --pair in Terminal; give the owner the command, and do not run it. Run board --ensure without --link.";
const BOARD_MOVE = "the board port rule (T1079): no agent runs board --port. It moves the owner's board to another port: it stops the board, changes the board config and starts the board again. The owner runs it in Terminal, or asks the chief to run it; give the owner the command, and do not run it.";
const VARIABLE = /[$`]/;
function boardFolders(home) {
  const folder = join(home, ".config", "sage-board");
  let resolved = fold(folder);
  try { resolved = canonical(folder); } catch {}
  return [...new Set([fold(folder), resolved])];
}
function pathParts(word, dir, home) {
  const start = word.startsWith("/") ? [] : /^~(?:\/|$)/.test(word) ? home.split("/") : /^[$`~]/.test(word) ? [] : dir === undefined ? ["$"] : dir.split("/");
  const parts = [];
  for (const part of [...start, ...word.replace(/^~[^/]*/, (t) => (t === "~" ? "" : "$")).split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length && !VARIABLE.test(parts.at(-1))) parts.pop(); continue; }
    parts.push(part);
  }
  return parts;
}
function boardReach(word, dir, folders, home) {
  const cut = word.search(/[$`*?[{]/);
  if (!word || (cut === 0 && /^[$`]/.test(word))) return {};
  const literal = cut < 0 ? word : word.slice(0, cut) || ".";
  if (literal.length > 4096) return {};
  const path = fold(`/${pathParts(literal, dir, home).join("/")}`);
  const is = (p) => p === path;
  const temporary = (f) => dirname(path) === f && /^\.board-.*\.json$/.test(basename(path));
  return {
    config: folders.some((f) => is(f) || is(`${f}/board.json`) || is(`${f}/.board-000000000000.json`) || temporary(f) || is(`${f}/state`) || path.startsWith(`${f}/state/`)),
    above: folders.some((f) => f.split("/").some((_, k, all) => is(all.slice(0, k + 1).join("/") || "/"))),
  };
}
export function boardPathProblem(path, cwd, { home = process.env.HOME || homedir(), search = false } = {}) {
  const reach = boardReach(path, cwd, boardFolders(home), home);
  return reach.config || (search && reach.above) ? BOARD_CONFIG : undefined;
}
const SEARCHES = /^(?:e|f)?grep$|^(?:rg|ag|ack|find|fd)$/;
const WHOLE = (name, args) => /^(?:rg|ag|ack|fd|ditto|tar|bsdtar|zip|rsync|mv|ln)$/.test(name) ||
  (name === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) ||
  (/^(?:e|f)?grep$/.test(name) && args.some((a) => /^-[^-]*[rR]|^--(?:recursive|dereference-recursive|directories=recurse)$|^recurse$/.test(a))) ||
  (/^(?:cp|gcp|scp)$/.test(name) && args.some((a) => /^-[^-]*[rRa]|^--(?:recursive|archive)$/.test(a)));
const BOARD_RUN = ({ word, args }) => (basename(word) === "cli.mjs" || args.some((a) => /(?:^|\/)cli\.mjs$/i.test(a)) || /^(?:npm|pnpm|yarn|bun)$/.test(programName(word))) && args.includes("board");
export function boardCommandProblem(text, cwd, { home = process.env.HOME || homedir(), uncertain = false, chief = false } = {}) {
  let read;
  try {
    read = programsRun(text, cwd, undefined, { contextEvidence: true, uncertainDirectory: uncertain, home });
  } catch {
    return undefined;
  }
  const folders = boardFolders(home), seen = new Map();
  const reachOf = (word, dir) => {
    const key = `${dir}\0${word}`;
    if (!seen.has(key)) seen.set(key, boardReach(word, dir, folders, home));
    return seen.get(key);
  };
  for (const { run, uncertainDirectory } of read.programs) {
    const name = programName(run.word), board = BOARD_RUN(run);
    if (board && (run.args.some((a) => /^--pair(?:=|$)/.test(a)) || !chief && run.args.some((a) => /^--link(?:=|$)/.test(a)))) return BOARD_PAIR;
    if (board && !chief && run.args.some((a) => /^--port(?:=|$)/.test(a)) && !run.args.some((a) => /^--(?:setup|ensure)$/.test(a))) return BOARD_MOVE;
    const whole = WHOLE(name, run.args);
    const start = uncertainDirectory ? undefined : run.dir;
    let dir = start;
    for (const [k, arg] of run.args.entries()) {
      const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
      if (!value) continue;
      for (const path of [value, /^[\w.-]+=(.+)$/s.exec(value)?.[1]].filter(Boolean)) {
        const reach = reachOf(path, dir);
        if (reach.config && !(board && (run.args[k - 1] === "--config" || arg.startsWith("--config=")))) return BOARD_CONFIG;
        if (reach.above && whole) return BOARD_CONFIG;
      }
      if (name === "git" && run.args[k - 1] === "-C") dir = /[$`]|^~[^/]/.test(value) || (dir === undefined && !/^[/~]/.test(value)) ? undefined : from(dir ?? "/", value.replace(/^~(?=\/|$)/, home));
    }
    if (SEARCHES.test(name) && whole && reachOf(".", start).above) return BOARD_CONFIG;
  }
  for (const { redirect, dir, uncertainDirectory } of read.redirects) if (reachOf(redirect.replace(/^\d*[<>&|]+/, ""), uncertainDirectory ? undefined : dir).config) return BOARD_CONFIG;
  return undefined;
}
