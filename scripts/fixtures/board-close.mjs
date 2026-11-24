import { quietBoard } from "./quiet-board.mjs";

const server = quietBoard({ sources: [{ id: "sample", path: process.argv[2] }], port: 0, app: null });
await server.start();
await server.ready();
await server.close();
process.stdout.write("closed\n");
