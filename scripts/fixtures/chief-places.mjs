import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOME = `/sage-t1240-not-created-${process.pid}/home`;

export function chiefPlaces() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "sage-t1240-")));
  const project = join(temp, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project], { env: { ...process.env, HOME: temp } });
  symlinkSync(project, join(temp, "to-project"));
  symlinkSync(join(project, "src"), join(temp, "to-src"));
  symlinkSync(join(HOME, ".claude", "settings.json"), join(temp, "settings.json"));
  const worktrees = join(temp, "sage-worktrees"), live = join(worktrees, "t1"), logbook = join(temp, "sage-home");
  mkdirSync(join(worktrees, "sage-x", "pages", "T1"), { recursive: true });
  mkdirSync(live);
  writeFileSync(join(live, ".git"), `gitdir: ${project}/.git/worktrees/t1\n`);
  const rows = [
    ["a file in the temp folder", join(temp, "notes", "out.md"), true],
    ["the temp folder by its /tmp name", `/tmp/sage-t1240-${process.pid}/out.md`, true],
    ["a page in the sage worktrees folder", join(HOME, "sage-worktrees", "sage-x", "pages", "T1", "plan.md"), true],
    ["the project", join(project, "README.md"), false],
    ["a task worktree in the project", join(project, ".claude", "worktrees", "t1", "a.js"), false],
    ["the logbook (SAGE_HOME)", join(logbook, "sage-x", "tasks.tsv"), false],
    ["~/.sage", join(HOME, ".sage", "sage-x", "tasks.tsv"), false],
    ["~/.claude", join(HOME, ".claude", "settings.json"), false],
    ["~/.codex", join(HOME, ".codex", "config.toml"), false],
    ["~/.config/sage-board", join(HOME, ".config", "sage-board", "board.json"), false],
    ["a link in the temp folder to the project", join(temp, "to-project", "a.js"), false],
    [".. after a link in the temp folder", `${temp}/to-src/../escape.md`, false],
    [".. out of the temp folder", `/tmp/..${HOME}/.claude/settings.json`, false],
    ["a link in the temp folder to a file of ~/.claude that does not exist yet", join(temp, "settings.json"), false],
  ].map(([name, path, scratch]) => ({ name, path, scratch, env: { HOME, SAGE_HOME: logbook } }));
  rows.push({ name: "a git work tree in the sage worktrees folder", path: join(live, "README.md"), scratch: false, worktree: true, env: { HOME, SAGE_HOME: logbook, SAGE_WORKTREES: worktrees } },
    { name: "a page in that sage worktrees folder", path: join(worktrees, "sage-x", "pages", "T1", "plan.md"), scratch: true, env: { HOME, SAGE_HOME: logbook, SAGE_WORKTREES: worktrees } });
  return { project, rows };
}
