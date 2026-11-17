import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

export function copyRepo(prefix) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of tracked) if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(dir, file));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}
