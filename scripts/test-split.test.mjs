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
const tally = (calls) => calls.reduce((counts, { name }) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map());
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
    parts.forEach((calls, k) => assert.ok(calls.length > 0, `${files[k]} registers no test of ${body}. Likely cause: the file sets a number above the part count of the splitTest call in ${body}, or that count is below its ${files.length} part files. Fix: give splitTest the count ${files.length}, and let part file k set k.`));
    const want = tally(all), got = tally(parts.flat());
    const nowhere = [...want.keys()].filter((name) => !got.has(name)), twice = [...got].filter(([name, n]) => n > (want.get(name) ?? 0)).map(([name]) => name);
    assert.deepEqual([
      ...(nowhere.length ? [`${nowhere.length} of its ${all.length} tests run in no part file, for example ${JSON.stringify(nowhere[0])}. Likely cause: the part count of the splitTest call in ${body} is above its ${files.length} part files, or a part file sets a wrong number. Fix: give splitTest the count ${files.length}, and let part file k set k.`] : []),
      ...(twice.length ? [`${twice.length} tests run in more than one part file, for example ${JSON.stringify(twice[0])}. Likely cause: ${body} calls node:test directly, or two part files set the same number. Fix: take test only from splitTest in ${body}, and let part file k set k.`] : []),
    ], [], `${body}: its ${files.length} part files must run each of its ${all.length} tests once`);
  }
});

test("npm test runs the part files of a split body, never the body itself, which would run all its tests a second time", () => {
  const { scripts } = JSON.parse(readFileSync(join(SCRIPTS, "..", "package.json"), "utf8"));
  const words = `${scripts.test} ${scripts["test:browser"]}`.split(/\s+/);
  assert.deepEqual(words.filter((word) => bodies.some((body) => word.endsWith(body))), []);
});

test("each CI shard runs the same number of part files of each split body, so that no shard runs two long parts while another runs none", () => {
  const { scripts } = JSON.parse(readFileSync(join(SCRIPTS, "..", "package.json"), "utf8"));
  const workflow = readFileSync(join(SCRIPTS, "..", ".github", "workflows", "check.yml"), "utf8");
  const shards = Number(workflow.match(/TEST_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)$/m)?.[1]);
  assert.deepEqual(workflow.match(/^ +shard: \[([\d, ]+)\]$/m)?.[1].split(", ").map(Number), Array.from({ length: shards }, (_, k) => k + 1), `the test matrix of check.yml runs shards 1 to ${shards}, the N of its TEST_SHARD`);
  const files = scripts.test.split(/\s+/).filter((word) => word.endsWith(".test.mjs")).sort();
  for (const body of bodies) {
    const part = new RegExp(`^scripts/${body.replace(/-tests\.mjs$/, "")}-\\d+\\.test\\.mjs$`), per = Array(shards).fill(0);
    files.forEach((file, k) => part.test(file) && per[k % shards]++);
    assert.ok(per.every((n) => n === per[0]), `${body}: node --test --test-shard sorts the test files and gives file k to shard (k mod ${shards}) + 1, so the ${shards} CI shards run ${per.join(", ")} of its part files. Fix: make its part count a multiple of ${shards}, the shard count in .github/workflows/check.yml.`);
  }
});

test("the shared selector gives node:test each test's name, options and function, also through test.skip, test.only and test.todo", () => {
  const body = join(scratch, "sample-tests.mjs");
  writeFileSync(body, [
    `import { splitTest } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "test-split.mjs")).href)};`,
    "const test = splitTest(2, undefined, { timeout: 5 });",
    "const fn = () => {};",
    'test("two arguments", fn);',
    'test("three arguments", { timeout: 9 }, fn);',
    'test.skip("skipped", fn);',
    'test.only("only", { timeout: 9 }, fn);',
    'test.todo("todo", fn);',
    'test.todo("todo with options", { timeout: 9 }, fn);',
  ].join("\n"));
  assert.deepEqual(registered(body), [
    { name: "two arguments", options: { timeout: 5 }, fn: true },
    { name: "three arguments", options: { timeout: 9 }, fn: true },
    { name: "skipped", options: { timeout: 5, skip: true }, fn: true },
    { name: "only", options: { timeout: 9, only: true }, fn: true },
    { name: "todo", options: { timeout: 5, todo: true }, fn: true },
    { name: "todo with options", options: { timeout: 9, todo: true }, fn: true },
  ]);
});
