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
