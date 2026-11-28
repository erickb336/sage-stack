import { appendFileSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_PORT = 43123;
export const GUARD = `--import=${JSON.stringify(fileURLToPath(import.meta.url))}`;
export const LOG = "SAGE_TEST_OWNER_PORT_LOG";
export const withGuard = (options = "") => (options.includes(GUARD) ? options : `${options} ${GUARD}`.trim());

const guarded = new Set([OWNER_PORT, ...String(process.env.SAGE_TEST_GUARDED_PORTS ?? "").split(",").filter(Boolean).map(Number)]);
const portOf = (value) => (value !== null && typeof value === "object" ? (typeof value.path === "string" ? undefined : value.port) : value);
const isGuarded = (value) => guarded.has(Number(portOf(Array.isArray(value) ? value[0] : value)));
const refused = (what, args) => {
  const port = Number(portOf(Array.isArray(args[0]) ? args[0][0] : args[0]));
  try { appendFileSync(process.env[LOG], `- process ${process.pid} ${what} port ${port}: ${process.argv.slice(1).join(" ")}\n`); } catch {}
  return Object.assign(new Error(`a test ${what} port ${port}, the owner's board (T1218): give the test a free port from scripts/fixtures/board-port.mjs`), { code: "ESAGEOWNERPORT" });
};

if (!process.env[LOG]) {
  const own = join(tmpdir(), `sage-test-owner-port-${process.pid}.log`);
  process.env[LOG] = own;
  process.on("exit", () => {
    let text = "";
    try { text = readFileSync(own, "utf8"); } catch {}
    rmSync(own, { force: true });
    if (!text) return;
    process.stderr.write(`A test reached the owner's board port ${OWNER_PORT} (T1218). Nothing connected: the guard refused each try. Give each test a free board port:\n${text}`);
    process.exitCode = 1;
  });
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!isGuarded(args[0])) return connect.apply(this, args);
  const error = refused("connects to", args);
  process.nextTick(() => this.destroy(error));
  return this;
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (!isGuarded(args[0])) return listen.apply(this, args);
  const error = refused("listens on", args);
  process.nextTick(() => this.emit("error", error));
  return this;
};
