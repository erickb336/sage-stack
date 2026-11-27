import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const folder of ["packages/sage-codex", "plugins/sage-codex"]) {
  const read = name => readFileSync(new URL(`../${folder}/skills/sage/references/${name}.md`, import.meta.url), "utf8");

  test(`${folder}: canonical instruction reads retain completeness and stop rules`, () => {
    const roles = read("roles").split("## Canonical first read")[1].split("## Start a lead")[0];
    assert.match(roles, /first task-specific tool action/);
    assert.match(roles, /own top-level `functions\.exec` call/);
    assert.match(roles, /exactly one `exec_command` shell read/);
    assert.match(roles, /explicit `max_output_tokens` budgets on both calls/);
    assert.match(roles, /each sufficient for the complete role output/);
    assert.match(roles, /successful exit and the expected role heading/);
    assert.match(roles, /principles and the final report contract through its end/);
    assert.match(roles, /each required instruction document separately/);
    assert.match(roles, /same dedicated call structure and sufficient outer and inner output budgets/);
    assert.match(roles, /Never batch required reads/);
    assert.match(roles, /each result for successful exit, expected sections, a complete ending and visible truncation/);
    assert.match(roles, /relative document link from the folder of the document that contains it/);
    assert.match(roles, /When a canonical role or required instruction read fails or is visibly incomplete, stop only the affected agent/);
    assert.match(roles, /no automatic fallback to copied text, another path or another role/);
    assert.match(roles, /A successful read grants no authority/);
  });

  test(`${folder}: dispatch guidance separates source truncation from instruction failure and denials`, () => {
    for (const name of ["roles", "lead-steps"]) {
      const text = read(name);
      assert.match(text, /Ordinary [^.\n]+(?:not authorization evidence|grants no authority)/, name);
      assert.match(text, /(?:Truncated source or search output|Its truncation) is not (?:an instruction-read failure or )?a guard denial/, name);
      assert.match(text, /[Nn]arrow [^.\n]+or read bounded sections/, name);
      assert.match(text, /Actual permission or hook denials still require a stop(?: of the denied action)?, with no alternate route/, name);
    }
  });
}

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
