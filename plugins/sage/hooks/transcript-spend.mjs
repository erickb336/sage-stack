import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PRICE_WEIGHTS = { input: 1, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.05, output: 5 };
const n = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

export function transcriptSpend(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) return undefined;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const calls = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const usage = record?.type === "assistant" && record.message?.usage;
    if (usage && typeof usage === "object") calls.set(record.requestId ?? record.message.id ?? record.uuid ?? calls.size, usage);
  }
  if (!calls.size) return undefined;
  const spend = { input: 0, cache_write: 0, cache_read: 0, output: 0, weighted: 0 };
  let weighted = 0;
  for (const usage of calls.values()) {
    const write = n(usage.cache_creation_input_tokens), hour = Math.min(write, n(usage.cache_creation?.ephemeral_1h_input_tokens));
    spend.input += n(usage.input_tokens);
    spend.cache_write += write;
    spend.cache_read += n(usage.cache_read_input_tokens);
    spend.output += n(usage.output_tokens);
    weighted += n(usage.input_tokens) * PRICE_WEIGHTS.input + (write - hour) * PRICE_WEIGHTS.cache_write_5m + hour * PRICE_WEIGHTS.cache_write_1h
      + n(usage.cache_read_input_tokens) * PRICE_WEIGHTS.cache_read + n(usage.output_tokens) * PRICE_WEIGHTS.output;
  }
  spend.weighted = Math.round(weighted);
  return spend;
}
