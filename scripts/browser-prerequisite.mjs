import { spawn as spawnChild } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PIN = "1.55.1";
const fail = text => { throw new Error(`Browser prerequisite: ${text}. Run node scripts/browser-prerequisite.mjs setup explicitly; tests never install a browser.`); };

export function loadPinnedBrowser() {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const playwright = require("playwright/package.json"), core = require("playwright-core/package.json");
  const metadata = { pin: manifest.devDependencies.playwright, version: playwright.version, coreVersion: core.version, coreDependency: playwright.dependencies["playwright-core"] };
  checkVersions(metadata);
  const { registry, browserDirectoryToMarkerFilePath } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/server/registry/index.js"));
  const expected = registry.findExecutable("chromium-headless-shell");
  return { ...metadata, directory: expected.directory, executable: expected.executablePath(), marker: browserDirectoryToMarkerFilePath(expected.directory),
    cli: join(dirname(require.resolve("playwright/package.json")), "cli.js"), chromium: require("playwright").chromium };
}

function checkVersions(data) {
  if ([data.pin, data.version, data.coreVersion, data.coreDependency].some(version => version !== PIN)) fail(`the project, playwright and playwright-core must agree on pinned ${PIN}; run npm ci --ignore-scripts`);
}

function checkBrowser(data, env) {
  checkVersions(data);
  if (env.BOARD_BROWSER_PATH) fail("BOARD_BROWSER_PATH is not supported by browser tests; use the pinned Playwright headless shell");
  try { if (!statSync(data.marker).isFile()) throw new Error(); } catch { fail(`completion marker missing at ${data.marker}`); }
  try {
    if (!statSync(data.executable).isFile()) throw new Error();
    accessSync(data.executable, constants.X_OK);
  } catch { fail(`executable missing or not executable at ${data.executable}`); }
}

export function requireBrowser({ load = loadPinnedBrowser, env = process.env } = {}) {
  const data = load();
  checkBrowser(data, env);
  return { launch: async () => { checkBrowser(data, env); return data.chromium.launch({ headless: true, env }); } };
}

export function setupBrowser({ load = loadPinnedBrowser, env = process.env, spawn = spawnChild, timers = { setTimeout, clearTimeout },
  deadlineMs = 600_000, cleanupMs = 10_000, withDeps = false, output = (stream, text) => process[stream].write(text) } = {}) {
  const data = load();
  checkVersions(data);
  if (env.BOARD_BROWSER_PATH) fail("BOARD_BROWSER_PATH is not supported by browser setup");
  return new Promise(resolveResult => {
    const result = { status: null, exit: null, close: null, error: null, termination: { requested: false, accepted: false, error: null }, cleanup: "unknown", descendants: "unknown", stdout: "", stderr: "" };
    let child, deadline, cleanup, settled = false, spawned = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(deadline); timers.clearTimeout(cleanup);
      if (result.cleanup === "unknown") {
        child?.unref?.(); child?.stdout?.unref?.(); child?.stderr?.unref?.();
      }
      resolveResult({ ...result, termination: { ...result.termination } });
    };
    try {
      child = spawn(process.execPath, [data.cli, "install", ...withDeps ? ["--with-deps"] : [], "--only-shell", "chromium"], {
        env: { ...env, DO_NOT_TRACK: "1", DEBUG: [env.DEBUG, "pw:install"].filter(Boolean).join(",") }, stdio: ["ignore", "pipe", "pipe"], shell: false,
      });
    } catch (error) {
      result.status = "spawn-error"; result.error = String(error); result.cleanup = "not-started"; finish(); return;
    }
    for (const stream of ["stdout", "stderr"]) child[stream]?.on("data", chunk => { const text = chunk.toString(); result[stream] += text; output(stream, text); });
    child.once("spawn", () => { spawned = true; });
    child.on("error", error => { result.error = String(error); if (!result.status) result.status = spawned ? "failed" : "spawn-error"; });
    child.once("exit", (code, signal) => { result.exit = { code, signal }; });
    child.once("close", (code, signal) => {
      result.close = { code, signal }; result.cleanup = "closed";
      if (!result.status) {
        result.status = code === 0 && signal === null ? "complete" : "failed";
        if (result.status === "complete") try { checkBrowser(data, env); } catch (error) { result.status = "incomplete"; result.error = String(error); }
      }
      finish();
    });
    deadline = timers.setTimeout(() => {
      if (!result.status) result.status = "deadline";
      cleanup = timers.setTimeout(finish, cleanupMs);
      if (!result.exit && child.exitCode == null && child.signalCode == null && spawned) {
        result.termination.requested = true;
        try { result.termination.accepted = child.kill("SIGTERM"); } catch (error) { result.termination.error = String(error); }
      }
    }, deadlineMs);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "setup" && (args.length === 0 || args.join() === "--with-deps")) {
      const result = await setupBrowser({ withDeps: args.includes("--with-deps") });
      const { stdout, stderr, ...evidence } = result;
      console.log(`Browser setup: ${JSON.stringify(evidence)}`);
      if (result.status !== "complete") process.exitCode = 1;
      else console.log("Pinned installation files are complete. Browser startup and close remain to be checked by the browser tests.");
    } else if (command === "check" && args.length === 0) {
      requireBrowser();
      console.log("Pinned browser prerequisite passed. This checked files, not browser startup.");
    } else throw new Error("Use browser-prerequisite.mjs check or setup [--with-deps].");
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
