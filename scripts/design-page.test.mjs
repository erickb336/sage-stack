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
const SEE = '<h2><span class="num">5</span>What you will see <span class="tag sample">sample</span></h2>';
const SCRIPT = (kind = "<script>") => `the page has a script (${kind}): show every part and every state in plain HTML, with no script`;
const SWITCH = (control) => `a switch (${control}) is above "Under the hood": show each state side by side, with no button and no switch`;
const HIDDEN = 'a hidden element is above "Under the hood": show every part with no click and no switch';
const NO_DIAGRAM = 'no diagram: draw at least one state chart, architecture diagram or flow chart, as an <svg>, an <img> with alt text, a <figure>, an element with role="img" and an aria-label, or a <div> of boxes with an aria-label';
const CODE = (name) => `<${name}> is above "Under the hood": move code and command output to part 10, "Under the hood"`;

test("the owner's design page has the format: no problems, and the check prints a pass in Claude's and Codex's plugin", () => {
  assert.ok(owner.includes(".plan .ar::after,.plan .ar::before{display:none}"), "the owner page hides a decoration with a style rule");
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
  assert.deepEqual(designPageProblems(noLabels), [NO_DIAGRAM]);
  const picture = '<pre role="img" aria-label="State chart of a task">╭──────╮ done ╭──────╮\n│ open │─────▶│ done │\n╰──────╯      ╰──────╯</pre>';
  assert.deepEqual(designPageProblems(noLabels.replace(HOW, HOW + picture)), []);
  assert.deepEqual(designPageProblems(noLabels.replace(HOW, `${HOW}<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>`)), []);
});

test("a tab, a details block or a hidden part above \"Under the hood\" fails", () => {
  const cases = [
    ['<div role="tablist"><button role="tab">One</button></div>', 'a tab (role="tablist") is above "Under the hood": show every part on one scrolling page, with no tabs'],
    ["<details><summary>More</summary><p>Limits</p></details>", 'a <details> block is above "Under the hood": show its content open, with no click'],
    ["<div hidden><p>Limits</p></div>", HIDDEN],
    ['<div style="display: none"><p>Limits</p></div>', HIDDEN],
    ['<div style="visibility:hidden"><p>Limits</p></div>', HIDDEN],
    ['<div title="a>b" hidden><p>Limits</p></div>', HIDDEN],
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

test("states that a style rule hides and buttons switch fail, as in an arena candidate page, and the message names the switch and the script", () => {
  const states = '<style>.state{display:none}.state.on{display:block}</style><div class="tabs"><button aria-pressed="true">Normal</button><button aria-pressed="false">Failure</button></div>'
    + '<div class="state on"><p>Normal state, sample data</p></div><div class="state"><p>Failure state, sample data</p></div>';
  const script = '<script>document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {})</script>';
  assert.deepEqual(designPageProblems(changed(SEE, SEE + states + script)), [SCRIPT(), SWITCH("<button>")]);
  assert.deepEqual(designPageProblems(changed(SEE, SEE + states)), [SWITCH("<button>")]);
  assert.deepEqual(designPageProblems(changed(HOOD, HOOD + states)), [], "a button under the hood");
  assert.deepEqual(designPageProblems(changed("</body>", script + "</body>")), [SCRIPT()], "a script at the end of the page");
});

test("each kind of switch above \"Under the hood\" fails and names itself", () => {
  const cases = [
    ['<input type="radio" name="s" id="a" checked><label for="a">Normal</label>', '<input type="radio">'],
    ['<select><option>Normal</option><option>Failure</option></select>', "<select>"],
    ['<span role="switch">Failure</span>', 'role="switch"'],
    ['<div aria-expanded="false">More</div>', "aria-expanded"],
    ['<a href="#fail" aria-controls="fail">Failure</a>', "aria-controls"],
  ];
  for (const [html, control] of cases) {
    assert.deepEqual(designPageProblems(changed(SEE, SEE + html)), [SWITCH(control)], html);
    assert.deepEqual(designPageProblems(changed(HOOD, HOOD + html)), [], `${html} under the hood`);
  }
});

test("a character reference above the last code point reads as a character, with no crash", () => {
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<p>&#x110000; &#1114112; &#99999999999999999999;</p>`)), []);
});

test("only a real picture is a diagram: a landmark, a section, a paragraph or an empty or unlabelled picture is not", () => {
  const noLabels = owner.replace(/ aria-label="[^"]*"/g, "");
  const notPictures = [
    '<nav aria-label="Parts"><a href="#rules">Rules</a></nav>',
    '<section aria-label="Rules"><p>One rule</p></section>',
    '<div role="navigation" aria-label="Parts"><span>Rules</span></div>',
    '<p aria-label="Flow">Open, then done</p>',
    '<div aria-label="Flow"></div>',
    '<div role="img"><span>Open</span><span>Done</span></div>',
    '<img src="flow.png">',
    '<img alt=" " src="flow.png">',
    '<svg viewBox="0 0 10 10"></svg>',
    "<figure></figure>",
    '<canvas width="40" height="40"></canvas>',
  ];
  for (const html of notPictures) assert.deepEqual(designPageProblems(noLabels.replace(HOW, HOW + html)), [NO_DIAGRAM], html);
  const pictures = [
    '<img alt="Flow chart of a task" src="flow.png">',
    "<figure><figcaption>Flow chart of a task</figcaption></figure>",
    '<div aria-label="Flow chart of a task"><span>Open</span><span>Done</span></div>',
    '<span role="img" aria-label="Flow chart of a task">Open → Done</span>',
  ];
  for (const html of pictures) assert.deepEqual(designPageProblems(noLabels.replace(HOW, HOW + html)), [], html);
});

test("a labelled <pre> is code, and only a text picture with role=\"img\" skips the code rule", () => {
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<pre aria-label="Test output">$ npm test\nok 12</pre>`)), [CODE("pre")]);
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<pre role="img" aria-label="Flow">open ─▶ done</pre>`)), []);
});

