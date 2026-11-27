import { existsSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, workerData } from "node:worker_threads";

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

export function boardAnswers(port, timeout = 1000) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), { workerData: { probe: { port, timeout, flag } } });
  worker.unref();
  Atomics.wait(flag, 0, 0, timeout + 1000);
  worker.terminate();
  return Atomics.load(flag, 0) === 1;
}

export function boardDownLine() {
  const cli = ["../board/cli.mjs", "../sage-board/cli.mjs"].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(path));
  const ensure = cli ? `node ${/\s/.test(cli) ? `"${cli}"` : cli} board --ensure` : "board --ensure";
  return `The board does not answer now; open the file, or start the board with \`${ensure}\`.`;
}

if (!isMainThread && workerData?.probe) {
  const { port, timeout, flag } = workerData.probe;
  probeBoard({ port }, timeout).then(found => { Atomics.store(flag, 0, ["board", "older"].includes(found.kind) ? 1 : 2); Atomics.notify(flag, 0); });
}
