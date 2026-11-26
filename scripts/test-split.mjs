import { test as nodeTest } from "node:test";

export function splitTest(parts, part, defaults = {}) {
  let count = 0;
  const test = (name, options, fn) => {
    if (typeof options === "function") [options, fn] = [{}, options];
    if (part !== undefined && count++ % parts !== part - 1) return undefined;
    return nodeTest(name, { ...defaults, ...options }, fn);
  };
  const flagged = (flag) => (name, options, fn) => (typeof options === "function" ? test(name, { [flag]: true }, options) : test(name, { ...options, [flag]: true }, fn));
  return Object.assign(test, { skip: flagged("skip"), only: flagged("only"), todo: flagged("todo") });
}
