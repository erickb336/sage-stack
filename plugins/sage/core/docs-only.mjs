import { readLocalGit } from "./local-git.mjs";

const NAMES = ["readme", "changelog", "license", "contributing"];
const WIDE = ["x", "x.mjs", "src/x.py", ".github/workflows/ci.yml", "a/b/c/Makefile"];
export const DOCS_RULE = "a file under a docs folder, or a README, CHANGELOG, LICENSE or CONTRIBUTING file";

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
  const wide = globsOf(text).find((glob) => WIDE.every((path) => globPattern(glob).test(path)));
  return wide && `the glob ${JSON.stringify(wide)} matches every file, so every pull request would merge with no review`;
}

function isDoc(path, globs) {
  const parts = path.split("/"), name = parts.at(-1).replace(/\.[^.]*$/, "").toLowerCase();
  return parts.slice(0, -1).includes("docs") || NAMES.includes(name) || globs.some((glob) => glob.test(path));
}

export function docsOnly(project, sha, docsPaths) {
  if (docsPaths !== undefined && (typeof docsPaths !== "string" || docsPathsProblem(docsPaths))) return null;
  let files;
  try {
    const git = (...args) => readLocalGit(project, args).toString();
    const base = git("merge-base", "refs/remotes/origin/main", sha).trim();
    files = git("diff", "--name-only", "-z", "--no-renames", base, sha, "--").split("\0").filter(Boolean);
  } catch {
    return null;
  }
  const globs = globsOf(docsPaths).map(globPattern);
  return { only: files.length > 0 && files.every((path) => isDoc(path, globs)), count: files.length, extra: globs.length > 0, sha };
}

export const docsNote = ({ sha, count, extra }) =>
  `${sha.slice(0, 7)} is docs-only: ${count === 1 ? "the one file" : `each of the ${count} files`} that it changes since its merge base with origin/main is ${DOCS_RULE}${extra ? ", or matches the project's docs_paths" : ""}. So it needs checks-pass, and lint-pass when the project lints, and no review cycle.`;
