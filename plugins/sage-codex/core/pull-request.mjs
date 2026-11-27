import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const PR = /^[1-9][0-9]*$/;

export function pullRequestHead(pr, cwd, env = process.env) {
  if (!/^\d+$/.test(String(pr ?? "")) || !BigInt(pr)) throw new Error("the merge names no pull request number");
  pr = String(BigInt(pr));
  const r = spawnSync("gh", ["pr", "view", pr, "--json", "headRefName,isCrossRepository"], { cwd, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "gh did not answer in 5 seconds" : r.error.message);
  if (r.status !== 0) throw new Error(`gh pr view ${pr} failed`);
  const view = JSON.parse(r.stdout);
  if (view?.isCrossRepository !== false) throw new Error(`PR ${pr} is not a branch of this repository`);
  if (typeof view.headRefName !== "string" || !view.headRefName) throw new Error("gh gave no head branch");
  return view.headRefName;
}

export const USERS_FOLDER = "for-users";
export const USERS_MAX = 64 * 1024;
const USERS_HEADING = /^ {0,3}(#{1,6})[ \t]+what changes for users[ \t]*:?[ \t]*#*[ \t]*$/i;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/, FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function usersPart(body) {
  const lines = String(body ?? "").split(/\r?\n/), start = lines.findIndex((line) => USERS_HEADING.test(line));
  if (start < 0) return "";
  const level = USERS_HEADING.exec(lines[start])[1].length, part = [];
  let fence = null;
  for (const line of lines.slice(start + 1)) {
    const mark = FENCE.exec(line)?.[1];
    if (mark && (!fence || (mark[0] === fence[0] && mark.length >= fence.length))) fence = fence ? null : mark;
    else if (!fence && (HEADING.exec(line)?.[1].length ?? 7) <= level) break;
    part.push(line);
  }
  const text = part.join("\n").trim();
  return Buffer.byteLength(text) > USERS_MAX ? "" : text;
}

export function pullRequestBody(pr, repository, cwd, env = process.env) {
  if (!PR.test(String(pr ?? ""))) throw new Error("the task names no pull request number");
  const r = spawnSync("gh", ["pr", "view", String(pr), "--repo", repository, "--json", "body"], { cwd, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 ** 22, stdio: ["ignore", "pipe", "ignore"], env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "gh did not answer in 5 seconds" : r.error.message);
  if (r.status !== 0) throw new Error(`gh pr view ${pr} failed`);
  const body = JSON.parse(r.stdout)?.body;
  if (typeof body !== "string") throw new Error("gh gave no body");
  return body;
}

export function keptUsersText(logbook, task) {
  if (!/^T[1-9]\d*$/.test(String(task))) return null;
  let fd;
  try {
    fd = openSync(join(logbook, USERS_FOLDER, `${task}.md`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > USERS_MAX) return null;
    const bytes = Buffer.alloc(info.size), read = readSync(fd, bytes, 0, info.size, 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read)).trim() || null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const MERGES_MAX = 100, FILES_MAX = 3000, REPO = "repos/{owner}/{repo}";
const ghRead = (cwd, env) => (args) => {
  const { GH_HOST, GH_REPO, ...rest } = env;
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 2 ** 24, stdio: ["ignore", "pipe", "pipe"], env: { ...rest, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? `gh ${args.slice(0, 2).join(" ")} did not answer in 15 seconds` : r.error.message);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return args.includes("--paginate") ? r.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : JSON.parse(r.stdout);
};
const isTime = (text) => typeof text === "string" && !Number.isNaN(Date.parse(text));

function changedFiles(gh, n, count) {
  const list = gh(["api", `${REPO}/pulls/${n}/files?per_page=100`, "--paginate", "--jq", ".[] | .filename | @json"]);
  if (!Array.isArray(list) || list.some((path) => typeof path !== "string")) throw new Error(`GitHub gave no list of the changed files of PR ${n}`);
  if (count !== undefined && list.length < count) throw new Error(`GitHub listed only ${list.length} of the ${count} changed files of PR ${n}`);
  if (count === undefined && list.length >= FILES_MAX) throw new Error(`PR ${n} has ${FILES_MAX} or more changed files, and GitHub lists only ${FILES_MAX}`);
  return list;
}

export function mainOverlap(pr, sha, cwd, env = process.env, gh = ghRead(cwd, env)) {
  let base, since, closed, after, hits;
  try {
    const view = gh(["api", `${REPO}/pulls/${pr}`, "--jq", "{base: .base.ref, changed: .changed_files}"]);
    since = gh(["api", `${REPO}/commits/${sha}`, "--jq", "{date: .commit.committer.date}"]).date;
    if (typeof view?.base !== "string" || !Number.isInteger(view.changed) || !isTime(since)) throw new Error("GitHub gave no base branch, count of changed files or commit time");
    base = view.base;
    closed = gh(["api", `${REPO}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${MERGES_MAX}`, "--jq", "[.[] | {number, merged: .merged_at, updated: .updated_at}]"]);
    if (!Array.isArray(closed) || closed.some((m) => !Number.isInteger(m?.number) || !isTime(m.updated) || (m.merged !== null && !isTime(m.merged)))) throw new Error("GitHub gave a closed pull request with no number, update time or merge time");
    if (closed.length >= MERGES_MAX && closed.every((m) => Date.parse(m.updated) >= Date.parse(since))) return `${MERGES_MAX} or more pull requests into ${base} closed or changed after the head ${sha.slice(0, 7)} of PR ${pr}, so the merge check refuses: CI may never have run on a head that holds their merges. Merge ${base} into the branch, wait for CI to pass on the new head, then check again.`;
    after = closed.filter((m) => m.merged && m.number !== Number(pr) && Date.parse(m.merged) > Date.parse(since)).sort((a, b) => a.number - b.number);
    if (!after.length) return "";
    const mine = new Set(changedFiles(gh, pr, view.changed));
    hits = after.map((m) => ({ n: m.number, files: changedFiles(gh, m.number).filter((p) => mine.has(p)) })).filter((m) => m.files.length);
  } catch (e) {
    return `the merge check cannot read from GitHub which merges into the base branch came after the last CI of PR ${pr} (${e?.message ?? e}), so it refuses the merge. Check that gh is logged in, then check again.`;
  }
  if (!hits.length) return "";
  return `PR ${pr} changes files that ${hits.length === 1 ? "a merge" : "merges"} into ${base} after its last CI also changed: ${hits.map((m) => `PR ${m.n} (${m.files.join(", ")})`).join("; ")}. CI never ran on a head that holds both changes. Merge ${base} into the branch, wait for CI to pass on the new head, record checks-pass on it, then check again.`;
}
