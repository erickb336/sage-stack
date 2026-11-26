# Board design

This page holds the design of the board: the redesign of milestone M7, which the owner approved (gates G154, G156 and G159), and the service rules that stay from the first board (T205). Task T770 retired the first, script-free board: the address `/` now sends the browser to the app at `/app/`, and the chat board is the view that needs no scripts.

## The board redesign (M7)

The new board is a React app that the build bundles into each plugin. The server on the Mac serves it at `http://127.0.0.1:<port>/app/` under a strict content security policy: no inline script or style, no `eval`, and no source outside the board's own address. It is for a desktop browser only. The text board in the chat stays the view that needs no scripts and no server.

The app gets its data from one event stream, `/app/events`. Each message is `event: model` with the Overview model as JSON (`boardOverview` in core). The model holds text only, never HTML, and React escapes each text. When the stream breaks, the app keeps the last data, says when it is from, and connects again.

### The board tenets

The owner approved these tenets (G156). Each page and each element of the board follows them.

0. **Useful before beautiful.** Each element helps the owner decide or act. The Overview answers each of the seven jobs in at most two clicks.
1. **Needs you first.** What waits for the owner comes before everything else, with its full context.
2. **Overview first, details on demand.** A row is one short line. Its details open when the owner asks for them.
3. **The logbook is the truth.** The board shows what the logbook records. A value that the logbook does not record shows as unknown, never as a guess.
4. **One truth, many views.** The board, the chat and each chief read the same logbook. When two answers race, the first answer wins.
5. **Calm by default.** Only running work moves. Colour shows state only. Words come before ids.
6. **The owner stays in control.** Each action of the owner has an Undo.
7. **Every chief is visible.** Claude and Codex chiefs show alike.
8. **Local and private.** The board runs on the Mac and loads nothing from the network: no CDN, font or picture from outside.

### The seven jobs

| Job | The owner wants to know | Served by |
| --- | --- | --- |
| J1 | What needs me, with full context | Overview, "Needs you": one click opens the question with its kept message; answer and Undo there (T1059) |
| J2 | Where each milestone and task stands, by priority | Overview, "Milestones" (T1054); the Tasks page, grouped by priority (T1061) |
| J3 | Where a task is in its dev cycle, and what its agents made | A milestone on the Overview, then a task: the task page (a side panel in T1061, a page of its own since T1083); the reader |
| J4 | Which agents run, for which chief, against the limit | The Agents page |
| J5 | Which PRs are open, merged or waiting, and what depends on what | The Pull requests page |
| J6 | What changed since I looked | Overview, the counts: "Since you looked" with a paired browser, else the last 24 hours |
| J7 | Whether each chief runs, and whether autopilot is on | The chief chips under the top bar |

### The ux-review checklist

A ux review of a board page checks each line. A line that fails is a finding.

| # | Check | Tenet |
| --- | --- | --- |
| 1 | Each element answers one of the seven jobs, or helps the owner act on one. | 0 |
| 2 | Each job that the page serves is reachable from the Overview in at most two clicks. | 0 |
| 3 | What needs the owner comes first on the page, oldest first, with its chief, its task and when it was asked. | 1 |
| 4 | A row is one line of words; ids come second; details open on demand. | 2, 5 |
| 5 | Each value comes from the logbook. A value that the logbook does not record says "not known" or "not recorded". Sample data says so. | 3 |
| 6 | The page shows its states: loading, live, stale ("not updated since"), lost link, failure and empty. A failure keeps the last data and never shows an empty board. | 3 |
| 7 | An answer shows where it came from. A later answer from another place is refused and names the first. | 4 |
| 8 | Only running work moves. Colour shows state only, and each colour has a word beside it. Motion stops when the system asks for reduced motion. | 5 |
| 9 | Each action of the owner has an Undo until a chief picks it up. | 6 |
| 10 | Each chief, Claude or Codex, shows with its id and provider. | 7 |
| 11 | The page makes no request outside 127.0.0.1, and its content security policy has no `unsafe-inline`, no `unsafe-eval` and no outside source. | 8 |
| 12 | Text and controls meet WCAG AA contrast in the dark and the light theme. | – |
| 13 | Each control is reachable by the keyboard, in reading order, with a visible focus ring. | – |
| 14 | The page fits a desktop window from 1024 px wide. | – |
| 15 | The page works at 390 px wide (a phone): each job that it serves takes two clicks or fewer, nothing scrolls sideways, and each control is large enough for a finger. | – |

### What T1054 built

