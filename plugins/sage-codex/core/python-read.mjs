const words = (text) => new Set(text.trim().split(/\s+/));
const MODULES = words("json csv sys re os os.path pathlib glob collections itertools math statistics datetime time textwrap pprint string hashlib base64");
const ATTRS = words(`
  load loads dumps JSONDecodeError reader DictReader
  argv stdin stdout stderr flush read readline readlines close exit version platform executable maxsize
  search match fullmatch findall finditer sub subn split compile escape group groups groupdict start end span pattern IGNORECASE MULTILINE DOTALL VERBOSE I M S X
  path environ getenv listdir scandir walk stat lstat getcwd sep linesep pathsep getpid cpu_count name is_file is_dir is_symlink st_size st_mtime st_mode
  join exists isfile isdir islink isabs basename dirname abspath realpath relpath normpath expanduser getsize getmtime splitext commonpath
  Path PurePath read_text read_bytes iterdir glob iglob rglob resolve stem suffix suffixes parent parents parts home cwd absolute relative_to as_posix joinpath with_suffix with_name
  keys values items get rsplit splitlines strip lstrip rstrip startswith endswith lower upper casefold title capitalize find rfind index rindex count format
  encode decode isdigit isalpha isalnum isspace ljust rjust center zfill partition rpartition append extend insert sort setdefault update pop most_common elements total
  Counter defaultdict OrderedDict deque chain from_iterable islice groupby product combinations permutations zip_longest accumulate
  floor ceil sqrt log log10 log2 exp pi e inf isnan fsum prod mean median mode stdev pstdev quantiles
  datetime date timedelta timezone utc now today fromtimestamp fromisoformat isoformat strftime strptime timestamp total_seconds days seconds year month day hour minute second
  time localtime gmtime monotonic perf_counter sleep sha256 sha1 md5 hexdigest digest b64decode b64encode urlsafe_b64decode urlsafe_b64encode
  dedent indent fill shorten wrap pprint pformat ascii_letters digits punctuation`);
const BUILTINS = words(`abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits
  delattr dict dir divmod enumerate eval exec exit filter float format frozendict frozenset getattr globals hasattr hash help hex id input int
  isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range repr reversed
  round sentinel set setattr slice sorted staticmethod str sum super tuple type vars zip`);
const SAFE = words(`abs all any ascii bin bool bytearray bytes callable chr complex dict divmod enumerate filter float frozendict frozenset hash hex id int
  isinstance iter len list map max min next oct open ord pow print range repr reversed round set slice sorted str sum tuple zip`);
