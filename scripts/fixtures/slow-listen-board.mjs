// Loaded with --import into a board server (board --serve). The server holds its port for a while before it listens:
// the port is bound, so a second listener gets "address in use", but a connection is refused. This is how any
// listener looks between its bind and its listen, made long, as a board that starts slowly (T1271).
// BOARD_TEST_BOUND_FILE: the file that the server writes once it holds the port.
import { writeFileSync } from "node:fs";
import net from "node:net";

const HOLD_MS = 1500;
if (process.argv.includes("--serve")) {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (port, ...rest) {
    const { TCP, constants } = process.binding("tcp_wrap"), held = new TCP(constants.SERVER);
    if (held.bind("127.0.0.1", port) !== 0) throw new Error(`the slow board could not hold port ${port}`);
    writeFileSync(process.env.BOARD_TEST_BOUND_FILE, `${port}\n`);
    setTimeout(() => { held.close(); listen.call(this, port, ...rest); }, HOLD_MS);
    return this;
  };
}