- The bundle: `scripts/board-app.mjs` bundles `packages/sage-board/app/` with esbuild into a vendor file (React), an app file and one CSS file, each named by its content hash, with a manifest. The build fails when a bundled package is not pinned to its exact version in `package.json`, or when a file is over its size budget.
- The `/app/` route, its HTML shell and its content security policy; the `/app/events` stream.
- The Overview, read-only: "Needs you", the milestones by priority with their progress, and the counts of the last 24 hours. The pages Tasks, Agents and Pull requests said that they come next (T1061, T1062 and T1063 built them).
- The logbook keeps no time when a task is added, so "New tasks" shows as not known (tenet 3).

### What T1061 built

T1083 later made the side panel a task page of its own, at `#task?key=<task key>`, with the same parts.

- The Tasks page at `/app/#tasks`: every task, grouped by milestone, priority, chief or state, with filters for chief, provider, priority, kind and state. Each row shows the priority, the state word, the kind, the chief tag (id and provider) and "may conflict" when another chief's open branch changes the same file. Ended tasks (merged, concluded, abandoned) are collapsed in each group.
- The side panel of one task: the steps of its route with the current step, the clean-cycle count ("not known" when the board does not know the PR's last commit), the last event, and the tabs Artifacts, Log and Decisions.
- The stream carries one short row for each task. The panel reads `/app/task/<key>` when it opens, and again when the logbook changes. That route also lists the task's pages folder, the kept reports of its runs, and the brief and report files that name the task or one of its runs. A pages file opens through `/pages`; the reader for the other files comes later.
- A "Needs you" row opens its task's panel, and a milestone row opens the Tasks page at that milestone.

### What T1059 built

Later changes: T1125 added the pair link that `show board` sends, so the Terminal code is the way when no chat is open, and it keeps the time of the last visit in each browser, so the server keeps no `seen.json`.

- Writes from a paired browser only: `board --pair` in Terminal (it refuses input that is not a terminal) prints a one-time code; the server sets an `HttpOnly; SameSite=Strict` cookie, gives the page a random token that it keeps in `localStorage` (scoped to the board's origin, so a server on another port that gets the cookie has no token), and keeps only the hashes of both in the board's state folder, `state/` next to the config. Each `POST /api/...` needs the exact `Origin`, `Sec-Fetch-Site: same-origin`, JSON, the cookie and the token of the same browser; an answer carries the digest of the question that the owner saw (`gate answer --seen`).
- The reader core stays pure. The server runs only the owner's commands `gate answer --via board`, `gate undo`, `gate give` and `chief name`, through the state tool in a worker thread, so the logbook lock never holds the server's event thread.
- The Overview: the chief chips (live, waits for you, stopped, not known; autopilot; rename; a chief filter that holds on each page), the question view at `#question?key=<gate key>` with the kept message, Send and Undo, "Answered first in <chief>'s chat at <time>" when another place won, "Answered · waits for the chief" with Undo, "Stopped chiefs" with "Give to another chief", and "Since you looked" from `seen.json`.
- `task add` keeps a `task added` decision row, so the model has `addedAt` for new tasks; older tasks show no time.
- A path or a branch name is data: the panel shows each control character in it as a visible escape, such as `\n`.

### What T1063 built

- The Pull requests page at `/app/#pull-requests`. It groups the tasks with a PR by the next action: Needs you, In review, Repairing, Ready to merge, Waiting for another task, and Merged recently (the last 7 days). A task with no PR that waits for another task is in the Waiting group too.
- Each row shows the PR number, which links to the PR on GitHub, the title, which opens the task's side panel, the chief tag, the task, the milestone, "may conflict", the clean cycles and the CI state. The CI state is the checks verdict on the PR's current head in the ledger: "CI passes", "CI fails" or "CI not known". The board never asks GitHub.
- A PR number links to GitHub only when it is a whole number and the logbook names the repository: the PR record's repository, or else the project's. With no repository, the row says so in words.
- The Graph view shows each item that waits for another item on the page, or may conflict with one, in columns by "waits for": an arrow from A to B means that B waits for A. It is React Flow (`@xyflow/react`, MIT) in its own graph file, which the page loads only when the graph opens. The graph file has its own size budget.
- A link of the graph never passes through a box, and no two links share a line. A link runs only in the gaps between the boxes, on lines that only it uses: its own point on each box side, its own track in each column gap, and its own lane in a gap between two rows when it skips a column or goes back. A gap grows to hold all its tracks. A wait and a "may conflict" link between the same two tasks are two separate lines.
- Two boxes in one column that may conflict get a dashed link that leaves and comes back on their right side.
- A loop in the "waits for" links shows one link that goes back, under the boxes, with the mark "loop". A task that waits for itself shows a link around its box, with the mark "waits for itself".

### What T1081 changed on the Pull requests page

- A seventh group, Building, holds a task with a PR whose build or plan still runs (framed, designing, awaiting-you, briefed, building, held, replan). In review holds only reviewing and verifying tasks, and verified tasks that the merge check refuses. A task with no PR is only in the Waiting group, also when a question for you is open.
- Each row and group has its group's icon. A row has no state word, because its group says it; a state that the board cannot read shows "state not known". A row shows the open findings and the worst open severity ("1 open · medium"), or "0 open · 2 closed".
- A row shows its reason (the "why" line) and its waits line together. The waits line names a wait for a missing task or a milestone breakdown too. A merged row counts its clean cycles ("2 clean cycles"), not against today's configured count, and a merge time in the future says so. Ages count from now.
- Logbook text shows each control character as an escape, so a right-to-left override reverses nothing. With two projects, each row and each box names its project.
- Beside the panel or below 1280 px, the cycles, CI, findings and age go to a line under the row. The page keeps the List or Graph choice in the browser. An empty project shows no view switch.
- The graph draws a box for each task that a task on the page waits for but that the page does not list ("Not on this page", or "Not in the logbook"). It refits when its width changes, shows each box of a large graph at first (zoom down to 0.2), and keeps its links while the panel opens. A met wait has its own legend line. React Flow's link is gone; the legend credits it as text.
- Labels never cover each other or a box: a loop or self-wait mark is placed first; a "may conflict" label with no free place is left out. The router has no recursion, so a long chain cannot overflow the stack, and an error while drawing shows a message in place of the graph.

### What T1062 built

- The Agents page at `/app/#agents`, for J4 and J7: each chief (Claude and Codex alike), then each running lead with its running helpers, the chief's own runs with no lead, and the chief's queued runs with their place. Each row gives the role, the run, the state, the task, the model and the age; a row opens its task's side panel. Ended helpers of a running lead stay collapsed; other ended runs stay out, so the page stays small with a large logbook. A stopped chief shows as stopped, with the open tasks that it owns. A timeline has one lane for each agent, by chief. The page only reads.
- One component draws an agent: `AgentMark` in `packages/sage-board/app/agent.jsx`. It draws a lead's card head, a helper, a chief's own run and a queued run, from the run and its `kind` (`lead`, `helper`, `own` or `queued`). A later design of the agent look replaces that file only; the chief box, the lead card, the queue and the timeline stay in `agents.jsx`.
- The counts in the top bar of every page: "Agents 7 of 20 · C1 4 · C2 3 · 2 queued" and "Leads 3 of 5". They come from the logbook's `config.json`, with the rule of the state tool (`projectLimits` in `logbook-fields.mjs`): before the limits move into the logbook, the largest `cap.<name>` or `max_agents` of the provider roots, for the folder name and each bound checkout's name. A count turns amber at its limit, and a click opens the Agents page (one click from the Overview). A lead counts while it runs or waits in the queue, as the lead limit counts it. A chief filter hides other chiefs' agents, but the counts stay whole, because the limits are shared.
- An admitted run's start time is the time of its admission, so its clock and its agent time leave out the time in the queue. A queued run shows once in its task's log, as queued with its place, and the task's step line names it when no agent of the task runs.

### Acceptance of the seven jobs (T770)

Each job is answered from the Overview in at most two clicks. `scripts/board-jobs-browser.test.mjs` walks each job on sample data (`writeTasksLogbook` of `scripts/fixtures/board-app.mjs`), at 1440 px and at 390 px, counts the clicks, and fails on more than two or on a page error. The owner's walkthrough page has one screenshot of each job at each width.

| Job | Steps from the Overview | Clicks | Browser test |
| --- | --- | --- | --- |
| J1 | Needs you: click the question. The question view shows the question, its context and the answers, with "Read the full question" for the reader. | 1 | `J1 at <width> px: one click on a Needs you row opens the question …` |
| J2 | The Milestones card shows each milestone by priority (0 clicks). Tasks, then "Priority" in Group by, gives the groups P0 to P3. | 0 and 2 | `J2 at <width> px: the milestones stand by priority …` |
| J3 | Click a milestone (the Tasks page at that milestone), then a task row. The task page shows the steps, About this task, and the tabs Artifacts, Log and Decisions. | 2 | `J3 at <width> px: a milestone, then a task, shows the task's dev cycle …` |
| J4 | The top bar: "Agents 8 of 20 · C1 4 · C2 4 · 3 waiting" and "Leads 4 of 5" (0 clicks). A click on the count opens the Agents page, with a box for each chief. | 0 and 1 | `J4 at <width> px: the top bar counts the agents …` |
| J5 | Pull requests: the groups by next action. Graph: what waits for what. | 1 and 2 | `J5 at <width> px: Pull requests groups each PR …` |
| J6 | The counts at the end of the Overview: merged, failed or flagged, new tasks. | 0 | `J6 at <width> px: the Overview counts what changed …` |
| J7 | The chief chips: a dot for live or stopped, and "autopilot on" or "autopilot off". | 0 | `J7 at <width> px: each chief's chip says …` |

The ux-review checklist above applies to each page. Its line 14 (from 1024 px wide) holds, and a phone-width window (390 px) works for every job too, with the narrow layout of T1099.

### What T770 retired

- The server-rendered pages `/` (the task board), `/task/<id>`, `/agents`, `/milestones`, `/milestone/<id>`, `/releases`, the old `/program...` addresses and their streams (`?events=1`). Each now gives 404, and `/` gives a redirect (302) to `/app/`.
- The HTML parts of `board-render.mjs`; it keeps the chat board (`renderBoardText`), the chat task view (`renderTaskText`) and the status lines (`renderBoardStatus`).
- The one-file HTML export: `board --html --out`, the `--pages` setup option and the state tool's `board --view html`. A config that still names `pagesDir` loads; the board ignores the key.
- The facts that only the old pages showed stay in the chat board: the move banner, the offer line, the checkout of each run, "Old · read-only", the changing note, the logbook notes and the releases frame.

## Packages and service

- Core reads explicit logbook roots and returns one shared model. It calls no provider API or Git command, takes no lock and writes no logbook.
- A separate provider-neutral board package owns the command, server, file watchers and optional login setup. It imports only the public core API.
- The server listens only on 127.0.0.1. The default configurable port is 43123. A busy port causes a clear failure; the server never stops another process or changes ports silently.
- A stable installed command supports optional per-user launchd startup. Provider cache changes must not replace the service.
- The board is for a desktop browser on this Mac only (T1053). It answers a request only when the request comes from loopback, names a loopback host at the board's port (`127.0.0.1`, `localhost` or `[::1]`), and has no forwarded header; every other request gets 403. The exact Host check also stops DNS rebinding. The read routes take only GET and HEAD. The board has no sign-in, no secret, and no phone or remote access.
- The app needs scripts; the chat board is the view without scripts. File events update an open page through `/app/events`. Watch errors show stale data, not an empty board.

Read-only access can still expose private briefs and reports to any account or program on the Mac.

## Approved recorded-data choice

Current tables do not record the current PR head, open PR status or provider identity for every run. A branch name alone does not prove live activity. A reviewed SHA alone does not prove the current remote head.

The state tool adds minimal PR and run evidence records with source, observation time and task association. A separate state/provider writer records evidence. The board stays read-only. Old records without evidence show unknown.

Alternative: keep existing fields and show unknown or inferred values. This preserves honest display but does not complete the requested current-head and activity capability. The owner selected the recommended evidence records.

## Acceptance to preserve

| Requirements | Evidence required |
| --- | --- |
| 1–2 | Provider-neutral multi-root data; the reader takes no lock and writes no logbook (the server's owner writes go through the state tool in a worker thread, T1059); no provider calls; escaped agent text. |
| 3–4 | The chat board's exact six-section mapping; backlog PRs visible; seven-day Done window. The script-free export is retired (T770). |
| 5–6 | Complete cards and evidence-backed cycles, agents and owner reasons; matching project filters and counts. |
| 7–9 | Dark and light themes, AA contrast, reduced motion, numbered text board from the same data. |
| 10–11 | Task detail in the app's task page and in the chat; all views use one shared model with source-qualified task identities. |
| 12–13 | Board/task-only service, no file browsing; event-driven updates, reconnects and explicit stale state. |
| 14–15 | Desktop only: a configurable loopback port, one start command, optional startup at login and stop instructions. No sign-in, and no phone or remote access. |
| 16–17 | Server-independent chat views; every requested board, task and status phrase; owner-text-only parsing and provider capability disclosure. |

Current board history writes, project-list initialization and Git-derived head checks cannot be reused in the new pure reader.

## Verification limits

The design reviews inspected source and official Node and Apple documentation. They did not install a service or read private logbooks. The browser tests exercise the app with invented data and blocked network access.

Backend acceptance needs multi-root fixtures, exact-head changes, missing evidence, read-only spies, hostile text, server access checks and watcher replacement. Local tests cover these behaviors; login startup remains unverified.
