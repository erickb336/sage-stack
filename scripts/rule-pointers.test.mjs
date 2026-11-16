import "./test-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { PRIOR_ART_COLUMNS } from "../packages/sage-core/prior-art-index.mjs";
import { RULE_POINTERS, pointer, pointerProblems, ruleFile } from "./rule-pointers.mjs";

const real = (path) => readFileSync(join(ROOT, path), "utf8");
const json = (path) => JSON.parse(real(path));
const PLUGINS = { claude: "plugins/sage", codex: "plugins/sage-codex" };

async function builtTexts(path) {
  const role = /^packages\/sage-core\/roles\/([a-z-]+)\.md$/.exec(path)?.[1];
  const own = /^packages\/sage-(claude|codex)\/(.+)$/.exec(path);
  if (own) return [[own[1], real(`${PLUGINS[own[1]]}/${own[2]}`)]];
  if (!role) return Object.entries(PLUGINS).map(([provider, plugin]) => [provider, real(`${plugin}/core/${path.slice("packages/sage-core/".length)}`)]);
  const core = await import(pathToFileURL(join(ROOT, PLUGINS.codex, "core/index.mjs")));
  const codex = role === "chief-of-staff"
    ? core.renderChiefInstructions(json(`${PLUGINS.codex}/chief-bindings.json`))
    : core.renderRoleInstructions(role, { ...json(`${PLUGINS.codex}/role-bindings.json`).common, ...json(`${PLUGINS.codex}/role-bindings.json`)[role] });
  return [["claude", real(`${PLUGINS.claude}/agents/${role}.md`)], ["codex", codex]];
}

test("each role, playbook and provider text that applies a shared rule points to its reference", () => {
  assert.deepEqual(pointerProblems(), []);
});

test("the agents of both providers read the pointers: Claude's built agent files and the role and chief texts that Codex renders", async () => {
  for (const [name, { texts }] of Object.entries(RULE_POINTERS)) {
    for (const path of texts) {
      for (const [provider, text] of await builtTexts(path)) assert.ok(text.includes(pointer(name)), `${provider} ${path}: no ${pointer(name)}`);
    }
  }
});

test("a text that loses one pointer is a problem that names it and the rule, and only it, also when the rule's words stay in it", () => {
  for (const [name, { texts }] of Object.entries(RULE_POINTERS)) {
    for (const lost of texts) {
      const read = (path) => path === lost ? `${real(path).replaceAll(`core/references/${name}.md`, "the rule")}\nThe report names the ${name}.\n` : real(path);
      const problems = pointerProblems(read);
      assert.equal(problems.length, 1, `${lost}: ${problems.join("; ")}`);
      assert.ok(problems[0].startsWith(`${lost}: no pointer to the ${name} rule`), problems[0]);
    }
  }
});

test("both plugins carry each rule as its source, and the prior-art table has the columns that the index tool checks", () => {
  for (const name of Object.keys(RULE_POINTERS)) {
    for (const plugin of Object.values(PLUGINS)) assert.equal(real(`${plugin}/core/references/${name}.md`), real(ruleFile(name)), `${plugin} ${name}`);
  }
  assert.ok(real(ruleFile("prior-art")).includes(`| ${PRIOR_ART_COLUMNS.join(" | ")} |`), "the table of the prior-art rule");
});
