# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots, and from the shared root that both providers use for a shared project. It reads them without changing them.

The service runs independently of a chat session. It is for a desktop browser on this Mac only: it listens on 127.0.0.1, needs no sign-in, and refuses every request that does not come from the Mac itself. The board in the chat uses the same task model, and it needs no server.

## Start locally

Use Node.js 20 or later. In Claude and in Codex, the board phrase does this for you: the chief runs `board --ensure` (in Codex, escalated, after your approval), which sets the board up when `~/.config/sage-board/board.json` is missing, starts the server in the background when nothing answers on its port, and prints the address or why the server is not running. The server log goes to `board.log` next to the config. The server writes its pid to `board.pid` there once it listens, and removes the file when it stops. Without `--config`, every board command uses that file; without `--sources`, setup uses the standard roots: `$SAGE_HOME` when it is set, or else `$CLAUDE_CONFIG_DIR/sage` or `~/.claude/sage`, and `$CODEX_HOME/sage` or `~/.codex/sage`, then the shared root: `$SAGE_SHARED_HOME`, `$SAGE_HOME/shared` or `~/.sage`. A root that does not exist shows no task and no problem until it appears. The shared root is not there until a project is shared.

A config from before the shared root names only the Claude and Codex roots. The server and each board command add the shared root when they read, when no source of the config names its path, so a shared project shows without a new config. They do not change the config file.

The board reads a logbook again when it changed during the read: at most 3 times, each with its own share of the read limit. After the third change, the server keeps its last good read, which is not stale, because the change is not a problem. It reads again soon, and the next read with no change shows the new state. The chat board shows that third read with the note "The logbook is changing".

Each server sends a non-secret id of its config on the Mac, so `board --ensure` tells this config's board from an older board server or a board of another config on the same port, and says which. A server reads its config once, when it starts. After you change the config, or update sage, `board --ensure` says that a restart is needed. A server keeps the code that it started with: after you update sage to the version that shows shared projects, stop the board with the command below, then ask for the board again. To restart, run:

```sh
node <path to board/cli.mjs> board --stop
```

Then ask for the board again (or run `board --ensure`). `--stop` stops only this config's board: it checks that the board on the port names this config and the pid in `board.pid`, sends that pid a stop signal, and waits until the port is free. The login service runs the same `--serve` command, so its board writes `board.pid` too and `--stop` stops it; to stop the login service itself, use `launchctl bootout` (below).

A paired browser can also stop the board: "Stop the board" at the foot of the side bar (in a narrow window, under the page links) asks once, then sends the owner write `POST /api/stop`. The server answers, closes, and removes `board.pid`, like the stop signal. The login service does not start it again until the next login (its login file has `RunAtLoad` and no `KeepAlive`); `show board` starts it again at any time. A browser that is not paired cannot send the write, and the side bar says "Ask the chief to stop the board."

An older board server, from before the board sent its id, does not name its process. `--stop` sends it no signal, whatever `board.pid` holds, and `board --ensure` says so. Stop it where it started: press Ctrl+C in its terminal, or run `launchctl bootout "gui/$(id -u)/dev.sage.board"` for the login service. Then ask for the board again.

To set it up by hand, run these commands in the `board/` folder of the installed plugin. `board --ensure` does the first and the last step for you; the install step makes a copy that does not change when the plugin updates. Replace the source paths when your provider uses another root.

```sh
node cli.mjs board --setup --config "$HOME/.config/sage-board/board.json" --sources "[{\"id\":\"claude\",\"path\":\"$HOME/.claude/sage\"},{\"id\":\"codex\",\"path\":\"$HOME/.codex/sage\"}]"
node cli.mjs board --install --config "$HOME/.config/sage-board/board.json" --install-dir "$HOME/.local/share/sage-board/service" --login-file "$HOME/Library/LaunchAgents/dev.sage.board.plist"
node "$HOME/.local/share/sage-board/service/packages/board/cli.mjs" board --serve --config "$HOME/.config/sage-board/board.json"
```

