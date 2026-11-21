import "./test-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mainOverlap } from "../packages/sage-core/pull-request.mjs";

const PR_632 = { number: 632, mergedAt: "2026-11-21T02:50:50Z", files: ["README.md", "docs/assets/board-walkthrough-dark.gif", "docs/assets/board-walkthrough-light.gif", "docs/assets/shared-dark.svg", "docs/assets/shared-light.svg", "docs/guide/using-sage.md", "scripts/board-walkthrough.mjs", "scripts/graphics.mjs"] };
const PR_634 = { head: "a6ce6e4b85616802df00a7d0393dae7d6cbc0fd4", committed: "2026-11-21T02:28:15Z", files: ["README.md", "docs/assets/board-tour.mp4", "scripts/board-walkthrough-browser.test.mjs", "scripts/board-walkthrough.mjs", "scripts/board-walkthrough.test.mjs"] };
const PR_635 = { number: 635, mergedAt: "2026-11-21T04:09:40Z", files: ["packages/sage-core/state.mjs"] };
const MAIN_MERGED = "b".repeat(40);

function github({ dates = { [PR_634.head]: PR_634.committed }, merged = [PR_632, PR_635], fail } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (fail === calls.at(-1)) throw new Error(`gh ${fail} failed: HTTP 502`);
    if (args[0] === "pr" && args[1] === "view") return { files: PR_634.files.map((path) => ({ path })), baseRefName: "main" };
    if (args[0] === "api") return { date: dates[args[1].slice(-40)] };
    const since = args[args.indexOf("--search") + 1].replace("merged:>=", "");
    return merged.filter((m) => m.mergedAt >= since).map((m) => ({ ...m, files: m.files.map((path) => ({ path })) }));
  };
  return { gh, calls };
}

test("T1197: PR 634 is refused, because PR 632 merged after its last CI and changed the same files; the refusal names the files, the merge and the fix", () => {
  const said = mainOverlap(634, PR_634.head, "/nowhere", {}, github().gh);
  assert.match(said, /PR 632 \(README\.md, scripts\/board-walkthrough\.mjs\)/);
  assert.doesNotMatch(said, /PR 635/, "a merge that changed other files is not named");
  assert.match(said, /Merge main into the branch, wait for CI to pass on the new head/);
});

test("T1197: a PR passes when no merge after its last CI changed one of its files", () => {
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ merged: [PR_635] }).gh), "");
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ merged: [{ ...PR_632, mergedAt: "2026-11-21T02:00:00Z" }] }).gh), "", "a merge before the head's commit time was in the head's CI run");
});

test("T1197: after a merge of main into the branch, the new head holds PR 632, so the check passes on it", () => {
  const { gh } = github({ dates: { [PR_634.head]: PR_634.committed, [MAIN_MERGED]: "2026-11-21T03:00:00Z" } });
  assert.notEqual(mainOverlap(634, PR_634.head, "/nowhere", {}, gh), "", "the old head still fails");
  assert.equal(mainOverlap(634, MAIN_MERGED, "/nowhere", {}, gh), "");
});

test("T1197: when the check cannot read GitHub, it refuses and gives the reason; it never passes", () => {
  for (const fail of ["pr view", "api repos/{owner}/{repo}/commits/" + PR_634.head, "pr list"]) {
    const said = mainOverlap(634, PR_634.head, "/nowhere", {}, github({ fail: fail.split(" ").slice(0, 2).join(" ") }).gh);
    assert.match(said, /cannot read from GitHub .* HTTP 502.*so it refuses the merge/, fail);
  }
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ dates: {} }).gh), /cannot read from GitHub/, "a head with no commit time on GitHub is refused");
});
