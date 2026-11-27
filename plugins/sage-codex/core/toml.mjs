const BARE = /^[A-Za-z0-9_-]+/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|inf|nan)/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/;

export function parseToml(text) {
  let i = 0, line = 1;
  const fail = (why) => { throw new Error(`TOML line ${line}: ${why}`); };
  const peek = (s) => text.startsWith(s, i);
  const space = () => { while (text[i] === " " || text[i] === "\t") i++; };
  const comment = () => { if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++; };
  const newline = () => {
    if (peek("\r\n")) i += 2; else if (text[i] === "\n") i++; else return false;
    line++;
    return true;
  };
  const gap = () => { for (;;) { space(); comment(); if (!newline()) return; } };
  const escape = () => {
    const c = text[i++];
    if (c in ESCAPES) return ESCAPES[c];
    const size = c === "u" ? 4 : c === "U" ? 8 : fail(`unknown escape \\${c}`);
    const hex = text.slice(i, i + size);
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== size) fail("bad unicode escape");
    i += size;
    return String.fromCodePoint(parseInt(hex, 16));
  };
  const string = () => {
    const quote = text[i], many = peek(quote.repeat(3));
    i += many ? 3 : 1;
    if (many) newline();
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      if (many && peek(quote.repeat(3))) {
        i += 3;
        for (let n = 0; n < 2 && text[i] === quote; n++) out += text[i++];
        return out;
      }
      if (!many && text[i] === quote) { i++; return out; }
      if (text[i] === "\n" || peek("\r\n")) { if (!many) fail("line break in a string"); out += text[i] === "\r" ? "\r\n" : "\n"; newline(); continue; }
      if (quote === '"' && text[i] === "\\") {
        i++;
        if (many && /^[ \t]*\r?\n/.test(text.slice(i))) { space(); while (newline() || text[i] === " " || text[i] === "\t") space(); continue; }
        out += escape();
        continue;
      }
      out += text[i++];
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      space();
      if (text[i] === '"' || text[i] === "'") { if (peek('"""') || peek("'''")) fail("a key cannot be a multi-line string"); parts.push(string()); }
      else { const bare = BARE.exec(text.slice(i)) ?? fail("expected a key"); parts.push(bare[0]); i += bare[0].length; }
      space();
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const value = () => {
    space();
    const c = text[i];
    if (c === '"' || c === "'") return string();
    if (c === "[") {
      i++;
      const out = [];
      for (;;) {
        gap();
        if (text[i] === "]") { i++; return out; }
        out.push(value());
        gap();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        fail("expected , or ] in an array");
      }
    }
    if (c === "{") {
      i++;
      const out = {};
      space();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        const path = key();
        if (text[i++] !== "=") fail("expected = in an inline table");
        put(out, path, value());
        space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        fail("expected , or } in an inline table");
      }
    }
    for (const [word, v] of [["true", true], ["false", false]]) if (peek(word) && !/[\w-]/.test(text[i + word.length] ?? "")) { i += word.length; return v; }
    const date = DATE.exec(text.slice(i));
    if (date) { i += date[0].length; return date[0]; }
    const number = NUMBER.exec(text.slice(i)) ?? fail("expected a value");
    i += number[0].length;
    const n = number[0].replaceAll("_", "");
    return /^[+-]?0[xob]/.test(n) ? Number(n.replace(/^[+-]/, "")) * (n.startsWith("-") ? -1 : 1) : /inf$/.test(n) ? (n.startsWith("-") ? -Infinity : Infinity) : /nan$/.test(n) ? NaN : Number(n);
  };
  const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const put = (table, path, v) => {
    let at = table;
    for (const part of path.slice(0, -1)) {
      if (!Object.hasOwn(at, part)) at[part] = {};
      if (!isTable(at[part])) fail(`${path.join(".")} is given twice`);
      at = at[part];
    }
    if (Object.hasOwn(at, path.at(-1))) fail(`${path.join(".")} is given twice`);
    at[path.at(-1)] = v;
  };
  const root = {}, headers = new Set();
  let current = root;
  for (;;) {
    gap();
    if (i >= text.length) return root;
    if (text[i] === "[") {
      const many = peek("[[");
      i += many ? 2 : 1;
      const path = key();
      if (!peek(many ? "]]" : "]")) fail("expected ] after a table name");
      i += many ? 2 : 1;
      let at = root;
      for (const part of path.slice(0, -1)) {
        if (!Object.hasOwn(at, part)) at[part] = {};
        at = Array.isArray(at[part]) ? at[part].at(-1) : at[part];
        if (!isTable(at)) fail(`${path.join(".")} is not a table`);
      }
      const last = path.at(-1);
      if (many) {
        if (!Object.hasOwn(at, last)) at[last] = [];
        if (!Array.isArray(at[last])) fail(`${path.join(".")} is not an array of tables`);
        at[last].push(current = {});
      } else {
        const name = JSON.stringify(path);
        if (headers.has(name)) fail(`[${path.join(".")}] is given twice`);
        headers.add(name);
        if (!Object.hasOwn(at, last)) at[last] = {};
        if (!isTable(at[last])) fail(`${path.join(".")} is not a table`);
        current = at[last];
      }
    } else {
      const path = key();
      if (text[i++] !== "=") fail("expected = after a key");
      put(current, path, value());
    }
    space();
    comment();
    if (i < text.length && !newline()) fail("expected the end of the line");
  }
}
