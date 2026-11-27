import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const calls = (globalThis.TEST_LIST_CALLS ??= []);
const record = (...args) => {
  calls.push({ name: args[0], options: args.length > 2 ? args[1] : undefined, fn: typeof args.at(-1) === "function" });
};
export const test = Object.assign(record, { skip: record, only: record, todo: record });
export default test;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, out] = process.argv.slice(2);
  registerHooks({ resolve: (specifier, context, next) => (specifier === "node:test" ? { url: `${import.meta.url}?recorder`, shortCircuit: true } : next(specifier, context)) });
  await import(pathToFileURL(resolve(file)).href);
  writeFileSync(out, JSON.stringify(calls));
  process.exit(0);
}
