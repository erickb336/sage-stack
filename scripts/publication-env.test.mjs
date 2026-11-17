import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("publication guidance keeps authenticated commands outside test isolation", () => {
  const source = readFileSync(new URL("../packages/sage-codex/skills/sage/references/lead-steps.md", import.meta.url), "utf8");
  const section = source.split("**The pull request.**")[1].split("**Wait for CI.**")[0];
  assert.ok(section.includes("outside the test process"));
  assert.ok(section.includes("Do not copy credentials"));
  assert.ok(section.includes("global Git configuration"));
});

test("two synthetic homes prove test isolation hides Git markers without changing the invoking context", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const publication = join(root, "publication"), isolated = join(root, "test");
  for (const [home, marker] of [[publication, "publication-marker"], [isolated, "test-marker"]]) {
    mkdirSync(home); writeFileSync(join(home, ".gitconfig"), `[sageFixture]\n\tmarker = ${marker}\n`);
  }
  const base = { PATH: process.env.PATH, HOME: publication, SAGE_HOME: join(root, "sage"), CODEX_HOME: join(root, "codex"), TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", DO_NOT_TRACK: "1" };
  const marker = env => spawnSync("git", ["config", "--global", "--get", "sageFixture.marker"], { env, encoding: "utf8" });
  assert.equal(marker(base).stdout.trim(), "publication-marker");
  assert.equal(marker({ ...base, HOME: isolated }).stdout.trim(), "test-marker");
  const program = `import ${JSON.stringify(new URL("./test-env.mjs", import.meta.url).href)}; import { spawnSync } from 'node:child_process'; const result = spawnSync('git', ['config', '--global', '--get', 'sageFixture.marker'], { env: process.env, encoding: 'utf8' }); console.log(JSON.stringify({ status: result.status, text: result.stdout, global: process.env.GIT_CONFIG_GLOBAL, home: process.env.HOME }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: { ...base, HOME: isolated }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 1, text: "", global: "/dev/null", home: isolated });
  assert.equal(base.HOME, publication);
  assert.equal(marker(base).stdout.trim(), "publication-marker");
  assert.equal(marker({ ...base, HOME: isolated }).stdout.trim(), "test-marker");
});
