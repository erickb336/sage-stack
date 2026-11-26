import { readLocalGit } from "./local-git.mjs";

const NAMES = ["readme", "changelog", "license", "contributing"];
const PAGES = ["md", "rst", "adoc", "png", "jpg", "jpeg", "gif", "webp", "svg"], TEXT = ["md", "txt", "rst", "adoc"];
const WIDE = ["x.mjs", "src/x.py", ".github/workflows/ci.yml"];
const NEVER = ["100755", "120000", "160000"];
export const DOCS_RULE = "a .md, .rst, .adoc or picture file under a docs folder, or a README, CHANGELOG, LICENSE or CONTRIBUTING file with no extension or a .md, .txt, .rst or .adoc one; never an executable file, a symlink or a file in a dot folder";

function globPattern(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) (out += "(?:.*/)?"), (i += 2);
    else if (glob.startsWith("**", i)) (out += ".*"), (i += 1);
    else if (glob[i] === "*") out += "[^/]*";
    else if (glob[i] === "?") out += "[^/]";
    else out += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export const globsOf = (text) => String(text ?? "").split(",").map((glob) => glob.trim()).filter(Boolean);

export function docsPathsProblem(text) {
  const globs = globsOf(text), patterns = globs.map(globPattern);
  return globs.length > 0 && WIDE.every((path) => patterns.some((glob) => glob.test(path)))
    && `the value ${JSON.stringify(globs.join(","))} matches every file, so every pull request would merge with no review`;
}

function isDoc(path, globs) {
  const folders = path.split("/"), name = folders.pop().toLowerCase(), dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "", stem = dot > 0 ? name.slice(0, dot) : name;
  if (folders.some((folder) => folder.startsWith("."))) return false;
  if (globs.some((glob) => glob.test(path))) return true;
  return (folders.includes("docs") && PAGES.includes(ext)) || (NAMES.includes(stem) && (dot < 0 || TEXT.includes(ext)));
}

function rawFiles(text) {
  const out = [], parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith(":")) continue;
    const modes = parts[i].slice(1).split(" ", 2);
    out.push([parts[++i], modes]);
  }
  return out;
}

export function docsOnly(project, sha, docsPaths) {
  if (docsPaths !== undefined && (typeof docsPaths !== "string" || docsPathsProblem(docsPaths))) return null;
  let files, commits;
  try {
    const git = (...args) => readLocalGit(project, args).toString();
    const base = git("merge-base", "refs/remotes/origin/main", sha).trim(), raw = ["--raw", "-z", "--no-renames", "--no-abbrev", "--ignore-submodules=none"];
    files = rawFiles(git("diff", ...raw, base, sha, "--"));
    commits = rawFiles(git("log", ...raw, "--no-merges", "--format=", `${base}..${sha}`, "--"));
  } catch {
    return null;
  }
  const globs = globsOf(docsPaths).map(globPattern);
  const only = files.length > 0 && [...files, ...commits].every(([path, modes]) => !modes.some((mode) => NEVER.includes(mode)) && isDoc(path, globs));
  return { only, count: files.length, extra: globs.length > 0, sha };
}

export const docsNote = ({ sha, count, extra }) =>
  `${sha.slice(0, 7)} is docs-only: ${count === 1 ? "the one file" : `each of the ${count} files`} that it changes since its merge base with origin/main is ${extra ? "a match of the project's docs_paths or " : ""}${DOCS_RULE}. So it needs checks-pass, and lint-pass when the project lints, and no review cycle.`;
