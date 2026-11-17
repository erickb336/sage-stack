import { closeSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIRST_PORT_THAT_NO_SYSTEM_PICKS = 20000, LAST_PORT_BELOW_LINUX_AND_MACOS_PICKS = 32767;
const locksOfThisProcess = new Set();
process.once("exit", () => { for (const lock of locksOfThisProcess) rmSync(lock, { force: true }); });

const anotherProgramHolds = port => new Promise(done => {
  const server = createServer();
  server.once("error", () => done(true));
  server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
});

export async function boardCommandPort() {
  const count = LAST_PORT_BELOW_LINUX_AND_MACOS_PICKS - FIRST_PORT_THAT_NO_SYSTEM_PICKS + 1;
  for (let tries = 0; tries < 500; tries++) {
    const port = FIRST_PORT_THAT_NO_SYSTEM_PICKS + Math.floor(Math.random() * count), lock = join(tmpdir(), `sage-board-test-port-${port}.lock`);
    try { closeSync(openSync(lock, "wx")); } catch (error) { if (error.code === "EEXIST") continue; throw error; }
    locksOfThisProcess.add(lock);
    if (!await anotherProgramHolds(port)) return port;
  }
  throw new Error(`no board test port from ${FIRST_PORT_THAT_NO_SYSTEM_PICKS} to ${LAST_PORT_BELOW_LINUX_AND_MACOS_PICKS} is free: each one has a lock file in ${tmpdir()} or another program holds it`);
}
