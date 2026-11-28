import { writeFileSync } from "node:fs";
import net from "node:net";

const HOLD_THE_PORT_BOUND_BEFORE_LISTENING_MS = 1500;
if (process.argv.includes("--serve")) {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (port, ...rest) {
    const { TCP, constants } = process.binding("tcp_wrap"), held = new TCP(constants.SERVER);
    if (held.bind("127.0.0.1", port) !== 0) throw new Error(`the slow board could not hold port ${port}`);
    writeFileSync(process.env.BOARD_TEST_BOUND_FILE, `${port}\n`);
    setTimeout(() => { held.close(); listen.call(this, port, ...rest); }, HOLD_THE_PORT_BOUND_BEFORE_LISTENING_MS);
    return this;
  };
}
