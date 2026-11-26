import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SCRIPTS = import.meta.dirname;
const scratch = mkdtempSync(join(tmpdir(), "test-split-"));
const env = { ...process.env, HOME: join(scratch, "home"), SAGE_HOME: join(scratch, "sage") };
let lists = 0;
function registered(file) {
  const out = join(scratch, `list-${lists++}.json`);
  const run = spawnSync(process.execPath, [join(SCRIPTS, "test-list.mjs"), file, out], { encoding: "utf8", env });
  assert.equal(run.status, 0, `${file} loads with a recorder in place of node:test:\n${run.stderr}`);
  return JSON.parse(readFileSync(out, "utf8"));
}
const names = (calls) => calls.map((call) => call.name).sort();
const bodies = readdirSync(SCRIPTS).filter((file) => file.endsWith("-tests.mjs"));

test("the part files of each split body together register each test of the body exactly once, with its function", () => {
  assert.ok(bodies.length >= 3, `the split bodies: ${bodies}`);
  for (const body of bodies) {
    const all = registered(join(SCRIPTS, body)), part = new RegExp(`^${body.replace(/-tests\.mjs$/, "")}-(\\d+)\\.test\\.mjs$`);
    const files = readdirSync(SCRIPTS).filter((file) => part.test(file)).sort((a, b) => a.match(part)[1] - b.match(part)[1]);
    assert.ok(all.length > 0, `${body} registers its tests`);
    assert.deepEqual(all.filter((call) => !call.fn).map((call) => call.name), [], `${body}: each test gets its function`);
    assert.ok(files.length >= 2, `${body} runs as part files scripts/${body.replace(/-tests\.mjs$/, "")}-1.test.mjs and on`);
    assert.deepEqual(files.map((file) => Number(file.match(part)[1])), files.map((_, k) => k + 1), `${body}: its part files are numbered 1 to ${files.length}`);
    const parts = files.map((file) => registered(join(SCRIPTS, file)));
    parts.forEach((calls, k) => assert.ok(calls.length > 0, `${files[k]} registers at least one test of ${body}`));
    assert.deepEqual(names(parts.flat()), names(all), `${body}: the ${files.length} parts register each of its ${all.length} tests once, so no test runs twice or in no part`);
  }
});

test("npm test runs the part files of a split body, never the body itself, which would run all its tests a second time", () => {
  const { scripts } = JSON.parse(readFileSync(join(SCRIPTS, "..", "package.json"), "utf8"));
  const words = `${scripts.test} ${scripts["test:browser"]}`.split(/\s+/);
  assert.deepEqual(words.filter((word) => bodies.some((body) => word.endsWith(body))), []);
});

test("the shared selector gives node:test each test's name, options and function, also through test.skip and test.only", () => {
  const body = join(scratch, "sample-tests.mjs");
  writeFileSync(body, [
    `import { splitTest } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "test-split.mjs")).href)};`,
    "const test = splitTest(2, undefined, { timeout: 5 });",
    "const fn = () => {};",
    'test("two arguments", fn);',
    'test("three arguments", { timeout: 9 }, fn);',
    'test.skip("skipped", fn);',
    'test.only("only", { timeout: 9 }, fn);',
  ].join("\n"));
  assert.deepEqual(registered(body), [
    { name: "two arguments", options: { timeout: 5 }, fn: true },
    { name: "three arguments", options: { timeout: 9 }, fn: true },
    { name: "skipped", options: { timeout: 5, skip: true }, fn: true },
    { name: "only", options: { timeout: 9, only: true }, fn: true },
  ]);
});
