import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

export const RULE_POINTERS = Object.freeze({
  "prior-art": {
    task: "T1143",
    texts: [
      "packages/sage-core/roles/designer.md",
      "packages/sage-core/roles/pe.md",
      "packages/sage-core/roles/investigate.md",
      "packages/sage-core/roles/arena-judge.md",
      "packages/sage-core/roles/chief-of-staff.md",
      "packages/sage-core/references/playbooks/design.md",
      "packages/sage-core/references/playbooks/architecture.md",
      "packages/sage-core/references/design-format.md",
      "packages/sage-codex/skills/sage/references/briefs.md",
    ],
  },
  "fragile-patterns": {
    task: "T1149",
    texts: [
      "packages/sage-core/roles/designer.md",
      "packages/sage-core/roles/pe.md",
      "packages/sage-core/roles/code-reviewer.md",
      "packages/sage-core/roles/security-reviewer.md",
      "packages/sage-core/roles/chief-of-staff.md",
      "packages/sage-core/references/playbooks/design.md",
      "packages/sage-core/references/playbooks/architecture.md",
      "packages/sage-core/references/playbooks/new-rule.md",
      "packages/sage-codex/skills/sage/references/briefs.md",
    ],
  },
});

export const ruleFile = (name) => `packages/sage-core/references/${name}.md`;
export const pointer = (name) => `\`core/references/${name}.md\``;

export function pointerProblems(read = (path) => readFileSync(join(ROOT, path), "utf8")) {
  return Object.entries(RULE_POINTERS).flatMap(([name, { task, texts }]) => texts
    .filter((path) => !read(path).includes(pointer(name)))
    .map((path) => `${path}: no pointer to the ${name} rule; name ${pointer(name)} where the text applies the rule (${task})`));
}
