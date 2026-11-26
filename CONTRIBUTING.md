# Contributing to sage

This page tells you how to change sage: which files are sources, how to build and check them, and how sage credits pstack. An agent that works on sage also reads [AGENTS.md](AGENTS.md), which has the same rules in short form.

To report a security problem, do not open an issue: see [SECURITY.md](SECURITY.md).

## The folders

| Path | What it is |
| --- | --- |
| `packages/` | The sources: shared core, the Claude Code and Codex parts, and the board server. |
| `plugins/sage/`, `plugins/sage-codex/` | The built plugins for Claude Code and Codex. Never edit them by hand. |
| `principles/`, `writing/`, `preferences/` | The principles (adapted from pstack, and sage's own), the writing standard, the dictionary and the author's working preferences. |
| `docs/` | The guides, the design pages, the dry run report and the README's graphics: see the [docs index](docs/README.md). |
| `scripts/` | The build, the checks, the tests, and the scripts that draw the graphics and take the board screenshots. |

## Sources and build output

Edit only the sources. The build makes everything else, and `npm run check` fails when a built file differs from its sources.

| Edit these sources | Never edit by hand |
| --- | --- |
| `principles/`, `writing/`, `preferences/` | `plugins/sage/` and `plugins/sage-codex/` (the built plugins) |
| `packages/` (shared code, and each provider's hooks, agents and skills) | `instructions/core.md` (built from `preferences/` and `writing/`) |
| `scripts/graphics.mjs` (draws the README's graphics) | `docs/assets/*.svg` (drawn by the script) |
| `scripts/board-shots.mjs` (takes the board screenshots) | `docs/assets/board-*.png` and `learn-*.png` (taken by the script) |
| `scripts/board-walkthrough.mjs` (records the board walkthrough and the tour) | `docs/assets/board-walkthrough-*.gif` and `board-tour.mp4` (recorded by the script) |

To add a principle, add `principles/<name>.md`. A principle adapted from pstack has `source: pstack principle-<name>`, with the credit and the pstack version and commit that it was checked against (see [Credit](#credit)).

## Change it

1. Install the pinned build dependencies. Installed plugins do not need this step.

   ```sh
   npm ci --ignore-scripts
   ```

2. Edit a source.
3. After a change to a graphic, draw the graphics again:

   ```sh
   npm run graphics
   ```

4. Build:

   ```sh
   npm run build
   ```

5. Run the checks:

   ```sh
   npm run check
   ```

   The checks do these things:
   - They check the README's limits, its links and sage's word check.
   - They run the tests of the no-comments rule set in [`packages/sage-core/lint/`](packages/sage-core/lint/README.md), with `ast-grep test` from the pinned `@ast-grep/cli` devDependency.
   - They scan `packages/`, `scripts/` and `.github/` with that rule set, and fail on each comment that is not an allowed directive. The scan skips each folder that `SCAN_EXCLUSIONS` in `scripts/lint-rules.mjs` lists, with its reason.

   To remove the comments of your change:
   1. Commit your change.
   2. Run `node scripts/strip-comments.mjs`.
   3. Run `node scripts/comment-proof.mjs`. For each file that the strip changed, it checks that the code tokens and the minified code (for YAML, the parsed value) did not change. It must report 0 failed.
   4. Put a reason that a reader needs in a name, a test name or a doc, never in a comment.

   A branch made before the no-comments sweep (PR 540) has comments that main does not have. See [A branch from before the sweep](#a-branch-from-before-the-sweep).

6. Run the tests. CI runs the check and the tests on each pull request. It runs `npm test` in 4 parts at the same time: `node --test` sorts the test files by path and gives each file to exactly one part. To run one part, set `TEST_SHARD`, for example `TEST_SHARD=2/4 npm test`. CI runs on Ubuntu 24.04, not on `ubuntu-latest`, because Playwright 1.55.1 has no headless shell for Ubuntu 26.04 (`ubuntu-latest` since 2026-10-19). The last job of the workflow, `check`, passes only when every other job passed. The protection of `main` requires that job by its name, so keep the name.

   ```sh
   npm test
   ```

7. Run the browser tests of the board. They are not in `npm test`, so that it stays fast. They use the Chromium headless shell of the pinned `playwright` devDependency. `npm ci` downloads no browser, so install it once:

   ```sh
   node scripts/browser-prerequisite.mjs setup
   npm run test:browser
   ```

   To run one file: `node --test scripts/board-app-browser.test.mjs`. Every browser test checks the same prerequisite before it starts a board or browser. The check requires matching Playwright 1.55.1 packages, the expected headless shell executable and its installation completion marker. It refuses `BOARD_BROWSER_PATH`; another cached revision is not a substitute. Tests never install a browser or skip an assertion when setup is incomplete.

   Setup uses the pinned Playwright installer, with `pw:install` diagnostics. It keeps stdout and stderr through the child's close event. A ten-minute deadline requests termination through that child handle, unless its exit was already observed. Setup then waits at most ten seconds for close. A signal request or progress at 100% proves no completion. If close does not arrive, setup fails with cleanup unknown; its output snapshot covers the bounded wait. Do not start another installer until the host resolves that unknown cleanup. A direct child's close does not prove that every descendant stopped.

   The prerequisite checks installation files. Only a successful browser startup and close checks that the browser can run on this host. CI uses a fresh Linux environment, installs with `node scripts/browser-prerequisite.mjs setup --with-deps`, and runs `npm run test:browser` after `npm run check`. Agents use their own scratch home and browser cache; they do not borrow the owner's browser or cache.

   Run test commands in their own process and environment. `scripts/test-env.mjs` disables global Git configuration on purpose. Keep publication in the invoking authenticated context, outside that test process and its scratch home. Do not copy credentials or change Git configuration to publish from a test environment.

## A branch from before the sweep

PR 540 removed every comment from the sources. Strip the files that a branch made before it changed, with main's script, so that the merge has only real conflicts. Both scripts work in the git repository of the current folder, so run each command at the root of your worktree:

1. Commit your work.
2. In a checkout of main that has PR 540, run `npm ci --ignore-scripts`.
3. Run `git fetch origin`. If `git diff --name-only --diff-filter=d origin/main...HEAD` lists no file, skip to step 5. Else strip the files that your branch changed, and no other file: `node <main checkout>/scripts/strip-comments.mjs $(git diff --name-only --diff-filter=d origin/main...HEAD)`.
4. Run `node <main checkout>/scripts/comment-proof.mjs HEAD`. It must report 0 failed, except for a YAML file whose `run:` block lost a shell comment: that file always fails, so check its change by hand with `git diff HEAD -- <file>`. Each line that changed must only have lost a `#` comment. A file type with no proof, such as `.json`, is "not proved" and does not fail.
5. Commit, then run `git merge origin/main`. In a conflict, take main's side of each line that only lost a comment.
6. Run `npm ci`. The merge brought the tools of the strip and the proof into `package.json`.
7. If `git diff --name-only --diff-filter=d origin/main...HEAD` lists no file, skip to step 9. Else strip your branch's files again: `node scripts/strip-comments.mjs $(git diff --name-only --diff-filter=d origin/main...HEAD)`. It removes the comments that the merge brought.
8. Run `node scripts/comment-proof.mjs HEAD`. It must report 0 failed, except for a YAML file whose `run:` block lost a shell comment: check that file by hand, as in step 4.
9. Run `npm run build` and `npm run check`, then commit.

## The README and the docs

- The README is a short front page. `npm run check` holds it to 150 lines, a first screen that answers what sage is and its status, a link to the releases page, and relative links that resolve. A longer text goes into a page under `docs/`, listed in the [docs index](docs/README.md).
- **No history file.** The repository keeps no `CHANGELOG.md` and no change files, because an agent that arrives fresh reads old history as current fact. Git history and the merged pull requests are the record. A task pull request says what changed for users in its description, in plain words. `npm run check` fails on a `CHANGELOG.md` or a file in a `changes/` folder: delete it, and put its text in the pull request description.
- **Prior art.** sage leaves the practice of one change file per pull request, as in [changesets](https://github.com/changesets/changesets) and [towncrier](https://github.com/twisted/towncrier) fragments, and of a changelog file in the repository. It follows [GitHub's generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes), which draw the notes from the merged pull requests, as [release-please](https://github.com/googleapis/release-please) also does for its release notes. So each change is written once, in its pull request, and no file in the tree goes stale.
- **Release notes, for the chief.** Each release gets one set of notes, on the [releases page](https://github.com/erickb336/sage-stack/releases). At a release:
  1. Draft the notes from the pull requests that merged since the last release. GitHub's generated release notes are the default, so sage needs no new tool. This command makes a draft and saves nothing: `gh api --method POST repos/erickb336/sage-stack/releases/generate-notes -f tag_name=<new tag>`. After the first release, add `-f previous_tag_name=<last tag>`. The answer has a name and a body, with one line for each merged pull request.
  2. Rewrite the draft in plain words for users. Group the lines by what changed for them, leave out the changes that users do not see, and keep the task numbers.
  3. Show the notes to the owner, and ask before anything is published. A GitHub release and its tag are published, so only the owner's yes starts `gh release create <tag> --title <name> --notes-file <notes file>`. Do not use `--generate-notes` there: it publishes GitHub's draft as it is.
- The word table of [Concepts](docs/guide/concepts.md) and the table of [Principles](docs/guide/principles.md) come from the build: edit `writing/dictionary.md` or the principles, then run `npm run build`.
- Write at about 80% of Simplified Technical English ([writing/ste-80.md](writing/ste-80.md)), with sage's words from [writing/dictionary.md](writing/dictionary.md). `npm run check` fails on a flagged word.

## The board screenshots

The board screenshots of the README, the [board guide](docs/guide/board.md) and [Learn sage in 5 minutes](docs/guide/learn-sage.md) come from `scripts/board-shots.mjs`. It writes sample logbooks (made-up data, from `scripts/fixtures/board-app.mjs` and `scripts/fixtures/board-walkthrough.mjs`) to a temporary folder, starts a board server on a free port with the built app, and opens each page in Playwright's Chromium. Each shot is at laptop width (1280 by 800 CSS pixels; the narrow shot is 390 by 844) and 2x, and carries a SAMPLE DATA label. It uses the same browser as the browser tests (step 7 above):

```sh
node scripts/board-shots.mjs
```

`npm run check` fails when a PNG is missing, or when the sample data changed after the last screenshots. It does not compare pixels.

## The board walkthrough

The README's board walkthrough, `docs/assets/board-walkthrough-dark.gif` and `board-walkthrough-light.gif`, comes from `scripts/board-walkthrough.mjs`. Make it again after a board change:

```sh
npm run walkthrough
```

The full tour of every board page, `docs/assets/board-tour.mp4`, comes from the same script. The README links it under the walkthrough. Make it again after a board change:

```sh
npm run tour
```

- It writes the sample logbook of the screenshots (`scripts/fixtures/board-app.mjs`) to a temporary folder and starts a board server on a free port, with the built app.
- It pairs a Playwright browser at 1320 by 800 pixels and plays one fixed path of three scenes: the Overview, a zoom on Needs you, and a click that opens one task. The clip is about 9 s long and loops.
- It records frame by frame, 20 frames a second: for each frame it sets the zoom, the cursor, the click ring, the caption and any fade, then takes one screenshot. So the clip does not depend on the speed of the machine, and the text stays sharp in a zoom.
- ffmpeg puts a window frame around each frame: a title bar with a SAMPLE DATA label, and a caption band under the board. So the label and the caption never cover board text.
- The board server of the walkthrough refuses every write, so the script never runs the state tool.
- It stops when a frame shows the temporary folder, the home folder or the user name.
- The tour adds an archived sample project, and plays nine scenes in the dark theme: the Overview, zooms on Needs you and Sessions, then Tasks, one task, Agents, Pull requests, Stats and the Archive. It is about 53 s long, an H.264 MP4 of about 1.6 MB. A video in the repository does not play in a GitHub README, so the README links the file.
- It needs ffmpeg 6 or later, to write the GIF and the MP4: on PATH, or its path in `FFMPEG` (macOS: `brew install ffmpeg`; Debian or Ubuntu: `sudo apt-get install ffmpeg`).
- It uses Playwright's Chromium, or the browser in `--browser <path>` or `BOARD_BROWSER_PATH`. `--theme dark` or `--theme light` makes one GIF; `--frames <folder>` keeps the frames in a new or empty folder, to compare two runs.
- Each GIF is about 5 MB. CI does not run it. Two runs make the same frames, except for the clock times on the board.

For board QA, `node scripts/board-sample.mjs <empty folder>` writes sample logbooks (made-up data), with sample agent slots for the Agents page. It prints the board sources as JSON.

## Credit

sage's principles come from pstack, by Lauren Tan (poteto), under the MIT licence. sage keeps its own text of each principle in `principles/`, and it does not copy or sync pstack.

- Each principle's `source` line names its pstack principle, and the pstack version and commit that its text was checked against, for example `checked against pstack 0.15.36 at commit 0bb6f37`.
- pstack's MIT licence is in [principles/LICENSE-pstack](principles/LICENSE-pstack). The build puts it in each plugin as `LICENSE-pstack`.
- The [baseline table](docs/guide/principles.md#baseline-against-pstack) gives the state of each principle against that commit.
- To check against a later pstack, compare each text by hand and adapt it in `principles/`. Then update the baseline table and the version and commit in each `source` line.

pstack's own modes (poteto mode, orchestrate, autopilot) stay out, because sage mode is the orchestration layer here. Another pstack skill comes in only when it works in Claude Code and has a test.

## Design pages

- [The sage mode design](docs/design/sage-mode.md): the first design, with its decisions.
- [Rules held in code](docs/design/rules-in-code.md): every rule that the hook and the state tool hold.
- [Separate provider packages](docs/design/provider-packages.md): the Claude Code and Codex plugins, and the shared core.
