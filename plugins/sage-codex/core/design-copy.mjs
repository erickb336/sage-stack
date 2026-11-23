import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PAGE_MAX, pageType } from "./message.mjs";
import { pageFile, pageTaskFolder } from "./page-files.mjs";

export const DESIGN_GATE = "design";
export const DESIGN_OPTIONS = ["Approve", "Approve with your words", "New version"];
export const WORDS_MAX = 1000;
export const DESIGNS_FOLDER = "designs";
export const DESIGN_LIMITS = { files: 200, bytes: 30 * 1024 * 1024 };
export const MANIFEST = "manifest.json";
const WITH_WORDS = `${DESIGN_OPTIONS[1]}: `;
const LEFTOVER = /^\.G[1-9]\d*-[0-9a-f-]+\.tmp$/;

export const withWords = (words) => `${WITH_WORDS}${words}`;
export const designChoice = (answer) => (answer === DESIGN_OPTIONS[0] ? 0 : String(answer ?? "").startsWith(WITH_WORDS) ? 1 : answer === DESIGN_OPTIONS[2] ? 2 : -1);
export const designPathOk = (design) => typeof design === "string" && (pageType(design) !== null || pageType(`${design}/page.md`) !== null);

class NotCopied extends Error {}
const stop = (why) => { throw new NotCopied(why); };

function folderPages(folder, design) {
  const info = lstatSync(join(folder, design), { throwIfNoEntry: false });
  if (!info?.isDirectory()) stop(`${design} is not a page or a folder in the task's pages folder`);
  return readdirSync(join(folder, design), { recursive: true }).map((name) => `${design}/${name}`).filter(pageType).sort();
}

export function designFiles(logbook, task, design, env, read = false) {
  try {
    const folder = pageTaskFolder(logbook, task, env) ?? stop(`the pages folder of ${task} is gone, or its path has a link`);
    const names = pageType(design) ? [design] : folderPages(folder, design);
    if (!names.length) stop(`${design} holds no page`);
    if (names.length > DESIGN_LIMITS.files) stop(`${design} holds ${names.length} pages, over the limit of ${DESIGN_LIMITS.files}`);
    let bytes = 0;
    return { files: names.map((name) => {
      const page = pageFile(folder, name, read) ?? stop(`${name} is gone, is not a plain file, has a link in its path or is over ${PAGE_MAX / 1024 / 1024} MiB`);
      if ((bytes += page.size) > DESIGN_LIMITS.bytes) stop(`${design} is over the limit of ${DESIGN_LIMITS.bytes / 1024 / 1024} MiB`);
      return { path: name === design ? basename(name) : name.slice(design.length + 1), ...page };
    }) };
  } catch (error) {
    if (error instanceof NotCopied) return { problem: error.message };
    return { problem: `sage could not read it (${error?.code ?? error?.message ?? "an error"})` };
  }
}

export function copyDesign({ dir, task, gate, design, answer, at }, env) {
  const root = join(dir, DESIGNS_FOLDER), place = `${DESIGNS_FOLDER}/${task}/${gate}`;
  let temp;
  try {
    mkdirSync(join(root, task), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root)) if (LEFTOVER.test(name)) rmSync(join(root, name), { recursive: true, force: true });
    if (lstatSync(join(root, task, gate), { throwIfNoEntry: false })) return `copied already to ${place}`;
    const { files, problem } = designFiles(basename(dir), task, design, env, true);
    if (problem) return `not copied: ${problem}`;
    temp = join(root, `.${gate}-${randomUUID()}.tmp`);
    for (const file of files) {
      mkdirSync(dirname(join(temp, file.path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(temp, file.path), file.bytes, { mode: 0o600, flag: "wx" });
    }
    const manifest = { gate, task, design, answer, at, files: files.map(({ path, size, bytes }) => ({ path, size, sha256: createHash("sha256").update(bytes).digest("hex") })) };
    writeFileSync(join(temp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, join(root, task, gate));
    return `copied ${files.length === 1 ? "1 page" : `${files.length} pages`} to ${place}`;
  } catch (error) {
    try { if (temp) rmSync(temp, { recursive: true, force: true }); } catch {}
    return `not copied: the copy failed (${error?.code ?? error?.message ?? "an error"})`;
  }
}
