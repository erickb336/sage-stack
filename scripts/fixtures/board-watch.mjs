import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function untilTheWatchersReportAWrite(port, folder, guard = 30_000) {
  const controller = new AbortController(), write = () => writeFileSync(join(folder, "watch-probe.txt"), "sample\n");
  const timer = setTimeout(() => controller.abort(new Error("the board's watchers reported no write")), guard);
  let again, first;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/app/events`, { signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the board's stream ended before its watchers reported a write");
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const lines = buffer.slice(0, end).split("\n"); buffer = buffer.slice(end + 2);
        if (!lines.includes("event: model")) continue;
        const { at } = JSON.parse(lines.find(line => line.startsWith("data: ")).slice("data: ".length));
        if (first === undefined) { first = at; write(); again = setInterval(write, 200); }
        else if (at !== first) return;
      }
    }
  } finally { clearTimeout(timer); clearInterval(again); controller.abort(); }
}