const STRING_CALLS = words("read read_text readline decode strip lstrip rstrip lower upper casefold title capitalize replace join format dumps");
const OPEN_KEYS = words("file mode encoding errors newline buffering closefd");
const PY_FLAGS = /^-[BEIOqsSu]+$/, PY_CODE = /^-[BEIOqsSu]*c$/;
const OP = /^(?:\*\*=?|\/\/=?|<<=?|>>=?|->|:=|\.\.\.|[-+*/%&|^@<>=!]=|[()[\]{},:;.@=+\-*/%&|^~<>!])/;
const STRING = /^([rRbBuUfF]{0,2})('''|"""|'|")/;
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d[\d_]*)?[jJ]?)/;

export function pythonRead(name, args) {
  if (!/^python[\d.]*$/.test(name)) return false;
  const at = args.findIndex((arg) => !PY_FLAGS.test(arg)), code = args[at + 1];
  if (at < 0 || !PY_CODE.test(args[at]) || typeof code !== "string" || /[$`]/.test(code)) return false;
  const list = tokens(code);
  return list !== undefined && reads(list);
}

function tokens(code) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < code.length;) {
    const rest = code.slice(i), c = code[i];
    if (c === "\\" && code[i + 1] === "\n") { i += 2; continue; }
    if ((c === "\n" && !depth) || c === ";") { out.push({ op: ";" }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { while (i < code.length && code[i] !== "\n") i++; continue; }
    const quote = STRING.exec(rest);
    if (quote) {
      const end = quote[2];
      let j = i + quote[0].length;
      for (; !code.startsWith(end, j); j += code[j] === "\\" ? 2 : 1) if (j >= code.length || (end.length === 1 && code[j] === "\n")) return undefined;
      const body = code.slice(i + quote[0].length, j), f = /f/i.test(quote[1]);
      out.push({ string: body, f });
      if (f) {
        const fields = fieldsOf(body);
        if (!fields) return undefined;
        for (const field of fields) {
          const inner = tokens(field);
          if (!inner) return undefined;
          out.push({ op: "(" }, ...inner.filter((t) => t.op !== ";"), { op: ")", field: true });
        }
      }
      i = j + end.length;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(rest) ?? NUMBER.exec(rest);
    if (word) { out.push(/^[A-Za-z_]/.test(word[0]) ? { name: word[0] } : { number: word[0] }); i += word[0].length; continue; }
    const op = OP.exec(rest);
    if (!op) return undefined;
    out.push({ op: op[0] });
    depth += "([{".includes(op[0]) ? 1 : ")]}".includes(op[0]) ? -1 : 0;
    i += op[0].length;
  }
  return out;
}

function fieldsOf(body) {
  const fields = [];
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("{{", i)) { i++; continue; }
    if (body[i] !== "{") continue;
    let depth = 1, j = i + 1, quote;
    for (; j < body.length && depth; j++) {
      const c = body[j];
      if (quote) { if (c === quote) quote = undefined; }
      else if (c === "'" || c === '"') quote = c;
      else if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
    }
    if (depth) return undefined;
    fields.push(body.slice(i + 1, j - 1));
    i = j - 1;
  }
  return fields;
}

function reads(list) {
  for (let i = 0; i < list.length; i++) {
    const { name } = list[i], prev = list[i - 1];
    if (name === undefined) continue;
    const start = !prev || prev.op === ";" || prev.op === ":";
    if (name === "import" || (name === "from" && start)) {
      const end = start ? importEnd(list, i) : -1;
      if (end < 0) return false;
      i = end;
      continue;
    }
    if (name.startsWith("__")) return false;
    const attribute = prev?.op === ".", args = list[i + 1]?.op === "(" ? argsOf(list, i + 1) : undefined;
    if (name === "open") { if (!args || !openReads(args, attribute)) return false; continue; }
    if (attribute && name === "write") { if (!/^std(?:out|err)$/.test((list[i - 2]?.name === "buffer" ? list[i - 4] : list[i - 2])?.name ?? "")) return false; continue; }
    if (attribute && name === "replace") { if (!args || !stringBefore(list, i - 2)) return false; continue; }
    if (attribute ? !ATTRS.has(name) : BUILTINS.has(name) && !SAFE.has(name)) return false;
  }
  return true;
}

function stringBefore(list, k) {
  while (list[k]?.field) k = opening(list, k) - 1;
  if (list[k]?.string !== undefined) return true;
  const call = list[k]?.op === ")" ? opening(list, k) - 1 : -1, name = list[call]?.name ?? "";
  return list[call - 1]?.op === "." ? STRING_CALLS.has(name) : name === "str";
}

function opening(list, k) {
  for (let depth = 0; k >= 0; k--) {
    const op = list[k].op ?? "";
    if (op && ")]}".includes(op)) depth++;
    else if (op && "([{".includes(op) && --depth === 0) return k;
  }
  return -1;
}

function importEnd(list, i) {
  const dotted = (k) => {
    const parts = [];
    for (; list[k]?.name; k += 2) { parts.push(list[k].name); if (list[k + 1]?.op !== ".") return { module: parts.join("."), next: k + 1 }; }
    return { next: -1 };
  };
  const alias = (k) => (list[k]?.name === "as" ? (list[k + 1]?.name && !list[k + 1].name.startsWith("__") ? k + 2 : -1) : k);
  const ends = (k) => k >= list.length || list[k].op === ";";
  let k = i + 1;
  if (list[i].name === "import") {
    for (;;) {
      const { module, next } = dotted(k);
      if (next < 0 || !MODULES.has(module) || (k = alias(next)) < 0) return -1;
      if (ends(k)) return k - 1;
      if (list[k].op !== ",") return -1;
      k++;
    }
  }
  const { module, next } = dotted(k);
  if (next < 0 || !MODULES.has(module) || list[next]?.name !== "import") return -1;
  k = next + 1;
  const open = list[k]?.op === "(";
  if (open) k++;
  for (;;) {
    if (!ATTRS.has(list[k]?.name ?? "") || (k = alias(k + 1)) < 0) return -1;
    if (open && list[k]?.op === ")") return ends(k + 1) ? k : -1;
    if (!open && ends(k)) return k - 1;
    if (list[k]?.op !== ",") return -1;
    k++;
  }
}

function argsOf(list, k) {
  const args = [[]];
  for (let j = k + 1, depth = 0; j < list.length; j++) {
    const { op } = list[j];
    if (op === ")" || op === "]" || op === "}") { if (depth-- === 0) return args; }
    else if (op === "(" || op === "[" || op === "{") depth++;
    else if (op === "," && depth === 0) { args.push([]); continue; }
    args.at(-1).push(list[j]);
  }
  return undefined;
}

function openReads(args, method) {
  const readMode = (arg) => arg.length === 1 && arg[0].string !== undefined && !arg[0].f && /^[rbtU]*$/.test(arg[0].string);
  let positional = 0;
  return args.every((arg, n) => {
    if (!arg.length) return n === args.length - 1;
    if (arg[0].name && arg[1]?.op === "=") return OPEN_KEYS.has(arg[0].name) && (arg[0].name !== "mode" || readMode(arg.slice(2)));
    if (arg[0].op === "*" || arg[0].op === "**") return false;
    const at = positional++;
    return method ? at === 0 && readMode(arg) : at === 0 || (at === 1 && readMode(arg));
  });
}
