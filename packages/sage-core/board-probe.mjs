import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, workerData } from "node:worker_threads";

export const boardFolder = (env = process.env) => join(env.HOME || homedir(), ".config", "sage-board");
export const PORT_FILE = "board.port";
export const BOARD_CONFIG = "board.json";
export function servedPort(env = process.env) {
  let fd;
  try {
    fd = openSync(join(boardFolder(env), PORT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = Buffer.alloc(8), port = Number(/^([1-9]\d{3,4})\n?$/.exec(bytes.subarray(0, fstatSync(fd).isFile() ? readSync(fd, bytes, 0, 8, 0) : 0).toString("ascii"))?.[1]);
    return port >= 1024 && port <= 65535 ? port : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export const probeBoard = ({ port }, timeout = 2000) => new Promise(done => {
  const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD", agent: false, timeout, headers: { Host: `127.0.0.1:${port}` } }, response => {
    response.resume();
    const { "content-type": type = "", "content-security-policy": policy = "", "cross-origin-resource-policy": resource, "x-sage-board": named = "" } = response.headers;
    const boardHeaders = policy.startsWith("default-src 'none'") && resource === "same-origin";
    const own = /^id=([a-f0-9]{16,64}); pid=([1-9]\d{0,9}); started=(\d{1,16})$/.exec(named);
    if (boardHeaders && response.statusCode === 200 && type.startsWith("text/html")) done(own ? { kind: "board", id: own[1], pid: Number(own[2]), started: Number(own[3]) } : { kind: "older" });
    else done({ kind: "other" });
  });
  req.once("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  req.once("error", error => done({ kind: { ECONNREFUSED: "none", TIMEOUT: "timeout", EPERM: "blocked" }[error.code] ?? "other" }));
  req.end();
});

export const configId = configPath => createHash("sha256").update(`sage-board-config:${realpathSync(configPath)}`).digest("hex").slice(0, 16);

export function boardAnswers(env = process.env, timeout = 1000) {
  const port = servedPort(env);
  let id;
  try { id = configId(join(boardFolder(env), BOARD_CONFIG)); } catch { return false; }
  if (!port) return false;
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), { workerData: { probe: { port, id, timeout, flag } } });
  worker.unref();
  Atomics.wait(flag, 0, 0, timeout + 1000);
  worker.terminate();
  return Atomics.load(flag, 0) === 1;
}

const boardCli = () => ["../board/cli.mjs", "../sage-board/cli.mjs"].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(path));

export function boardDownLine() {
  const cli = boardCli();
  const ensure = cli ? `node ${/\s/.test(cli) ? `"${cli}"` : cli} board --ensure` : "board --ensure";
  return `The board does not answer now; open the file, or start the board with \`${ensure}\`.`;
}

const LOCAL_LINK = /http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:[/?#][^\s<>"'`()[\]{}|\\^]*)?/gi;
export async function boardLinkStop(input, { budgetMs, env = process.env } = {}) {
  if (input?.hook_event_name !== "Stop" || "agent_id" in input || input.stop_hook_active === true || typeof input.last_assistant_message !== "string") return undefined;
  const links = (input.last_assistant_message.match(LOCAL_LINK) ?? []).map(link => link.replace(/[.,;:!?*_~]+$/, ""));
  if (!links.length) return undefined;
  try {
    const { checkBoardLinks } = await import(pathToFileURL(boardCli()).href);
    const reason = await checkBoardLinks(links, { env, budgetMs });
    return reason ? { decision: "block", reason } : undefined;
  } catch { return undefined; }
}

if (!isMainThread && workerData?.probe) {
  const { port, id, timeout, flag } = workerData.probe;
  probeBoard({ port }, timeout).then(found => { Atomics.store(flag, 0, found.kind === "board" && found.id === id ? 1 : 2); Atomics.notify(flag, 0); });
}
