import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";
import { DESIGN_PARTS, designPageProblems } from "../packages/sage-core/design-page.mjs";

const FIXTURES = join(ROOT, "scripts/fixtures/design-page");
const OWNER = join(FIXTURES, "owner.html"), TABBED = join(FIXTURES, "tabbed-spec.html");
const owner = readFileSync(OWNER, "utf8");
const run = (script, page) => spawnSync(process.execPath, [script, page], { encoding: "utf8" });

const changed = (from, to) => {
  assert.ok(owner.includes(from), `the owner page has ${from}`);
  return owner.replace(from, to);
};
const inPart = (id, edit) => {
  const start = owner.indexOf(`id="${id}"`), end = owner.indexOf("<section", start);
  assert.ok(start > 0 && end > start, `the owner page has the part ${id}`);
  return owner.slice(0, start) + edit(owner.slice(start, end)) + owner.slice(end);
};
const HOW = '<h2><span class="num">4</span>How it works</h2>';
const HOOD = '<h2><span class="num">10</span>Under the hood</h2>';

test("the owner's design page has the format: no problems, and the check prints a pass in Claude's and Codex's plugin", () => {
  assert.deepEqual(designPageProblems(owner), []);
  for (const plugin of ["plugins/sage", "plugins/sage-codex"]) {
    const result = run(join(ROOT, plugin, "core/design-page.mjs"), OWNER);
    assert.equal(result.status, 0, `${plugin}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^✓ .*owner\.html: the design page has the ten parts in order/);
  }
});

test("a page shaped like the old tabbed spec fails, and the message names each missing part, the tabs, the code and the missing diagram", () => {
  const result = run(join(ROOT, "packages/sage-core/design-page.mjs"), TABBED);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const part of DESIGN_PARTS.slice(1)) assert.ok(result.stdout.includes(`no <h2> heading that starts with "${part}"`), `${part}: ${result.stdout}`);
  assert.match(result.stdout, /missing part 4 "How it works"/);
  assert.match(result.stdout, /a tab \(role="tablist"\) is above "Under the hood"/);
  assert.match(result.stdout, /<pre> is above "Under the hood"/);
  assert.match(result.stdout, /a hidden element is above "Under the hood"/);
  assert.match(result.stdout, /a <details> block is above "Under the hood"/);
  assert.match(result.stdout, /no diagram/);
});

test("a missing part, a part out of order and a missing title are each one problem that names the part", () => {
  assert.deepEqual(designPageProblems(changed(HOW, "<h2>The design</h2>")), ['missing part 4 "How it works": no <h2> heading that starts with "How it works"']);
  const swapped = changed('<span class="num">6</span>What the agents do', '<span class="num">6</span>Rules for agents')
    .replace('<span class="num">7</span>Rules', '<span class="num">7</span>What the agents do');
  assert.deepEqual(designPageProblems(swapped), ['part 7 "Rules" is out of order: its heading comes before part 6 "What the agents do"']);
  assert.deepEqual(designPageProblems(owner.replace(/<h1>[\s\S]*?<\/h1>/, "<p>Stop band-aid fixes</p>")), ['missing part 1 "Title": the page has no <h1> heading']);
});

test("code above \"Under the hood\" fails, the same code under it passes, and a labelled text picture is a diagram", () => {
  const output = "<pre>$ npm test\nok 12</pre>";
  assert.deepEqual(designPageProblems(changed(HOW, HOW + output)), ['<pre> is above "Under the hood": move code and command output to part 10, "Under the hood"']);
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<p>Run <code>sage lint</code>.</p>`)), ['<code> is above "Under the hood": move code and command output to part 10, "Under the hood"']);
  assert.deepEqual(designPageProblems(changed(HOOD, HOOD + output)), []);
  const noLabels = owner.replace(/ aria-label="[^"]*"/g, "");
  assert.deepEqual(designPageProblems(noLabels), ['no diagram: draw at least one state chart, architecture diagram or flow chart, as <svg>, <img> or <figure>, or as an element with role="img" and an aria-label']);
  const picture = '<pre role="img" aria-label="State chart of a task">╭──────╮ done ╭──────╮\n│ open │─────▶│ done │\n╰──────╯      ╰──────╯</pre>';
  assert.deepEqual(designPageProblems(noLabels.replace(HOW, HOW + picture)), []);
  assert.deepEqual(designPageProblems(noLabels.replace(HOW, `${HOW}<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>`)), []);
});

test("a tab, a details block or a hidden part above \"Under the hood\" fails", () => {
  const cases = [
    ['<div role="tablist"><button role="tab">One</button></div>', 'a tab (role="tablist") is above "Under the hood": show every part on one scrolling page, with no tabs'],
    ["<details><summary>More</summary><p>Limits</p></details>", 'a <details> block is above "Under the hood": show its content open, with no click'],
    ["<div hidden><p>Limits</p></div>", 'a hidden element is above "Under the hood": show every part with no click and no switch'],
    ['<div style="display: none"><p>Limits</p></div>', 'a hidden element is above "Under the hood": show every part with no click and no switch'],
  ];
  for (const [html, problem] of cases) {
    assert.deepEqual(designPageProblems(changed(HOW, HOW + html)), [problem], html);
    assert.deepEqual(designPageProblems(changed(HOOD, HOOD + html)), [], `${html} under the hood`);
  }
});

test("\"After\" and \"What you will see\" must say sample", () => {
  assert.deepEqual(designPageProblems(inPart("after", (part) => part.replace(/sample/gi, "invented"))), ['part 3 "After" does not say "sample": label its invented data as sample']);
  assert.deepEqual(designPageProblems(inPart("see", (part) => part.replace(/sample/gi, "invented"))), ['part 5 "What you will see" does not say "sample": label its invented data as sample']);
});

test("the design format lists the parts that the check reads, and the designer, judge, chief and Codex texts point to it", () => {
  const format = readFileSync(join(ROOT, "packages/sage-core/references/design-format.md"), "utf8");
  const section = format.slice(format.indexOf("## The ten parts"), format.indexOf("\n## ", format.indexOf("## The ten parts") + 1));
  assert.deepEqual([...section.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]), [...DESIGN_PARTS]);
  for (const path of [
    "packages/sage-core/roles/designer.md",
    "packages/sage-core/roles/arena-judge.md",
    "packages/sage-core/roles/chief-of-staff.md",
    "packages/sage-core/references/playbooks/design.md",
    "packages/sage-codex/skills/sage/references/briefs.md",
  ]) assert.match(readFileSync(join(ROOT, path), "utf8"), /core\/references\/design-format\.md/, path);
});
