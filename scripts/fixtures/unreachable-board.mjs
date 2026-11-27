import { EventEmitter } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

if (process.argv.includes("--ensure")) {
  http.request = () => {
    const req = new EventEmitter();
    req.end = () => setTimeout(() => req.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1 (test: this shell cannot reach it)"), { code: "ECONNREFUSED" })), 5);
    req.destroy = () => req;
    return req;
  };
  syncBuiltinESMExports();
}
