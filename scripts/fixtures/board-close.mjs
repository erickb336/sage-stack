import { createBoardServer } from "../../packages/sage-board/server.mjs";

const server = createBoardServer({ sources: [{ id: "sample", path: process.argv[2] }], port: 0, app: null, settleReads: [] });
await server.start();
await server.ready();
await server.close();
process.stdout.write("closed\n");
