import { lstatSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBoardServer } from "../../packages/sage-board/server.mjs";

const AGAIN = 200, GUARD = 30_000;
const folder = path => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? path : null;

export function quietBoard(options, { probe = folder(options.sources[0].path) ?? folder(dirname(options.sources[0].path)), create = createBoardServer } = {}) {
  let heard = null, readied = null;
  const board = create({ ...options, settleReads: [], onWatch: (path, name) => heard?.(path, name) });
  const untilTheWatchersReportTheLastProbe = () => !probe ? undefined : new Promise((accept, reject) => {
    let count = 0, latest, unheard = true;
    const write = () => { latest = `watch-probe-${++count}.txt`; writeFileSync(join(probe, latest), "sample\n"); };
    const end = error => { heard = null; clearInterval(again); clearTimeout(guard); if (error) reject(error); else accept(); };
    const again = setInterval(() => { if (unheard) write(); unheard = true; }, AGAIN);
    const guard = setTimeout(() => end(new Error(`the board's watchers reported no probe file in ${probe}`)), GUARD);
    heard = (path, name) => { if (path !== probe || !name?.startsWith("watch-probe-")) return; unheard = false; if (name === latest) end(); };
    write();
  });
  return Object.freeze({ ...board, ready: () => readied ??= board.ready().then(untilTheWatchersReportTheLastProbe).then(() => board.idle()) });
}
