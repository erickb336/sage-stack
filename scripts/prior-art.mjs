import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

export const PRIOR_ART_RULE = "packages/sage-core/references/prior-art.md";
export const PRIOR_ART_TEXTS = Object.freeze([
  "packages/sage-core/roles/designer.md",
  "packages/sage-core/roles/pe.md",
  "packages/sage-core/roles/investigate.md",
  "packages/sage-core/roles/arena-judge.md",
  "packages/sage-core/roles/chief-of-staff.md",
  "packages/sage-core/references/playbooks/design.md",
  "packages/sage-core/references/playbooks/architecture.md",
  "packages/sage-core/references/design-format.md",
  "packages/sage-codex/skills/sage/references/briefs.md",
]);

const POINTER = /`core\/references\/prior-art\.md`/;

export function priorArtProblems(read = (path) => readFileSync(join(ROOT, path), "utf8")) {
  return PRIOR_ART_TEXTS.filter((path) => !POINTER.test(read(path)))
    .map((path) => `${path}: no pointer to the prior-art rule; name \`core/references/prior-art.md\` where the text asks for the prior art (T1143)`);
}