The last line runs the installed copy: use the path that the install step prints after "Installed board command". From the Sage checkout, run the same commands in `packages/sage-board/`; the installed copy is then `service/packages/sage-board/cli.mjs`.

Open the printed localhost URL in a desktop browser on the Mac. The address `/` sends the browser to the board app at `/app/`. The board answers a request only when it comes from loopback, names a loopback host (`127.0.0.1`, `localhost` or `[::1]` at the board's port), and has no header that a proxy adds (`X-Forwarded-*` or `Forwarded`). Every other request is refused: status 403, or 404 on the pages route. The read routes take only GET and HEAD.

A config from an earlier version can still hold the keys `allowedHosts`, `password` or `secret`. It still loads, and this version of the board ignores those keys. An installed copy of an earlier version does not ignore them: the login service runs that copy, and the copy does not change when sage updates. So after an update, remove the keys from the file, then restart the board. To run this version at login, stop the login service with `launchctl bootout` (below), remove the old install folder and the login file, then run the install step again.

The sage hook, in Claude Code and in Codex, refuses the ordinary command shapes by which a session or an agent reads, copies or replaces the configuration file, or lists, searches, copies or moves its folder. An agent runs as your own user, so a script that builds the path while it runs can still pass the hook. Full protection needs the sandbox (tasks T97 to T99).

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error that names the command below; the service does not choose another port.

### Change the board's port

Setup never changes a config that exists. To move the board of an existing config to another port, run in Terminal:

```sh
node <path to board/cli.mjs> board --port 43124
```

Use any free port from 1024 to 65535, and add `--config <file>` for a config that is not the default one. The command checks the port (a number from 1024 to 65535, and free on 127.0.0.1) and that it can write the config and its folder. Then it stops this config's board if it runs, writes only `"port"` (in a new file that replaces the config, with the same mode, and every other key kept), and starts the board on the new port. When a check fails, it changes nothing. It never prints the config. The hooks refuse it from an agent; the chief may run it. The login service reads the port at each start, so it needs no change.

Each server writes its port to `board.port`, next to `board.pid`, and keeps the file when it stops. The file holds only the port. The message command of the state tool reads `board.port` in `~/.config/sage-board/` (and never the config), so a message's Page link names the port of the board of the default config. Without the file, the link names 43123.

The manual way, when your sage has no `board --port`: stop the board with `board --stop --config <file>` first (it looks for the board on the port that the file names), then edit `"port"` in the file, then ask for the board again. To set the board up again from the start, remove the file first.

The stable installation copies only board and core sources, and the licence files of the packages in the board's bundles. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## The board in the browser

The board is a React app at `/app/` on the server: open `http://127.0.0.1:43123/` (or the port of your config) in a desktop browser, and the server sends you to `/app/`. It needs scripts. A browser with scripts off gets one line that points to the chat board, which needs none. The [board guide](../../docs/guide/board.md) shows each page with a screenshot: Overview, Tasks, the task page, Agents, Pull requests, the question view and the reader.

The Overview has:

- **The chiefs:** a chip for each chief of each shared project, with live, waits for you, stopped or not known, and the autopilot state. A click shows only that chief's work, on each page.
- **Needs you:** each open question, oldest first, with its chief, its task, its recommendation and when it was asked. A click opens the question with the message that the chief kept for it (`gates/G<n>.json`).
- **Answered · waits for the chief**, with Undo, and **Stopped chiefs**, with "Give to another chief" for each open task.
- **Milestones:** each milestone by the top priority of its open tasks, with its progress.
- **Since you looked** (or **In the last 24 hours** before your first visit): the tasks merged, the runs that failed or whose agent is silent for 30 minutes, and the tasks added. A task gets its added time from its `task added` decision row; a task from before this row shows no time.

**Writes.** A browser acts only after you pair it once. The usual way is the link that `show board` sends: the chief runs `board --ensure --link`, and one click on `/app/#pair=<key>` pairs the browser (the [board guide](../../docs/guide/board.md#act-from-the-board) has the outcomes). With no chat open, run `node cli.mjs board --pair` in Terminal (it refuses input that is not a terminal), and type the one-time code on the board; the pairing card shows this command with the full path of the running board's `cli.mjs`, and a Copy button. The server then sets the cookie `sage_board` (`HttpOnly; SameSite=Strict; Path=/`) and gives the page a second random secret, the token, which the page keeps in `localStorage`. The server keeps only the hashes of both in the board's state folder, `state/` next to the config. The time of your last visit, for "Since you looked", stays in each browser, not on the server. A browser sends its cookies to every port of `127.0.0.1`, but `localStorage` belongs to the board's own origin (its port too), so a server on another port that gets the cookie still has no token. Each `POST /api/...` must have the board's exact `Origin`, `Sec-Fetch-Site: same-origin`, a JSON body, the cookie and the token of the same browser in `X-Sage-Token`; an answer also carries the digest of the question that you saw. The server runs only `gate answer --via board`, `gate undo`, `gate give`, `chief name`, and `config archived=yes` or `config archived=no` (Archive and Restore, one at a time; the forms live in `writes.mjs` only), through the state tool in its own thread (Node's `worker_threads`), so the logbook lock never holds the server's event thread. It writes a shared logbook through a checkout of it on this Mac, and a Claude or Codex logbook only to archive or restore its project. `POST /api/stop` stops the board.

Limits of the writes. Each one needs a program on this Mac that acts on purpose:

- A program that forges the board's headers can send five wrong pairing codes, and so spend the code. Nothing is paired: run `board --pair` again (F-T1076-3).
- A board that starts with a `--config` outside `~/.config/sage-board` keeps its pairing in the `state/` folder next to that config, and the hooks do not guard that folder. A program can read that folder, or add a browser to `paired.json`. The folder keeps hashes, but `pair-code.json` keeps the SHA-256 of an 8-letter code (about 40 bits), so a program can find the code within its 10 minutes. This stays a limit because only a program that acts on purpose does it (F-T1076-4).
- The reader keeps the board's origin (`sandbox allow-same-origin`), because the board and the pages folder refuse the cross-site requests of a page with no origin, so its links and pictures need it. A script on the reader could read the token, but the reader runs none: its sandbox has no `allow-scripts`, its policy has `script-src 'none'`, and a test checks both (F-T1076-6).

**Request size.** The board accepts up to 64 KiB of request headers. A browser sends the cookies of `127.0.0.1` to every port of it, so the cookies of other apps on `127.0.0.1` come to the board too. Ordinary cookie sets are far below 64 KiB: a cookie has at most 4 KiB, and most servers, Node's too, refuse more than 8 to 16 KiB of headers. When the cookies for `127.0.0.1` are more than 64 KiB in all, the board answers HTTP 431 to every request, reads and writes, until those cookies end. Nothing is written and nothing leaks. To recover, clear the browser's site data for `127.0.0.1` (F-T1076-9).

The pages Tasks, Agents and Pull requests sit beside the Overview. The top bar of each page shows the agent and lead counts against the project's limits, from the logbook's `config.json` (`max_agents`, `max_leads`), and links to the Agents page. The board loads only its own files from the board server, under a content security policy with no inline code and no outside source. Its data comes from one stream, `/app/events`.

### The reader for agent documents (T1064)

The reader shows what the agents made, as pages of the board at `/read/<task>/<kind>`, where `<task>` is the base64url of the task's key. Open it from a task's Artifacts tab, or from a question in Needs you. Each page has a back link to where you came from.

| Kind | Route | What it shows |
| --- | --- | --- |
| Brief | `brief/R<n>` | The ten fields of `briefs/R<n>.md`. GOAL and ACCEPTANCE open first; a closed field shows its first line. |
| Report | `report/R<n>` | STATUS, RESULT first, each finding as a row with its state from the logbook, then the other fields. It reads `reports/R<n>.md`, then `<R>-report.md` in the pages folder, then a review's `kept/R<n>.json`. |
| Markdown page | `page/<file>.md` | The page with a contents list and its pictures, from the task's pages folder. |
| Design | `design` | One version (today), or two side by side, from `designs/<version>/`. |
| Arena | `arena` | The candidates, the judge's scores and the judge's final. |
| Question | `question/G<n>` | The full question from `gates/G<n>.json`: every part in one column, in the message's order, each under its short label (Due and Default as well), with the answers where the message puts them and the chief's pick first. A question kept before the short labels shows its own older labels. It only reads: its last line says "Answer on the board or in the chat" and links to the question view. |

A page says "not written yet" while its run runs, "not kept" for a run or question older than T1058, and "gone" for a recorded page that is no longer in the pages folder. A report of a run that a gate records as the run that asked it (`gates.run`) starts with "This became G<n>.", with a link to the question view.

**In the question view (T1121).** `GET /app/gate/<key>` gives the question with `material` from `material.mjs`: the pages that the kept message names (a page of another task of the same logbook too; a task that the board does not have in that logbook gets a note, not a frame), then the task's design, the newest version's prototype and its Markdown pages (newest first), then the report and brief of the asking run (`gates.run`, else the newest designer, pe or investigate run). It never lists the pages of the tasks that the task waits for (G189), shows a file once, stops at 8 and counts the rest. The material is not in the event stream. The app opens each item in a frame: the app's policy has `frame-src` for `/read/` and `/pages/` only. A reader page with `?in=board` has no top bar, sends `frame-ancestors 'self'` (else `'none'`) and the frame's sandbox flags in its own `sandbox` policy (the browser applies the stricter of the two, so with `allow-same-origin` alone no link in the frame opens, F-T1121-2), carries `in=board` on each link to a reader page of the same task, so that page opens in the frame too, and gives every other link (all but a `#` link and a `/read/` link with `in=board`) `target="_blank"` with `rel="noopener noreferrer"`, so the question view and its picked answer stay (F-T1121-20); its frame has `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, with no `allow-scripts` and no `allow-top-navigation`, so nothing in it moves the board's window. A prototype's frame has `sandbox="allow-scripts"` only, with one warning line (G190). Each frame has `referrerpolicy="no-referrer"`. A named part of a Markdown page opens by the app's scroll of the frame (`at`, the heading's id), not by a fragment, so the board itself does not scroll.

**Safety.** The server renders each page; the page has no scripts. Its content security policy is `sandbox allow-same-origin` with `script-src 'none'` and `form-action 'none'`, so the page cannot run code or send a form to the board. Pictures load only from the task's own pages folder (`img-src` names that folder) and from a `data:` PNG, JPEG, GIF or WebP picture in the page (T1116). Markdown renders with the pinned `markdown-it` with raw HTML off. A link opens only when it is `https:` or a file of the task's pages folder. Bidi control characters show as visible marks, such as `[U+202E]`.

**Design versions.** A version is a folder `designs/<version>/` in the task's pages folder. Without more, the reader shows its pictures, its first web page as the prototype and its first Markdown file as the notes. A `version.json` in the folder adds the rest (a later task, T1074, makes sage write it); every key is optional:

```json
{ "title": "v2", "about": "One line about the version.", "at": "2026-11-12T14:00:00Z", "run": "R3684", "today": true,
  "prototype": "index.html", "notes": "notes.md", "screenshots": [{ "file": "after.png", "caption": "After Create link" }], "gates": ["G8"],
  "candidate": "A", "angle": "Precision: a count on each list", "strong": "…", "weak": "…",
  "final": { "base": "A", "why": "…", "grafted": ["C"], "grafts": ["From C: …"], "unused": ["…"], "gate": "G12",
    "scores": { "rubric": ["Fits the brief", "Access"], "max": 5, "candidates": { "A": [5, 4], "C": [4, 5] } } } }
```

A version with `candidate` or `final` belongs to the arena, not to the design's versions.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

The board has no HTML file export: `--html`, `--out` and `--pages` say that they are gone. A config that still names `pagesDir` loads, and the board ignores that key.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. New login files use the current Node through its stable command on PATH. With Homebrew, the file keeps the bin alias instead of a version under Cellar. The installer checks that the alias names the running Node.

After a Node upgrade, inspect the login service with `launchctl print "gui/$(id -u)/dev.sage.board"`. Check its Node path, then open the board’s configured address. An older login file that names a Cellar version needs a new file with a stable Node path.

## This Mac only

Do not forward the board's port to another computer (for example with `ssh -L`, `socat` or a reverse proxy), and do not bind the board to a LAN address. A raw TCP forward connects from loopback and adds no proxy header, so it passes the access check.

## Limits and verification

The board displays recorded facts. Missing provider, head, completion, or budget evidence stays unknown. Inferred PR counts remain separate from recorded running agents.

Claude owner phrases can request the board and task views. Codex uses the manual skill commands until native owner phrase delivery is verified. The service does not start agent orchestration or autopilot.

The server has these routes, all with the same access check: `/` (it sends the browser to `/app/`; a query on `/` or `/app/` changes nothing), the old board's streams (`/?events=1`, `/agents?events=1` and the others before T770: each answers once with a note that the board was updated and a link to `/app/`, and a retry of one day, so an old tab does not say "Reconnecting" for ever), `/app/` and the app's files, the stream `/app/events`, a task's panel data at `/app/task/<id>` and a question at `/app/gate/<id>` (each id is the base64url of the key), the reader at `/read/...`, the pages at `/pages/...` and the writes at `/api/...`. Every other path gets 404. The Agents data also reads the hook's agent slots and helper notes under each logbook root (`.hooks/slots` and `.hooks/helpers`), by name and change time only. It refreshes by itself when an agent's state changes with time (30 min with no activity, or running long), as no file changes then.

**Agent activity (T1100).** The hook renews an agent's slot on each of its tool calls, and an agent's actions go to `<logbook>/actions/R<n>.jsonl` (one short record a line; the writer comes in a later task). A change under `.hooks/` or under a logbook's `actions/` folder does not read the logbook again. The server reads only the slot times and the last line of each running agent's action file, at most once every 2 s, and sends the runs that changed as a small `activity` event on `/app/events`: `{"<logbook>/R<n>": {"activity": <slot time in ms or null>, "now": <last action or null>}}`. A new stream gets the activity of each running agent after its first model. A slot or a helper note that comes or goes, or a quiet agent that wakes, still reads the logbook again, because the Agents page changes then.

`GET /api/actions/R<n>?logbook=<source>/<logbook>` gives one run's last 20 actions, `{logbook, run, actions, dropped}`, with the same access check as the pages; `dropped` counts the lines that are not readable. It answers only for a run in the runs table of a logbook that the board shows (else 404), reads only that logbook's `actions/R<n>.jsonl`, and refuses a link or a file with a second name (403). With no `actions/` folder or no file yet, `actions` is empty.

The server also shows each task's pages folder, read-only, at `/pages/<logbook>/<task>/` (an index) and `/pages/<logbook>/<task>/<file>` (T1001). It serves these only to a request from the Mac itself.

It reads the raw path and never joins it onto a folder: it refuses `%`, `..`, a part that starts with a dot, any query, a logbook that the board does not show, and a link or a file with a second name anywhere in the path. A person's own click on a Markdown page of a task on the board (`Sec-Fetch-Dest: document` and `Sec-Fetch-Site: none`, as from a chat link or a typed address) gets a 303 to the reader's `page/<file>.md`, and the index links each Markdown page to the reader (T1116). A copy of the board without its Markdown renderer has no reader, so it serves the Markdown file itself and links it. The reader's "Open the file" link is same-origin, so it gets the file; a click from another site also gets the file, because the reader refuses other sites. It serves only web pages, PDFs, pictures, and Markdown and text as plain text, at most 4 parts deep (`PAGE_DEPTH` in core: a design's `designs/<version>/shots/x.png`, T1130) and 16 MiB.

Each page's response has a sandbox policy in place of the board's: the page has no origin, loads no style or frame from a server, loads pictures only from its own task's folder (`img-src` names that folder, T1130), and runs only sage's own script (the switch of a message page). A page with a script of its own (the same test as before: a `<script>` tag or an event attribute) gets, on a request with `Sec-Fetch-Dest: document`, a frame page instead: one warning line that ends with a link to the task's index, and an `<iframe sandbox="allow-scripts">` of the page. The frame page runs no script, and its `frame-src` names only the task's folder, so the page in the frame cannot move the frame to another site or to another task. The index sends `frame-ancestors 'none'`, so a link to the index in the frame does not open either: the warning line's link opens it in the top window (F-T1130-1). The page itself, on a request with `Sec-Fetch-Dest: iframe`, gets `sandbox allow-scripts` with `script-src 'unsafe-inline'` and `frame-ancestors` of the board's own origin: its scripts run with no origin, no `connect-src`, no form, no window and no move of the top window (T1130). A request with no `Sec-Fetch-Dest` gets the page with no script of its own. A script from a server does not run, but when its `integrity` hash matches the switch hash, the browser still requests it before it checks the hash (F-T1013-8); a blocked frame to another site still opens a connection that sends the host name (F-T1013-9). No policy stops a meta refresh in a page that runs scripts (`navigate-to` is not in Chromium), so a page with the switch gets scripts only when it has no `http-equiv` and no `srcdoc` outside sage's own policy tag, exactly as the message command writes it with core's `PAGE_POLICY`, and no UTF-16 byte order mark (F-T1013-1, F-T1013-2, F-T1013-6). The test fails closed: a tag that it cannot judge, for example one in a comment, costs the page its switch, and so does a message page from a sage with another page policy. The index runs no script and has no sandbox, so that its opener policy cuts the window handle of another site that opened it. A page cannot fetch the board, read its storage or send a form. A person's click on another site may open a page (a host app's chat may send its links so); a move that no person started gets 403. A request from a page with no origin is cross-site, so the route also takes a cross-site frame request (`navigate` to an `iframe`: only the board's origin may frame a page) and a cross-site picture request (`no-cors` to an `image`, with `Cross-Origin-Resource-Policy: cross-origin` on pictures only). A browser sends no `Referer` from a page with no origin, so another site that knows a picture's full address can show it, but cannot read its pixels. The same site can learn whether a picture is at an address that it guesses, and its size (F-T1130-3).

Limits of the pages route:

- A page with no script of its own can still send its own content out through a link that you click in it. It runs no refresh. A page with scripts of its own cannot: in its frame, a link or a refresh to another site does not open.
- A page with scripts of its own can send its own text to another host through WebRTC (`RTCPeerConnection` with a STUN or TURN address): CSP does not cover it, and no header that the board can send stops it in Chromium (F-T1130-2). Its scripts cannot read the board, its cookies or another page, so only that page's own text can leave.
- A page can also send content out with no click, also with no script: when it opens, Chromium sends the request of a prerender link (`<link rel="prerender">`, NoStatePrefetch) to any site, and the address can hold the page's content. No header that the board can send stops it: a probe in Chromium 140 tried CSP (`prefetch-src` and `navigate-to` too), Permissions-Policy, COOP, COEP, Vary and others (F-T1013-5). The request carries no referrer, but it carries the cookies of that site that `SameSite=Lax` lets through (F-T1013-10), and the page stays. Prefetch, preload, preconnect, DNS prefetch and speculation rules reached nothing in the same probe.
- On macOS, the board opens a page with no link in any folder of its path (`O_NOFOLLOW_ANY`). Other systems have no such flag, so there a folder that flips between a link and a folder during the board's checks can pass them.
- The folder of the pages comes from `SAGE_WORKTREES`, or else `~/sage-worktrees`. A board that launchd starts gets no `SAGE_WORKTREES` from your shell, so it shows the pages under `~/sage-worktrees` only.

Local tests exercise the access check, file updates, the app's routes and stream, reconnects and stable installation. Browser tests walk each of the board's seven jobs from the Overview (`scripts/board-jobs-browser.test.mjs`). Login startup still needs a direct check.
