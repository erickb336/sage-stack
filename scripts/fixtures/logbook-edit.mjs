import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function editTable(dir, name, edit) {
  const [head, ...lines] = readFileSync(join(dir, `${name}.tsv`), "utf8").split("\n").filter(Boolean), columns = head.split("\t");
  const rows = edit(lines.map(line => Object.fromEntries(line.split("\t").map((value, i) => [columns[i], value]))));
  writeFileSync(join(dir, `${name}.tsv`), [head, ...rows.map(row => columns.map(column => row[column] ?? "").join("\t"))].join("\n") + "\n");
}

export function addRecords(dir, records) {
  const file = join(dir, "observations.json"), kept = JSON.parse(readFileSync(file, "utf8"));
  kept.records.push(...records.map((record, i) => ({ id: `O${kept.records.length + i + 1}`, ...record })));
  writeFileSync(file, JSON.stringify(kept));
}
