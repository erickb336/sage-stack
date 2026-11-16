import "./test-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { PRIOR_ART_COLUMNS } from "../packages/sage-core/prior-art-index.mjs";
import { PRIOR_ART_RULE, PRIOR_ART_TEXTS, priorArtProblems } from "./prior-art.mjs";

const real = (path) => readFileSync(join(ROOT, path), "utf8");

test("the designer, PE, investigate, judge and chief texts, the playbooks, the design format and the Codex briefs point to the prior-art rule", () => {
  assert.deepEqual(priorArtProblems(), []);
});

test("a text that loses its pointer is a problem that names it, and only it, also when the words \"prior art\" stay in it", () => {
  for (const lost of PRIOR_ART_TEXTS) {
    const read = (path) => path === lost ? `${real(path).replaceAll("core/references/prior-art.md", "the rule")}\nThe report names the prior art.\n` : real(path);
    const problems = priorArtProblems(read);
    assert.equal(problems.length, 1, `${lost}: ${problems.join("; ")}`);
    assert.ok(problems[0].startsWith(`${lost}: no pointer to the prior-art rule`), problems[0]);
  }
});

test("the rule's table has the columns that the index tool checks, and the plugins carry the rule", () => {
  const rule = real(PRIOR_ART_RULE);
  assert.ok(rule.includes(`| ${PRIOR_ART_COLUMNS.join(" | ")} |`), "the table of the rule");
  for (const plugin of ["plugins/sage", "plugins/sage-codex"]) assert.equal(real(`${plugin}/core/references/prior-art.md`), rule, plugin);
});
