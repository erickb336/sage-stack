import { writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const HOLD_ANSWERS_LONGER_THAN_THE_2_S_PROBE_MS = 2500;
if (process.argv.includes("--serve")) {
  const createServer = http.createServer;
  http.createServer = (options, handler) => {
    let answersFrom = Infinity;
    const held = (request, response) => setTimeout(() => handler(request, response), Math.max(0, answersFrom - Date.now()));
    const server = createServer(options, held);
    server.once("listening", () => { answersFrom = Date.now() + HOLD_ANSWERS_LONGER_THAN_THE_2_S_PROBE_MS; writeFileSync(process.env.BOARD_TEST_BOUND_FILE, `${server.address().port}\n`); });
    return server;
  };
  syncBuiltinESMExports();
}
