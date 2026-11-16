# The board

The board is a view of every project's logbook: what needs you, where each milestone and task stands, the agents that run now, and the pull requests. This page is the user guide to the board.

The board has two views:

- **The board in the chat:** `show board` prints it as text. It needs no server and no scripts.
- **The board in the browser:** a local page on this Mac, at `http://127.0.0.1:43123/` (or the [port that you moved it to](#change-the-boards-port)). It needs scripts, and it reads the same logbooks.

[Every phrase](using-sage.md#every-phrase) lists the board phrases with all the others. The [board service guide](../../packages/sage-board/README.md) gives the server's setup by hand and the login service.

The board reads. It writes only the few actions of a [paired browser](#act-from-the-board). To change a task, a priority or a kind, ask the chief.

Every screenshot on this page shows sample data, made by `scripts/board-shots.mjs`.

## Ask for the board

The chat view shows the tasks in the project's logbook: its shared logbook, or else the logbook of the tool that you use (Claude or Codex). The browser view shows the logbooks in its config: by default, the Claude and the Codex logbooks and the [shared logbooks](#a-shared-project-on-the-board).

| Say | You see |
| --- | --- |
| `show board`, `sage board`, or `show board for this project` | The chat board for the current checkout, with each source kept separate, and the address of the board in the browser. |
| `show board for all` or `sage board for all projects` | Tasks from all configured sources. |
| `show board for sage-bot` or `sage board for sage-bot` | One named project: the name that the board shows (its display name, or its repository's name) or its folder's name, in any letter case. The Claude and the Codex logbook of one checkout are one project, so the name shows both. An ambiguous name (two clones) gives qualified project choices. |
| `show board T197`, `sage board T197`, or `board T197` | Full task detail for the current project. An unknown task gives nearby IDs and opens no other task. |
| `show status` or `sage status` | Task states, recorded agents, what needs you, and the budget evidence that the logbook has. |

Claude recognizes these phrases only at the start of your own message, outside quoted text:

- Bold around the phrase works, for example `**show board**`.
- A question mark works right after the phrase, also inside the bold (`**show board?**`). After the closing stars (`**show board**?`), it does not work.
- Text after a question mark on the same line does not trigger the phrase.

Codex recognizes the same phrases by the same rules. There, the board in the browser starts after you approve one prompt, as [The board in Codex](codex.md#the-board-in-codex) tells.

The chat board groups the tasks in six sections:

- Backlog, Design, Building, In review, Ready to merge, and Done.
- Done holds the merged and concluded tasks of the last seven days, when their completion date is recorded.
- A section shows 5 tasks; the board in the browser shows all of them on its Tasks page.
- A verified pull request is in Ready to merge only when sage's merge check passes on its last commit. The board does not check the pull request's head branch on GitHub.

### The state words

Each task, step, milestone and agent shows one of six state words, on both views. Each word has a mark, so it reads without colour too.

| Word | Mark | It means |
| --- | --- | --- |
| not started | ○ | The task exists, and no agent works on it yet. |
| waiting | ⧗ | It cannot start before another task, or before you approve its milestone. |
| needs you | ? | It waits for your answer to a question, or for your merge. |
| in progress | ▶ | Agents or the chief work on it. |
| done | ✓ | It merged, or it was a study that ended. |
| stopped | ■ | Its work stopped for good. |

The same words and marks show the steps of a task and the agents, from one table in sage's code. Two more marks:

- `!` is a problem: failed, blocked, may be stuck, running long or run still open. The problem shows after the word, for example "in progress · may be stuck".
- `◌` is a state that the board does not know. It reads "unknown".

Two marks are not states:

- `⊘` is a wait that is never met: the task that it waits for stopped, so this task cannot start. For example "⊘ Waits for T20 (pilot, stopped): it cannot start".
- 🔴 starts the chat board's top line, before the count of items that need you.

Each kind tag (for example `◇ Design` or `⋈ Orchestration`) and the offer line (`⇄`) have marks of their own, which no state uses.

- A wait names the word of the task that it waits for, for example "Waits for T12 (in progress)".
- A milestone's word comes from its breakdown: "needs you" while the breakdown waits for you, or when its pilot stopped; "stopped" when you dropped it. Else it comes from its tasks.
- The status lines that the chief shows you (the `status` command) give the word of each release and each milestone. Their tasks line keeps the tool's own states.

## The seven jobs of the board

The board in the browser answers seven questions. Each answer is at most two clicks from the Overview, and a browser test walks each one on sample data (`scripts/board-jobs-browser.test.mjs`).

| Job | Clicks from the Overview | Where |
| --- | --- | --- |
| What needs me, with full context | 1 | Overview, Needs you: a click on a question opens the question view. |
| Where each milestone and task stands, by priority | 0 for milestones, 2 for tasks | The Milestones card. Tasks, then "Priority" in Group by. |
| Where a task is in its dev cycle, and what its agents made | 2 | A milestone, then a task: the task page. |
| Which agents run, for which chief, against the limit | 0 or 1 | The counts in the top bar; a click opens the Agents page. |
| Which PRs are open, merged or waiting, and what depends on what | 1 or 2 | Pull requests; Graph shows the waits. |
| What changed since I looked | 0 | The counts at the end of the Overview. |
| Whether each chief runs, and whether autopilot is on | 0 | The chief chips under the top bar. |

## The Overview

<img alt="The Overview of the board, with SAMPLE DATA: the chief chips under the top bar, Needs you with three items, the Milestones card by priority, and the counts of the last 24 hours." src="../assets/board-dark.png" width="100%">

The address of the board opens the Overview. From the top:

- **The top bar:** the counts of agents and leads against the project's limits, for example "Agents 8 of 20 · C1 4 · C2 4 · 3 waiting" and "Leads 4 of 5". A count turns amber at its limit, and a click opens the Agents page.
- **The time and the theme:** "Live · read 10:56" gives the time of the last read. The board is dark until you choose the light theme with the switch, and it keeps your choice in this browser.
- **The chief chips:** one chip for each chief, Claude and Codex alike, with a green dot for a live chief, a yellow dot for a chief that waits for your answer, a ring for a stopped chief, and "autopilot on" or "autopilot off". A click on a chip shows only that chief's work, on each page; "All chiefs" shows all again.
- **Needs you:** each open question and each problem, oldest first, with its chief, its task and when it was asked. A click on a question opens the [question view](#the-question-view-and-the-reader).
- **Milestones:** each milestone by the top priority of its open tasks, with its state word, its goal, its progress bar ("2 of 9 merged") and its pilot. A click opens the Tasks page at that milestone.
- **Since you looked**, or **In the last 24 hours** on the first visit in a browser, or **In the last 7 days** after a longer absence: the tasks merged, the runs that failed or whose agent is silent for 30 minutes, and the tasks added.

Needs you also has items that no task holds: a stuck milestone, a breakdown gate that the logbook lost, a milestone that tasks name but the logbook does not have, a table or a logbook that the board cannot read, and an open move gate ([the move](using-sage.md#move-an-existing-project)). Each item says why and what to do.

When the merge check refuses a PR's head, the chief must fix it: the task stays "in progress", its Merge step shows "! in progress · blocked", and it is not in Needs you.

## Tasks

<img alt="The Tasks page of the board, with SAMPLE DATA: the Group by switch, then the tasks of each milestone, one row for each task with its priority, title, kind, state word, chief and step." src="../assets/board-tasks.png" width="100%">

The Tasks page lists every task, grouped by milestone (the default), priority, chief or state. Filters show one chief, provider, priority, kind or state. A click on a row opens the task page.

- Each row shows the priority, the title, the kind, the state word, the chief tag (id and provider), the step that runs now, the PR and the age.
- "may conflict" shows when another chief's open branch changes the same file.
- The tasks that ended (merged, concluded, abandoned) fold under each group.

Every task has a priority (P0 to P3). An older open task with none shows "no priority", so that you can ask the chief to set one.

## The task page

<img alt="The task page of T3, with SAMPLE DATA: the title, the state word and the facts line, the agents at work now, then About this task with the milestone, goal and criteria." src="../assets/board-task.png" width="100%">

Each task has one page, at `/app/#task?key=<task key>`. The Overview, Tasks, Agents and Pull requests pages open it. The browser's Back returns to the same place on the page that you came from, and a click with Cmd (Ctrl on Windows and Linux) opens it in a new tab. From the top, the page shows:

- the title, the state word, the priority, size, step and chief, and the agents at work now;
- "About this task": Milestone, Before and after ("Comes after" and "Needed by"), Goal, Why, Criteria, Status and Cost, then the links to the brief, the reports, the pull request and the milestone;
- the tabs Artifacts, Log and Decisions. Artifacts lists the task's pages folder, the briefs and reports of its runs, and its design versions; each opens in the [reader](#the-question-view-and-the-reader).

| Part | Where it comes from |
| --- | --- |
| Goal | The GOAL field of the lead's brief (or of the newest brief of the task). |
| Why | Your request, which the chief records with `task <T> set request="..."`. |
| Criteria | The ACCEPTANCE lines of the brief. A line shows "met" only when a passing review or QA report of the task names it; else "not checked yet". |
| Cost | The agent time and tokens of the task's runs, against the BUDGET field of the brief. |

A part with no data shows "unknown" and the reason, for example "The logbook keeps no brief of R25". A path or a branch name shows each control character in it as a visible escape, such as `\n`.

`show board T197` gives the same task in the chat: its steps, brief, runs, verdict evidence, findings (with the polish list of open low findings), artifacts and latest decisions.

## The Agents page

<img alt="The Agents page of the board, with SAMPLE DATA: a box for each chief, each running lead as a card with its helpers, and the queued runs." src="../assets/board-agents.png" width="100%">

The Agents page (`/app/#agents`) shows every agent that runs now, in all projects, for Claude and Codex. It only reads. The page shows:

- the seats: one square for each running agent, grouped by chief, then the free seats, the limit mark and the queued runs as dashed squares;
- each chief under its C1 or C2 tile, Claude and Codex alike, and a stopped chief as stopped, with the open tasks that it owns;
- each running lead as a card with its helpers. Each agent is a tile with its role's line glyph and its role word. The outline round the tile shows its state; only a running outline moves, and the system's reduced-motion setting stops it. Ended helpers fold under "Show n ended helpers";
- an arena as one card: its candidates, then the judge;
- the chief's own runs, one row for each task, and its queued runs with their place in the queue;
- a timeline with one lane for each agent, with its glyph.

A click on a card's title, on "About" or on an agent opens the task page. A run that ended shows "done", "stopped · failed" or "stopped · blocked", and a queued run shows its place, for example "waiting · 1st in the queue".

| State | Shown when |
| --- | --- |
| ▶ in progress | The hook saw the agent in the last 30 min. A Codex run also shows this word: the logbook says that it runs. Codex sends no activity notes yet, so the row has no last activity, no helpers and no cap. |
| ⧗ waiting | A lead has at least one helper that still runs. |
| ! in progress · may be stuck | No hook activity for 30 min or more, and no running helper. Or the logbook says that the run runs, and no agent slot holds it (the hook frees a slot after 60 min with no activity). |
| ! in progress · running long | The time running is more than 2 times the median of the same role's ended runs in this project. It needs 5 ended runs. |
| ! stopped · run still open | The hook saw the helper stop, but the logbook still says that the run runs. The chief must end the run. |

The page reads files only: the logbooks, the hook's agent slots and helper notes (by name and time, not their content) and the limits in `config.json`. It runs no command and reads no process list. To join a slot to its run, the hook marks each agent slot with the run id from the first line of the agent's brief ("Run R12 · task T3").

## Pull requests

<img alt="The Pull requests page of the board, with SAMPLE DATA: the List and Graph switch, then the groups Needs you, In review, Repairing, Ready to merge, Waiting for another task and Merged recently." src="../assets/board-prs.png" width="100%">

The Pull requests page (`/app/#pull-requests`) groups the tasks with a PR by the next action: Needs you, Building, In review, Repairing, Ready to merge, Waiting for another task, and Merged recently (the last 7 days). Each row shows the PR number (a link to GitHub when the logbook names the repository), the title, the chief tag, the milestone, "may conflict", the clean cycles, the CI state from the ledger ("CI passes", "CI fails" or "CI not known") and the open findings ("1 open · medium"). The board never asks GitHub.

**Graph** draws each PR and each task that waits for another one in columns: an arrow from A to B means that B waits for A. A dashed link joins two tasks that may conflict, and a loop of waits shows one link that goes back, marked "loop". The page keeps the List or Graph choice in this browser.

## The question view and the reader

<img alt="The question view of G4, with SAMPLE DATA: the question, its chief and task, then each answer as a card with its next step and its cost, the chief's pick first." src="../assets/board-question.png" width="100%">

A click on a question in Needs you opens the question view (`/app/#question?key=<gate key>`): the full question as the chief kept it, then each answer as a card, with the chief's pick first. With a paired browser, you pick an answer and Send it here ([Act from the board](#act-from-the-board)). "Read the full question" opens it in the reader.

<img alt="The reader with a question of the sample data, with SAMPLE DATA: Where, Approve and Choice, each under its short label, then the answers." src="../assets/board-reader.png" width="100%">

The reader (`/read/...`) shows what the agents made as plain pages of the board, each with a back link to where you came from: a brief, a report, a Markdown page with its contents list, a design (one version, or two side by side), an arena (the candidates, the scores and the judge's final), and a question. It runs no script.

A page says "not written yet" while its run runs, "not kept" for a run older than the kept briefs, and "gone" for a recorded page that is no longer in the pages folder. The [board service guide](../../packages/sage-board/README.md#the-reader-for-agent-documents-t1064) gives its routes and its safety rules.

## Narrow windows

<img alt="The question view at the width of a phone, 390 pixels, with SAMPLE DATA: the menu moves above the page, and the answers stack in one column." src="../assets/board-narrow.png" width="40%">

The board is for a desktop window from 1024 px wide. A narrower window still works: below 900 px, the menu moves above the page, and the cards and the answers stack in one column.

The board is for this Mac only: it has no phone or remote access.

## Act from the board

With a paired browser, you act from the Overview:

| Action | Clicks from the Overview | What it writes |
| --- | --- | --- |
| Answer a question in Needs you | 1 to open it with its full context (the question message that the chief kept), then pick and Send | `gate answer --via board`. The chief that owns the question applies the answer at its next step. |
| Undo a board answer | 1: Undo, under "Answered · waits for the chief" | `gate undo`, until the chief picks the answer up. |
| Rename a chief | 2: the chief's menu (▾), then Rename | `chief name`. An empty name clears your name. |
| Show only one chief's work | 1: the chief's chip. "All chiefs" shows all again | Nothing: the filter holds on each page, in this browser tab. |
| Give a task of a stopped chief to another chief | 2: Give to another chief, then Open the takeover question | `gate give`. Nothing moves until you answer the takeover question. |
| See what changed since you looked | 0 | Nothing on the Mac: each browser keeps the time when you last left the board (the tab closed, or hidden for 5 minutes). A reload keeps the counts. |

The first answer wins. When you answer in a chat or on a card first, the board shows where and when, for example "Answered first in C2's chat at 14:51", and a later board answer is not recorded.

**Pair a browser once.** Until you pair, the board only reads. Type `show board` in a chief's chat, and click the link in its reply: one click opens the board and pairs the browser.

The chief makes the link with `board --ensure --link`:

- The link has the form `http://127.0.0.1:<port>/app/#pair=<key>`. The key is 256 random bits. It is after the `#`, so the browser never sends it in a request line, a log or a referrer.
- The board takes the key out of the address bar and the history at once, then sends it once. The server keeps only its hash, in `pair-link.json` in the board's state folder.
- A link pairs one browser, once, within 10 minutes. A new link ends the older one.
- The hooks refuse `--link` from an agent: only the chief runs it, and the chief puts the link in the chat text only, never in a file, a message page or a brief.

After the click, a note on top of the Overview gives the outcome and the next step:

| Outcome | What the note says |
| --- | --- |
| Paired | This browser is paired, and the link is used up. |
| Already paired | Nothing changed. The link no longer pairs any browser. |
| Used | Another browser on this Mac used the link, and when. The note has the button **Unpair every browser**, for the case that it was not you. |
| Replaced | A newer link replaced this one. |
| Expired | The link is older than 10 minutes. |
| Refused | The key is not a link of this board. |

For each outcome except Paired and Already paired, type `show board` again for a new link.

**Unpair every browser** works without pairing. It removes every pairing, so each browser reads only until you pair it again. A program on this Mac can also send it; the worst result is that you pair again.

**No chat open?** Pair with a Terminal code. The pairing card shows the command, with its full path, for example `node "<board folder>/cli.mjs" board --pair`:

1. Choose Copy, then paste the command in Terminal on the Mac, and run it. It prints a one-time code that works for 10 minutes.
2. On the board, type the code in the "Pairing code" field, and choose Pair.

If the page shows no pairing card, the board that runs is older than your sage: run the `board --stop` command that `board --pair` prints, ask for the board again, and reload the page. When a browser loses its site data, it pairs again.

`board --pair` refuses to run when its input is not a terminal, and the hooks refuse it from an agent.

**What the board checks.** Each write is a POST to `/api/...`, and the server refuses it unless all of these hold:

1. The `Origin` is the board's own address, `Sec-Fetch-Site` is `same-origin`, and the body is JSON. The server answers no CORS preflight, so a page on another site or port cannot send one. A `/pages` page with scripts has the origin `null`, and the server refuses it.
2. The browser has the pairing cookie (`HttpOnly; SameSite=Strict`). The board keeps only its hash, in the board's state folder (`~/.config/sage-board/state`).
3. The request carries the pairing token of the same browser. The server gives it to the page once, when you pair, and keeps only its hash. The page keeps it in `localStorage`, which belongs to the board's own address and port, and a `/pages` page runs in a sandbox without it.
4. An answer names the digest of the question and the options that you saw. When the question changed, the state tool refuses the answer.
5. The board runs only your commands: `gate answer --via board`, `gate undo`, `gate give` and `chief name`, through the state tool, in its own thread. It never claims, accepts or writes a task.

A browser sends the cookie to every server on `127.0.0.1`, also on another port. That server never gets the token, so the cookie alone writes nothing.

The board writes only a shared logbook. A logbook with no checkout on this Mac refuses, and you answer in the chief's chat.

An agent runs as your user, so a script that builds the state folder's path while it runs can still read the cookie's hash file. The sandbox is the full protection.

## A shared project on the board

A project with a [shared logbook](using-sage.md#shared-logbooks) shows as one project on both views, from Claude and from Codex. The board reads the shared root (`~/.sage`, or the root that `SAGE_SHARED_HOME` names) beside the Claude and Codex roots. A project that is not shared looks and works as before.

In the browser, each task shows its owning chief as a chip with its id and provider, for example `Claude · C1`, and the chief filter shows one chief's work. The chat board and the chat task view (`show board T320`) give these lines too:

| Line | Where in the chat | What it says |
| --- | --- | --- |
| `Owning chief: Claude · C1` | The task view | The owning chief and its provider. A task with no owning chief says `Unclaimed`: the chief that unclaimed it can claim it back; another chief needs your takeover gate. |
| `Offered to Codex · C2. It waits for R407 to end, then Codex · C2 accepts.` | Under the task's line, and in the task view | An open offer, while a run of the task runs. |
| `Hand T320 from Claude · C1 to Codex · C2? R410 and R411 end as failed.` | Needs you | An open takeover gate, with its options and recommendation: `approve, when you know that Claude · C1 stopped`, or after an accept `approve, because Claude · C1 offered T320 to Codex · C2`. |
| `The owning chief, Codex · C2, may have stopped: R412 shows no change for over 24 h.` | Needs you | A running run of the owning chief has no change in the task's rows for over 24 h. Ask any chief to open a takeover gate. |
| `R407 Claude · qa · checkout lantern · in progress` | The runs of the task view | The provider of each run, from the run's chief in `chiefs.tsv`, and the folder of the checkout that the run started from: its name only, never its path. A run with no chief stands in as `Unknown`. |
| `checkout lantern (gone)` | The same | That folder is not on this Mac now, or it is a file or a folder with no Git checkout. When it is the folder of the branch's newest writer run, one line under the runs names the folder and the run, and the next review step stops until the folder is back. |
| `checkout lantern (not checked)` | The same | The board checks at most 64 checkout folders of a logbook, so it did not check this one. |
| `checkout lantern \#2` | The same | Two linked checkouts have the folder name lantern. The number is the link order, and it never moves to another folder. |
| `was Claude T640` | The task's line and the task view | A task that [the move](using-sage.md#move-an-existing-project) took to the shared logbook, with its old provider and number. |
| `⇢ sage moved to one shared logbook on 2026-11-03 15:44 UTC.` | The top of the chat board | The project moved in the last 7 days. The line names the map page of old and new numbers, `move-map.html`, and the logbook folder that holds it. It shows no path. |
| `Old · Claude · read-only` | The task's line in Done, and the task view | A finished task that stayed in its old logbook when the project moved. Its number belongs to the old logbook, and an open gate of it is not in Needs you. |
| `The logbook is changing` | The top of the chat board | The board read the logbook 3 times, and it changed during each read. Ask for the board again. The board in the browser keeps its last good read and reads again soon. |
| `Logbook note: …` | The end of the chat board | A row of `sources.tsv` or `bindings.tsv` that the board does not use, for example `A checkout named harbor-new is linked to this logbook, but it has no first commit in common with it.` The board stays live. |

- **Names and links:** the board takes a shared project's checkout from its row in `bindings.tsv`, so the name and the PR links come from that checkout's GitHub remote.
- **Old logbooks:** the move lists them in `sources.tsv`. The board reads a folder of that list only when it is a logbook folder directly under a Claude or Codex root, not a link, with the move's mark `moved.json`, and its row names that root's provider. Each old logbook shows once, in its shared project.
- **Agents:** a run of a shared logbook joins its agent slot in its provider's root. So a Claude run with a slot shows as at work, not as "may be stuck".
- **"Show board" in a session:** the chat board finds a shared project from its checkout, a worktree, a subfolder or another linked clone. A clone with no row does not find a shared project by its folder's name: link it first.

<!-- The old anchor stays, so that older links to it still work. -->
<a id="programs-on-the-board"></a>

## Milestones on the board

A milestone is a request that sage runs as two or more tasks for one goal, with one pilot task and a breakdown that you approve (see [Milestones](using-sage.md#milestones)).

| Where | What you see |
| --- | --- |
| The Overview's Milestones card | Each milestone by the top priority of its open tasks, with its state word, goal, progress bar, what needs you and the pilot. A milestone done more than 7 days ago leaves the card, and a line counts them. A click opens the Tasks page at that milestone. |
| Needs you | A breakdown that waits for your approval, and a stuck milestone. |
| The Tasks page, grouped by milestone | The tasks of each milestone, with "waits" on a task that waits for another one. |
| The chat | A Milestones section with one line for each milestone that is not done, with what moves next. Done milestones, and dropped milestones with no task left in them, are counts, with ": see the board's Tasks page, grouped by milestone". In Needs you, a breakdown gate is under its own heading, "Milestone approval". |

Every line that you read names a milestone by its level: "Milestone 6: Faster reviews", or "milestone 6" inside a sentence ("Waits for your approval of milestone 6").

## Releases on the board

A release is a version that you ship, such as 1.0. It holds milestones and single tasks, and it is optional (see [Releases](using-sage.md#releases)).

The chat board shows the releases: a "Where we are" section after Needs you, with boxes inside boxes (release › milestone › task) in a code block, 46 columns wide. Each task line ends with its nearest level: its milestone, else its release, else "no release" when its project has releases.

- The frame shows each release that is not done or stopped, or the last release when all are, then the open milestones and tasks in no release.
- A milestone box holds its tasks that need you or are in progress (at most 3), then a box for each other word, with its count.
- A releases table that the board cannot read is an item in Needs you, with the file and the line; the board then shows the tasks without their releases.

The board in the browser does not show releases yet. Ask for the board in the chat to see them.

## The pages of a task

Agents save each task's pages (research, designs, the pages of the chief's messages) in the task's pages folder. The board server also shows these pages, read-only, on the Mac only:

- `http://127.0.0.1:<port>/pages/<logbook>/<task>/` is the task's index: a list of its pages, with the size of each.
- `http://127.0.0.1:<port>/pages/<logbook>/<task>/<file>` opens one page. For example: `http://127.0.0.1:43123/pages/sage-43265b/T1000/research.html`.

The task page's Artifacts tab lists the pages of the task, and a Markdown page opens in the reader.

The Page block of a message gives this link between its title and its file path ([sage's messages](using-sage.md#sages-messages)). So one link opens the page in the same way in each app: in the Browser pane of the Claude desktop app, in the built-in browser of the Codex app, and in your default browser from a terminal.

The board shows web pages, PDFs, pictures (PNG, JPEG, GIF, WebP and SVG), and Markdown and text files as plain text. It shows no other file: no logbook file, JSON, log, hidden file or link.

A page can be at most 3 parts deep in the task's folder (for example `designs/final/index.html`) and at most 16 MiB. The index lists at most 200 pages.

Each page opens in a sandbox. A page cannot read the board or your files, load a picture, a style or a frame from the board or from another site, or send a form.

A script from another site does not run, but if its `integrity` hash matches the switch, your browser still asks that site for it before it checks the hash. A frame to another site stays blocked, but your browser still opens a connection to that site, and the connection sends its host name.

Only sage's own script runs: the Today switch of a message's page. A page that holds this switch and also an `http-equiv` (for example a refresh) or a `srcdoc` outside sage's own policy tag gets no script, so that a refresh cannot move it: it shows without its switch. When the board cannot judge a page, the page also shows without its switch.

The usual way out of a page is a link that you click in it. Two ways out need no click:

- When a page opens, it can make your browser ask another site for an address, for example with a prerender link. The address can hold any text of the page, so that text can leave the Mac, and the request carries the cookies of that site that `SameSite=Lax` lets through. The board found no header that stops this in Chromium.
- A page that you open with "open with its scripts" (`?scripts=1`) can move itself to another site, by its script or by a meta refresh.

Two warning lines in the index tell you the rest:

- A page may link to sites outside this Mac. When you click such a link, your browser opens that site, and the site gets everything in the link's address.
- The link "open with its scripts" (in the index, for a page with a script of its own) runs the page's own scripts. They cannot read the board or your files, but they can send the page's content to another site. Use it only for a page that you trust.

A link in a page to another page of the board, or to the index, opens when you click it: the board opens a page by a person's click from any site. A page cannot load or fetch anything from the board.

A site that moves you to a page by itself gets "not permitted", and so does a link to "open with its scripts" in a page or on another site: open it from the index. When another site opens the index in a new tab, the index cuts that site's hold on the tab, so the site cannot move the tab or read what a page sends to it.

## The board server

The board server reads your logbooks. It writes only the owner's actions of a paired browser, through the state tool ([Act from the board](#act-from-the-board)). It does not fetch from GitHub or decide whether a pull request may merge.

In Claude and in Codex, `show board` also starts the local board server on the Mac when it is not running (the first time, it sets it up from the standard Claude and Codex roots and the shared root), and the chief shows its address, or why it is not running, next to the chat board. In Codex, this start runs outside Codex's sandbox, so Codex asks you to approve it ([The board in Codex](codex.md#the-board-in-codex)). The board is for a desktop browser on this Mac only, and it needs no sign-in.

The server listens on loopback and refuses every request that is not from the Mac itself.

The sage hook refuses the ordinary command shapes by which an agent reads, copies or replaces the board config or a file of the board's state folder, lists, searches, copies or moves the board's folder (`~/.config/sage-board/`), or runs `board --pair`, and it refuses `board --ensure --link` from an agent. It does not stop a script that builds them while it runs; full protection needs the sandbox.

After you change a setting of the config, or update sage, the line says that a restart is needed: run the `board --stop` command that it gives, then ask for the board again.

### Change the board's port

The board uses port 43123. When another program on the Mac uses that port, `show board` says so and gives the command that moves the board. Run it in Terminal on the Mac:

```sh
node <board folder>/cli.mjs board --port 43124
```

Use the board folder that the message names, and any free port from 1024 to 65535 in place of 43124. Add `--config <file>` when your board config is not `~/.config/sage-board/board.json`.

You can also ask the chief to run it. An agent cannot run it: the hooks refuse it.

The command does these steps in this order. When a check fails, it stops and changes nothing:

1. It checks that the port is a number from 1024 to 65535, and that no program on the Mac uses it.
2. It checks that it can write the board config and its folder.
3. It stops this config's board, if it runs. Another program, or the board of another config, on the old port runs on.
4. It writes the new port in the board config. It keeps every other setting and the mode of the file.
5. It starts the board on the new port and prints its address.

After the move:

- The Page link of each new message names the new port. A Page link in a message from before still names the old port: change the port in that link.
- The login service (`dev.sage.board`, if you set it up) reads the port from the board config each time it starts, so it needs no change.

**The manual way.** Use it only when your sage has no `board --port`. Do these steps in this order:

1. Run `board --stop --config <file>`, with the path of your board config. Do this first: `--stop` looks for the board on the port that the file names.
2. Edit `"port"` in that file.
3. Ask for the board again.

If you edit the port first, `--stop` finds no board on the new port, and the old server runs on.

The [board service guide](../../packages/sage-board/README.md) gives local startup and the stable installation. The server runs independently of a chat.

`board --install --login-file` refuses when no upgrade-stable `node` command is on PATH, for example with asdf, Volta, fnm or a keg-only Homebrew Node. To fix it, put a `node` link to the Node that you run the install with in a folder that you own and that is on PATH (for example `~/.local/bin/node`), then run the install again.
