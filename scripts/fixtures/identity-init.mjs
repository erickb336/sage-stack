import { parentPort, workerData } from "node:worker_threads";
import { sage } from "../../plugins/sage/skills/sage/sage.mjs";

process.env.SAGE_TEST_PIDS = "{}";
process.env.NODE_TEST_CONTEXT = "child";
parentPort.once("message", () => {
  try {
    parentPort.postMessage({ ok: true, result: sage(["init", "--project", workerData.project], workerData.env) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  } finally {
    parentPort.close();
  }
});
parentPort.postMessage("ready");
