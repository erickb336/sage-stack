import "./test-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mainOverlap } from "../packages/sage-core/pull-request.mjs";

const PR_632 = { number: 632, merged: "2026-11-21T02:50:50Z", files: ["README.md", "docs/assets/board-walkthrough-dark.gif", "docs/assets/board-walkthrough-light.gif", "docs/assets/shared-dark.svg", "docs/assets/shared-light.svg", "docs/guide/using-sage.md", "scripts/board-walkthrough.mjs", "scripts/graphics.mjs"] };
const PR_634 = { number: 634, head: "a6ce6e4b85616802df00a7d0393dae7d6cbc0fd4", committed: "2026-11-21T02:28:15Z", files: ["README.md", "docs/assets/board-tour.mp4", "scripts/board-walkthrough-browser.test.mjs", "scripts/board-walkthrough.mjs", "scripts/board-walkthrough.test.mjs"] };
const PR_635 = { number: 635, merged: "2026-11-21T04:09:40Z", files: ["packages/sage-core/state.mjs"] };
const PR_630 = { number: 630, merged: null, updated: "2026-11-21T05:00:00Z", files: ["README.md"] };
const MAIN_MERGED = "b".repeat(40);
const many = (n, at) => Array.from({ length: n }, (_, i) => `${at}/file-${i}.txt`);

function github({ dates = { [PR_634.head]: PR_634.committed }, closed = [PR_632, PR_635], mine = PR_634, fail } = {}) {
  const calls = [], prs = new Map([mine, ...closed].map((p) => [p.number, p]));
  const gh = (args) => {
    const path = args[1].replace("repos/{owner}/{repo}/", "");
    calls.push(path);
    if (fail && path.startsWith(fail)) throw new Error(`gh api ${fail} failed: HTTP 502`);
    let m;
    if ((m = /^pulls\/(\d+)$/.exec(path))) return { base: "main", changed: prs.get(+m[1]).changed ?? prs.get(+m[1]).files.length };
    if ((m = /^pulls\/(\d+)\/files\?per_page=100$/.exec(path)) && args.includes("--paginate")) { const f = prs.get(+m[1]).files; return Array.isArray(f) ? f.slice(0, 3000) : f; }
    if (path.startsWith("commits/")) return { date: dates[path.slice(-40)] };
    if (path === "pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100") return closed.map(({ number, merged, updated }) => ({ number, merged, updated: updated ?? merged }));
    throw new Error(`no fake answer for ${args.join(" ")}`);
  };
  return { gh, calls };
}

test("T1197: PR 634 is refused, because PR 632 merged after its last CI and changed the same files; the refusal names the files, the merge and the fix", () => {
  const said = mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [PR_632, PR_635, PR_630] }).gh);
  assert.match(said, /PR 632 \(README\.md, scripts\/board-walkthrough\.mjs\)/);
  assert.doesNotMatch(said, /PR 635|PR 630/, "a merge that changed other files, and a closed pull request that never merged, are not named");
  assert.match(said, /Merge main into the branch, wait for CI to pass on the new head/);
});

test("T1197: a PR passes when no merge after its last CI changed one of its files", () => {
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [PR_635, PR_630] }).gh), "");
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [{ ...PR_632, merged: "2026-11-21T02:00:00Z" }] }).gh), "", "a merge before the head's commit time was in the head's CI run");
});

test("T1197: after a merge of main into the branch, the new head holds PR 632, so the check passes on it", () => {
  const { gh } = github({ dates: { [PR_634.head]: PR_634.committed, [MAIN_MERGED]: "2026-11-21T03:00:00Z" } });
  assert.notEqual(mainOverlap(634, PR_634.head, "/nowhere", {}, gh), "", "the old head still fails");
  assert.equal(mainOverlap(634, MAIN_MERGED, "/nowhere", {}, gh), "");
});

test("T1197: when the check cannot read GitHub, it refuses and gives the reason; it never passes", () => {
  for (const fail of ["pulls/634", "commits/", "pulls?state=closed", "pulls/634/files", "pulls/632/files"]) {
    const said = mainOverlap(634, PR_634.head, "/nowhere", {}, github({ fail }).gh);
    assert.match(said, /cannot read from GitHub .* HTTP 502.*so it refuses the merge/, fail);
  }
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ dates: {} }).gh), /cannot read from GitHub/, "a head with no commit time on GitHub is refused");
});

test("F-T1197-1: an overlap in a file past the first 100 of a large PR, or of a large merge, is found; a list that GitHub cuts short refuses", () => {
  const big = { ...PR_634, files: [...many(150, "mine"), "scripts/board-walkthrough.mjs"] };
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ mine: big }).gh), /PR 632 \(scripts\/board-walkthrough\.mjs\)/, "the PR's 151st file overlaps");
  const bigMerge = { ...PR_632, files: [...many(320, "theirs"), "README.md"] };
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [bigMerge] }).gh), /PR 632 \(README\.md\)/, "the merge's 321st file overlaps");
  const cut = { ...PR_634, files: many(3000, "mine"), changed: 3100 };
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ mine: cut }).gh), /cannot read from GitHub .*3000 of the 3100 changed files of PR 634.*so it refuses the merge/);
  const cutMerge = { ...PR_632, files: many(3001, "theirs") };
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [cutMerge] }).gh), /cannot read from GitHub .*PR 632 has 3000 or more changed files.*so it refuses the merge/);
});

test("F-T1197-2: the merges come from GitHub's list of pull requests by update time, not from the search index, and only when a merge came after the head are file lists read", () => {
  const { gh, calls } = github({ closed: [PR_630] });
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, gh), "");
  assert.deepEqual(calls, ["pulls/634", `commits/${PR_634.head}`, "pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100"]);
  const full = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, merged: null, updated: "2026-11-21T05:00:00Z", files: [] }));
  assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: full }).gh), /100 or more pull requests into main closed or changed after the head a6ce6e4 of PR 634/, "a full page of updates after the head may hide a merge, so it refuses");
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [...full.slice(1), { ...PR_632, merged: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z" }] }).gh), "", "a full page that reaches past the head time holds every merge after it");
});

test("F-T1197-6: a merge with no merge time, no number or no file list refuses with a reason; it never passes in silence", () => {
  assert.equal(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed: [{ ...PR_632, files: ["other.txt"] }] }).gh), "", "the same merge with a full record and no shared file passes");
  for (const [closed, why] of [
    [[{ number: 632, updated: "2026-11-21T03:00:00Z" }], "no merge time"],
    [[{ number: 632, merged: "soon", updated: "2026-11-21T03:00:00Z" }], "a bad merge time"],
    [[{ merged: PR_632.merged, updated: PR_632.merged }], "no number"],
    [[{ ...PR_632, files: null }], "no file list"],
  ]) assert.match(mainOverlap(634, PR_634.head, "/nowhere", {}, github({ closed }).gh), /cannot read from GitHub .*so it refuses the merge/, why);
});