test("content that HTML hides by default is hidden: a <template> and a <dialog> that is not open", () => {
  for (const html of ["<template><p>Failure state, sample data</p></template>", "<dialog><p>Failure state, sample data</p></dialog>"]) {
    assert.deepEqual(designPageProblems(changed(HOW, HOW + html)), [HIDDEN], html);
    assert.deepEqual(designPageProblems(changed(HOOD, HOOD + html)), [], `${html} under the hood`);
  }
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<dialog open><p>Failure state, sample data</p></dialog>`)), []);
});

test("\"samples\" labels the data as well as \"sample\"", () => {
  assert.deepEqual(designPageProblems(inPart("after", (part) => part.replace(/\bsample\b/gi, "Samples"))), []);
});

test("a hidden form value is not a switch", () => {
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<input type="hidden" name="page" value="1"><input type="HIDDEN" name="v" value="2">`)), []);
});

test("an event attribute or a javascript: URL is a script, in any part, and a <label for> above \"Under the hood\" is a switch", () => {
  const scripts = [
    ['<span onclick="this.hidden = true">Failure</span>', "onclick"],
    ['<a href="javascript:void 0">Failure</a>', "a javascript: URL"],
    ['<a href=" Java&#x09;Script:void 0">Failure</a>', "a javascript: URL"],
  ];
  for (const [html, kind] of scripts) {
    assert.deepEqual(designPageProblems(changed(HOW, HOW + html)), [SCRIPT(kind)], html);
    assert.deepEqual(designPageProblems(changed(HOOD, HOOD + html)), [SCRIPT(kind)], `${html} under the hood`);
  }
  const label = '<label for="failure">Failure</label>';
  assert.deepEqual(designPageProblems(changed(HOW, HOW + label)), [SWITCH("<label for>")]);
  assert.deepEqual(designPageProblems(changed(HOOD, HOOD + label)), []);
});

test("a quote that does not follow \"=\" is a plain character, so it hides no later tag", () => {
  const cases = [
    "<p class=owner's>Plain text</p><div hidden><p>Failure state</p></div><p title='x'>end</p>",
    "<img alt=don't src=x.png><div hidden><p>Failure state</p></div><p title='x'>end</p>",
    '<p class="a"">Plain text</p><div hidden><p>Failure state</p></div><p class=b">end</p>',
  ];
  for (const html of cases) assert.deepEqual(designPageProblems(changed(HOW, HOW + html)), [HIDDEN], html);
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<p class=owner's>Plain text</p><p title='x'>end</p>`)), []);
});

test("role is a list of words: each word counts", () => {
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<span role=" button ">Failure</span>`)), [SWITCH('role="button"')]);
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<span role="button link">Failure</span>`)), [SWITCH('role="button"')]);
  assert.deepEqual(designPageProblems(changed(HOW, `${HOW}<div role="none tablist"><span>One</span></div>`)),
    ['a tab (role="tablist") is above "Under the hood": show every part on one scrolling page, with no tabs']);
});
