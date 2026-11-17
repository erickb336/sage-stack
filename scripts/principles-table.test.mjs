import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { principleRows } from "./principles-table.mjs";
import { copyRepo } from "./repo-copy.mjs";

test("each principle gets its attribution from its source: from pstack; or sage's own", () => {
  const rows = principleRows([
    { id: "fix-root-causes", applyWhen: "debugging a failure.", source: "pstack principle-fix-root-causes, MIT, Copyright (c) 2026 Lauren Tan, adapted" },
    { id: "contextualize", applyWhen: "writing for a reader.", source: "this kit's own" },
    { id: "build-the-lever", applyWhen: "the work is not trivial: edits, checks.", source: "pstack principle-build-the-lever, MIT, Copyright (c) 2026 Lauren Tan, adapted" },
  ]);
  assert.deepEqual(rows, [
    { id: "build-the-lever", applyWhen: "the work is not trivial: edits, checks", text: "from pstack" },
    { id: "contextualize", applyWhen: "writing for a reader", text: "sage's own" },
    { id: "fix-root-causes", applyWhen: "debugging a failure", text: "from pstack" },
  ]);
});

function copy(t) {
  const dir = copyRepo("sage-principles-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (script) => spawnSync("node", [join(dir, "scripts", `${script}.mjs`)], { encoding: "utf8" });
  const read = (rel) => readFileSync(join(dir, rel), "utf8");
  const write = (rel, text) => (mkdirSync(dirname(join(dir, rel)), { recursive: true }), writeFileSync(join(dir, rel), text));
  return { run, read, write };
}

test("npm run check fails when a principle's applyWhen changes and the principles page does not; the build fixes it", (t) => {
  const c = copy(t);
  c.write("principles/fix-root-causes.md", c.read("principles/fix-root-causes.md").replace("applyWhen: debugging a failure or repairing a finding.", "applyWhen: a test fails for a reason nobody knows."));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ docs\/guide\/principles\.md: out of date; run npm run build/);
  assert.equal(c.run("build").status, 0);
  assert.match(c.read("docs/guide/principles.md"), /\n\| fix-root-causes<br>\*from pstack\* \| a test fails for a reason nobody knows \|\n/);
  const after = c.run("check");
  assert.equal(after.status, 0, after.stderr);
});

test("npm run check fails when the principles page's table is edited by hand", (t) => {
  const c = copy(t);
  c.write("docs/guide/principles.md", c.read("docs/guide/principles.md").replace("| fix-root-causes<br>*from pstack* | debugging a failure or repairing a finding |", "| fix-root-causes<br>*mine* | debugging a failure or repairing a finding |"));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ docs\/guide\/principles\.md: out of date; run npm run build/);
});
