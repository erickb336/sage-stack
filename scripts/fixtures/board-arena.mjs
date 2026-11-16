import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ARENA_NOW = "2026-11-16T12:00:00.000Z";
export const ARENA_KEY = "shared/sample-arena-abc123/T1";

export function writeArenaFixture(root) {
  const logbook = join(root, "logbooks", "sample-arena-abc123"), worktrees = join(root, "worktrees");
  const pages = join(worktrees, "sample-arena-abc123", "pages", "T1");
  mkdirSync(logbook, { recursive: true });
  const tables = {
    tasks: ["id title size risk route state branch pr round keys", ["T1", "SAMPLE DATA: fictional arena", "small", "", "build", "building", "sample/final", "", "0", ""]],
    runs: ["id task role round candidate branch status tokens report started ended",
      ...[["R1", "A", "done"], ["R2", "B", "done"], ["R3", "C", "failed"], ["R4", "", "done"]].map(([id, candidate, status]) =>
        [id, "T1", id === "R4" ? "arena-judge" : "designer", "0", candidate, `sample/${id}`, status, "", "", ARENA_NOW, ARENA_NOW])],
    findings: ["task key round source severity summary triage reason status"],
    ledger: ["task pr sha kind cycle run at"],
    gates: ["id task question options recommendation default answer at"],
    decisions: ["at task decision why"],
  };
  for (const [name, [header, ...rows]] of Object.entries(tables)) writeFileSync(join(logbook, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n${rows.map(row => row.join("\t") + "\n").join("")}`);
  const version = (name, meta) => {
    const dir = join(pages, "designs", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "version.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "index.html"), `<!doctype html><title>SAMPLE DATA</title><p>Fictional prototype ${name}</p>`);
  };
  version("A", { candidate: "A", run: "R1", title: "SAMPLE: list first", strong: "Visible notes", weak: "Long lists" });
  version("B", { candidate: "B", run: "R2", title: "SAMPLE: search first", strong: "Quick search", weak: "Empty start" });
  version("final", { run: "R4", final: { base: "A", why: "Fictional recommendation", grafted: ["B"], grafts: ["From B: clear search"], unused: ["C: no artifact"], scores: { rubric: ["Find a note", "Recover", "Extend"], max: 4, candidates: { A: [4, 3, 4], B: [3, 4, 3] } } } });
  return { logbook, pages, worktrees, sources: [{ id: "shared", path: join(root, "logbooks") }] };
}
